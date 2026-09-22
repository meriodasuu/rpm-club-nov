import { query, type Db } from "@/lib/db";

// One slot per Telegram recipient/category/Moscow day, shared by both workers.
// The conditional upsert is atomic; retries of the same message keep their slot.
export async function reserveNotificationSlot(
  target: string,
  category: "service" | "marketing" | "transactional",
  resource: string,
  tx: Db = { query },
) {
  if (category === "transactional") return true;
  const [limits] = await tx.query<{
    value: { service: number; marketing: number };
  }>("SELECT value FROM program_settings WHERE key='notifications:limits'");
  if ((limits?.value[category] ?? 1) === 0) return false;
  const rows = await tx.query(
    `INSERT INTO program_settings(key,value) VALUES($1,jsonb_build_object('day',to_char(now() AT TIME ZONE 'Europe/Moscow','YYYY-MM-DD'),'resource',$2::text))
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()
    WHERE program_settings.value->>'day'<>excluded.value->>'day' OR program_settings.value->>'resource'=$2
    RETURNING key`,
    ["notifications:daily:tg:" + target + ":" + category, resource],
  );
  return rows.length > 0;
}
