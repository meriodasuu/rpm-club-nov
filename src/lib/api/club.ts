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
  createRequestedRental,
} from "@/lib/loyalty";
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
        "SELECT * FROM club_content WHERE kind=$1 AND active ORDER BY published_at DESC,id LIMIT 200",
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
          "SELECT q.*,r.pickup_at,to_char(q.start_date,'YYYY-MM-DD') start_date,to_char(q.end_date,'YYYY-MM-DD') end_date FROM rental_requests q LEFT JOIN rentals r ON r.id=q.rental_id WHERE q.user_id=$1 ORDER BY q.created_at DESC,q.id LIMIT 100",
          [userId],
        ),
      });
    if (request.method === "POST") {
      requireOrigin(request);
      const input = await body(request, requestInput);
      if (path === "me/rental-quotes") {
        const days = dates(input.startDate, input.endDate);
        const [car] = await query<ClubContent>(
          "SELECT * FROM club_content WHERE id=$1 AND kind='car' AND active",
          [input.carId],
        );
        if (!car) return notFound();
        const account = await getAccountSnapshot(userId);
        return json({
          ...rentalQuote(
            car.daily_price_kopecks,
            days,
            account.discount_rate_bps,
          ),
          carVersion: car.version,
          programId: account.program.id,
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
            old.comment !== input.comment
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
        const account = await getAccountSnapshotInTransaction(tx, userId);
        const quote = rentalQuote(
          car.daily_price_kopecks,
          days,
          account.discount_rate_bps,
        );
        if (
          input.expectedCarVersion !== car.version ||
          input.expectedProgramId !== account.program.id ||
          input.expectedTotal !== quote.totalKopecks
        )
          throw new HttpError(
            409,
            "QUOTE_CHANGED",
            "Условия изменились. Рассчитайте стоимость заново",
          );
        const [row] = await tx.query<RentalRequest>(
          `INSERT INTO rental_requests(user_id,car_id,car_name,start_date,end_date,days,gross_kopecks,discount_kopecks,total_kopecks,discount_bps,program_version_id,comment,request_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
          [
            userId,
            car.id,
            car.title,
            input.startDate,
            input.endDate,
            days,
            quote.grossKopecks,
            quote.discountKopecks,
            quote.totalKopecks,
            quote.discountBps,
            account.program.id,
            input.comment,
            key,
          ],
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
    const changed = await query(
      "UPDATE rental_requests SET status='cancelled',updated_at=now() WHERE id=$1 AND user_id=$2 AND status='pending' RETURNING id",
      [cancel[1], session.user_id],
    );
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
          "SELECT * FROM club_content WHERE kind=$1 ORDER BY created_at DESC,id LIMIT 200",
          [kind],
        ),
      });
    }
    if (request.method === "POST" || request.method === "PATCH") {
      requireOrigin(request);
      const input = await body(request, contentSchema);
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
      .enum(["pending", "accepted", "declined", "cancelled", "all"])
      .parse(new URL(request.url).searchParams.get("status") ?? "pending");
    return json({
      items: await query(
        "SELECT r.*,u.name,u.phone,trip.pickup_at,to_char(r.start_date,'YYYY-MM-DD') start_date,to_char(r.end_date,'YYYY-MM-DD') end_date FROM rental_requests r JOIN users u ON u.id=r.user_id LEFT JOIN rentals trip ON trip.id=r.rental_id WHERE ($1='all' OR r.status=$1) ORDER BY r.created_at DESC,r.id LIMIT 200",
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
      if (
        input.kind === "weather" &&
        input.enabled &&
        !process.env.OPEN_METEO_API_KEY
      )
        throw new HttpError(
          409,
          "WEATHER_NOT_CONFIGURED",
          "Сначала подключите ключ сервиса погоды",
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
