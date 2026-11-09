import { query, transaction, type Db } from "@/lib/db";
import { moscowDate } from "@/lib/club/contracts";
import { HttpError } from "@/lib/http";

export type Credit = {
  id: string;
  user_id: string;
  source_type: "registration" | "promo" | "manual";
  source_key: string;
  granted: number;
  consumed: number;
  expires_at: string;
  reason: string | null;
  created_at: string;
};

export async function reconcileRegistrationCredits(limit = 200) {
  const rows = await query<{ id: string }>(
    `INSERT INTO roulette_attempt_credits(user_id,source_type,source_key,granted,expires_at,reason)
     SELECT u.id,'registration',u.id::text,s.registration_attempts,
       u.first_activated_at+s.attempt_ttl_days*interval '1 day','Завершение регистрации'
     FROM users u CROSS JOIN roulette_settings s
     WHERE s.id=true AND s.registration_attempts>0 AND s.registration_enabled_at IS NOT NULL
       AND u.status='active' AND u.first_activated_at>=s.registration_enabled_at
       AND u.first_activated_at+s.attempt_ttl_days*interval '1 day'>now()
       AND NOT EXISTS(SELECT 1 FROM roulette_attempt_credits c WHERE c.user_id=u.id AND c.source_type='registration')
     ORDER BY u.first_activated_at,u.id LIMIT $1 ON CONFLICT DO NOTHING RETURNING id`,
    [Math.max(1, Math.min(limit, 1000))],
  );
  return rows.length;
}

export async function creditBalance(db: Db, userId: string) {
  const [row] = await db.query<{ remaining: number }>(
    `SELECT coalesce(sum(granted-consumed),0)::int remaining FROM roulette_attempt_credits
     WHERE user_id=$1 AND expires_at>now()`, [userId],
  );
  const [legacy] = await db.query<{ remaining: number }>(
    `SELECT greatest(granted-consumed,0) remaining FROM roulette_attempt_grants
     WHERE user_id=$1 AND period_key=$2`, [userId, moscowDate()],
  );
  return (row?.remaining ?? 0) + (legacy?.remaining ?? 0);
}

export async function nextCredit(db: Db, userId: string) {
  const [credit] = await db.query<Credit>(
    `SELECT * FROM roulette_attempt_credits WHERE user_id=$1 AND expires_at>now()
       AND consumed<granted ORDER BY expires_at,id LIMIT 1 FOR UPDATE`, [userId],
  );
  const [legacy] = await db.query<{ id: string }>(
    `SELECT id FROM roulette_attempt_grants WHERE user_id=$1 AND period_key=$2
       AND consumed<granted FOR UPDATE`, [userId, moscowDate()],
  );
  if (legacy && (!credit || new Date(moscowDate() + "T21:00:00.000Z") < new Date(credit.expires_at)))
    return { kind: "legacy" as const, id: legacy.id };
  return credit ? { kind: "credit" as const, id: credit.id } : null;
}

export async function issueManualCredit(input: { userId: string; amount: number; reason: string; key: string }, actorId: string) {
  return transaction(async (tx) => {
    const sourceKey = actorId + ":" + input.key;
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["roulette-manual:" + sourceKey]);
    const [prior] = await tx.query<Credit>("SELECT * FROM roulette_attempt_credits WHERE source_type='manual' AND source_key=$1", [sourceKey]);
    if (prior) {
      if (prior.user_id !== input.userId || prior.granted !== input.amount || prior.reason !== input.reason)
        throw new HttpError(409, "IDEMPOTENCY_CONFLICT", "Ключ уже использован для другой выдачи");
      return prior;
    }
    const [user] = await tx.query<{ id: string }>("SELECT id FROM users WHERE id=$1 AND status='active' FOR SHARE", [input.userId]);
    if (!user) throw new HttpError(404, "MEMBER_NOT_FOUND", "Активный участник не найден");
    const [settings] = await tx.query<{ attempt_ttl_days: number }>("SELECT attempt_ttl_days FROM roulette_settings WHERE id=true");
    const [credit] = await tx.query<Credit>(
      `INSERT INTO roulette_attempt_credits(user_id,source_type,source_key,granted,expires_at,reason,actor_id)
       VALUES($1,'manual',$2,$3,now()+$4*interval '1 day',$5,$6) RETURNING *`,
      [input.userId, sourceKey, input.amount, settings.attempt_ttl_days, input.reason, actorId],
    );
    await tx.query("INSERT INTO audit_logs(actor_id,actor_role,action,entity_type,entity_id,reason,after_data) VALUES($1,'admin','roulette.credit.manual','roulette_credit',$2,$3,$4)", [actorId, credit.id, input.reason, JSON.stringify({ userId: input.userId, amount: input.amount })]);
    return credit;
  });
}
