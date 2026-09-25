import pg from "pg";
import { writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { closePool, type Db } from "../src/lib/db";
import {
  exportRentRequests,
  syncRentStates,
  deliverRentNotifications,
} from "../src/lib/club/rpm-rent";

const shutdown = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => shutdown.abort());
let client: pg.Client | undefined;
try {
  const url = new URL(process.env.RPM_RENT_DATABASE_URL ?? "");
  const token = process.env.RPM_RENT_BOT_TOKEN;
  if (
    url.hostname !== "rpm-rent-db-1" ||
    url.username !== "rpm_club_requests" ||
    !token
  )
    throw new Error("Bridge configuration missing");
  client = new pg.Client({
    connectionString: url.href,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
    application_name: "rpm-club-requests",
  });
  let lost = false;
  client.on("error", () => {
    lost = true;
  });
  await client.connect();
  const lock = await client.query(
    "SELECT pg_try_advisory_lock(hashtextextended('rpm:club-requests',0)) locked",
  );
  if (!lock.rows[0].locked) throw new Error("Bridge already running");
  const connected = client;
  const peer: Db = {
    query: async <T>(sql: string, values: unknown[] = []) =>
      (await connected.query(sql, values)).rows as T[],
  };
  while (!shutdown.signal.aborted) {
    if (lost) throw new Error("Source disconnected");
    await exportRentRequests(peer);
    await syncRentStates(peer);
    await deliverRentNotifications(peer, async (chatId, text, number) => {
      const response = await fetch(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(10000),
          body: JSON.stringify({
            chat_id: chatId,
            text,
            disable_web_page_preview: true,
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "Открыть заявку",
                    callback_data: `booking:${number}`,
                  },
                ],
              ],
            },
          }),
        },
      );
      const result = await response.json();
      if (
        !response.ok ||
        result.ok !== true ||
        !Number.isSafeInteger(result.result?.message_id)
      )
        throw new Error("Telegram delivery failed");
      return result.result.message_id as number;
    });
    await writeFile("/tmp/rpm-requests-heartbeat", String(Date.now()));
    await sleep(5000, undefined, { signal: shutdown.signal }).catch(() => {});
  }
} catch {
  if (!shutdown.signal.aborted) {
    console.error(
      "RPM Rent request bridge failed; queued requests retained for retry",
    );
    process.exitCode = 1;
    await sleep(5000);
  }
} finally {
  await client?.end().catch(() => {});
  await closePool();
}
