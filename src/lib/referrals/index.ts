import { createHash } from "node:crypto";
import { query, transaction, type Db } from "@/lib/db";
import { HttpError } from "@/lib/http";
import type { Actor } from "@/lib/loyalty";
import {
  referralProgramSchema,
  issueAwardSchema,
  type ReferralProgram,
  type ReferralAward,
} from "./contracts";

const db: Db = { query };
type Referral = {
  id: string;
  referrer_id: string;
  referred_id: string;
  manual_version_id?: string | null;
};
export async function getReferralProgram(
  tx: Db = db,
): Promise<ReferralProgram | null> {
  const [row] = await tx.query<ReferralProgram>(
    "SELECT * FROM referral_program_versions ORDER BY version DESC LIMIT 1",
  );
  return row ?? null;
}
async function log(
  tx: Db,
  actor: Actor,
  action: string,
  id: string,
  reason: string,
  before: unknown,
  after: unknown,
  key: string,
) {
  await tx.query(
    "INSERT INTO audit_logs(actor_id,actor_role,action,entity_type,entity_id,reason,before_data,after_data,request_id) VALUES($1,$2,$3,'referral',$4,$5,$6,$7,$8)",
    [
      actor.id,
      actor.role,
      action,
      id,
      reason,
      JSON.stringify(before),
      JSON.stringify(after),
      key,
    ],
  );
}
async function mutation<T>(
  scope: string,
  key: string,
  input: unknown,
  actor: Actor,
  admin: boolean,
  work: (tx: Db) => Promise<T>,
) {
  if (!(admin ? ["admin"] : ["admin", "manager"]).includes(actor.role))
    throw new HttpError(403, "FORBIDDEN", "Недостаточно прав");
  if (!key || key.length > 200)
    throw new HttpError(422, "IDEMPOTENCY_REQUIRED", "Нужен ключ операции");
  const hash = createHash("sha256")
    .update(JSON.stringify({ input, actorId: actor.id }))
    .digest("hex");
  return transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      scope + ":" + key,
    ]);
    const [old] = await tx.query<{ payload_hash: string; result: T }>(
      "SELECT payload_hash,result FROM idempotency_requests WHERE scope=$1 AND key=$2",
      [scope, key],
    );
    if (old) {
      if (old.payload_hash !== hash)
        throw new HttpError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Ключ уже использован для других данных",
        );
      return old.result;
    }
    const result = await work(tx);
    await tx.query(
      "INSERT INTO idempotency_requests(scope,key,payload_hash,result) VALUES($1,$2,$3,$4)",
      [scope, key, hash, JSON.stringify(result)],
    );
    return result;
  });
}
export async function publishReferralProgram(
  raw: unknown,
  key: string,
  actor: Actor,
) {
  const input = referralProgramSchema.parse(raw);
  return mutation("referral_program", key, input, actor, true, async (tx) => {
    await tx.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('referral-program-publish',0))",
    );
    const before = await getReferralProgram(tx);
    if ((before?.version ?? 0) !== input.expectedVersion)
      throw new HttpError(
        409,
        "REFERRAL_STALE",
        "Условия уже изменены. Обновите страницу.",
      );
    const [after] = await tx.query<ReferralProgram>(
      `INSERT INTO referral_program_versions(version,enabled,referrer,referred,activated_at,created_by,reason)
      VALUES($1,$2,$3,$4,coalesce($5::timestamptz,CASE WHEN $2 THEN clock_timestamp() END),$6,$7) RETURNING *`,
      [
        (before?.version ?? 0) + 1,
        input.enabled,
        JSON.stringify(input.referrer),
        JSON.stringify(input.referred),
        before?.activated_at ?? null,
        actor.id,
        input.reason,
      ],
    );
    await log(
      tx,
      actor,
      "referral_program.publish",
      after.id,
      input.reason,
      before,
      after,
      key,
    );
    return after;
  });
}

// Called only after the existing first-rental eligibility check, inside its transaction.
// Returns false for pre-activation rentals: their existing economics remain unchanged.
export async function qualifyManualReferral(
  tx: Db,
  ref: Referral,
  rentalId: string,
  programId: string,
  actor: Actor,
): Promise<boolean> {
  const policy = await getReferralProgram(tx);
  if (!policy?.activated_at) return false;
  const [eligible] = await tx.query<{ eligible: boolean }>(
    "SELECT created_at >= $2::timestamptz AND mode='operational' AS eligible FROM rentals WHERE id=$1",
    [rentalId, policy.activated_at],
  );
  if (!eligible?.eligible) return false;
  if (!policy.enabled) {
    await tx.query(
      "UPDATE referrals SET status='ineligible',reason='manual_program_disabled',qualifying_rental_id=$2,manual_version_id=$3 WHERE id=$1",
      [ref.id, rentalId, policy.id],
    );
    return true;
  }
  await tx.query(
    "UPDATE referrals SET status='qualified',qualifying_rental_id=$2,manual_version_id=$3,program_version_id=$4,referrer_reward=0,referred_reward=0 WHERE id=$1",
    [ref.id, rentalId, policy.id, programId],
  );
  await createManualAwards(
    tx,
    { ...ref, manual_version_id: policy.id },
    rentalId,
    actor,
  );
  return true;
}
export async function createManualAwards(
  tx: Db,
  ref: Referral,
  rentalId: string,
  actor: Actor,
) {
  const states = await tx.query<{ status: string }>(
    "SELECT status FROM users WHERE id=ANY($1::uuid[])",
    [[ref.referrer_id, ref.referred_id]],
  );
  if (states.some((u) => u.status === "blocked")) {
    await tx.query("UPDATE referrals SET reason='blocked_hold' WHERE id=$1", [
      ref.id,
    ]);
    return;
  }
  const [policy] = await tx.query<ReferralProgram>(
    "SELECT * FROM referral_program_versions WHERE id=$1",
    [ref.manual_version_id],
  );
  if (!policy) throw new Error("REFERRAL_POLICY_MISSING");
  for (const [side, id] of [
    ["referrer", ref.referrer_id],
    ["referred", ref.referred_id],
  ] as const) {
    const reward = policy[side];
    const [award] = await tx.query<ReferralAward>(
      `INSERT INTO referral_manual_awards(referral_id,beneficiary_user_id,side,rental_id,program_version_id,title,terms)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(referral_id,side) DO NOTHING RETURNING *`,
      [ref.id, id, side, rentalId, policy.id, reward.title, reward.terms],
    );
    if (award)
      await log(
        tx,
        actor,
        "referral_award.create",
        award.id,
        "Первая завершённая оплаченная аренда",
        null,
        award,
        award.id,
      );
  }
  await tx.query("UPDATE referrals SET reason='manual_pending' WHERE id=$1", [
    ref.id,
  ]);
}
export async function issueReferralAward(
  id: string,
  raw: unknown,
  key: string,
  actor: Actor,
) {
  const input = issueAwardSchema.parse(raw);
  return mutation(
    "referral_issue",
    key,
    { id, ...input },
    actor,
    false,
    async (tx) => {
      const [source] = await tx.query<{
        external_rental_id: string;
        rental_id: string;
        referral_id: string;
        referrer_id: string;
        referred_id: string;
      }>(
        `SELECT a.rental_id,a.referral_id,r.external_rental_id,f.referrer_id,f.referred_id FROM referral_manual_awards a JOIN rentals r ON r.id=a.rental_id JOIN referrals f ON f.id=a.referral_id WHERE a.id=$1`,
        [id],
      );
      if (!source)
        throw new HttpError(404, "AWARD_NOT_FOUND", "Награда не найдена");
      // Match the rental cancellation lock order to serialize issue vs cancellation.
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "rental:" + source.external_rental_id,
      ]);
      await tx.query(
        "SELECT user_id FROM loyalty_accounts WHERE user_id=ANY($1::uuid[]) ORDER BY user_id FOR UPDATE",
        [[source.referrer_id, source.referred_id]],
      );
      await tx.query("SELECT id FROM referrals WHERE id=$1 FOR UPDATE", [
        source.referral_id,
      ]);
      const [before] = await tx.query<ReferralAward>(
        "SELECT * FROM referral_manual_awards WHERE id=$1 FOR UPDATE",
        [id],
      );
      if (before.status === "issued") return before;
      if (before.status !== "pending")
        throw new HttpError(
          409,
          "AWARD_UNAVAILABLE",
          "Эту награду нельзя выдать",
        );
      const [rental] = await tx.query<{
        status: string;
        payment_status: string;
      }>("SELECT status,payment_status FROM rentals WHERE id=$1", [
        source.rental_id,
      ]);
      if (rental.status !== "completed" || rental.payment_status !== "paid")
        throw new HttpError(
          409,
          "AWARD_RENTAL_UNAVAILABLE",
          "Аренда не завершена или не оплачена",
        );
      const blocked = await tx.query(
        "SELECT id FROM users WHERE id=ANY($1::uuid[]) AND status='blocked'",
        [[source.referrer_id, source.referred_id]],
      );
      if (blocked.length)
        throw new HttpError(
          409,
          "AWARD_BLOCKED",
          "Выдача приостановлена: участник заблокирован",
        );
      const [after] = await tx.query<ReferralAward>(
        "UPDATE referral_manual_awards SET status='issued',issued_at=clock_timestamp(),issued_by=$2,issue_comment=$3 WHERE id=$1 RETURNING *",
        [id, actor.id, input.comment],
      );
      await log(
        tx,
        actor,
        "referral_award.issue",
        id,
        input.comment,
        before,
        after,
        key,
      );
      await tx.query(
        "UPDATE referrals SET status='rewarded',rewarded_at=clock_timestamp(),reason=NULL WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM referral_manual_awards WHERE referral_id=$1 AND status<>'issued')",
        [source.referral_id],
      );
      return after;
    },
  );
}
export async function cancelManualAwards(
  tx: Db,
  rentalId: string,
  actor: Actor,
  reason: string,
  key: string,
) {
  const awards = await tx.query<ReferralAward>(
    "SELECT * FROM referral_manual_awards WHERE rental_id=$1 AND status IN ('pending','issued') ORDER BY id FOR UPDATE",
    [rentalId],
  );
  for (const before of awards) {
    const [after] = await tx.query<ReferralAward>(
      "UPDATE referral_manual_awards SET status=$2,cancelled_at=clock_timestamp() WHERE id=$1 RETURNING *",
      [before.id, before.status === "issued" ? "review" : "cancelled"],
    );
    await log(
      tx,
      actor,
      "referral_award.cancel",
      before.id,
      reason,
      before,
      after,
      key,
    );
  }
}
