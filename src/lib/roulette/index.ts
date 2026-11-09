import { createHash, randomInt, randomUUID } from "node:crypto";
import { z } from "zod";
import { query, transaction, type Db } from "@/lib/db";
import { requireSession, requireStaff, rateLimit } from "@/lib/auth/session";
import {
  body,
  HttpError,
  json,
  notFound,
  operationKey,
  requireOrigin,
} from "@/lib/http";
import {
  getAccountSnapshot,
  getAccountSnapshotInTransaction,
  TIER_CODES,
} from "@/lib/loyalty";
import { moscowDate } from "@/lib/club/contracts";
import { creditBalance, nextCredit, issueManualCredit, reconcileRegistrationCredits } from "./credits";
import { roulettePromoRoute } from "./promos";
import { effectiveOdds, validateShares } from "./odds";
import { bulkCreditInput, issueBulkCredits, previewBulkCredits } from "./bulk-credits";

export type Prize = {
  id: string;
  code: string;
  title: string;
  summary: string;
  terms: string;
  image_url: string;
  image_alt: string;
  effect_type:
    "percent" | "fixed" | "free_day" | "wash" | "upgrade" | "bonus" | "info";
  effect_value: number;
  weight: number;
  minimum_tier: string | null;
  car_ids: string[];
  min_days: number;
  max_days: number;
  min_total_kopecks: string;
  starts_at: string | null;
  ends_at: string | null;
  issue_cap: number | null;
  issued_count: number;
  active: boolean;
  archived_at: string | null;
  sort_order: number;
  version: number;
};
export type Award = {
  id: string;
  user_id: string;
  status: string;
  claim_code: string;
  issued_at: string;
  expires_at: string;
  redeemed_at: string | null;
  redeemed_by: string | null;
  reserved_request_id: string | null;
  prize_snapshot: Prize;
};
type Settings = {
  enabled: boolean;
  approved: boolean;
  daily_attempts: number;
  registration_attempts: number;
  registration_enabled_at: string | null;
  attempt_ttl_days: number;
  award_ttl_days: number;
  version: number;
};

const prizeSchema = z
  .object({
    title: z.string().trim().min(2).max(100),
    summary: z.string().trim().min(1).max(220),
    terms: z.string().trim().min(1).max(10000),
    image_url: z.union([
      z.literal(""),
      z.string().regex(/^\/api\/media\/[a-f0-9-]{36}\.webp$/),
    ]),
    image_alt: z.union([z.literal(""), z.string().trim().min(2).max(160)]),
    effect_type: z.enum([
      "percent",
      "fixed",
      "free_day",
      "wash",
      "upgrade",
      "bonus",
      "info",
    ]),
    effect_value: z.number().int().min(0).max(1_000_000_000),
    minimum_tier: z.string().nullable().default(null),
    car_ids: z.array(z.string().uuid()).max(200).default([]),
    min_days: z.number().int().min(1).max(90).default(1),
    max_days: z.number().int().min(1).max(90).default(90),
    min_total_kopecks: z
      .string()
      .regex(/^\d{1,15}$/)
      .default("0"),
    starts_at: z.iso.datetime({ offset: true }).nullable().default(null),
    ends_at: z.iso.datetime({ offset: true }).nullable().default(null),
    issue_cap: z.number().int().positive().nullable().default(null),
    active: z.boolean().default(false),
    sort_order: z.number().int().min(-100000).max(100000).default(0),
    expected_version: z.number().int().positive().optional(),
  })
  .superRefine((p, ctx) => {
    if (
      p.min_days > p.max_days ||
      (p.starts_at && p.ends_at && p.starts_at >= p.ends_at)
    )
      ctx.addIssue({ code: "custom", message: "Проверьте период доступности" });
    if (
      p.effect_type === "percent" &&
      (p.effect_value < 1 || p.effect_value > 9999)
    )
      ctx.addIssue({
        code: "custom",
        message: "Процент должен быть от 0,01 до 99,99%",
      });
    if (
      ["fixed", "free_day", "bonus"].includes(p.effect_type) &&
      p.effect_value < 1
    )
      ctx.addIssue({ code: "custom", message: "Укажите значение награды" });
    if (
      ["wash", "upgrade", "info"].includes(p.effect_type) &&
      p.effect_value !== 0
    )
      ctx.addIssue({
        code: "custom",
        message: "Для этого типа значение должно быть нулём",
      });
  });

function publicPrize(p: Prize) {
  const {
    id,
    code,
    title,
    summary,
    terms,
    image_url,
    image_alt,
    effect_type,
    effect_value,
    minimum_tier,
    car_ids,
    min_days,
    max_days,
    min_total_kopecks,
    version,
  } = p;
  return {
    id,
    code,
    title,
    summary,
    terms,
    image_url,
    image_alt,
    effect_type,
    effect_value,
    minimum_tier,
    car_ids,
    min_days,
    max_days,
    min_total_kopecks,
    version,
  };
}
export function nextReset(periodKey = moscowDate()) {
  return new Date(periodKey + "T21:00:00.000Z").toISOString();
}
async function availablePrizes(db: Db, tier: string, lock = false) {
  const allowed = TIER_CODES.slice(
    0,
    TIER_CODES.indexOf(tier as (typeof TIER_CODES)[number]) + 1,
  );
  return db.query<Prize>(
    `SELECT * FROM roulette_prizes WHERE active AND archived_at IS NULL
    AND (starts_at IS NULL OR starts_at<=now()) AND (ends_at IS NULL OR ends_at>now())
    AND (issue_cap IS NULL OR issued_count<issue_cap)
    AND (minimum_tier IS NULL OR minimum_tier=ANY($1::text[]))
    ORDER BY id LIMIT 200 ${lock ? "FOR UPDATE" : ""}`,
    [allowed],
  );
}
async function settings(db: Db, lock = false) {
  const [row] = await db.query<Settings>(
    `SELECT * FROM roulette_settings WHERE id=true ${lock ? "FOR SHARE" : ""}`,
  );
  return row;
}
export async function rouletteRoute(
  request: Request,
  path: string,
): Promise<Response | null> {
  const promoResponse = await roulettePromoRoute(request, path);
  if (promoResponse) return promoResponse;
  if (path === "me/roulette" && request.method === "GET") {
    const session = await requireSession(request);
    await rateLimit("client:" + session.user_id, 120);
    await reconcileRegistrationCredits(200);
    const periodKey = moscowDate();
    const config = await settings({ query });
    const account = await getAccountSnapshot(session.user_id!);
    const [prizes, awards, grants] = await Promise.all([
      availablePrizes({ query }, account.tier),
      query<Award>(
        "SELECT *,CASE WHEN status='available' AND expires_at<=now() THEN 'expired' ELSE status END AS status FROM roulette_awards WHERE user_id=$1 ORDER BY issued_at DESC LIMIT 100",
        [session.user_id],
      ),
      creditBalance({ query }, session.user_id!),
    ]);
    return json({
      enabled:
        config.enabled &&
        config.approved &&
        process.env.ROULETTE_ECONOMICS_APPROVED === "1",
      attempts: grants,
      credits: await query("SELECT id,source_type,granted,consumed,expires_at,reason FROM roulette_attempt_credits WHERE user_id=$1 AND expires_at>now() AND consumed<granted ORDER BY expires_at,id LIMIT 30", [session.user_id]),
      nextResetAt: nextReset(periodKey),
      prizes: prizes.map(publicPrize),
      awards,
    });
  }
  if (path === "me/roulette/awards" && request.method === "GET") {
    const session = await requireSession(request);
    await rateLimit("client:" + session.user_id, 120);
    return json({
      items: await query<Award>(
        "SELECT *,CASE WHEN status='available' AND expires_at<=now() THEN 'expired' ELSE status END AS status FROM roulette_awards WHERE user_id=$1 ORDER BY issued_at DESC LIMIT 100",
        [session.user_id],
      ),
    });
  }
  if (path === "me/roulette/spins" && request.method === "POST") {
    requireOrigin(request);
    const session = await requireSession(request);
    await rateLimit("roulette:" + session.user_id, 20);
    const key = z.string().uuid().parse(operationKey(request));
    let result;
    try { result = await transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "spin:" + session.user_id,
      ]);
      const [old] = await tx.query<{ id: string; prize_snapshot: Prize }>(
        "SELECT id,prize_snapshot FROM roulette_spins WHERE user_id=$1 AND idempotency_key=$2",
        [session.user_id, key],
      );
      if (old) {
        const [award] = await tx.query<Award>(
          "SELECT * FROM roulette_awards WHERE spin_id=$1",
          [old.id],
        );
        return {
          spinId: old.id,
          prize: old.prize_snapshot,
          award,
          attempts: await creditBalance(tx, session.user_id!),
        };
      }
      const config = await settings(tx, true);
      if (
        !config.enabled ||
        !config.approved ||
        process.env.ROULETTE_ECONOMICS_APPROVED !== "1"
      )
        throw new HttpError(
          409,
          "ROULETTE_DISABLED",
          "Розыгрыш пока недоступен",
        );
      const [member] = await tx.query<{ status: string }>(
        "SELECT status FROM users WHERE id=$1 FOR SHARE",
        [session.user_id],
      );
      if (member?.status !== "active")
        throw new HttpError(
          403,
          "MEMBER_INACTIVE",
          "Участие в клубе недоступно",
        );
      const account = await getAccountSnapshotInTransaction(
        tx,
        session.user_id!,
      );
      const grant = await nextCredit(tx, session.user_id!);
      if (!grant)
        throw new HttpError(409, "NO_ATTEMPTS", "Попыток больше нет");
      const prizes = await availablePrizes(tx, account.tier, true);
      if (!prizes.length)
        throw new HttpError(409, "NO_PRIZES", "Сейчас нет доступных призов");
      const total = prizes.reduce((sum, p) => sum + p.weight, 0);
      const ticket = randomInt(total);
      let remaining = ticket;
      const prize = prizes.find((p) => (remaining -= p.weight) < 0)!;
      const snapshot = publicPrize(prize);
      await tx.query(
        "UPDATE roulette_prizes SET issued_count=issued_count+1 WHERE id=$1",
        [prize.id],
      );
      await tx.query(`UPDATE ${grant.kind === "credit" ? "roulette_attempt_credits" : "roulette_attempt_grants"} SET consumed=consumed+1 WHERE id=$1`, [grant.id]);
      const [spin] = await tx.query<{ id: string }>(
        "INSERT INTO roulette_spins(user_id,idempotency_key,config_version,prize_id,prize_snapshot,attempt_grant_id,attempt_credit_id,pool_snapshot,random_ticket,random_total) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id",
        [
          session.user_id,
          key,
          config.version,
          prize.id,
          JSON.stringify(snapshot),
          grant.kind === "legacy" ? grant.id : null,
          grant.kind === "credit" ? grant.id : null,
          JSON.stringify(prizes.map((p) => ({ id: p.id, weight: p.weight }))),
          ticket,
          total,
        ],
      );
      let award: Award | undefined;
      for (let attempt = 0; attempt < 3 && !award; attempt++) {
        [award] = await tx.query<Award>(
          "INSERT INTO roulette_awards(spin_id,user_id,prize_snapshot,expires_at) VALUES($1,$2,$3,now()+$4*interval '1 day') ON CONFLICT (claim_code) DO NOTHING RETURNING *",
          [spin.id, session.user_id, JSON.stringify(snapshot), config.award_ttl_days],
        );
      }
      if (!award) throw new Error("Could not assign a unique prize code");
      await tx.query(
        "INSERT INTO audit_logs(actor_id,actor_role,action,entity_type,entity_id,reason,after_data) VALUES($1,'system','roulette.award.issue','roulette_award',$2,'Выигрыш в рулетке',$3)",
        [session.user_id, award.id, JSON.stringify({ spinId: spin.id, claimCode: award.claim_code })],
      );
      return {
        spinId: spin.id,
        prize: snapshot,
        award,
        attempts: await creditBalance(tx, session.user_id!),
      };
    }); } catch (error) {
      if (error instanceof HttpError && ["NO_ATTEMPTS", "NO_PRIZES", "ROULETTE_DISABLED"].includes(error.code))
        await query("INSERT INTO roulette_spin_denials(user_id,reason) VALUES($1,$2)", [session.user_id, error.code]).catch(() => console.error("Roulette denial audit write failed"));
      throw error;
    }
    return json(result, 201);
  }
  if (!path.startsWith("admin/roulette")) return null;
  const staff = await requireStaff(
    request,
    request.method === "GET" ? "viewer" : "manager",
  );
  if (request.method !== "GET") {
    requireOrigin(request);
    await rateLimit("staff-roulette:" + staff.id, 30);
  }
  if (path === "admin/roulette/odds") {
    if (request.method === "GET") {
      const items = await query<Prize>("SELECT * FROM roulette_prizes WHERE active AND archived_at IS NULL ORDER BY sort_order,id");
      return json({ items, byTier: Object.fromEntries(TIER_CODES.map((tier) => [tier, effectiveOdds(items, tier)])) });
    }
    if (request.method === "PATCH") {
      await requireStaff(request, "admin");
      const input = await body(request, z.object({ shares: z.array(z.object({ id: z.string().uuid(), basisPoints: z.number().int().min(1).max(10000) })).min(1).max(200), expectedVersion: z.number().int().positive() }));
      return transaction(async (tx) => {
        const [before] = await tx.query<Settings>("SELECT * FROM roulette_settings WHERE id=true FOR UPDATE");
        if (before.version !== input.expectedVersion) throw new HttpError(409, "VERSION_CONFLICT", "Шансы изменились. Обновите страницу");
        const items = await tx.query<Prize>("SELECT * FROM roulette_prizes WHERE active AND archived_at IS NULL ORDER BY id FOR UPDATE");
        if (!validateShares(input.shares, items.map((p) => p.id))) throw new HttpError(422, "ODDS_TOTAL", "Укажите шанс для каждого опубликованного приза. Сумма должна быть 100%");
        for (const share of input.shares)
          await tx.query("UPDATE roulette_prizes SET weight=$2,version=version+1,updated_by=$3,updated_at=now() WHERE id=$1", [share.id, share.basisPoints, staff.id]);
        const [changed] = await tx.query<Settings>("UPDATE roulette_settings SET version=version+1,updated_by=$1,updated_at=now() WHERE id=true RETURNING *", [staff.id]);
        await tx.query("INSERT INTO audit_logs(actor_id,actor_role,action,entity_type,entity_id,reason,before_data,after_data) VALUES($1,$2,'roulette.odds','roulette','settings','Изменение шансов',$3,$4)", [staff.id, staff.role, JSON.stringify(items.map((p) => ({ id: p.id, weight: p.weight }))), JSON.stringify(input.shares)]);
        return json({ version: changed.version });
      });
    }
  }
  if (path === "admin/roulette/credits" && request.method === "POST") {
    await requireStaff(request, "admin");
    const input = await body(request, z.object({ userId: z.string().uuid(), amount: z.number().int().min(1).max(100), reason: z.string().trim().min(10).max(500) }));
    return json(await issueManualCredit({ ...input, key: operationKey(request) }, staff.id), 201);
  }
  if (path === "admin/roulette/credits/bulk/preview" && request.method === "GET") {
    await requireStaff(request, "admin");
    const params = new URL(request.url).searchParams;
    const mode = z.enum(["all", "tiers"]).parse(params.get("mode"));
    const amount = mode === "all" ? z.coerce.number().int().min(1).max(100).parse(params.get("amount")) : 0;
    let rawAmounts: unknown = {};
    if (mode === "tiers") {
      try { rawAmounts = JSON.parse(params.get("amounts") ?? "{}"); }
      catch { throw new HttpError(422, "INVALID_AMOUNTS", "Проверьте число попыток по уровням"); }
    }
    const amounts = z.partialRecord(z.enum(TIER_CODES), z.number().int().min(0).max(100)).parse(rawAmounts);
    return json(await previewBulkCredits(mode, amount, amounts));
  }
  if (path === "admin/roulette/credits/bulk" && request.method === "POST") {
    await requireStaff(request, "admin");
    const input = await body(request, bulkCreditInput);
    return json(await issueBulkCredits(input, staff.id, operationKey(request)), 201);
  }
  if (path === "admin/roulette/credits/bulk" && request.method === "GET") {
    await requireStaff(request, "admin");
    return json({ items: await query("SELECT entity_id batch_id,actor_id,reason,after_data result,created_at FROM audit_logs WHERE action='roulette.credit.bulk' ORDER BY created_at DESC LIMIT 30") });
  }
  if (path === "admin/roulette/credits" && request.method === "GET")
    return json({ items: await query("SELECT id,user_id,source_type,granted,consumed,expires_at,reason,actor_id,created_at FROM roulette_attempt_credits ORDER BY created_at DESC LIMIT 100") });
  if (path === "admin/roulette/settings") {
    if (request.method === "GET") return json({ ...(await settings({ query })), serverApproved: process.env.ROULETTE_ECONOMICS_APPROVED === "1" });
    if (request.method === "PATCH") {
      await requireStaff(request, "admin");
      const input = await body(
        request,
        z.object({
          enabled: z.boolean(),
          approved: z.boolean(),
          registration_attempts: z.number().int().min(0).max(100),
          attempt_ttl_days: z.number().int().min(1).max(365),
          award_ttl_days: z.number().int().min(0).max(365),
          expected_version: z.number().int().positive(),
        }),
      );
      const key = operationKey(request);
      const payloadHash = createHash("sha256")
        .update(JSON.stringify(input))
        .digest("hex");
      if (
        input.enabled &&
        (!input.approved || !input.award_ttl_days || process.env.ROULETTE_ECONOMICS_APPROVED !== "1")
      )
        throw new HttpError(
          422,
          "ROULETTE_SETTINGS",
          "Для запуска нужны утверждённые правила, срок награды и разрешение сервера",
        );
      return transaction(async (tx) => {
        const [before] = await tx.query<Settings>(
          "SELECT * FROM roulette_settings WHERE id=true FOR UPDATE",
        );
        const [replay] = await tx.query<{
          payload_hash: string;
          result: Settings;
        }>(
          "SELECT payload_hash,result FROM idempotency_requests WHERE scope=$1 AND key=$2",
          ["roulette-settings:" + staff.id, key],
        );
        if (replay) {
          if (replay.payload_hash !== payloadHash)
            throw new HttpError(
              409,
              "IDEMPOTENCY_CONFLICT",
              "Ключ уже использован для других настроек",
            );
          return json(replay.result);
        }
        if (before.version !== input.expected_version)
          throw new HttpError(409, "VERSION_CONFLICT", "Настройки изменились");
        if (input.enabled) {
          for (const tier of TIER_CODES)
            if (!(await availablePrizes(tx, tier)).length)
              throw new HttpError(422, "NO_PRIZES", `Для уровня ${tier} нет доступных призов`);
        }
        const [changed] = await tx.query<Settings>(
          "UPDATE roulette_settings SET enabled=$1,approved=$2,daily_attempts=0,registration_attempts=$3,registration_enabled_at=CASE WHEN $3>0 AND registration_attempts=0 THEN now() WHEN $3=0 THEN NULL ELSE registration_enabled_at END,attempt_ttl_days=$4,award_ttl_days=$5,version=version+1,updated_by=$6,updated_at=now() WHERE id=true RETURNING *",
          [
            input.enabled,
            input.approved,
            input.registration_attempts,
            input.attempt_ttl_days,
            input.award_ttl_days,
            staff.id,
          ],
        );
        await tx.query(
          "INSERT INTO audit_logs(actor_id,actor_role,action,entity_type,entity_id,reason,before_data,after_data) VALUES($1,$2,'roulette.settings','roulette','settings','Настройка розыгрыша',$3,$4)",
          [
            staff.id,
            staff.role,
            JSON.stringify(before),
            JSON.stringify(changed),
          ],
        );
        await tx.query(
          "INSERT INTO idempotency_requests(scope,key,payload_hash,result) VALUES($1,$2,$3,$4)",
          [
            "roulette-settings:" + staff.id,
            key,
            payloadHash,
            JSON.stringify(changed),
          ],
        );
        return json(changed);
      });
    }
  }
  if (path === "admin/roulette/spins" && request.method === "GET")
    return json({
      items: await query(
        "SELECT s.id,s.user_id,s.created_at,s.prize_snapshot,s.pool_snapshot,s.random_ticket,s.random_total,c.source_type,CASE WHEN a.status='available' AND a.expires_at<=now() THEN 'expired' ELSE a.status END AS status,a.reserved_request_id FROM roulette_spins s JOIN roulette_awards a ON a.spin_id=s.id LEFT JOIN roulette_attempt_credits c ON c.id=s.attempt_credit_id ORDER BY s.created_at DESC LIMIT 100",
      ),
      denials: await query("SELECT user_id,reason,created_at FROM roulette_spin_denials ORDER BY created_at DESC LIMIT 100"),
    });
  if (path === "admin/roulette/awards" && request.method === "GET") {
    const params = new URL(request.url).searchParams;
    const userId = z.string().uuid().optional().parse(params.get("userId") || undefined);
    const search = z.string().trim().max(80).parse(params.get("q") ?? "");
    const status = z.enum(["available", "reserved", "redeemed", "expired", "active", "archive"]).optional().parse(params.get("status") || undefined);
    const from = z.iso.date().optional().parse(params.get("from") || undefined);
    const to = z.iso.date().optional().parse(params.get("to") || undefined);
    const page = z.coerce.number().int().min(1).max(10000).parse(params.get("page") ?? "1");
    const rows = await query<Award & { user_name: string; public_member_id: string; redeemed_by_name: string | null; effective_status: string }>(
      `SELECT a.*,u.name user_name,u.public_member_id,m.name redeemed_by_name,
        CASE WHEN a.status='available' AND a.expires_at<=now() THEN 'expired' ELSE a.status END effective_status
       FROM roulette_awards a JOIN users u ON u.id=a.user_id LEFT JOIN admin_memberships m ON m.id=a.redeemed_by
       WHERE ($1::uuid IS NULL OR a.user_id=$1)
         AND ($2='' OR u.name ILIKE '%'||$2||'%' OR u.public_member_id ILIKE '%'||$2||'%' OR a.user_id::text ILIKE '%'||$2||'%' OR a.claim_code ILIKE '%'||$2||'%')
         AND ($3::text IS NULL OR CASE WHEN a.status='available' AND a.expires_at<=now() THEN 'expired' ELSE a.status END=$3 OR ($3='active' AND a.status IN ('available','reserved') AND a.expires_at>now()) OR ($3='archive' AND (a.status IN ('redeemed','expired') OR (a.status='available' AND a.expires_at<=now()))))
         AND ($4::date IS NULL OR a.issued_at >= ($4::date AT TIME ZONE 'Europe/Moscow'))
         AND ($5::date IS NULL OR a.issued_at < (($5::date+1) AT TIME ZONE 'Europe/Moscow'))
       ORDER BY a.issued_at DESC,a.id DESC LIMIT 51 OFFSET $6`,
      [userId ?? null, search, status ?? null, from ?? null, to ?? null, (page - 1) * 50],
    );
    return json({ items: rows.slice(0, 50), page, hasMore: rows.length > 50 });
  }
  const redeemAward = path.match(/^admin\/roulette\/awards\/([a-f0-9-]{36})\/redeem$/);
  if (redeemAward && request.method === "POST") {
    return json(await transaction(async (tx) => {
      const [award] = await tx.query<Award>(
        "SELECT * FROM roulette_awards WHERE id=$1 FOR UPDATE",
        [redeemAward[1]],
      );
      if (!award) notFound();
      if (award.status !== "available")
        throw new HttpError(409, "AWARD_UNAVAILABLE", "Приз уже использован или срок его действия истёк");
      const [changed] = await tx.query<Award>(
        "UPDATE roulette_awards SET status='redeemed',redeemed_at=now(),redeemed_by=$2 WHERE id=$1 AND status='available' AND expires_at>now() RETURNING *",
        [award.id, staff.id],
      );
      if (!changed) throw new HttpError(409, "AWARD_UNAVAILABLE", "Срок действия приза истёк");
      await tx.query(
        "INSERT INTO audit_logs(actor_id,actor_role,action,entity_type,entity_id,reason,before_data,after_data) VALUES($1,$2,'roulette.award.redeem','roulette_award',$3,'Активация в офисе или через менеджера',$4,$5)",
        [staff.id, staff.role, award.id, JSON.stringify({ status: award.status }), JSON.stringify({ status: changed.status, userId: award.user_id })],
      );
      return changed;
    }));
  }
  if (path === "admin/roulette/prizes") {
    if (request.method === "GET")
      return json({
        items: await query(
          "SELECT * FROM roulette_prizes ORDER BY archived_at NULLS FIRST,sort_order,id LIMIT 200",
        ),
      });
    if (request.method === "POST")
      return savePrize(request, staff.id, staff.role);
  }
  const match = path.match(/^admin\/roulette\/prizes\/([a-f0-9-]{36})$/);
  if (match && request.method === "PATCH")
    return savePrize(request, staff.id, staff.role, match[1]);
  if (match && request.method === "DELETE") {
    const input = await body(
      request,
      z.object({ expected_version: z.number().int().positive() }),
    );
    return transaction(async (tx) => {
      await tx.query(
        "UPDATE roulette_settings SET version=version+1 WHERE id=true",
      );
      const [before] = await tx.query<Prize>(
        "SELECT * FROM roulette_prizes WHERE id=$1 FOR UPDATE",
        [match[1]],
      );
      if (
        !before ||
        before.version !== input.expected_version ||
        before.archived_at
      )
        throw new HttpError(
          409,
          "VERSION_CONFLICT",
          "Приз изменился или уже архивирован",
        );
      const [changed] = await tx.query(
        "UPDATE roulette_prizes SET active=false,archived_at=now(),version=version+1,updated_by=$2,updated_at=now() WHERE id=$1 RETURNING *",
        [match[1], staff.id],
      );
      await tx.query(
        "INSERT INTO audit_logs(actor_id,actor_role,action,entity_type,entity_id,reason,before_data,after_data) VALUES($1,$2,'roulette.prize.archive','roulette_prize',$3,'Архивирование',$4,$5)",
        [
          staff.id,
          staff.role,
          match[1],
          JSON.stringify(before),
          JSON.stringify(changed),
        ],
      );
      return json(changed);
    });
  }
  return null;
}

async function savePrize(
  request: Request,
  actorId: string,
  role: string,
  id?: string,
) {
  const input = await body(request, prizeSchema);
  const key = id ? null : operationKey(request);
  const payloadHash = createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex");
  if (
    input.minimum_tier &&
    !TIER_CODES.includes(input.minimum_tier as (typeof TIER_CODES)[number])
  )
    throw new HttpError(422, "PRIZE_TIER", "Неизвестный уровень");
  if (input.active && !input.image_url)
    throw new HttpError(422, "PRIZE_IMAGE", "Загрузите фото");
  if (input.active && !input.image_alt)
    throw new HttpError(422, "PRIZE_IMAGE_ALT", "Добавьте описание фото");
  if (input.active && input.effect_type === "bonus")
    throw new HttpError(
      422,
      "PRIZE_EFFECT",
      "Начисление RPM Bonus для рулетки пока недоступно",
    );
  if (input.car_ids.length) {
    const cars = await query<{ id: string }>(
      "SELECT id FROM club_content WHERE id=ANY($1::uuid[]) AND kind='car' AND active",
      [input.car_ids],
    );
    if (cars.length !== new Set(input.car_ids).size)
      throw new HttpError(
        422,
        "PRIZE_CARS",
        "Укажите опубликованные автомобили",
      );
  }
  return transaction(async (tx) => {
    await tx.query("SELECT id FROM roulette_settings WHERE id=true FOR UPDATE");
    if (key) {
      const [replay] = await tx.query<{ payload_hash: string; result: Prize }>(
        "SELECT payload_hash,result FROM idempotency_requests WHERE scope=$1 AND key=$2",
        ["roulette-prize:" + actorId, key],
      );
      if (replay) {
        if (replay.payload_hash !== payloadHash)
          throw new HttpError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "Ключ уже использован для другого приза",
          );
        return json(replay.result);
      }
    }
    const [before] = id
      ? await tx.query<Prize>(
          "SELECT * FROM roulette_prizes WHERE id=$1 FOR UPDATE",
          [id],
        )
      : [];
    if (id && (!before || before.archived_at)) return notFound();
    if (id && before.version !== input.expected_version)
      throw new HttpError(409, "VERSION_CONFLICT", "Приз изменился");
    await tx.query(
      "UPDATE roulette_settings SET version=version+1 WHERE id=true",
    );
    const values = [
      before?.code ?? `prize-${randomUUID().replaceAll("-", "")}`,
      input.title,
      input.summary,
      input.terms,
      input.image_url,
      input.image_alt,
      input.effect_type,
      input.effect_value,
      before?.weight ?? 1,
      input.minimum_tier,
      input.car_ids,
      input.min_days,
      input.max_days,
      input.min_total_kopecks,
      input.starts_at,
      input.ends_at,
      input.issue_cap,
      input.active,
      input.sort_order,
      actorId,
    ];
    const [row] = await tx.query<Prize>(
      id
        ? `UPDATE roulette_prizes SET code=$1,title=$2,summary=$3,terms=$4,image_url=$5,image_alt=$6,effect_type=$7,effect_value=$8,weight=$9,minimum_tier=$10,car_ids=$11,min_days=$12,max_days=$13,min_total_kopecks=$14,starts_at=$15,ends_at=$16,issue_cap=$17,active=$18,sort_order=$19,updated_by=$20,updated_at=now(),version=version+1 WHERE id=$21 RETURNING *`
        : `INSERT INTO roulette_prizes(code,title,summary,terms,image_url,image_alt,effect_type,effect_value,weight,minimum_tier,car_ids,min_days,max_days,min_total_kopecks,starts_at,ends_at,issue_cap,active,sort_order,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$20) RETURNING *`,
      id ? [...values, id] : values,
    );
    if (key)
      await tx.query(
        "INSERT INTO idempotency_requests(scope,key,payload_hash,result) VALUES($1,$2,$3,$4)",
        ["roulette-prize:" + actorId, key, payloadHash, JSON.stringify(row)],
      );
    await tx.query(
      "INSERT INTO audit_logs(actor_id,actor_role,action,entity_type,entity_id,reason,before_data,after_data) VALUES($1,$2,$3,'roulette_prize',$4,'Изменение карточки',$5,$6)",
      [
        actorId,
        role,
        id ? "roulette.prize.update" : "roulette.prize.create",
        row.id,
        before ? JSON.stringify(before) : null,
        JSON.stringify(row),
      ],
    );
    return json(row);
  });
}
