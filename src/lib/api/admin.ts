import { z } from "zod";
import {
  getReferralProgram,
  publishReferralProgram,
  issueReferralAward,
} from "@/lib/referrals";
import {
  referralProgramSchema,
  issueAwardSchema,
} from "@/lib/referrals/contracts";
import { query, transaction, type Db } from "@/lib/db";
import { normalizePhone } from "@/lib/auth/telegram";
import {
  getAccountSnapshot,
  getProgram,
  getHistory,
  processRental,
  updateRentalStatus,
  creditBonus,
  debitBonus,
  reverseTransaction,
  adjustRental,
  cancelRental,
  changeTier,
  publishProgram,
  TIER_CODES,
} from "@/lib/loyalty";
import { requireStaff, rateLimit } from "@/lib/auth/session";
import {
  body,
  HttpError,
  json,
  operationKey,
  requireOrigin,
  idSchema,
  notFound,
} from "@/lib/http";
const reason = z
  .string()
  .trim()
  .min(3, "Укажите причину (от 3 символов)")
  .max(1000);
const amount = z.string().regex(/^\d{1,15}$/);
const tier = z.enum(TIER_CODES);
const likePattern = (value: string) => `%${value.replace(/[\\%_]/g, "\\$&")}%`;
function phoneSearch(value: string) {
  if (!/^[+\d()\s-]+$/.test(value)) return "";
  const digits = value.replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("8")
    ? "7" + digits.slice(1)
    : digits;
}
function dateFilters(url: URL) {
  const from = z.iso
    .date()
    .optional()
    .parse(url.searchParams.get("date_from") || undefined);
  const to = z.iso
    .date()
    .optional()
    .parse(url.searchParams.get("date_to") || undefined);
  if (from && to && from > to)
    throw new HttpError(422, "DATE_RANGE", "Начало периода позже окончания");
  return [from ?? null, to ?? null];
}
async function lockStaffManager(tx: Db, id: string) {
  const [owner] = await tx.query(
    `SELECT m.id FROM admin_memberships m WHERE m.id=$1 AND m.active AND m.role='admin' AND m.can_manage_staff
     AND (m.telegram_user_id IS NULL OR EXISTS(SELECT 1 FROM users u WHERE u.id=m.telegram_user_id AND u.status='active')) FOR UPDATE`,
    [id],
  );
  if (!owner)
    throw new HttpError(
      403,
      "STAFF_MANAGEMENT_FORBIDDEN",
      "Только владелец может назначать и отключать администраторов",
    );
}
export async function adminRoute(
  request: Request,
  path: string,
): Promise<Response | null> {
  if (!path.startsWith("admin/")) return null;
  const staff = await requireStaff(request);
  const mutating = request.method !== "GET";
  if (mutating) {
    requireOrigin(request);
    await rateLimit("staff-write:" + staff.id, 30);
  }
  const actor = {
    id: staff.id,
    role: staff.role === "viewer" ? ("manager" as const) : staff.role,
  };
  const manager = () => requireStaff(request, "manager");
  const admin = () => requireStaff(request, "admin");
  const staffManager = async () => {
    const current = await admin();
    if (!current.can_manage_staff)
      throw new HttpError(
        403,
        "STAFF_MANAGEMENT_FORBIDDEN",
        "Только владелец может назначать и отключать администраторов",
      );
  };
  const url = new URL(request.url);
  const page = z.coerce
    .number()
    .int()
    .min(0)
    .max(10000)
    .parse(url.searchParams.get("page") ?? 0);
  const offset = page * 50;
  if (request.method === "GET" && path === "admin/me") return json(staff);
  if (path === "admin/referral-program" && request.method === "GET")
    return json({ program: await getReferralProgram() });
  if (path === "admin/referral-program" && request.method === "POST") {
    await admin();
    return json(
      await publishReferralProgram(
        await body(request, referralProgramSchema),
        operationKey(request),
        actor,
      ),
    );
  }
  const issueAward = path.match(
    /^admin\/referral-awards\/([a-f0-9-]{36})\/issue$/,
  );
  if (issueAward && request.method === "POST") {
    await manager();
    return json(
      await issueReferralAward(
        idSchema.parse(issueAward[1]),
        await body(request, issueAwardSchema),
        operationKey(request),
        actor,
      ),
    );
  }
  if (request.method === "GET" && path === "admin/dashboard") {
    const [stats] = await query(
      `SELECT (SELECT count(*) FROM loyalty_accounts WHERE member_since IS NOT NULL)::int members,(SELECT count(*) FROM loyalty_accounts WHERE member_since>now()-interval '30 days')::int new_members,(SELECT count(*) FROM loyalty_accounts a JOIN users u ON u.id=a.user_id WHERE a.member_since IS NOT NULL AND u.status='blocked')::int blocked_members,COALESCE(sum(total_rental_amount),0)::text total_amount,COALESCE(sum(bonus_available),0)::text available_bonus FROM loyalty_accounts`,
    );
    const distribution = await query(
      "SELECT effective.code tier,count(*)::int count FROM loyalty_accounts a JOIN loyalty_tiers calculated ON calculated.code=a.calculated_tier JOIN loyalty_tiers achieved ON achieved.code=a.achieved_tier LEFT JOIN loyalty_tiers manual ON manual.code=a.manual_override JOIN loyalty_tiers effective ON effective.rank=greatest(calculated.rank,achieved.rank,coalesce(manual.rank,0)) WHERE a.member_since IS NOT NULL GROUP BY effective.code",
    );
    const [bonuses] = await query(
      `SELECT COALESCE(sum(amount) FILTER(WHERE amount>0 AND type<>'reversal'),0)::text credited,
        COALESCE(sum(amount) FILTER(WHERE amount>0 AND type<>'reversal' AND NOT(type='manual_credit' AND reason='opening_balance')),0)::text gross_credits,
        COALESCE(sum(amount) FILTER(WHERE type='manual_credit' AND reason='opening_balance'),0)::text opening_balance,
        COALESCE(sum(amount) FILTER(WHERE type='reversal' AND amount>0),0)::text reversal_credits,
        COALESCE(-sum(amount) FILTER(WHERE type='reversal' AND amount<0),0)::text reversal_debits,
        COALESCE(-sum(amount) FILTER(WHERE type='manual_debit'),0)::text manual_debits,
        COALESCE(-sum(amount) FILTER(WHERE type='rental_payment'),0)::text redeemed,
        COALESCE(-sum(amount) FILTER(WHERE type='expiration'),0)::text expired,
        COALESCE(sum(amount),0)::text net_bonus FROM bonus_transactions`,
    );
    const [rentalTotals] = await query(
      `SELECT coalesce(sum(amount_kopecks),0)::text gross_rental_amount,coalesce(sum(greatest(amount_kopecks-current_amount_kopecks,0)),0)::text rental_reductions,coalesce(sum(greatest(current_amount_kopecks-amount_kopecks,0)),0)::text rental_increases FROM rentals WHERE is_qualified`,
    );
    const recent = await query(
      "SELECT r.*,u.name customer_name FROM rentals r JOIN users u ON u.id=r.user_id ORDER BY r.created_at DESC LIMIT 5",
    );
    return json({
      stats: { ...stats, ...bonuses, ...rentalTotals },
      distribution,
      recent,
      program: await getProgram(),
    });
  }
  if (request.method === "GET" && path === "admin/customers") {
    const q = (url.searchParams.get("q") ?? "").trim().slice(0, 200);
    const selectedTier = url.searchParams.get("tier") ?? "";
    const status = url.searchParams.get("status") ?? "";
    const values = [
      likePattern(q),
      selectedTier,
      status,
      offset,
      phoneSearch(q),
    ];
    const items = await query(
      `SELECT u.*,a.achieved_tier tier,a.total_rental_amount,a.bonus_available,a.account_version,(SELECT count(*)::int FROM rentals r WHERE r.user_id=u.id AND r.is_qualified AND r.status<>'cancelled') rental_count,count(*) OVER()::int total_count FROM users u JOIN loyalty_accounts a ON a.user_id=u.id WHERE (u.name ILIKE $1 OR u.phone ILIKE $1 OR u.public_member_id ILIKE $1 OR u.telegram_username ILIKE $1 OR u.telegram_id::text ILIKE $1 OR u.crm_customer_id ILIKE $1 OR ($5<>'' AND replace(u.phone,'+','') LIKE '%'||$5||'%')) AND ($2='' OR a.achieved_tier=$2) AND ($3='' OR u.status=$3) ORDER BY u.created_at DESC,u.id LIMIT 50 OFFSET $4`,
      values,
    );
    return json({ items, page, total: items[0]?.total_count ?? 0 });
  }
  const customer = path.match(/^admin\/customers\/([a-f0-9-]{36})$/);
  if (request.method === "GET" && customer) {
    const id = idSchema.parse(customer[1]);
    const [snapshot, rentals, transactions, referrals, crmIdentities, profile] =
      await Promise.all([
        getAccountSnapshot(id),
        getHistory(id, "rentals", 50),
        getHistory(id, "bonus", 50),
        query(
          "SELECT r.*,a.name referrer_name,b.name referred_name FROM referrals r JOIN users a ON a.id=r.referrer_id JOIN users b ON b.id=r.referred_id WHERE referrer_id=$1 OR referred_id=$1 ORDER BY r.created_at DESC LIMIT 50",
          [id],
        ),
        query(
          "SELECT source,crm_customer_id FROM customer_external_identities WHERE user_id=$1 ORDER BY source,crm_customer_id",
          [id],
        ),
        query("SELECT crm_customer_id FROM users WHERE id=$1", [id]),
      ]);
    return json({
      snapshot,
      rentals,
      transactions,
      referrals,
      crmIdentities,
      crmCustomerId: profile[0]?.crm_customer_id ?? null,
    });
  }
  if (request.method === "GET" && path === "admin/rentals") {
    const status = z
      .enum(["accepted", "completed", "in_progress", "cancelled"])
      .optional()
      .parse(url.searchParams.get("status") || undefined);
    const payment = z
      .enum(["paid", "unpaid", "partial", "refunded"])
      .optional()
      .parse(url.searchParams.get("payment_status") || undefined);
    const source = z
      .string()
      .max(128)
      .parse(url.searchParams.get("source") ?? "")
      .trim();
    const [from, to] = dateFilters(url);
    const items = await query(
      `SELECT r.*,to_char(r.start_date,'YYYY-MM-DD') start_date,to_char(r.end_date,'YYYY-MM-DD') end_date,u.name customer_name,count(*) OVER()::int total_count FROM rentals r JOIN users u ON u.id=r.user_id WHERE ($1::text IS NULL OR r.status=$1) AND ($2::text IS NULL OR r.payment_status=$2) AND ($3='' OR r.source=$3) AND ($4::date IS NULL OR r.end_date>=$4::date) AND ($5::date IS NULL OR r.end_date<=$5::date) ORDER BY r.created_at DESC,r.id LIMIT 50 OFFSET $6`,
      [status ?? null, payment ?? null, source, from, to, offset],
    );
    return json({ items, page, total: items[0]?.total_count ?? 0 });
  }
  if (request.method === "GET" && path === "admin/transactions") {
    const type = z
      .enum([
        "rental_cashback",
        "referral_reward",
        "manual_credit",
        "manual_debit",
        "rental_payment",
        "expiration",
        "reversal",
      ])
      .optional()
      .parse(url.searchParams.get("type") || undefined);
    const userId = idSchema
      .optional()
      .parse(url.searchParams.get("user_id") || undefined);
    const q = (url.searchParams.get("q") ?? "").trim().slice(0, 200),
      [from, to] = dateFilters(url);
    const items = await query(
      `SELECT t.*,u.name customer_name,l.remaining_amount,l.expires_at,coalesce(reversed.amount,0)::text reversed_amount,(abs(t.amount)-coalesce(reversed.amount,0))::text reversible_amount,count(*) OVER()::int total_count FROM bonus_transactions t JOIN users u ON u.id=t.user_id LEFT JOIN bonus_lots l ON l.credit_transaction_id=t.id LEFT JOIN LATERAL (SELECT sum(abs(r.amount)) AS amount FROM bonus_transactions r WHERE r.reverses_id=t.id AND r.type='reversal') reversed ON true WHERE ($1::text IS NULL OR t.type=$1) AND ($2::uuid IS NULL OR t.user_id=$2) AND ($3::date IS NULL OR t.created_at>=($3::date::timestamp AT TIME ZONE 'Europe/Moscow')) AND ($4::date IS NULL OR t.created_at<(($4::date+1)::timestamp AT TIME ZONE 'Europe/Moscow')) AND (u.name ILIKE $5 OR u.phone ILIKE $5 OR u.public_member_id ILIKE $5 OR u.telegram_username ILIKE $5 OR ($6<>'' AND replace(u.phone,'+','') LIKE '%'||$6||'%')) ORDER BY t.created_at DESC,t.id LIMIT 50 OFFSET $7`,
      [
        type ?? null,
        userId ?? null,
        from,
        to,
        likePattern(q),
        phoneSearch(q),
        offset,
      ],
    );
    return json({ items, page, total: items[0]?.total_count ?? 0 });
  }
  if (request.method === "POST" && path === "admin/rentals") {
    await manager();
    const input = await body(
      request,
      z.object({
        userId: idSchema,
        externalRentalId: z.string().min(1).max(128),
        carName: z.string().min(1).max(200),
        startDate: z.iso.date(),
        endDate: z.iso.date(),
        pickupAt: z.iso.datetime({ offset: true }).optional(),
        amountKopecks: amount,
        status: z.enum(["accepted", "completed", "in_progress", "cancelled"]),
        paymentStatus: z.enum(["paid", "unpaid", "partial", "refunded"]),
        reason,
      }),
    );
    return json(
      await processRental(
        { ...input, source: "manual", idempotencyKey: operationKey(request) },
        actor,
      ),
      201,
    );
  }
  const pickupAction = path.match(/^admin\/rentals\/([a-f0-9-]{36})\/pickup$/);
  if (request.method === "POST" && pickupAction) {
    await manager();
    const input = await body(
      request,
      z.object({
        pickupAt: z.iso.datetime({ offset: true }),
        expectedVersion: z.number().int().positive(),
        reason,
      }),
    );
    return json(
      await transaction(async (tx) => {
        const [r] = await tx.query<{
          id: string;
          status: string;
          mode: string;
          start_date: string;
          version: number;
          pickup_at: string | null;
        }>(
          "SELECT id,status,mode,to_char(start_date,'YYYY-MM-DD') start_date,version,pickup_at FROM rentals WHERE id=$1 FOR UPDATE",
          [pickupAction[1]],
        );
        if (!r) return notFound();
        if (r.version !== input.expectedVersion)
          throw new HttpError(
            409,
            "RENTAL_STALE",
            "Аренда уже изменена. Обновите список",
          );
        if (r.status !== "accepted" || r.mode !== "operational")
          throw new HttpError(
            409,
            "RENTAL_STATE",
            "Время выдачи можно менять до начала аренды",
          );
        if (
          new Date(Date.parse(input.pickupAt) + 3 * 3600000)
            .toISOString()
            .slice(0, 10) !== r.start_date ||
          Date.parse(input.pickupAt) <= Date.now()
        )
          throw new HttpError(
            422,
            "INVALID_PICKUP",
            "Укажите будущее время в день начала аренды (Москва)",
          );
        const [saved] = await tx.query(
          "UPDATE rentals SET pickup_at=$2 WHERE id=$1 RETURNING id,pickup_at,version",
          [r.id, input.pickupAt],
        );
        await tx.query(
          "INSERT INTO audit_logs(actor_id,actor_role,action,entity_type,entity_id,reason,before_data,after_data) VALUES($1,$2,'rental.pickup','rental',$3,$4,$5,$6)",
          [
            staff.id,
            staff.role,
            r.id,
            input.reason,
            JSON.stringify(r),
            JSON.stringify(saved),
          ],
        );
        return saved;
      }),
    );
  }
  const statusAction = path.match(/^admin\/rentals\/([a-f0-9-]{36})\/status$/);
  if (request.method === "POST" && statusAction) {
    await manager();
    const input = await body(
      request,
      z.object({
        status: z.enum(["accepted", "in_progress", "completed", "cancelled"]),
        paymentStatus: z.enum(["paid", "unpaid", "partial", "refunded"]),
        expectedVersion: z.number().int().positive(),
        reason,
      }),
    );
    return json(
      await updateRentalStatus(
        {
          ...input,
          rentalId: statusAction[1],
          idempotencyKey: operationKey(request),
        },
        actor,
      ),
    );
  }
  const rentalAction = path.match(
    /^admin\/rentals\/([a-f0-9-]{36})\/(cancel|adjust)$/,
  );
  if (request.method === "POST" && rentalAction) {
    await manager();
    const input = await body(
      request,
      z.object({ reason, amountKopecks: amount.optional() }),
    );
    const common = {
      rentalId: rentalAction[1],
      reason: input.reason,
      idempotencyKey: operationKey(request),
    };
    if (rentalAction[2] === "cancel")
      return json(await cancelRental(common, actor));
    if (!input.amountKopecks)
      throw new HttpError(422, "AMOUNT_REQUIRED", "Укажите исправленную сумму");
    return json(
      await adjustRental(
        { ...common, amountKopecks: input.amountKopecks },
        actor,
      ),
    );
  }
  if (request.method === "POST" && path.startsWith("admin/bonus/")) {
    await manager();
    const action = path.split("/")[2];
    if (action === "reverse") {
      const input = await body(
        request,
        z.object({ transactionId: idSchema, reason }),
      );
      return json(
        await reverseTransaction(
          { ...input, idempotencyKey: operationKey(request) },
          actor,
        ),
      );
    }
    const input = await body(
      request,
      z.object({
        userId: idSchema,
        amount,
        reason,
        expiresAt: z.iso.datetime().optional(),
        externalRentalId: z.string().max(128).optional(),
        eligiblePriceKopecks: amount.optional(),
      }),
    );
    const common = { ...input, idempotencyKey: operationKey(request) };
    if (action === "credit") return json(await creditBonus(common, actor));
    if (action === "debit" || action === "redeem")
      return json(
        await debitBonus(
          {
            ...common,
            type: action === "redeem" ? "rental_payment" : "manual_debit",
          },
          actor,
        ),
      );
  }
  const memberAction = path.match(
    /^admin\/customers\/([a-f0-9-]{36})\/(tier|block|restore)$/,
  );
  if (request.method === "POST" && memberAction) {
    await admin();
    const input = await body(
      request,
      z.object({ reason, tier: tier.nullable().optional() }),
    );
    const userId = memberAction[1];
    if (memberAction[2] === "tier")
      return json(
        await changeTier(
          {
            userId,
            tier: input.tier ?? null,
            reason: input.reason,
            idempotencyKey: operationKey(request),
          },
          actor,
        ),
      );
    const blocked = memberAction[2] === "block";
    await transaction(async (tx) => {
      const [before] = await tx.query(
        "SELECT * FROM users WHERE id=$1 FOR UPDATE",
        [userId],
      );
      if (!before) return notFound();
      const [after] = await tx.query(
        "UPDATE users SET status=$2,updated_at=now() WHERE id=$1 RETURNING *",
        [userId, blocked ? "blocked" : "active"],
      );
      if (blocked)
        await tx.query(
          "UPDATE miniapp_sessions SET revoked_at=now() WHERE user_id=$1",
          [userId],
        );
      const [a] = await tx.query<{ account_version: string }>(
        "UPDATE loyalty_accounts SET account_version=account_version+1 WHERE user_id=$1 RETURNING account_version",
        [userId],
      );
      await tx.query(
        "INSERT INTO audit_logs(actor_id,actor_role,action,entity_type,entity_id,reason,before_data,after_data) VALUES($1,$2,$3,'user',$4,$5,$6,$7)",
        [
          staff.id,
          staff.role,
          blocked ? "member.block" : "member.restore",
          userId,
          input.reason,
          JSON.stringify(before),
          JSON.stringify(after),
        ],
      );
      await tx.query(
        "INSERT INTO outbox_events(event_key,event_type,user_id,aggregate_id,account_version,payload) VALUES($1,'MEMBER_STATUS_CHANGED',$2::uuid,$2::text,$3,'{}')",
        [
          `member-status:${userId}:${a.account_version}`,
          userId,
          a.account_version,
        ],
      );
    });
    return json({ ok: true });
  }
  if (request.method === "GET" && path === "admin/settings") {
    await admin();
    return json({
      program: await getProgram(),
      settings: await query("SELECT key,value FROM program_settings"),
      versions: await query(
        "SELECT id,version,effective_at FROM program_versions ORDER BY version DESC LIMIT 20",
      ),
    });
  }
  if (request.method === "POST" && path === "admin/program-versions") {
    await admin();
    const input = await body(
      request,
      z.object({
        rewardMode: z.enum(["cashback", "discount"]).default("cashback"),
        tiers: z
          .array(
            z.object({
              code: tier,
              thresholdKopecks: amount,
              rateBps: z.number().int().min(0).max(10000),
              displayName: z.string().trim().min(1).max(30).optional(),
              color: z
                .enum(["bronze", "silver", "gold", "diamond", "red", "black"])
                .optional(),
              benefits: z.array(z.string().max(300)).max(15),
            }),
          )
          .min(5)
          .max(6),
        redemptionLimitBps: z.number().int().min(0).max(10000),
        expiryDays: z.number().int().min(1).max(3650),
        referrerReward: amount,
        referredReward: amount,
        programStartsAt: z.iso.datetime(),
        reason,
      }),
    );
    return json(
      await publishProgram(
        { ...input, idempotencyKey: operationKey(request) },
        actor,
      ),
    );
  }
  if (request.method === "GET" && path === "admin/referrals") {
    const status = z
      .enum(["", "pending", "issued", "cancelled", "review"])
      .parse(url.searchParams.get("status") ?? "");
    const search = likePattern(
      (url.searchParams.get("q") ?? "").trim().slice(0, 200),
    );
    return json({
      items: await query(
        `SELECT r.*,a.name referrer_name,b.name referred_name,coalesce((SELECT jsonb_agg(w ORDER BY w.side) FROM referral_manual_awards w WHERE w.referral_id=r.id),'[]'::jsonb) awards,rr.car_name,rr.external_rental_id
           FROM referrals r JOIN users a ON a.id=r.referrer_id JOIN users b ON b.id=r.referred_id LEFT JOIN rentals rr ON rr.id=r.qualifying_rental_id
           WHERE (a.name ILIKE $2 OR b.name ILIKE $2 OR a.phone ILIKE $2 OR b.phone ILIKE $2 OR a.public_member_id ILIKE $2 OR b.public_member_id ILIKE $2)
           AND ($3='' OR EXISTS(SELECT 1 FROM referral_manual_awards w WHERE w.referral_id=r.id AND w.status=$3)) ORDER BY r.created_at DESC,r.id LIMIT 50 OFFSET $1`,
        [offset, search, status],
      ),
      page,
    });
  }
  if (request.method === "GET" && path === "admin/audit") {
    await admin();
    return json({
      items: await query(
        "SELECT l.*,m.name actor_name FROM audit_logs l LEFT JOIN admin_memberships m ON m.id::text=l.actor_id ORDER BY l.created_at DESC,l.id LIMIT 50 OFFSET $1",
        [offset],
      ),
      page,
    });
  }
  if (request.method === "GET" && path === "admin/deliveries") {
    await admin();
    return json({
      items: await query(
        "SELECT d.id,d.channel,d.status,d.attempts,d.next_attempt_at,d.last_error,d.created_at,u.name recipient_name,e.event_type FROM deliveries d JOIN outbox_events e ON e.id=d.event_id LEFT JOIN users u ON u.id=e.user_id WHERE d.channel='telegram' ORDER BY d.created_at DESC,d.id LIMIT 100",
      ),
      maintenance:
        (
          await query(
            "SELECT value FROM program_settings WHERE key='jobs:last-maintenance-success'",
          )
        )[0]?.value ?? null,
      errors: await query(
        "SELECT * FROM operational_errors WHERE resolved_at IS NULL AND kind NOT IN ('apple_certificate_expiry','apple_device_log') ORDER BY created_at DESC LIMIT 50",
      ),
    });
  }
  const retry = path.match(/^admin\/deliveries\/([a-f0-9-]{36})\/retry$/);
  if (request.method === "POST" && retry) {
    await admin();
    await transaction(async (tx) => {
      const [before] = await tx.query(
        "SELECT * FROM deliveries WHERE id=$1 AND channel='telegram' FOR UPDATE",
        [retry[1]],
      );
      if (!before) return notFound();
      if (!["dead", "retry"].includes(String(before.status)))
        throw new HttpError(
          409,
          "DELIVERY_STATE",
          "Задание сейчас нельзя повторить",
        );
      await tx.query(
        "UPDATE deliveries SET status='pending',attempts=0,next_attempt_at=now(),lease_until=NULL,lease_token=NULL WHERE id=$1",
        [retry[1]],
      );
      await tx.query(
        "INSERT INTO audit_logs(actor_id,actor_role,action,entity_type,entity_id,reason,before_data,after_data) VALUES($1,$2,'delivery.retry','delivery',$3,'Повтор доставки',$4,'{\"status\":\"pending\"}')",
        [staff.id, staff.role, retry[1], JSON.stringify(before)],
      );
    });
    return json({ ok: true });
  }
  if (request.method === "GET" && path === "admin/team") {
    await admin();
    return json({
      can_manage_staff: !!staff.can_manage_staff,
      items: await query(
        "SELECT m.id,m.auth_user_id,m.telegram_user_id,m.name,m.email,m.role,m.active,m.can_manage_staff,u.telegram_username,u.phone FROM admin_memberships m LEFT JOIN users u ON u.id=m.telegram_user_id ORDER BY m.name",
      ),
    });
  }
  if (request.method === "GET" && path === "admin/team/candidates") {
    await staffManager();
    await rateLimit("staff-search:" + staff.id, 20);
    let phone: string;
    try {
      phone = normalizePhone(
        "+" + phoneSearch((url.searchParams.get("phone") ?? "").slice(0, 40)),
      );
    } catch {
      throw new HttpError(
        422,
        "PHONE_INVALID",
        "Введите полный номер телефона, например 79210611842",
      );
    }
    return json({
      items: await query(
        `SELECT u.id,u.name,u.phone,u.telegram_username,m.active staff_active,m.role staff_role,m.can_manage_staff
       FROM users u LEFT JOIN admin_memberships m ON m.telegram_user_id=u.id
       WHERE u.phone=$1 AND u.status='active' AND u.telegram_id IS NOT NULL LIMIT 5`,
        [phone],
      ),
    });
  }
  if (request.method === "POST" && path === "admin/team/telegram") {
    await staffManager();
    const input = await body(
      request,
      z.object({ userId: idSchema, active: z.boolean() }).strict(),
    );
    await transaction(async (tx) => {
      await lockStaffManager(tx, staff.id);
      const [before] = await tx.query(
        "SELECT * FROM admin_memberships WHERE telegram_user_id=$1 FOR UPDATE",
        [input.userId],
      );
      if (before?.can_manage_staff || before?.id === staff.id)
        throw new HttpError(
          409,
          "OWNER_ACCESS",
          "Доступ владельца нельзя изменить здесь",
        );
      const [user] = await tx.query<{
        id: string;
        name: string;
        status: string;
        telegram_id: string | null;
        phone: string | null;
      }>(
        "SELECT id,name,status,telegram_id,phone FROM users WHERE id=$1 FOR UPDATE",
        [input.userId],
      );
      if (!user)
        throw new HttpError(
          404,
          "USER_NOT_FOUND",
          "Пользователь не найден. Сначала он должен зарегистрироваться в боте.",
        );
      if (
        input.active &&
        (user.status !== "active" || !user.telegram_id || !user.phone)
      )
        throw new HttpError(
          409,
          "USER_NOT_ELIGIBLE",
          "Пользователь должен завершить регистрацию в боте и иметь активный аккаунт",
        );
      if (!input.active && !before)
        throw new HttpError(
          404,
          "STAFF_NOT_FOUND",
          "Доступ этому пользователю ещё не назначен",
        );
      const [after] = await tx.query(
        `INSERT INTO admin_memberships(telegram_user_id,name,role,active) VALUES($1,$2,'admin',$3)
         ON CONFLICT(telegram_user_id) DO UPDATE SET name=excluded.name,role=CASE WHEN excluded.active THEN excluded.role ELSE admin_memberships.role END,active=excluded.active RETURNING *`,
        [user.id, user.name, input.active],
      );
      if (
        before &&
        (before.active !== input.active || before.role !== "admin")
      ) {
        await tx.query(
          "UPDATE staff_sessions SET revoked_at=now() WHERE membership_id=$1 AND revoked_at IS NULL",
          [before.id],
        );
        await tx.query(
          "DELETE FROM staff_bot_login_links WHERE membership_id=$1",
          [before.id],
        );
      }
      await tx.query(
        "INSERT INTO audit_logs(actor_id,actor_role,action,entity_type,entity_id,reason,before_data,after_data) VALUES($1,'admin','staff.telegram_update','staff',$2,$3,$4,$5)",
        [
          staff.id,
          after.id,
          input.active
            ? "Назначение администратора владельцем"
            : "Отключение администратора владельцем",
          JSON.stringify(before ?? null),
          JSON.stringify(after),
        ],
      );
    });
    return json({ ok: true });
  }
  if (request.method === "POST" && path === "admin/team") {
    await staffManager();
    const input = await body(
      request,
      z.object({
        authUserId: idSchema,
        name: z.string().min(1).max(200),
        email: z.string().email(),
        role: z.enum(["admin", "manager", "viewer"]),
        active: z.boolean(),
        reason,
      }),
    );
    await transaction(async (tx) => {
      await lockStaffManager(tx, staff.id);
      const [before] = await tx.query(
        "SELECT * FROM admin_memberships WHERE auth_user_id=$1 FOR UPDATE",
        [input.authUserId],
      );
      if (before?.can_manage_staff && (!input.active || input.role !== "admin"))
        throw new HttpError(
          409,
          "OWNER_ACCESS",
          "Доступ владельца нельзя изменить здесь",
        );
      if (before?.id === staff.id && (!input.active || input.role !== "admin"))
        throw new HttpError(
          409,
          "OWN_ACCESS",
          "Нельзя отозвать собственный административный доступ",
        );
      const [after] = await tx.query(
        "INSERT INTO admin_memberships(auth_user_id,name,email,role,active) VALUES($1,$2,$3,$4,$5) ON CONFLICT(auth_user_id) DO UPDATE SET name=$2,email=$3,role=$4,active=$5 RETURNING *",
        [input.authUserId, input.name, input.email, input.role, input.active],
      );
      if (
        before &&
        (before.role !== input.role || before.active !== input.active)
      ) {
        await tx.query(
          "UPDATE staff_sessions SET revoked_at=now() WHERE membership_id=$1 AND revoked_at IS NULL",
          [before.id],
        );
        await tx.query(
          "DELETE FROM staff_bot_login_links WHERE membership_id=$1",
          [before.id],
        );
      }
      await tx.query(
        "INSERT INTO audit_logs(actor_id,actor_role,action,entity_type,entity_id,reason,before_data,after_data) VALUES($1,$2,'staff.update','staff',$3,$4,$5,$6)",
        [
          staff.id,
          staff.role,
          String(after.id),
          input.reason,
          JSON.stringify(before ?? null),
          JSON.stringify(after),
        ],
      );
    });
    return json({ ok: true });
  }
  if (request.method === "GET" && path === "admin/tiers")
    return json(await getProgram());
  return null;
}

export const allowedTier = (value: string) =>
  TIER_CODES.includes(value as (typeof TIER_CODES)[number]);
