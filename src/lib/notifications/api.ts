import { z } from "zod";
import { query, transaction } from "@/lib/db";
import { body, HttpError, json, requireOrigin } from "@/lib/http";
import { requireSession, requireStaff, rateLimit } from "@/lib/auth/session";
import { notificationRules, recordActivity } from "./engine";
import { notificationRuleSchema, type NotificationRule } from "./contracts";
import { moscowDate, rentalDays } from "@/lib/club/contracts";
export async function notificationsRoute(
  request: Request,
  path: string,
): Promise<Response | null> {
  if (
    ![
      "admin/notifications",
      "admin/notification-limits",
      "me/notification-activity",
      "me/notification-preferences",
      "me/booking-draft",
    ].includes(path)
  )
    return null;
  if (path.startsWith("admin/")) {
    const staff = await requireStaff(request, "admin");
    await rateLimit("notifications-admin:" + staff.id, 60);
    if (path === "admin/notifications" && request.method === "GET") {
      return json({
        rules: await notificationRules(),
        limits: (
          await query<{ value: unknown }>(
            "SELECT value FROM program_settings WHERE key='notifications:limits'",
          )
        )[0]?.value,
        stats: await query(
          `SELECT trigger_id,count(*) total,count(*) FILTER(WHERE status='sent') sent,count(*) FILTER(WHERE status='cancelled') cancelled,count(*) FILTER(WHERE status='failed') failed,count(*) FILTER(WHERE opened_at IS NOT NULL) opened,count(*) FILTER(WHERE converted_at IS NOT NULL) converted FROM notification_runs GROUP BY trigger_id`,
        ),
        logs: await query(
          `SELECT n.id,n.trigger_id,n.status,n.reason,n.created_at,n.scheduled_at,n.sent_at,n.opened_at,n.converted_at,n.config->>'path' path,u.name FROM notification_runs n LEFT JOIN users u ON u.id=n.user_id ORDER BY n.created_at DESC LIMIT 100`,
        ),
      });
    }
    if (request.method !== "POST") return null;
    requireOrigin(request);
    if (path === "admin/notification-limits") {
      const input = await body(
        request,
        z.object({
          service: z.number().int().min(0).max(1),
          marketing: z.number().int().min(0).max(1),
        }),
      );
      await transaction(async (tx) => {
        await tx.query(
          "UPDATE program_settings SET value=$1,updated_at=now() WHERE key='notifications:limits'",
          [JSON.stringify(input)],
        );
        await tx.query(
          "INSERT INTO audit_logs(actor_id,actor_role,action,entity_type,entity_id,reason,after_data) VALUES($1,$2,'notifications.limits','notifications','limits','Изменение суточных лимитов',$3)",
          [staff.id, staff.role, JSON.stringify(input)],
        );
      });
      return json({ ok: true });
    }
    const input = await body(request, notificationRuleSchema);
    await notificationRules();
    await transaction(async (tx) => {
      const [old] = await tx.query<NotificationRule>(
        "SELECT * FROM notification_rules WHERE id=$1 FOR UPDATE",
        [input.id],
      );
      if (old.version !== input.expectedVersion)
        throw new HttpError(
          409,
          "STALE_NOTIFICATION",
          "Правило изменилось. Обновите страницу.",
        );
      await tx.query(
        "UPDATE notification_rules SET config=$2,version=version+1,enabled_at=CASE WHEN $3 AND NOT (config->>'enabled')::boolean THEN now() ELSE enabled_at END,updated_at=now() WHERE id=$1",
        [input.id, JSON.stringify(input), input.enabled],
      );
      await tx.query(
        "UPDATE notification_runs SET status='cancelled',reason='RULE_UPDATED' WHERE trigger_id=$1 AND status='pending'",
        [input.id],
      );
      await tx.query(
        "INSERT INTO audit_logs(actor_id,actor_role,action,entity_type,entity_id,reason,before_data,after_data) VALUES($1,$2,'notifications.rule','notifications',$3,'Редакция уведомления',$4,$5)",
        [
          staff.id,
          staff.role,
          input.id,
          JSON.stringify(old.config),
          JSON.stringify(input),
        ],
      );
    });
    return json({ ok: true });
  }
  const session = await requireSession(
    request,
    path !== "me/notification-activity",
  );
  await rateLimit("notification-client:" + session.id, 90);
  if (request.method === "POST") requireOrigin(request);
  if (path === "me/notification-activity" && request.method === "POST") {
    const input = await body(
      request,
      z.object({
        notification: z.string().uuid().optional(),
        path: z.string().max(80),
      }),
    );
    await recordActivity({
      telegramId: session.telegram_id,
      userId: session.user_id,
      canMessage: !!session.telegram_profile.allows_write_to_pm,
      registered: session.user_status === "active",
    });
    if (input.notification)
      await query(
        `UPDATE notification_runs SET opened_at=coalesce(opened_at,now()),converted_at=CASE WHEN trigger_id IN ('RIDE_01','RIDE_02','LVL_01','LVL_02','PROMO_01','BDAY_01','ANNIV_01') THEN coalesce(converted_at,now()) ELSE converted_at END WHERE id=$1 AND (user_id=$2 OR (user_id IS NULL AND identity_key='tg:'||$3)) AND status='sent' AND config->>'path'=$4 AND sent_at+((config->>'attributionDays')::int)*interval '1 day'>=now()`,
        [input.notification, session.user_id, session.telegram_id, input.path],
      );
    return json({ ok: true });
  }
  if (path === "me/notification-preferences") {
    if (request.method === "GET")
      return json(
        (
          await query(
            "SELECT enabled,to_char(birthday,'YYYY-MM-DD') birthday,birthday_consent_at FROM notification_profiles WHERE user_id=$1",
            [session.user_id],
          )
        )[0] ?? { enabled: true, birthday: null, birthday_consent_at: null },
      );
    if (request.method === "POST") {
      const input = await body(
        request,
        z.object({
          enabled: z.boolean(),
          birthday: z.iso.date().nullable(),
          birthdayConsent: z.boolean(),
        }),
      );
      if (
        input.birthday &&
        (!input.birthdayConsent ||
          input.birthday >= moscowDate() ||
          input.birthday < "1900-01-01")
      )
        throw new HttpError(
          422,
          "BIRTHDAY_CONSENT",
          "Укажите корректную дату и согласие или оставьте поле пустым.",
        );
      await query(
        "INSERT INTO notification_profiles(user_id,enabled,birthday,birthday_consent_at) VALUES($1,$2,$3,CASE WHEN $3::date IS NOT NULL THEN now() END) ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled,birthday=excluded.birthday,birthday_consent_at=excluded.birthday_consent_at,updated_at=now()",
        [session.user_id, input.enabled, input.birthday],
      );
      return json({ ok: true });
    }
  }
  if (path === "me/booking-draft") {
    if (request.method === "GET") {
      const id = z
        .string()
        .uuid()
        .parse(new URL(request.url).searchParams.get("id"));
      const [draft] = await query(
        "SELECT d.id,d.car_id,to_char(d.start_date,'YYYY-MM-DD') start_date,to_char(d.end_date,'YYYY-MM-DD') end_date,d.comment,d.request_key FROM booking_drafts d JOIN club_content c ON c.id=d.car_id WHERE d.id=$1 AND d.user_id=$2 AND d.completed_at IS NULL AND c.active",
        [id, session.user_id],
      );
      if (!draft)
        throw new HttpError(
          404,
          "DRAFT_MISSING",
          "Черновик недоступен. Выберите автомобиль заново.",
        );
      return json(draft);
    }
    if (request.method === "POST") {
      const input = await body(
        request,
        z.object({
          carId: z.string().uuid(),
          requestKey: z.string().uuid(),
          startDate: z.iso.date(),
          endDate: z.iso.date(),
          comment: z.string().max(1000).default(""),
        }),
      );
      try {
        rentalDays(input.startDate, input.endDate);
      } catch {
        throw new HttpError(422, "DRAFT_DATES", "Проверьте даты");
      }
      if (input.startDate < moscowDate())
        throw new HttpError(422, "DRAFT_DATES", "Начало поездки уже прошло");
      const [car] = await query(
        "SELECT id FROM club_content WHERE id=$1 AND kind='car' AND active",
        [input.carId],
      );
      if (!car)
        throw new HttpError(404, "CAR_MISSING", "Автомобиль недоступен");
      const draft = await transaction(async (tx) => {
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "request:" + session.user_id,
        ]);
        const [submitted] = await tx.query(
          "SELECT id FROM rental_requests WHERE user_id=$1 AND request_key=$2",
          [session.user_id, input.requestKey],
        );
        if (submitted) return { completed: true };
        const [saved] = await tx.query(
          `INSERT INTO booking_drafts(user_id,car_id,start_date,end_date,comment,request_key) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id,car_id) DO UPDATE SET start_date=excluded.start_date,end_date=excluded.end_date,comment=excluded.comment,request_key=excluded.request_key,completed_at=NULL,created_at=CASE WHEN booking_drafts.completed_at IS NOT NULL THEN now() ELSE booking_drafts.created_at END,updated_at=CASE WHEN ROW(booking_drafts.start_date,booking_drafts.end_date,booking_drafts.comment,booking_drafts.completed_at) IS DISTINCT FROM ROW(excluded.start_date,excluded.end_date,excluded.comment,NULL::timestamptz) THEN now() ELSE booking_drafts.updated_at END RETURNING id`,
          [
            session.user_id,
            input.carId,
            input.startDate,
            input.endDate,
            input.comment,
            input.requestKey,
          ],
        );
        return saved;
      });
      return json(draft);
    }
  }
  return null;
}
