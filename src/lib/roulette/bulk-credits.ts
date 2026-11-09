import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { query, transaction, type Db } from "@/lib/db";
import { HttpError } from "@/lib/http";
import { TIER_CODES, type TierRule } from "@/lib/loyalty/rules";

const amounts = z.partialRecord(z.enum(TIER_CODES), z.number().int().min(0).max(100));
export const bulkCreditInput = z.object({
  mode: z.enum(["all", "tiers"]),
  amount: z.number().int().min(1).max(100).optional(),
  amounts: amounts.optional(),
  reason: z.string().trim().min(10).max(500),
  expectedVersion: z.number().int().positive(),
}).refine((v) => v.mode === "all" ? v.amount !== undefined : v.amounts !== undefined);
export type BulkCreditInput = z.infer<typeof bulkCreditInput>;

type Audience = { tier: string; count: number };
type ProgramRow = { id: string; version: number; tiers: TierRule[] };
async function currentProgram(db: Db) {
  const [program] = await db.query<ProgramRow>("SELECT id,version,tiers FROM program_versions ORDER BY version DESC LIMIT 1");
  if (!program) throw new HttpError(503, "PROGRAM_MISSING", "Программа лояльности не найдена");
  return program;
}
async function audience(db: Db) {
  return db.query<Audience>("SELECT a.achieved_tier tier,count(*)::int count FROM loyalty_accounts a JOIN users u ON u.id=a.user_id WHERE u.status='active' GROUP BY a.achieved_tier");
}
function summarize(program: ProgramRow, counts: Audience[], mode: "all" | "tiers", amount: number, perTier: Record<string, number>) {
  const tiers = program.tiers.map((tier) => {
    const count = counts.find((row) => row.tier === tier.code)?.count ?? 0;
    const granted = mode === "all" ? amount : (perTier[tier.code] ?? 0);
    return { code: tier.code, name: tier.displayName || tier.code, count, amount: granted, recipients: granted ? count : 0, attempts: count * granted };
  });
  return { programVersion: program.version, tiers, recipients: tiers.reduce((sum, row) => sum + row.recipients, 0), attempts: tiers.reduce((sum, row) => sum + row.attempts, 0) };
}
export async function previewBulkCredits(mode: "all" | "tiers", amount = 0, perTier: Record<string, number> = {}) {
  const [program, counts, settings] = await Promise.all([
    currentProgram({ query }), audience({ query }), query<{ attempt_ttl_days: number }>("SELECT attempt_ttl_days FROM roulette_settings WHERE id=true"),
  ]);
  return { ...summarize(program, counts, mode, amount, perTier), expiresInDays: settings[0]?.attempt_ttl_days ?? 30 };
}
export async function issueBulkCredits(input: BulkCreditInput, actorId: string, key: string) {
  const scope = "roulette.bulk:" + actorId;
  const payload = JSON.stringify(input);
  const hash = createHash("sha256").update(payload).digest("hex");
  return transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [scope + ":" + key]);
    const [prior] = await tx.query<{ payload_hash: string; result: unknown }>("SELECT payload_hash,result FROM idempotency_requests WHERE scope=$1 AND key=$2", [scope, key]);
    if (prior) {
      if (prior.payload_hash !== hash) throw new HttpError(409, "IDEMPOTENCY_CONFLICT", "Ключ уже использован для другой выдачи");
      return prior.result;
    }
    await tx.query("LOCK TABLE program_versions IN SHARE MODE");
    const program = await currentProgram(tx);
    if (program.version !== input.expectedVersion) throw new HttpError(409, "PROGRAM_CHANGED", "Уровни программы изменились. Проверьте выдачу заново");
    await tx.query("SELECT a.user_id FROM loyalty_accounts a JOIN users u ON u.id=a.user_id WHERE u.status='active' ORDER BY a.user_id FOR SHARE OF a,u");
    const counts = await audience(tx);
    const summary = summarize(program, counts, input.mode, input.amount ?? 0, input.amounts ?? {});
    if (!summary.recipients) throw new HttpError(422, "EMPTY_AUDIENCE", "Нет участников для выдачи");
    if (summary.recipients > 10000 || summary.attempts > 100000) throw new HttpError(422, "BULK_LIMIT", "Выдача слишком большая. Уменьшите число попыток");
    const batchId = randomUUID();
    const [settings] = await tx.query<{ attempt_ttl_days: number }>("SELECT attempt_ttl_days FROM roulette_settings WHERE id=true");
    const [inserted] = await tx.query<{ count: number }>(
      `WITH granted AS (
         INSERT INTO roulette_attempt_credits(user_id,source_type,source_key,granted,expires_at,reason,actor_id)
         SELECT a.user_id,'manual',$1,
           CASE WHEN $2::text='all' THEN $3::int ELSE coalesce(($4::jsonb->>a.achieved_tier)::int,0) END,
           now()+$5::int*interval '1 day',$6,$7
         FROM loyalty_accounts a JOIN users u ON u.id=a.user_id
         WHERE u.status='active'
           AND CASE WHEN $2::text='all' THEN $3::int ELSE coalesce(($4::jsonb->>a.achieved_tier)::int,0) END > 0
         RETURNING id
       ) SELECT count(*)::int count FROM granted`,
      ["bulk:" + batchId, input.mode, input.amount ?? 0, JSON.stringify(input.amounts ?? {}), settings.attempt_ttl_days, input.reason, actorId],
    );
    if (inserted.count !== summary.recipients) throw new HttpError(409, "AUDIENCE_CHANGED", "Состав участников изменился. Проверьте выдачу заново");
    const result = { batchId, ...summary, expiresInDays: settings.attempt_ttl_days };
    await tx.query("INSERT INTO audit_logs(actor_id,actor_role,action,entity_type,entity_id,reason,after_data) VALUES($1,'admin','roulette.credit.bulk','roulette_credit_batch',$2,$3,$4)", [actorId, batchId, input.reason, JSON.stringify(result)]);
    await tx.query("INSERT INTO idempotency_requests(scope,key,payload_hash,result) VALUES($1,$2,$3,$4)", [scope, key, hash, JSON.stringify(result)]);
    return result;
  });
}
