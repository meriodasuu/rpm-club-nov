import { z } from "zod";
import { createHash } from "node:crypto";
import {
  rentalAwardOption,
  rentalAwardSelectionSchema,
  rentalQuoteWithAwards,
  rentalTotalDiscountKopecks,
  transitionAward,
} from "@/lib/roulette/quote";
import { query, transaction, type Db } from "@/lib/db";
import { requireSession, requireStaff, rateLimit } from "@/lib/auth/session";
import { assertCatalogBookable } from "@/lib/club/catalog";
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
  createRequestedRental,
} from "@/lib/loyalty";
import { TIER_CODES, type TierCode } from "@/lib/loyalty/rules";
import {
  contentSchema,
  contentKinds,
  moscowDate,
  rentalDays,
  rentalQuote,
  triggerSchema,
  type ClubContent,
  type RentalRequest,
} from "@/lib/club/contracts";

const requestInput = z.object({
  carId: z.string().uuid(),
  startDate: z.string(),
  endDate: z.string(),
  comment: z.string().trim().max(1000).default(""),
  expectedTotal: z
    .string()
    .regex(/^\d{1,15}$/)
    .optional(),
  expectedCarVersion: z.number().int().positive().optional(),
  expectedProgramId: z.string().uuid().optional(),
  awardIds: rentalAwardSelectionSchema,
  offerId: z.string().uuid().optional(),
  expectedOfferVersion: z.number().int().positive().optional(),
  expectedQuoteVersion: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
function dates(start: string, end: string) {
  try {
    const days = rentalDays(start, end);
    if (
      start < moscowDate() ||
      start > moscowDate(new Date(Date.now() + 365 * 86400000))
    )
      throw new Error("Выберите даты в течение ближайшего года");
    return days;
  } catch (e) {
    throw new HttpError(422, "RENTAL_DATES", (e as Error).message);
  }
}
function quoteVersion(parts: unknown[]) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}
type RentalOffer = {
  id: string;
  title: string;
  discountBps: number;
  version: number;
};
function awardEligible(
  snapshot: Record<string, unknown>,
  carId: string,
  days: number,
  tier: TierCode,
  minimumTotal: string,
) {
  const required = snapshot.minimum_tier as TierCode | null | undefined;
  if (required && TIER_CODES.indexOf(tier) < TIER_CODES.indexOf(required))
    return false;
  const carIds = Array.isArray(snapshot.car_ids) ? snapshot.car_ids : [];
  if (carIds.length && !carIds.includes(carId)) return false;
  if (typeof snapshot.min_days === "number" && days < snapshot.min_days)
    return false;
  if (typeof snapshot.max_days === "number" && days > snapshot.max_days)
    return false;
  if (
    snapshot.min_total_kopecks &&
    BigInt(minimumTotal) < BigInt(String(snapshot.min_total_kopecks))
  )
    return false;
  const starts = snapshot.starts_at
    ? Date.parse(String(snapshot.starts_at))
    : null;
  const ends = snapshot.ends_at ? Date.parse(String(snapshot.ends_at)) : null;
  return (
    (starts === null || starts <= Date.now()) &&
    (ends === null || ends > Date.now())
  );
}
async function rentalOffer(
  db: Db,
  userId: string,
  offerId: string | undefined,
  carId: string,
  tier: TierCode,
): Promise<RentalOffer | null> {
  if (!offerId) return null;
  const allowedTiers = TIER_CODES.slice(0, TIER_CODES.indexOf(tier) + 1);
  const [row] = await db.query<{ snapshot: Record<string, unknown> }>(
    `SELECT COALESCE(personal.offer_snapshot,to_jsonb(o)) AS snapshot
       FROM offers o
       LEFT JOIN LATERAL (
         SELECT c.offer_snapshot FROM offer_campaigns c
         JOIN offer_campaign_recipients r ON r.campaign_id=c.id AND r.user_id=$2
         WHERE c.offer_id=o.id
           AND (c.offer_snapshot->>'start_at')::timestamptz<=now()
           AND (c.offer_snapshot->>'end_at')::timestamptz>now()
         ORDER BY c.created_at DESC LIMIT 1
       ) personal ON true
       WHERE o.id=$1 AND o.active=true AND o.archived_at IS NULL
         AND (
           personal.offer_snapshot IS NOT NULL
           OR (NOT EXISTS (SELECT 1 FROM offer_campaigns c WHERE c.offer_id=o.id)
             AND o.start_at<=now() AND o.end_at>now()
             AND o.minimum_tier=ANY($3::text[]))
         )`,
    [offerId, userId, allowedTiers],
  );
  const snapshot = row?.snapshot;
  if (
    !snapshot ||
    snapshot.offer_type !== "catalog" ||
    snapshot.car_id !== carId ||
    typeof snapshot.discount_bps !== "number" ||
    snapshot.discount_bps < 1 ||
    snapshot.discount_bps > 9999 ||
    typeof snapshot.version !== "number" ||
    snapshot.version < 1
  )
    throw new HttpError(
      409,
      "OFFER_UNAVAILABLE",
      "Предложение больше недоступно для этой аренды",
    );
  return {
    id: offerId,
    title: String(snapshot.title ?? "Предложение RPM Club"),
    discountBps: snapshot.discount_bps,
    version: snapshot.version,
  };
}
async function audit(
  tx: Db,
  actorId: string,
  role: string,
  action: string,
  id: string,
  data: unknown,
) {
  await tx.query(
    "INSERT INTO audit_logs(actor_id,actor_role,action,entity_type,entity_id,reason,after_data) VALUES($1,$2,$3,'club',$4,$3,$5)",
    [actorId, role, action, id, JSON.stringify(data)],
  );
}

export async function clubRoute(
  request: Request,
  path: string,
): Promise<Response | null> {
  if (path === "club/content" && request.method === "GET") {
    await requireSession(request);
    const kind = z
      .enum(contentKinds)
      .parse(new URL(request.url).searchParams.get("kind"));
    return json({
      items: await query(
        "SELECT * FROM club_content WHERE kind=$1 AND active ORDER BY sort_order,published_at DESC,id LIMIT 200",
        [kind],
      ),
    });
  }
  if (path === "me/rental-quotes" || path === "me/rental-requests") {
    const session = await requireSession(request),
      userId = session.user_id!;
    await rateLimit("rental-request:" + userId, 30);
    if (request.method === "GET" && path === "me/rental-requests")
      return json({
        items: await query(
          "SELECT q.*,r.pickup_at,to_char(q.start_date,'YYYY-MM-DD') start_date,to_char(q.end_date,'YYYY-MM-DD') end_date,COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'title',ra.prize_snapshot->>'title','terms',ra.prize_snapshot->>'terms','claim_code',a.claim_code,'status',a.status,'effect_kopecks',ra.effect_kopecks) ORDER BY ra.position) FROM rental_request_awards ra JOIN roulette_awards a ON a.id=ra.award_id WHERE ra.request_id=q.id),'[]'::jsonb) roulette_awards FROM rental_requests q LEFT JOIN rentals r ON r.id=q.rental_id WHERE q.user_id=$1 ORDER BY q.created_at DESC,q.id LIMIT 100",
          [userId],
        ),
      });
    if (request.method === "POST") {
      requireOrigin(request);
      const input = await body(request, requestInput);
      if (input.offerId && input.awardIds.length)
        throw new HttpError(
          422,
          "AWARD_WITH_OFFER",
          "Призы нельзя применять при бронировании по спецпредложению",
        );
      if (path === "me/rental-quotes") {
        const days = dates(input.startDate, input.endDate);
        const [car] = await query<ClubContent>(
          "SELECT * FROM club_content WHERE id=$1 AND kind='car' AND active",
          [input.carId],
        );
        if (!car) return notFound();
        await assertCatalogBookable({ query }, car, days);
        const account = await getAccountSnapshot(userId);
        const offer = await rentalOffer(
          { query },
          userId,
          input.offerId,
          car.id,
          account.tier,
        );
        const rawAvailableAwards = await query<{
          id: string;
          claim_code: string;
          prize_snapshot: Record<string, unknown>;
        }>(
          "SELECT id,claim_code,prize_snapshot FROM roulette_awards WHERE user_id=$1 AND status='available' AND expires_at>now() ORDER BY issued_at,id LIMIT 100",
          [userId],
        );
        const standard = rentalQuote(
          car.daily_price_kopecks,
          days,
          Math.max(account.discount_rate_bps, offer?.discountBps ?? 0),
        );
        const availableAwards = rawAvailableAwards.filter((a) =>
          awardEligible(
            a.prize_snapshot,
            car.id,
            days,
            account.tier,
            standard.totalKopecks,
          ),
        );
        const byId = new Map(availableAwards.map((a) => [a.id, a]));
        const selected = input.awardIds
          .map((id) => byId.get(id))
          .filter((a): a is NonNullable<typeof a> => !!a)
          .map(rentalAwardOption);
        if (selected.length !== input.awardIds.length)
          throw new HttpError(
            409,
            "AWARD_UNAVAILABLE",
            "Один из выбранных призов уже недоступен",
          );
        const quote = rentalQuoteWithAwards(
          car.daily_price_kopecks,
          days,
          account.discount_rate_bps,
          selected,
          offer?.discountBps ?? 0,
        );
        return json({
          ...quote,
          availableAwards: availableAwards.map(rentalAwardOption),
          carVersion: car.version,
          programId: account.program.id,
          offerId: offer?.id ?? null,
          offerVersion: offer?.version ?? null,
          offerTitle: offer?.title ?? null,
          offerDiscountBps: offer?.discountBps ?? null,
          quoteVersion: quoteVersion([
            userId,
            car.id,
            car.version,
            input.startDate,
            input.endDate,
            account.program.id,
            input.awardIds,
            offer?.id ?? null,
            offer?.version ?? null,
            quote.totalKopecks,
          ]),
        });
      }
      const key = operationKey(request);
      const result = await transaction(async (tx) => {
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "request:" + userId,
        ]);
        const [old] = await tx.query<RentalRequest>(
          "SELECT *,to_char(start_date,'YYYY-MM-DD') start_date,to_char(end_date,'YYYY-MM-DD') end_date FROM rental_requests WHERE user_id=$1 AND request_key=$2",
          [userId, key],
        );
        if (old) {
          if (
            old.car_id !== input.carId ||
            old.start_date !== input.startDate ||
            old.end_date !== input.endDate ||
            old.comment !== input.comment ||
            JSON.stringify(
              (
                await tx.query<{ award_id: string }>(
                  "SELECT award_id FROM rental_request_awards WHERE request_id=$1 ORDER BY position",
                  [old.id],
                )
              ).map((a) => a.award_id),
            ) !== JSON.stringify(input.awardIds) ||
            old.offer_id !== (input.offerId ?? null)
          )
            throw new HttpError(
              409,
              "IDEMPOTENCY_CONFLICT",
              "Ключ уже использован для другой заявки",
            );
          return old;
        }
        const days = dates(input.startDate, input.endDate);
        const [count] = await tx.query<{ n: number }>(
          "SELECT count(*)::int n FROM rental_requests WHERE user_id=$1 AND status='pending'",
          [userId],
        );
        if (count.n >= 5)
          throw new HttpError(
            409,
            "TOO_MANY_REQUESTS",
            "Дождитесь ответа по текущим заявкам",
          );
        const [car] = await tx.query<ClubContent>(
          "SELECT * FROM club_content WHERE id=$1 AND kind='car' AND active FOR SHARE",
          [input.carId],
        );
        if (!car)
          throw new HttpError(
            404,
            "CAR_NOT_FOUND",
            "Автомобиль больше недоступен",
          );
        await assertCatalogBookable(tx, car, days);
        const account = await getAccountSnapshotInTransaction(tx, userId);
        const offer = await rentalOffer(
          tx,
          userId,
          input.offerId,
          car.id,
          account.tier,
        );
        const awardRows = input.awardIds.length
          ? await tx.query<{
              id: string;
              claim_code: string;
              prize_snapshot: Record<string, unknown>;
            }>(
              "SELECT id,claim_code,prize_snapshot FROM roulette_awards WHERE id=ANY($1::uuid[]) AND user_id=$2 AND status='available' AND expires_at>now() ORDER BY array_position($1::uuid[],id) FOR UPDATE",
              [input.awardIds, userId],
            )
          : [];
        if (
          awardRows.length !== input.awardIds.length ||
          new Set(input.awardIds).size !== input.awardIds.length
        )
          throw new HttpError(
            409,
            "AWARD_UNAVAILABLE",
            "Один из выбранных призов уже недоступен",
          );
        const standard = rentalQuote(
          car.daily_price_kopecks,
          days,
          Math.max(account.discount_rate_bps, offer?.discountBps ?? 0),
        );
        if (
          awardRows.some(
            (a) =>
              !awardEligible(
                a.prize_snapshot,
                car.id,
                days,
                account.tier,
                standard.totalKopecks,
              ),
          )
        )
          throw new HttpError(
            409,
            "AWARD_INELIGIBLE",
            "Один из выбранных призов не подходит к этой аренде",
          );
        const selectedAwards = awardRows.map(rentalAwardOption);
        const quote = rentalQuoteWithAwards(
          car.daily_price_kopecks,
          days,
          account.discount_rate_bps,
          selectedAwards,
          offer?.discountBps ?? 0,
        );
        if (
          input.expectedCarVersion !== car.version ||
          input.expectedProgramId !== account.program.id ||
          (offer && input.expectedOfferVersion !== offer.version) ||
          input.expectedTotal !== quote.totalKopecks ||
          (input.expectedQuoteVersion &&
            input.expectedQuoteVersion !==
              quoteVersion([
                userId,
                car.id,
                car.version,
                input.startDate,
                input.endDate,
                account.program.id,
                input.awardIds,
                offer?.id ?? null,
                offer?.version ?? null,
                quote.totalKopecks,
              ]))
        )
          throw new HttpError(
            409,
            "QUOTE_CHANGED",
            "Условия изменились. Рассчитайте стоимость заново",
          );
        const [row] = await tx.query<RentalRequest>(
          `INSERT INTO rental_requests(user_id,car_id,car_name,start_date,end_date,days,gross_kopecks,discount_kopecks,total_kopecks,discount_bps,program_version_id,comment,request_key,roulette_award_id,roulette_effect_kopecks,roulette_prize_snapshot,offer_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NULL,$14,NULL,$15) RETURNING *`,
          [
            userId,
            car.id,
            car.title,
            input.startDate,
            input.endDate,
            days,
            quote.grossKopecks,
            rentalTotalDiscountKopecks(quote.grossKopecks, quote.totalKopecks),
            quote.totalKopecks,
            quote.discountBps,
            account.program.id,
            input.comment,
            key,
            quote.awardDiscountKopecks,
            offer?.id ?? null,
          ],
        );
        for (const [position, award] of quote.awards.entries()) {
          const source = awardRows.find((a) => a.id === award.id)!;
          await tx.query(
            "INSERT INTO rental_request_awards(request_id,award_id,position,effect_kopecks,prize_snapshot) VALUES($1,$2,$3,$4,$5)",
            [
              row.id,
              award.id,
              position,
              award.effectKopecks,
              JSON.stringify(source.prize_snapshot),
            ],
          );
          await tx.query(
            "UPDATE roulette_awards SET status='reserved',reserved_request_id=$2 WHERE id=$1 AND status='available'",
            [award.id, row.id],
          );
        }
        if (quote.awards.length) {
          const prizes = quote.awards.map((a) => ({
            title: a.title,
            claimCode: a.claim_code,
            terms: a.terms,
            effectType: a.effect_type,
            effectValue: a.effect_value,
            effectKopecks: a.effectKopecks,
          }));
          await tx.query(
            "UPDATE rpm_rent_exports SET payload=payload || jsonb_build_object('discountKopecks',$2::text,'prizes',$3::jsonb,'prizeDiscountKopecks',$4::text) WHERE request_id=$1",
            [
              row.id,
              quote.discountKopecks,
              JSON.stringify(prizes),
              quote.awardDiscountKopecks,
            ],
          );
        }
        await tx.query(
          "UPDATE booking_drafts SET completed_at=now() WHERE user_id=$1 AND completed_at IS NULL",
          [userId],
        );
        await tx.query(
          "UPDATE notification_runs SET converted_at=coalesce(converted_at,now()) WHERE user_id=$1 AND trigger_id IN ('BOOK_01','RET_01','APP_01') AND status='sent' AND sent_at<=now() AND sent_at+(config->>'attributionDays')::int*interval '1 day'>=now()",
          [userId],
        );
        return row;
      });
      return json(result, 201);
    }
    return null;
  }
  const cancel = path.match(/^me\/rental-requests\/([a-f0-9-]{36})\/cancel$/);
  if (cancel && request.method === "POST") {
    requireOrigin(request);
    const session = await requireSession(request);
    const changed = await transaction(async (tx) => {
      const rows = await tx.query<{ id: string }>(
        "UPDATE rental_requests SET status='cancelled',updated_at=now() WHERE id=$1 AND user_id=$2 AND status='pending' RETURNING id",
        [cancel[1], session.user_id],
      );
      if (rows.length) await transitionAward(tx, cancel[1], "cancelled");
      return rows;
    });
    if (!changed.length)
      throw new HttpError(
        409,
        "REQUEST_STATE",
        "Заявка уже обработана или недоступна",
      );
    return json({ ok: true });
  }
  const content = path.match(/^admin\/club-content(?:\/([a-f0-9-]{36}))?$/);
  if (content) {
    const staff = await requireStaff(
      request,
      request.method === "GET" ? "viewer" : "manager",
    );
    if (request.method === "GET") {
      const kind = z
        .enum(contentKinds)
        .parse(new URL(request.url).searchParams.get("kind"));
      return json({
        items: await query(
          "SELECT * FROM club_content WHERE kind=$1 AND NOT source_deleted ORDER BY sort_order,created_at DESC,id LIMIT 200",
          [kind],
        ),
        ...(kind === "car" || kind === "route"
          ? {
              catalogSync:
                (
                  await query(
                    "SELECT value FROM program_settings WHERE key=$1",
                    [kind === "car" ? "catalog:sync" : "routes:sync"],
                  )
                )[0]?.value ?? null,
            }
          : {}),
      });
    }
    if (request.method === "POST" || request.method === "PATCH") {
      requireOrigin(request);
      const input = await body(request, contentSchema);
      if (input.kind === "car" || input.kind === "route")
        throw new HttpError(
          409,
          "CATALOG_MANAGED_ON_SITE",
          input.kind === "car"
            ? "Автопарк редактируется в админке сайта RPM Rent"
            : "Маршруты редактируются в разделе «Локации» админки сайта RPM Rent",
        );
      const row = await transaction(async (tx) => {
        const values = [
          input.kind,
          input.title,
          input.summary,
          input.body,
          input.imageUrl,
          input.linkUrl,
          input.category,
          input.dailyPriceKopecks,
          input.distanceKm,
          input.durationMinutes,
          input.active,
        ];
        const [saved] = content[1]
          ? await tx.query<ClubContent>(
              `UPDATE club_content SET title=$2,summary=$3,body=$4,image_url=$5,link_url=$6,category=$7,daily_price_kopecks=$8,distance_km=$9,duration_minutes=$10,active=$11,published_at=CASE WHEN $11 AND published_at IS NULL THEN now() ELSE published_at END,version=version+1,updated_at=now() WHERE id=$12 AND kind=$1 AND version=$13 RETURNING *`,
              [...values, content[1], input.expectedVersion],
            )
          : await tx.query<ClubContent>(
              `INSERT INTO club_content(kind,title,summary,body,image_url,link_url,category,daily_price_kopecks,distance_km,duration_minutes,active,published_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CASE WHEN $11 THEN now() ELSE NULL END) RETURNING *`,
              values,
            );
        if (!saved)
          throw new HttpError(
            409,
            "CONTENT_STALE",
            "Запись уже изменена. Обновите страницу",
          );
        await audit(tx, staff.id, staff.role, "content.save", saved.id, saved);
        return saved;
      });
      return json(row);
    }
  }
  if (path === "admin/rental-requests" && request.method === "GET") {
    await requireStaff(request);
    const status = z
      .enum(["pending", "accepted", "declined", "cancelled", "closed", "all"])
      .parse(new URL(request.url).searchParams.get("status") ?? "pending");
    return json({
      items: await query(
        "SELECT r.*,u.name,u.phone,trip.pickup_at,to_char(r.start_date,'YYYY-MM-DD') start_date,to_char(r.end_date,'YYYY-MM-DD') end_date,r.rpm_rent_managed AND (NOT EXISTS(SELECT 1 FROM rpm_rent_deliveries d WHERE d.request_id=r.id) OR EXISTS(SELECT 1 FROM rpm_rent_deliveries d WHERE d.request_id=r.id AND d.delivered_at IS NULL)) AS rpm_rent_notification_pending,COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'title',ra.prize_snapshot->>'title','terms',ra.prize_snapshot->>'terms','claim_code',a.claim_code,'status',a.status,'effect_kopecks',ra.effect_kopecks) ORDER BY ra.position) FROM rental_request_awards ra JOIN roulette_awards a ON a.id=ra.award_id WHERE ra.request_id=r.id),'[]'::jsonb) roulette_awards FROM rental_requests r JOIN users u ON u.id=r.user_id LEFT JOIN rentals trip ON trip.id=r.rental_id WHERE ($1='all' OR ($1='closed' AND r.status IN ('declined','cancelled')) OR r.status=$1) ORDER BY r.created_at DESC,r.id LIMIT 200",
        [status],
      ),
    });
  }
  const decision = path.match(/^admin\/rental-requests\/([a-f0-9-]{36})$/);
  if (decision && request.method === "POST") {
    requireOrigin(request);
    const staff = await requireStaff(request, "manager");
    const input = await body(
      request,
      z.object({
        status: z.enum(["accepted", "declined"]),
        note: z.string().trim().min(3).max(1000),
        pickupTime: z
          .string()
          .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
          .optional(),
      }),
    );
    return json(
      await transaction(async (tx) => {
        const [row] = await tx.query<RentalRequest>(
          "SELECT *,to_char(start_date,'YYYY-MM-DD') start_date,to_char(end_date,'YYYY-MM-DD') end_date FROM rental_requests WHERE id=$1 FOR UPDATE",
          [decision[1]],
        );
        if (!row) throw new HttpError(404, "NOT_FOUND", "Заявка не найдена");
        if (row.rpm_rent_managed)
          throw new HttpError(
            409,
            "RPM_RENT_MANAGED",
            "Обработайте эту заявку в общем списке RPM Rent. Статус обновится автоматически.",
          );
        if (row.status === input.status) return row;
        if (row.status !== "pending")
          throw new HttpError(409, "REQUEST_STATE", "Заявка уже обработана");
        let rentalId: string | null = null;
        if (input.status === "accepted") {
          dates(row.start_date, row.end_date);
          if (!input.pickupTime)
            throw new HttpError(
              422,
              "PICKUP_REQUIRED",
              "Укажите согласованное время выдачи (Москва)",
            );
          const pickupAt = new Date(
            row.start_date + "T" + input.pickupTime + ":00+03:00",
          ).toISOString();
          if (Date.parse(pickupAt) <= Date.now())
            throw new HttpError(422, "PICKUP_PAST", "Время выдачи уже прошло");
          const [car] = await tx.query<ClubContent>(
            "SELECT * FROM club_content WHERE id=$1 FOR UPDATE",
            [row.car_id],
          );
          if (!car?.active)
            throw new HttpError(
              409,
              "CAR_INACTIVE",
              "Автомобиль снят с публикации",
            );
          const [overlap] = await tx.query(
            `SELECT q.id FROM rental_requests q JOIN rentals r ON r.id=q.rental_id WHERE q.car_id=$1 AND q.status='accepted' AND r.status<>'cancelled' AND daterange(q.start_date,greatest(q.end_date,q.start_date+1),'[)') && daterange($2::date,greatest($3::date,$2::date+1),'[)') LIMIT 1`,
            [row.car_id, row.start_date, row.end_date],
          );
          if (overlap)
            throw new HttpError(
              409,
              "CAR_RESERVED",
              "На эти даты уже есть подтверждённая заявка",
            );
          const result = await createRequestedRental(
            tx,
            {
              userId: row.user_id,
              externalRentalId: "app:" + row.id,
              carName: row.car_name,
              startDate: row.start_date,
              endDate: row.end_date,
              pickupAt,
              amountKopecks: row.total_kopecks,
              idempotencyKey: "request:" + row.id,
              reason: input.note,
            },
            { id: staff.id, role: staff.role as "admin" | "manager" },
          );
          rentalId = result.rentalId;
        }
        const [saved] = await tx.query<RentalRequest>(
          "UPDATE rental_requests SET status=$2,staff_note=$3,rental_id=$4,updated_at=now() WHERE id=$1 RETURNING *",
          [row.id, input.status, input.note, rentalId],
        );
        await transitionAward(tx, row.id, input.status);
        await audit(
          tx,
          staff.id,
          staff.role,
          "request." + input.status,
          row.id,
          { rentalId, note: input.note },
        );
        return saved;
      }),
    );
  }
  if (path === "admin/trigger-rules") {
    const staff = await requireStaff(request, "admin");
    if (request.method === "GET")
      return json({
        items: await query("SELECT * FROM trigger_rules ORDER BY kind"),
        weatherReady: !!process.env.OPEN_METEO_API_KEY,
      });
    if (request.method === "POST") {
      requireOrigin(request);
      const input = await body(request, triggerSchema);
      if (input.kind === "weather" && input.enabled)
        throw new HttpError(
          409,
          "WEATHER_DISABLED",
          "Погодные уведомления пока недоступны",
        );
      await transaction(async (tx) => {
        await tx.query(
          "UPDATE trigger_rules SET enabled=$2,message=$3,lead_hours=$4,city=$5,latitude=$6,longitude=$7,enabled_at=CASE WHEN $2 AND NOT enabled THEN now() ELSE enabled_at END,updated_at=now() WHERE kind=$1",
          [
            input.kind,
            input.enabled,
            input.message,
            input.leadHours,
            input.city,
            input.latitude,
            input.longitude,
          ],
        );
        await audit(
          tx,
          staff.id,
          staff.role,
          "trigger.save",
          input.kind,
          input,
        );
      });
      return json({ ok: true });
    }
  }
  return null;
}
