import { randomUUID } from 'node:crypto';
import { query, transaction } from '@/lib/db';
import { expireBonuses, retryReferrals, recalculateTiers, reconcileAccounts } from '@/lib/loyalty';
import { processQueuedImports } from '@/lib/imports/service';
import { deliverTelegram, type Delivery, type OutboxEvent } from './telegram';
import { ProviderError, retryDelay } from './provider';
import { scheduleClubTriggers } from '@/lib/club/triggers';
import { maintenanceStage,MaintenanceStageError } from './diagnostics';
import { processNotifications } from '@/lib/notifications/engine';
import { reconcileRegistrationCredits } from '@/lib/roulette/credits';
import { drawDueGiveaways, refreshGiveawayParticipants } from '@/lib/giveaways';

const TELEGRAM_EVENTS = ['BONUS_CHANGED', 'TIER_CHANGED', 'RPM_DROP', 'BOT_WELCOME', 'CLUB_TRIGGER', 'ROULETTE_ATTEMPTS_GRANTED', 'GIVEAWAY_PUBLISHED', 'GIVEAWAY_WON'];
const LEASE_SECONDS = 120;
const MAX_DELIVERY_ATTEMPTS = 7;
export async function expandOutbox(limit = 100, eventIds?: string[]) {
  return transaction(async tx => {
    const events = await tx.query<OutboxEvent>(`SELECT * FROM outbox_events WHERE expanded_at IS NULL AND event_type<>'PROGRAM_PUBLISHED' AND ($2::uuid[] IS NULL OR id=ANY($2::uuid[])) ORDER BY created_at,id LIMIT $1 FOR UPDATE SKIP LOCKED`, [Math.max(1, Math.min(limit, 500)), eventIds ?? null]);
    for (const event of events) {
      if (TELEGRAM_EVENTS.includes(event.event_type)) {
        const [user] = event.user_id ? await tx.query<{ telegram_id: string | null; status: string; telegram_reachable: boolean; member_since: string | null }>('SELECT u.telegram_id,u.status,u.telegram_reachable,a.member_since FROM users u LEFT JOIN loyalty_accounts a ON a.user_id=u.id WHERE u.id=$1', [event.user_id]) : [];
        const welcomeTarget = event.payload.telegram_id;
        const target = user?.telegram_id ?? (event.event_type === 'BOT_WELCOME' && typeof welcomeTarget === 'string' && /^\d{1,20}$/.test(welcomeTarget) ? welcomeTarget : null);
        if (target) {
          const suppress = event.payload.notify === false || (event.event_type !== 'BOT_WELCOME' && (!user || user.status !== 'active' || !user.telegram_reachable || !user.member_since || new Date(event.created_at) < new Date(user.member_since)));
          await tx.query(`INSERT INTO deliveries(event_id,channel,target,status) VALUES($1,'telegram',$2,$3) ON CONFLICT DO NOTHING`, [event.id, target, suppress ? 'suppressed' : 'pending']);
        }
      }
      await tx.query('UPDATE outbox_events SET expanded_at=clock_timestamp() WHERE id=$1', [event.id]);
    }
    return events.length;
  });
}
export async function claimDelivery(eventIds?: string[]) {
  return transaction(async tx => {
    // A crashed worker never calls failDelivery. Count its lost lease as an attempt,
    // but let a live seventh lease finish. Bounded cleanup avoids locking the queue.
    await tx.query(`WITH exhausted AS (
      SELECT d.id FROM deliveries d WHERE d.attempts >= $2
        AND (d.status IN ('pending','retry') OR (d.status='processing' AND d.lease_until<now()))
        AND ($1::uuid[] IS NULL OR d.event_id=ANY($1::uuid[]))
      ORDER BY d.created_at,d.id LIMIT 100 FOR UPDATE SKIP LOCKED
    ) UPDATE deliveries d SET status='dead',lease_until=NULL,lease_token=NULL,last_error='DELIVERY_ATTEMPTS_EXHAUSTED',updated_at=clock_timestamp()
      FROM exhausted e WHERE d.id=e.id`, [eventIds ?? null, MAX_DELIVERY_ATTEMPTS]);
    const [row] = await tx.query<{ id: string }>(`SELECT d.id FROM deliveries d WHERE d.attempts < $2 AND ((d.status IN ('pending','retry') AND d.next_attempt_at<=now()) OR (d.status='processing' AND d.lease_until<now())) AND ($1::uuid[] IS NULL OR d.event_id=ANY($1::uuid[])) ORDER BY d.next_attempt_at,d.created_at,d.id LIMIT 1 FOR UPDATE SKIP LOCKED`, [eventIds ?? null, MAX_DELIVERY_ATTEMPTS]);
    if (!row) return null;
    const token = randomUUID();
    await tx.query(`UPDATE deliveries SET status='processing',attempts=attempts+1,lease_token=$2,lease_until=clock_timestamp()+$3*interval '1 second',updated_at=clock_timestamp() WHERE id=$1`, [row.id, token, LEASE_SECONDS]);
    const [delivery] = await tx.query<Delivery>(`SELECT e.*,d.id AS delivery_id,d.channel,d.target,d.attempts,d.lease_token FROM deliveries d JOIN outbox_events e ON e.id=d.event_id WHERE d.id=$1`, [row.id]);
    return delivery;
  });
}
export async function finishDelivery(delivery: Delivery, status: 'succeeded' | 'suppressed', version?: string | null) {
  await transaction(async tx => {
    await tx.query(`UPDATE deliveries SET status=$3,delivered_version=$4,lease_until=NULL,lease_token=NULL,last_error=NULL,updated_at=clock_timestamp() WHERE id=$1 AND lease_token=$2 AND status='processing' RETURNING id`, [delivery.delivery_id, delivery.lease_token, status, version ?? null]);
  });
}
export async function failDelivery(delivery: Delivery, error: unknown) {
  const provider = error instanceof ProviderError ? error : null;
  const dead = provider?.permanent || delivery.attempts >= MAX_DELIVERY_ATTEMPTS;
  const label = provider?.message ?? (error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code.slice(0, 80) : 'DELIVERY_FAILED');
  const delay = retryDelay(delivery.attempts, provider?.retryAfterSeconds);
  await transaction(async tx => {
    await tx.query(`UPDATE deliveries SET status=$3,next_attempt_at=clock_timestamp()+$4*interval '1 millisecond',lease_until=NULL,lease_token=NULL,last_error=$5,updated_at=clock_timestamp() WHERE id=$1 AND lease_token=$2 AND status='processing' RETURNING id`, [delivery.delivery_id, delivery.lease_token, dead ? 'dead' : 'retry', delay, label]);
  });
  return dead ? 'dead' : 'retry';
}
export async function processProgramRecalculations(limit = 50, eventId?: string) {
  return transaction(async tx => {
    // One durable publication page per run. Concurrent workers do not advance the same cursor.
    const [lock] = await tx.query<{ acquired: boolean }>("SELECT pg_try_advisory_xact_lock(hashtextextended('jobs:program-recalculation',0)) AS acquired");
    if (!lock.acquired) return null;
    const [event] = await tx.query<{ id: string; payload: { programVersionId?: string; recalculateCursor?: string | null } }>(`SELECT id,payload FROM outbox_events WHERE event_type='PROGRAM_PUBLISHED' AND expanded_at IS NULL AND ($1::uuid IS NULL OR id=$1) ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`, [eventId ?? null]);
    if (!event) return null;
    if (!event.payload.programVersionId) throw new Error('PROGRAM_EVENT_VERSION_MISSING');
    const page = await recalculateTiers({ limit, cursor: event.payload.recalculateCursor, programVersionId: event.payload.programVersionId });
    await tx.query(`UPDATE outbox_events SET payload=payload||$2::jsonb,expanded_at=CASE WHEN $3 THEN clock_timestamp() ELSE NULL END WHERE id=$1`, [event.id, JSON.stringify({ recalculateCursor: page.nextCursor }), page.done]);
    return { eventId: event.id, ...page };
  });
}
async function maintenance() {
  const startedAt = new Date().toISOString();
  const stage = <T>(name:string,work:()=>Promise<T>)=>maintenanceStage(name,work,startedAt);
  const triggers = await stage('triggers',()=>scheduleClubTriggers());
  await stage('autopush',()=>processNotifications(2));
  await stage('roulette_registration_credits',()=>reconcileRegistrationCredits(200));
  const expired = await stage('bonus_expiration',()=>expireBonuses(50));
  const referrals = await stage('referrals',()=>retryReferrals());
  const imports = await stage('imports',()=>processQueuedImports(1));
  await stage('giveaway_participants',()=>refreshGiveawayParticipants());
  await stage('giveaway_draws',()=>drawDueGiveaways());
  const program = await stage('program_recalculation',()=>processProgramRecalculations(50));
  // Record success only after reconciliation. A five-minute claim permits retry after a crash.
  const claim = await stage('reconciliation_claim',()=>query(`INSERT INTO program_settings(key,value) VALUES('jobs:reconcile',jsonb_build_object('lease',now()+interval '5 minutes')) ON CONFLICT(key) DO UPDATE SET value=program_settings.value||jsonb_build_object('lease',now()+interval '5 minutes') WHERE coalesce((program_settings.value->>'lease')::timestamptz,'epoch')<now() AND coalesce((program_settings.value->>'completed')::timestamptz,'epoch')<now()-interval '1 day' RETURNING key`));
  if (claim.length) {
    await stage('reconciliation',async()=>{
    const differences = await reconcileAccounts();
    if (differences.length) await query(`INSERT INTO operational_errors(kind,details) VALUES('reconciliation',$1)`, [JSON.stringify({ count: differences.length, userIds: [...new Set(differences.map(row => row.userId))].slice(0, 100) })]);
    await query(`UPDATE program_settings SET value=jsonb_build_object('completed',now()),updated_at=now() WHERE key='jobs:reconcile'`);
    });
  }
  await stage('maintenance_status',()=>query(`INSERT INTO program_settings(key,value) VALUES('jobs:last-maintenance-success',jsonb_build_object('at',clock_timestamp())) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=clock_timestamp()`));
  return { expired, referrals, imports, program, triggers };
}
export async function processJobs(options: { limit?: number; maintenance?: boolean; eventIds?: string[]; timeBudgetMs?: number } = {}) {
  const started = Date.now(), budget = Math.max(1000, Math.min(options.timeBudgetMs ?? 45000, 50000));
  const result = { expanded: 0, succeeded: 0, suppressed: 0, retry: 0, dead: 0, maintenance: null as Awaited<ReturnType<typeof maintenance>> | null };
  if (options.maintenance !== false) {
    try { result.maintenance = await maintenance(); }
    catch (error) { await query(`INSERT INTO operational_errors(kind,details) VALUES('job_maintenance',$1)`,[JSON.stringify({message:'Фоновое обслуживание не завершено; будет повторено',stage:error instanceof MaintenanceStageError ? error.stage : 'unknown',code:error instanceof MaintenanceStageError ? error.safeCode : 'UNEXPECTED_ERROR',runId:randomUUID()})]); }
  }
  result.expanded = await expandOutbox(100, options.eventIds);
  const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
  for (let i = 0; i < limit && Date.now() - started < budget; i++) {
    const delivery = await claimDelivery(options.eventIds);
    if (!delivery) break;
    try {
      if (delivery.channel === 'telegram') { const status = await deliverTelegram(delivery); await finishDelivery(delivery, status); result[status]++; }
      else {
        // Retired delivery channels are closed without contacting a provider.
        await finishDelivery(delivery, 'suppressed'); result.suppressed++;
      }
    } catch (error) { result[await failDelivery(delivery, error)]++; }
  }
  await query(`INSERT INTO program_settings(key,value) VALUES('jobs:last-run',jsonb_build_object('at',now())) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()`);
  return result;
}
