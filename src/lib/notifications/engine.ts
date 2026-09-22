import { query, transaction, type Db } from "@/lib/db";
import { getAccountSnapshot } from "@/lib/loyalty";
import { tierName } from "@/lib/loyalty/rules";
import { ProviderError, retryDelay } from "@/lib/jobs/provider";
import { reserveNotificationSlot } from "./budget";
import {
  notificationIds,
  defaultNotification,
  blockedNotifications,
  renderNotification,
  type NotificationRule,
  type NotificationConfig,
} from "./contracts";
const db: Db = { query };
export async function notificationRules(tx: Db = db) {
  await tx.query(
    "INSERT INTO notification_rules(id,config) SELECT value->>'id',value FROM jsonb_array_elements($1::jsonb) ON CONFLICT DO NOTHING",
    [JSON.stringify(notificationIds.map(defaultNotification))],
  );
  return tx.query<NotificationRule>(
    "SELECT * FROM notification_rules ORDER BY id",
  );
}
export async function recordActivity(
  input: {
    telegramId: string;
    userId: string | null;
    canMessage: boolean;
    registered: boolean;
  },
  tx: Db = db,
) {
  await tx.query(
    `INSERT INTO notification_activity(identity_key,user_id,telegram_id,registration_started_at,registered_at,can_message,last_open_at)
 VALUES('tg:'||$1,$2,$1::bigint,now(),CASE WHEN $4 THEN now() END,$3,now())
 ON CONFLICT(identity_key) DO UPDATE SET user_id=coalesce(excluded.user_id,notification_activity.user_id),registered_at=CASE WHEN $4 THEN coalesce(notification_activity.registered_at,now()) ELSE notification_activity.registered_at END,
 can_message=excluded.can_message,previous_open_at=CASE WHEN notification_activity.last_open_at<now()-interval '1 hour' THEN notification_activity.last_open_at ELSE notification_activity.previous_open_at END,
 return_open_at=CASE WHEN notification_activity.last_open_at<now()-interval '1 hour' THEN now() ELSE notification_activity.return_open_at END,last_open_at=now(),updated_at=now()`,
    [input.telegramId, input.userId, input.canMessage, input.registered],
  );
}
type Candidate = {
  identity_key: string;
  user_id: string | null;
  resource_id: string;
  occurrence_key: string;
  occurred_at: string;
  expires_at: string;
};
type Run = Candidate & {
  id: string;
  trigger_id: NotificationConfig["id"];
  config: NotificationConfig;
  attempts: number;
  reserved_at: string | null;
  scheduled_at: string;
  sent_at: string | null;
};
async function candidates(
  rule: NotificationRule,
  tx: Db = db,
  identity: string | null = null,
): Promise<Candidate[]> {
  const c = rule.config;
  if (!c.enabled || !rule.enabled_at || blockedNotifications[c.id]) return [];
  let source = "";
  const rental = `SELECT r.*,row_number() OVER(PARTITION BY user_id ORDER BY completed_at,id) ride_number FROM rentals r WHERE r.mode='operational' AND r.status='completed' AND r.completed_at IS NOT NULL`;
  switch (c.id) {
    case "REG_01":
      source = `SELECT a.identity_key,a.user_id,a.identity_key resource_id,a.registration_started_at::text occurrence_key,a.registration_started_at occurred_at,a.registration_started_at+interval '7 days' expires_at FROM notification_activity a WHERE a.registered_at IS NULL AND NOT EXISTS(SELECT 1 FROM users u WHERE u.telegram_id=a.telegram_id AND u.status='active')`;
      break;
    case "BOOK_01":
      source = `SELECT 'u:'||d.user_id identity_key,d.user_id,d.id::text resource_id,d.updated_at::text occurrence_key,d.updated_at occurred_at,least(d.start_date::timestamp AT TIME ZONE 'Europe/Moscow'+interval '1 day',d.updated_at+interval '7 days') expires_at FROM booking_drafts d WHERE d.completed_at IS NULL AND NOT EXISTS(SELECT 1 FROM rental_requests q WHERE q.user_id=d.user_id AND q.created_at>=d.created_at)`;
      break;
    case "RIDE_01":
    case "RIDE_02":
      source = `SELECT 'u:'||r.user_id identity_key,r.user_id,r.id::text resource_id,r.id::text occurrence_key,r.completed_at occurred_at,r.completed_at+interval '8 days' expires_at FROM (${rental}) r WHERE ${c.id === "RIDE_01" ? "ride_number=1" : "ride_number>1"}`;
      break;
    case "LVL_02":
      source = `SELECT 'u:'||e.user_id identity_key,e.user_id,e.id::text resource_id,e.id::text occurrence_key,e.created_at occurred_at,e.created_at+interval '7 days' expires_at FROM tier_events e JOIN loyalty_tiers f ON f.code=e.from_tier JOIN loyalty_tiers t ON t.code=e.to_tier WHERE t.rank>f.rank`;
      break;
    case "LVL_01":
      source = `SELECT 'u:'||a.user_id identity_key,a.user_id,a.user_id::text resource_id,a.account_version::text occurrence_key,coalesce((SELECT max(r.completed_at) FROM rentals r WHERE r.user_id=a.user_id AND r.status='completed' AND r.mode='operational'),a.member_since) occurred_at,now()+interval '1 day' expires_at FROM loyalty_accounts a WHERE a.total_rental_amount>0 AND EXISTS(SELECT 1 FROM (SELECT tiers FROM program_versions ORDER BY version DESC LIMIT 1) p CROSS JOIN LATERAL jsonb_array_elements(p.tiers) WITH ORDINALITY current_tier(value,ordinal) CROSS JOIN LATERAL jsonb_array_elements(p.tiers) WITH ORDINALITY next_tier(value,ordinal) WHERE current_tier.value->>'code'=coalesce(a.manual_override,a.achieved_tier) AND next_tier.ordinal=current_tier.ordinal+1 AND (next_tier.value->>'thresholdKopecks')::bigint-a.total_rental_amount BETWEEN 1 AND ($3::jsonb->>'nearAmountKopecks')::bigint)`;
      break;
    case "LOY_01":
      source = `SELECT 'u:'||a.user_id identity_key,a.user_id,a.user_id::text resource_id,coalesce((SELECT max(r.completed_at)::text FROM rentals r WHERE r.user_id=a.user_id AND r.status='completed' AND r.mode='operational'),'') occurrence_key,(SELECT max(r.completed_at) FROM rentals r WHERE r.user_id=a.user_id AND r.status='completed' AND r.mode='operational') occurred_at,now()+interval '1 day' expires_at FROM loyalty_accounts a WHERE a.bonus_available>($3::jsonb->>'minBonus')::bigint AND (SELECT count(*) FROM rentals r WHERE r.user_id=a.user_id AND r.status='completed' AND r.mode='operational' AND r.completed_at>coalesce((SELECT max(b.created_at) FROM bonus_transactions b WHERE b.user_id=a.user_id AND b.type='rental_payment'),'epoch'))>=($3::jsonb->>'unusedRides')::int`;
      break;
    case "RET_01":
      source = `SELECT 'u:'||r.user_id identity_key,r.user_id,r.user_id::text resource_id,r.last_at::text||':'||floor(extract(epoch FROM (now()-r.last_at))/greatest(3600,($3::jsonb->>'cooldownHours')::int*3600))::text occurrence_key,greatest(r.last_at+($3::jsonb->>'inactivityDays')::int*interval '1 day',$2::timestamptz) occurred_at,now()+interval '1 day' expires_at FROM (SELECT user_id,max(completed_at) last_at FROM rentals WHERE status='completed' AND mode='operational' GROUP BY user_id) r WHERE r.last_at<=now()-($3::jsonb->>'inactivityDays')::int*interval '1 day' AND NOT EXISTS(SELECT 1 FROM rental_requests q WHERE q.user_id=r.user_id AND q.created_at>r.last_at AND q.status IN ('pending','accepted'))`;
      break;
    case "APP_01":
      source = `SELECT 'u:'||a.user_id identity_key,a.user_id,a.identity_key resource_id,a.return_open_at::text occurrence_key,a.return_open_at occurred_at,a.return_open_at+interval '1 day' expires_at FROM notification_activity a WHERE a.user_id IS NOT NULL AND a.return_open_at-a.previous_open_at>=($3::jsonb->>'inactivityDays')::int*interval '1 day' AND NOT EXISTS(SELECT 1 FROM rental_requests q WHERE q.user_id=a.user_id AND q.created_at>=a.return_open_at)`;
      break;
    case "EXP_01":
    case "EXP_02":
      source = `SELECT 'u:'||l.user_id identity_key,l.user_id,to_char(l.expires_at AT TIME ZONE 'Europe/Moscow','YYYY-MM-DD') resource_id,to_char(l.expires_at AT TIME ZONE 'Europe/Moscow','YYYY-MM-DD') occurrence_key,greatest(min(l.expires_at)-($3::jsonb->>'expireHours')::int*interval '1 hour',$2::timestamptz) occurred_at,min(l.expires_at) expires_at FROM bonus_lots l WHERE l.remaining_amount>0 AND l.available_at<=now() AND l.expires_at>now() AND l.expires_at<=now()+($3::jsonb->>'expireHours')::int*interval '1 hour' GROUP BY l.user_id,to_char(l.expires_at AT TIME ZONE 'Europe/Moscow','YYYY-MM-DD')`;
      break;
    case "PROMO_01":
      source = `SELECT 'u:'||b.user_id identity_key,b.user_id,b.id::text resource_id,b.id::text occurrence_key,b.created_at occurred_at,b.created_at+interval '7 days' expires_at FROM bonus_transactions b WHERE b.type='manual_credit' AND b.reason<>'opening_balance' AND b.amount>0 AND NOT EXISTS(SELECT 1 FROM bonus_transactions r WHERE r.reverses_id=b.id)`;
      break;
    case "BDAY_01":
      source = `SELECT 'u:'||p.user_id identity_key,p.user_id,p.user_id::text resource_id,to_char(now() AT TIME ZONE 'Europe/Moscow','YYYY') occurrence_key,((now() AT TIME ZONE 'Europe/Moscow')::date+make_interval(hours=>($3::jsonb->>'morningHour')::int)) AT TIME ZONE 'Europe/Moscow' occurred_at,((now() AT TIME ZONE 'Europe/Moscow')::date+1)::timestamp AT TIME ZONE 'Europe/Moscow' expires_at FROM notification_profiles p WHERE p.birthday_consent_at IS NOT NULL AND to_char(p.birthday,'MM-DD')=to_char(now() AT TIME ZONE 'Europe/Moscow','MM-DD')`;
      break;
    case "ANNIV_01":
      source = `SELECT 'u:'||r.user_id identity_key,r.user_id,r.user_id::text resource_id,to_char(now() AT TIME ZONE 'Europe/Moscow','YYYY') occurrence_key,((now() AT TIME ZONE 'Europe/Moscow')::date+make_interval(hours=>($3::jsonb->>'morningHour')::int)) AT TIME ZONE 'Europe/Moscow' occurred_at,((now() AT TIME ZONE 'Europe/Moscow')::date+1)::timestamp AT TIME ZONE 'Europe/Moscow' expires_at FROM (SELECT user_id,min(completed_at) first_at FROM rentals WHERE status='completed' AND mode='operational' GROUP BY user_id) r WHERE (r.first_at AT TIME ZONE 'Europe/Moscow')::date<(date_trunc('year',now() AT TIME ZONE 'Europe/Moscow'))::date AND to_char(r.first_at AT TIME ZONE 'Europe/Moscow','MM-DD')=to_char(now() AT TIME ZONE 'Europe/Moscow','MM-DD')`;
      break;
    default:
      return [];
  }
  return tx.query<Candidate>(
    `SELECT * FROM (${source}) x WHERE occurred_at>=$2::timestamptz AND expires_at>now() AND ($1::text IS NULL OR identity_key=$1) AND $3::jsonb IS NOT NULL AND ($1::text IS NOT NULL OR NOT EXISTS(SELECT 1 FROM notification_runs n WHERE n.trigger_id=$4 AND n.identity_key=x.identity_key AND n.occurrence_key=x.occurrence_key)) ORDER BY occurred_at,identity_key LIMIT 500`,
    [identity, rule.enabled_at, JSON.stringify(c), rule.id],
  );
}
async function validProgress(c: Candidate, config: NotificationConfig) {
  if (config.id !== "LVL_01") return true;
  const snapshot = await getAccountSnapshot(c.user_id!);
  return (
    !!snapshot.next_tier &&
    !!snapshot.remaining_amount &&
    BigInt(snapshot.remaining_amount) > 0n &&
    BigInt(snapshot.remaining_amount) <= BigInt(config.nearAmountKopecks)
  );
}
export async function scheduleNotifications(limit = 200) {
  const rules = (await notificationRules()).sort(
    (a, b) => b.config.priority - a.config.priority,
  );
  let count = 0;
  for (const rule of rules) {
    const rows = (await candidates(rule)).slice(0, Math.max(0, limit - count));
    if (rows.length) {
      const added = await query(
        `INSERT INTO notification_runs(trigger_id,identity_key,user_id,resource_id,occurrence_key,occurred_at,scheduled_at,expires_at,config)
        SELECT $1,x.identity_key,x.user_id,x.resource_id,x.occurrence_key,x.occurred_at,x.occurred_at+$3*interval '1 minute',x.expires_at,$4
        FROM jsonb_to_recordset($2::jsonb) AS x(identity_key text,user_id uuid,resource_id text,occurrence_key text,occurred_at timestamptz,expires_at timestamptz)
        ON CONFLICT DO NOTHING RETURNING id`,
        [
          rule.id,
          JSON.stringify(rows),
          rule.config.delayMinutes,
          JSON.stringify(rule.config),
        ],
      );
      count += added.length;
    }
    if (count >= limit) break;
  }
  return count;
}
async function templateValues(run: Run) {
  const values: Record<string, string | number> = {};
  if (!run.user_id) return values;
  const s = await getAccountSnapshot(run.user_id);
  values.first_name = s.user.name.split(" ")[0];
  values.bonus_balance = s.bonus_available;
  values.discount_percent = s.discount_rate_bps / 100;
  values.loyalty_level = tierName(
    s.program.tiers.find((t) => t.code === s.tier)!,
  );
  values.next_level = s.next_tier
    ? tierName(s.program.tiers.find((t) => t.code === s.next_tier)!)
    : "максимальный уровень";
  values.amount_to_next_level = (
    Number(s.remaining_amount ?? 0) / 100
  ).toLocaleString("ru-RU");
  const [rides] = await query<{ count: string }>(
    "SELECT count(*) FROM rentals WHERE user_id=$1 AND status='completed' AND mode='operational'",
    [run.user_id],
  );
  values.ride_count = rides.count;
  if (run.trigger_id.startsWith("EXP_")) {
    const [balance] = await query<{ amount: string }>(
      "SELECT coalesce(sum(remaining_amount),0) amount FROM bonus_lots WHERE user_id=$1 AND expires_at>now() AND available_at<=now() AND to_char(expires_at AT TIME ZONE 'Europe/Moscow','YYYY-MM-DD')=$2",
      [run.user_id, run.resource_id],
    );
    values.bonus_balance = balance.amount;
    values.bonus_expire_date = run.resource_id.split("-").reverse().join(".");
  }
  if (run.trigger_id === "PROMO_01") {
    const [b] = await query<{ amount: string }>(
      "SELECT amount FROM bonus_transactions WHERE id=$1 AND user_id=$2",
      [run.resource_id, run.user_id],
    );
    values.bonus_added = b?.amount ?? "0";
  }
  return values;
}
export async function sendNotification(
  runId: string,
  send: (
    target: string,
    text: string,
    url: string,
    cta: string,
  ) => Promise<void>,
) {
  const prepared = await transaction(async (tx) => {
    const [initial] = await tx.query<Run>(
      "SELECT * FROM notification_runs WHERE id=$1",
      [runId],
    );
    if (!initial) return "missing";
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "notification:" + initial.identity_key,
    ]);
    const [run] = await tx.query<
      Run & { status: string; expires_at: string; lease_until: string | null }
    >("SELECT * FROM notification_runs WHERE id=$1 FOR UPDATE", [runId]);
    if (
      !["pending", "sending"].includes(run.status) ||
      Date.parse(run.scheduled_at) > Date.now()
    )
      return run.status;
    if (
      run.status === "sending" &&
      run.lease_until &&
      Date.parse(run.lease_until) > Date.now()
    )
      return "processing";
    const cancel = async (reason: string) => {
      await tx.query(
        "UPDATE notification_runs SET status='cancelled',reason=$2,lease_until=NULL WHERE id=$1",
        [run.id, reason],
      );
      return "cancelled";
    };
    const [rule] = await tx.query<NotificationRule>(
      "SELECT * FROM notification_rules WHERE id=$1",
      [run.trigger_id],
    );
    if (!rule?.config.enabled) return cancel("TRIGGER_DISABLED");
    if (Date.parse(run.expires_at) <= Date.now()) return cancel("EXPIRED");
    const matches = await candidates(
      { ...rule, config: { ...run.config, enabled: true } },
      tx,
      run.identity_key,
    );
    if (
      !matches.some(
        (c) =>
          c.occurrence_key === run.occurrence_key &&
          c.resource_id === run.resource_id,
      ) ||
      !(await validProgress(run, run.config))
    )
      return cancel("CONDITION_COMPLETED_OR_CHANGED");
    let target: string | null = null;
    if (run.trigger_id === "REG_01") {
      const [a] = await tx.query<{ telegram_id: string; can_message: boolean }>(
        "SELECT telegram_id,can_message FROM notification_activity WHERE identity_key=$1",
        [run.identity_key],
      );
      if (a?.can_message) target = a.telegram_id;
    } else {
      const [u] = await tx.query<{
        telegram_id: string | null;
        status: string;
        telegram_reachable: boolean;
        marketing_consent: boolean;
        enabled: boolean;
      }>(
        "SELECT u.*,coalesce(p.enabled,true) enabled FROM users u LEFT JOIN notification_profiles p ON p.user_id=u.id WHERE u.id=$1",
        [run.user_id],
      );
      if (!u || u.status !== "active") return cancel("MEMBER_UNAVAILABLE");
      if (!u.enabled) return cancel("NOTIFICATIONS_DISABLED");
      if (run.config.category === "marketing" && !u.marketing_consent)
        return cancel("MARKETING_OPT_OUT");
      if (u.telegram_reachable) target = u.telegram_id;
    }
    if (!target) return cancel("CHANNEL_UNAVAILABLE");
    const [previous] = await tx.query<{ reserved_at: string }>(
      "SELECT reserved_at FROM notification_runs WHERE identity_key=$1 AND trigger_id=$2 AND id<>$3 AND reserved_at IS NOT NULL ORDER BY reserved_at DESC LIMIT 1",
      [run.identity_key, run.trigger_id, run.id],
    );
    if (
      previous &&
      Date.parse(previous.reserved_at) + run.config.cooldownHours * 3600000 >
        Date.now()
    )
      return cancel("COOLDOWN");
    const [higher] = await tx.query(
      `SELECT id FROM notification_runs WHERE identity_key=$1 AND status='pending' AND scheduled_at<=now() AND expires_at>now() AND (config->>'priority')::int>$2 LIMIT 1`,
      [run.identity_key, run.config.priority],
    );
    if (higher) return "deferred";
    if (run.attempts >= 7) {
      await tx.query(
        "UPDATE notification_runs SET status='failed',reason='ATTEMPTS_EXHAUSTED' WHERE id=$1",
        [run.id],
      );
      return "failed";
    }
    const vals = await templateValues(run),
      url = new URL(
        run.config.path,
        process.env.APP_URL ?? "http://127.0.0.1:3001",
      );
    url.searchParams.set("notification", run.id);
    if (run.trigger_id === "BOOK_01")
      url.searchParams.set("draft", run.resource_id);
    if (
      !(await reserveNotificationSlot(
        target,
        run.config.category,
        "lifecycle:" + run.id,
        tx,
      ))
    ) {
      await tx.query(
        `UPDATE notification_runs SET status='pending',lease_until=NULL,scheduled_at=(date_trunc('day',now() AT TIME ZONE 'Europe/Moscow')+interval '1 day') AT TIME ZONE 'Europe/Moscow',reason='DAILY_LIMIT' WHERE id=$1`,
        [run.id],
      );
      return "deferred";
    }
    await tx.query(
      "UPDATE notification_runs SET status='sending',attempts=attempts+1,reserved_at=now(),lease_until=now()+interval '2 minutes' WHERE id=$1",
      [run.id],
    );
    return {
      run,
      target,
      attempt: run.attempts + 1,
      text:
        renderNotification(run.config.title, vals) +
        "\n" +
        renderNotification(run.config.body, vals),
      url: url.toString(),
    };
  });
  if (typeof prepared === "string") return prepared;
  // Commit the claim before network I/O. A worker crash leaves a durable lease and attempt.
  const { run, target, attempt } = prepared;
  try {
    await send(
      target,
      prepared.text.slice(0, 4000),
      prepared.url,
      run.config.cta,
    );
    await query(
      "UPDATE notification_runs SET status='sent',sent_at=now(),reason=NULL,lease_until=NULL WHERE id=$1 AND status='sending' AND attempts=$2",
      [run.id, attempt],
    );
    return "sent";
  } catch (e) {
    const permanent = e instanceof ProviderError && e.permanent;
    await query(
      "UPDATE notification_runs SET status=$2,scheduled_at=now()+$3*interval '1 millisecond',reason=$4,lease_until=NULL WHERE id=$1 AND status='sending' AND attempts=$5",
      [
        run.id,
        permanent ? "failed" : "pending",
        retryDelay(
          attempt,
          e instanceof ProviderError ? e.retryAfterSeconds : undefined,
        ),
        e instanceof ProviderError ? e.message : "SEND_FAILED",
        attempt,
      ],
    );
    if (e instanceof ProviderError && e.status === 403) {
      await query(
        "UPDATE users SET telegram_reachable=false WHERE telegram_id=$1",
        [target],
      );
      await query(
        "UPDATE notification_activity SET can_message=false WHERE telegram_id=$1",
        [target],
      );
    }
    return permanent ? "failed" : "retry";
  }
}
export async function telegramNotification(
  target: string,
  text: string,
  url: string,
  cta: string,
) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new ProviderError("telegram", 503);
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify({
        chat_id: target,
        text,
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: [[{ text: cta, web_app: { url } }]] },
      }),
    });
  } catch {
    throw new ProviderError("telegram", 503);
  }
  const result = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    error_code?: number;
    parameters?: { retry_after?: number };
  };
  if (!response.ok || !result.ok)
    throw new ProviderError(
      "telegram",
      result.error_code ?? response.status,
      result.parameters?.retry_after,
    );
}
export async function processNotifications(
  limit = 10,
  send = telegramNotification,
) {
  await query(`UPDATE notification_runs n SET converted_at=now() WHERE n.status='sent' AND n.converted_at IS NULL AND n.sent_at+(n.config->>'attributionDays')::int*interval '1 day'>=now() AND (
    (n.trigger_id='REG_01' AND EXISTS(SELECT 1 FROM notification_activity a WHERE a.identity_key=n.identity_key AND a.registered_at>=n.sent_at)) OR
    (n.trigger_id IN ('LOY_01','EXP_01','EXP_02') AND EXISTS(SELECT 1 FROM bonus_transactions b WHERE b.user_id=n.user_id AND b.type='rental_payment' AND b.created_at>=n.sent_at))
  )`);
  await scheduleNotifications();
  const due = await query<{ id: string }>(
    "SELECT id FROM notification_runs WHERE (status='pending' AND scheduled_at<=now()) OR (status='sending' AND lease_until<=now()) ORDER BY (config->>'priority')::int DESC,scheduled_at,id LIMIT $1",
    [limit],
  );
  const results = [];
  for (const run of due) results.push(await sendNotification(run.id, send));
  return results;
}
