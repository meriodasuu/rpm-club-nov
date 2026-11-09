import { query, transaction } from "@/lib/db";
import { type TriggerRule, triggerKinds } from "./contracts";
import { TIER_CODES } from "@/lib/loyalty/rules";
import { ProviderError } from "@/lib/jobs/provider";
import type { OutboxEvent } from "@/lib/jobs/telegram";

export async function scheduleClubTriggers(limit = 200) {
  return transaction(async (tx) => {
    const [lock] = await tx.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtextextended('club:triggers',0)) acquired",
    );
    if (!lock.acquired) return 0;
    const rules = await tx.query<TriggerRule>(
      "SELECT * FROM trigger_rules WHERE enabled ORDER BY kind",
    );
    let count = 0;
    for (const rule of rules) {
      if (rule.kind === "weather") continue;
      // Bounded pages skip already queued keys so every audience member can progress.
      let source: string;
      if (rule.kind === "before_rental") {
        source = `SELECT u.id user_id,r.id::text resource_id,r.pickup_at occurrence_at,r.pickup_at expires_at,':'||extract(epoch FROM r.pickup_at)::text occurrence_key FROM rentals r JOIN users u ON u.id=r.user_id WHERE r.status='accepted' AND r.mode='operational' AND r.pickup_at>now() AND r.pickup_at<=now()+$2*interval '1 hour'`;
      } else if (rule.kind === "after_rental") {
        source =
          "SELECT u.id user_id,r.id::text resource_id,r.completed_at occurrence_at,r.completed_at+interval '8 days' expires_at,'' occurrence_key FROM rentals r JOIN users u ON u.id=r.user_id WHERE r.status='completed' AND r.mode='operational' AND r.completed_at>now()-interval '8 days' AND r.completed_at>=$6::timestamptz AND r.completed_at<=now()";
      } else if (rule.kind === "offer_reminder") {
        source = `SELECT u.id user_id,o.id::text resource_id,greatest(o.published_at,o.start_at) occurrence_at,o.end_at expires_at,'' occurrence_key FROM offers o CROSS JOIN users u JOIN loyalty_accounts a ON a.user_id=u.id WHERE o.active AND o.published_at IS NOT NULL AND o.start_at<=now() AND o.end_at>now() AND greatest(o.published_at,o.start_at)>=$6::timestamptz AND array_position($4::text[],a.achieved_tier)>=array_position($4::text[],o.minimum_tier)`;
      } else {
        source =
          "SELECT u.id user_id,c.id::text resource_id,c.published_at occurrence_at,c.published_at+interval '7 days' expires_at,'' occurrence_key FROM club_content c CROSS JOIN users u WHERE c.kind='route' AND c.active AND c.published_at>now()-interval '7 days' AND c.published_at>=$6::timestamptz AND c.published_at<=now()";
      }
      const topic = rule.kind === "offer_reminder" ? "offers" : rule.kind === "new_route" ? "routes" : "none";
      const inserted = await tx.query(
        `WITH candidates AS (${source}) INSERT INTO outbox_events(event_key,event_type,user_id,aggregate_id,payload)
        SELECT 'trigger:'||$1||':'||c.resource_id||':'||c.user_id||c.occurrence_key,'CLUB_TRIGGER',c.user_id,c.resource_id,jsonb_build_object('kind',$1::text,'resource_id',c.resource_id,'occurrence_at',c.occurrence_at,'expires_at',c.expires_at)
        FROM candidates c JOIN users u ON u.id=c.user_id JOIN loyalty_accounts a ON a.user_id=u.id
        WHERE u.status='active' AND u.telegram_reachable AND u.telegram_id IS NOT NULL AND a.member_since IS NOT NULL AND ($5::text='none' OR ($5::text='offers' AND u.offers_consent) OR ($5::text='routes' AND u.routes_consent))
          AND a.member_since<=c.occurrence_at AND cardinality($4::text[])>0 AND $2::int>=0 AND $6::timestamptz IS NOT NULL
          AND NOT EXISTS(SELECT 1 FROM outbox_events e WHERE e.event_key='trigger:'||$1||':'||c.resource_id||':'||c.user_id||c.occurrence_key)
        ORDER BY c.resource_id,c.user_id LIMIT $3 ON CONFLICT(event_key) DO NOTHING RETURNING id`,
        [
          rule.kind,
          rule.lead_hours,
          Math.max(1, Math.min(limit, 500)),
          TIER_CODES,
          topic,
          rule.enabled_at,
        ],
      );
      count += inserted.length;
    }
    return count;
  });
}

async function weatherForecast(rule: TriggerRule, date: string) {
  const key = process.env.OPEN_METEO_API_KEY;
  if (!key || rule.latitude === null || rule.longitude === null)
    throw new ProviderError("weather", 503);
  const cacheKey = `weather:${rule.city}:${rule.latitude}:${rule.longitude}:${date}`;
  const [cached] = await query<{ value: { text: string } }>(
    "SELECT value FROM program_settings WHERE key=$1 AND updated_at>now()-interval '1 hour'",
    [cacheKey],
  );
  if (cached?.value.text) return cached.value.text;
  const url = new URL("https://customer-api.open-meteo.com/v1/forecast");
  url.search = new URLSearchParams({
    latitude: String(rule.latitude),
    longitude: String(rule.longitude),
    daily:
      "temperature_2m_max,temperature_2m_min,precipitation_probability_max",
    timezone: "Europe/Moscow",
    start_date: date,
    end_date: date,
    apikey: key,
  }).toString();
  let data: {
    daily?: {
      time?: string[];
      temperature_2m_min?: number[];
      temperature_2m_max?: number[];
      precipitation_probability_max?: number[];
    };
  };
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error("forecast failed");
    data = await response.json();
  } catch {
    throw new ProviderError("weather", 503);
  }
  const d = data?.daily,
    low = d?.temperature_2m_min?.[0],
    high = d?.temperature_2m_max?.[0],
    rain = d?.precipitation_probability_max?.[0];
  if (
    d?.time?.[0] !== date ||
    ![low, high, rain].every((v) => typeof v === "number" && Number.isFinite(v))
  )
    throw new ProviderError("weather", 503);
  const text = `${rule.city}, ${date}: ${Math.round(low!)}…${Math.round(high!)} °C, вероятность осадков ${Math.round(rain!)}%.\nИсточник: Open-Meteo — https://open-meteo.com/`;
  await query(
    "INSERT INTO program_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()",
    [cacheKey, JSON.stringify({ text })],
  );
  return text;
}

export async function validateOpenMeteoApiKey(key: string) {
  const url = new URL("https://customer-api.open-meteo.com/v1/forecast");
  url.search = new URLSearchParams({
    latitude: "59.9311",
    longitude: "30.3609",
    daily: "temperature_2m_min,temperature_2m_max,precipitation_probability_max",
    timezone: "Europe/Moscow",
    forecast_days: "1",
    apikey: key,
  }).toString();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return false;
    const result = await response.json();
    return Array.isArray(result?.daily?.time) && result.daily.time.length === 1;
  } catch {
    return false;
  }
}

export async function clubTriggerMessage(
  event: OutboxEvent,
  marketingConsent: boolean | { offers: boolean; routes: boolean },
  tier: string,
) {
  const {
    kind,
    resource_id: resourceId,
    occurrence_at: occurrenceAt,
    expires_at: expiresAt,
  } = event.payload;
  if (
    typeof kind !== "string" ||
    !triggerKinds.includes(kind as TriggerRule["kind"]) ||
    typeof resourceId !== "string" ||
    !/^[a-f0-9-]{36}$/.test(resourceId) ||
    typeof expiresAt !== "string" ||
    typeof occurrenceAt !== "string" ||
    !Number.isFinite(Date.parse(occurrenceAt)) ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    Date.parse(expiresAt) <= Date.now()
  )
    return null;
  const [rule] = await query<TriggerRule>(
    "SELECT * FROM trigger_rules WHERE kind=$1 AND enabled",
    [kind],
  );
  if (
    !rule || kind === "weather" ||
    (["after_rental", "offer_reminder", "new_route"].includes(kind) &&
      Date.parse(occurrenceAt) < new Date(rule.enabled_at).getTime()) ||
    (kind === "offer_reminder" && !(typeof marketingConsent === "boolean" ? marketingConsent : marketingConsent.offers)) ||
    (kind === "new_route" && !(typeof marketingConsent === "boolean" ? marketingConsent : marketingConsent.routes))
  )
    return null;
  const lines = ["RPM Club", rule.message];
  if(kind==='after_rental'){
    const [replacement]=await query(`SELECT n.id FROM notification_rules n WHERE (n.config->>'enabled')::boolean AND n.enabled_at<=$3::timestamptz AND n.id=CASE WHEN (SELECT count(*) FROM rentals r WHERE r.user_id=$1 AND r.status='completed' AND r.mode='operational' AND ROW(r.completed_at,r.id)<= (SELECT completed_at,id FROM rentals WHERE id=$2))=1 THEN 'RIDE_01' ELSE 'RIDE_02' END`,[event.user_id,resourceId,occurrenceAt]);
    if(replacement)return null;
  }
  if (
    kind === "before_rental" ||
    kind === "after_rental" ||
    kind === "weather"
  ) {
    const [r] = await query<{
      car_name: string;
      start_date: string;
      end_date: string;
      status: string;
      payment_status: string;
      pickup_at: string | null;
    }>(
      "SELECT car_name,to_char(start_date,'YYYY-MM-DD') start_date,to_char(end_date,'YYYY-MM-DD') end_date,status,payment_status,pickup_at::text FROM rentals WHERE id=$1 AND user_id=$2 AND mode='operational'",
      [resourceId, event.user_id],
    );
    if (
      !r ||
      (kind === "after_rental"
        ? r.status !== "completed"
        : r.status !== "accepted")
    )
      return null;
    if (
      kind !== "after_rental" &&
      (!r.pickup_at ||
        typeof occurrenceAt !== "string" ||
        Date.parse(r.pickup_at) !== Date.parse(occurrenceAt) ||
        Date.parse(r.pickup_at) <= Date.now() ||
        Date.parse(r.pickup_at) > Date.now() + rule.lead_hours * 3600000)
    )
      return null;
    lines.push(`${r.car_name} · ${r.start_date} — ${r.end_date}`);
    if (kind !== "after_rental" && r.pickup_at)
      lines.push(
        `Выдача: ${new Date(r.pickup_at).toLocaleTimeString("ru-RU", { timeZone: "Europe/Moscow", hour: "2-digit", minute: "2-digit" })} (Москва)`,
      );
    if (kind === "weather")
      lines.push(await weatherForecast(rule, r.start_date));
  } else if (kind === "offer_reminder") {
    const [o] = await query<{
      title: string;
      description: string;
      minimum_tier: string;
    }>(
      "SELECT title,description,minimum_tier FROM offers WHERE id=$1 AND active AND start_at<=now() AND end_at>now()",
      [resourceId],
    );
    if (
      !o ||
      TIER_CODES.indexOf(tier as (typeof TIER_CODES)[number]) <
        TIER_CODES.indexOf(o.minimum_tier as (typeof TIER_CODES)[number])
    )
      return null;
    lines.push(o.title, o.description);
  } else {
    const [route] = await query<{ title: string; summary: string }>(
      "SELECT title,summary FROM club_content WHERE id=$1 AND kind='route' AND active",
      [resourceId],
    );
    if (!route) return null;
    lines.push(
      route.title,
      route.summary,
      "Откройте раздел «Маршруты» в клубе.",
    );
  }
  return lines.join("\n").slice(0, 4000);
}
