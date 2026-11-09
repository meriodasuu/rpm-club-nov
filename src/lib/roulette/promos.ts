import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { query, transaction } from "@/lib/db";
import { requireSession, requireStaff, rateLimit } from "@/lib/auth/session";
import { body, HttpError, json, operationKey, requireOrigin } from "@/lib/http";

function normalizeCode(value: string) {
  return value.trim().replace(/\s+/g, "").toUpperCase();
}
function hashCode(value: string) {
  return createHash("sha256").update(normalizeCode(value)).digest("hex");
}

export async function roulettePromoRoute(request: Request, path: string): Promise<Response | null> {
  if (path === "me/roulette/promos/redeem" && request.method === "POST") {
    requireOrigin(request);
    const session = await requireSession(request);
    await rateLimit("roulette-promo:" + session.user_id, 10);
    const input = await body(request, z.object({ code: z.string().trim().min(5).max(80) }));
    const result = await transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["roulette-promo-user:" + session.user_id]);
      const [member] = await tx.query("SELECT id FROM users WHERE id=$1 AND status='active' FOR SHARE", [session.user_id]);
      if (!member) throw new HttpError(403, "REGISTRATION_REQUIRED", "Сначала завершите регистрацию");
      const [promo] = await tx.query<{ id: string; label: string; redeemed_count: number; max_redemptions: number }>(
        `SELECT id,label,redeemed_count,max_redemptions FROM roulette_promo_codes
         WHERE code_hash=$1 AND active AND starts_at<=now() AND expires_at>now() FOR UPDATE`, [hashCode(input.code)],
      );
      if (!promo) throw new HttpError(422, "PROMO_UNAVAILABLE", "Промокод недоступен или срок действия истёк");
      const [old] = await tx.query("SELECT id FROM roulette_promo_redemptions WHERE promo_id=$1 AND user_id=$2", [promo.id, session.user_id]);
      if (old) throw new HttpError(409, "PROMO_USED", "Вы уже применили этот промокод");
      if (promo.redeemed_count >= promo.max_redemptions) throw new HttpError(409, "PROMO_LIMIT", "Промокод больше недоступен");
      const [settings] = await tx.query<{ attempt_ttl_days: number }>("SELECT attempt_ttl_days FROM roulette_settings WHERE id=true");
      const [credit] = await tx.query<{ id: string; expires_at: string }>(
        `INSERT INTO roulette_attempt_credits(user_id,source_type,source_key,granted,expires_at,reason)
         VALUES($1,'promo',$2,1,now()+$3*interval '1 day',$4) RETURNING id,expires_at`,
        [session.user_id, promo.id, settings.attempt_ttl_days, promo.label],
      );
      await tx.query("INSERT INTO roulette_promo_redemptions(promo_id,user_id,credit_id) VALUES($1,$2,$3)", [promo.id, session.user_id, credit.id]);
      await tx.query("UPDATE roulette_promo_codes SET redeemed_count=redeemed_count+1 WHERE id=$1", [promo.id]);
      return { label: promo.label, expiresAt: credit.expires_at };
    });
    return json(result, 201);
  }
  if (!path.startsWith("admin/roulette/promos")) return null;
  const staff = await requireStaff(request, request.method === "GET" ? "viewer" : "admin");
  if (path === "admin/roulette/promos" && request.method === "GET")
    return json({ items: await query("SELECT id,code_hint,label,starts_at,expires_at,max_redemptions,redeemed_count,active,version,created_by,created_at FROM roulette_promo_codes ORDER BY created_at DESC LIMIT 200") });
  requireOrigin(request);
  await rateLimit("staff-roulette-promo:" + staff.id, 30);
  if (path === "admin/roulette/promos" && request.method === "POST") {
    const input = await body(request, z.object({ label: z.string().trim().min(2).max(100), startsAt: z.iso.datetime({ offset: true }), expiresAt: z.iso.datetime({ offset: true }), maxRedemptions: z.number().int().min(1).max(1000000) }));
    if (input.startsAt >= input.expiresAt) throw new HttpError(422, "PROMO_DATES", "Дата окончания должна быть позже начала");
    if (new Date(input.expiresAt).getTime() <= Date.now()) throw new HttpError(422, "PROMO_DATES", "Укажите будущую дату окончания");
    const key = operationKey(request);
    const code = "RPM-" + randomBytes(16).toString("hex").toUpperCase();
    const result = await transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["roulette-promo-create:" + staff.id + ":" + key]);
      const [old] = await tx.query("SELECT id FROM roulette_promo_codes WHERE created_by=$1 AND idempotency_key=$2", [staff.id, key]);
      if (old) throw new HttpError(409, "PROMO_ALREADY_CREATED", "Промокод уже создан этим запросом. Код показывался при создании");
      const [promo] = await tx.query<{ id: string }>(
        `INSERT INTO roulette_promo_codes(code_hash,code_hint,label,starts_at,expires_at,max_redemptions,created_by,idempotency_key)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [hashCode(code), code.slice(-4), input.label, input.startsAt, input.expiresAt, input.maxRedemptions, staff.id, key],
      );
      await tx.query("INSERT INTO audit_logs(actor_id,actor_role,action,entity_type,entity_id,reason,after_data) VALUES($1,$2,'roulette.promo.create','roulette_promo',$3,'Создание промокода',$4)", [staff.id, staff.role, promo.id, JSON.stringify({ label: input.label, maxRedemptions: input.maxRedemptions })]);
      return { id: promo.id, code };
    });
    return json(result, 201);
  }
  const match = path.match(/^admin\/roulette\/promos\/([a-f0-9-]{36})$/);
  if (match && request.method === "PATCH") {
    const input = await body(request, z.object({ active: z.boolean(), expectedVersion: z.number().int().positive() }));
    const result = await transaction(async (tx) => {
      const [promo] = await tx.query<{ version: number; active: boolean }>("SELECT version,active FROM roulette_promo_codes WHERE id=$1 FOR UPDATE", [match[1]]);
      if (!promo || promo.version !== input.expectedVersion) throw new HttpError(409, "VERSION_CONFLICT", "Промокод изменился. Обновите список");
      const [changed] = await tx.query("UPDATE roulette_promo_codes SET active=$2,version=version+1,updated_at=now() WHERE id=$1 RETURNING id,code_hint,label,starts_at,expires_at,max_redemptions,redeemed_count,active,version", [match[1], input.active]);
      await tx.query("INSERT INTO audit_logs(actor_id,actor_role,action,entity_type,entity_id,reason,before_data,after_data) VALUES($1,$2,'roulette.promo.update','roulette_promo',$3,'Изменение промокода',$4,$5)", [staff.id, staff.role, match[1], JSON.stringify(promo), JSON.stringify(changed)]);
      return changed;
    });
    return json(result);
  }
  return null;
}
