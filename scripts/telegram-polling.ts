import { writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { TelegramPoller } from "./lib/telegram-polling";
import { setupTelegram } from "./lib/telegram-setup";

const shutdown = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => shutdown.abort());

try {
  if (process.env.TELEGRAM_UPDATES_MODE !== "polling")
    throw new Error("Set TELEGRAM_UPDATES_MODE=polling");
  // Read-only check: never remove another deployment's webhook on process restart.
  const settings = await setupTelegram(process.env, false);
  if (!settings.updatesModeMatches)
    throw new Error(
      "Disable the webhook with telegram:setup --apply before polling",
    );
  const poller = new TelegramPoller({
    token: process.env.TELEGRAM_BOT_TOKEN!,
    secret: process.env.TELEGRAM_WEBHOOK_SECRET!,
    endpoint: "http://app:3001/api/telegram/webhook",
  });
  let failures = 0;
  while (!shutdown.signal.aborted) {
    try {
      const delivered = await poller.poll(shutdown.signal);
      await writeFile("/tmp/rpm-telegram-heartbeat", String(Date.now()));
      failures = 0;
      if (delivered)
        console.log(
          JSON.stringify({ at: new Date().toISOString(), delivered }),
        );
    } catch (error) {
      if (shutdown.signal.aborted) break;
      failures++;
      console.error(
        error instanceof Error ? error.message : "Telegram polling failed",
      );
      // A restart recovers stale connections; queued updates remain in Telegram.
      if (failures >= 10)
        throw new Error("Telegram polling repeatedly failed; restarting");
    }
    await setTimeout(
      failures ? Math.min(30000, 1000 * 2 ** failures) : 250,
      undefined,
      { signal: shutdown.signal },
    ).catch(() => {});
  }
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Telegram polling startup failed",
  );
  process.exitCode = 1;
}
