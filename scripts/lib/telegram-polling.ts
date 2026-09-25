import { z } from "zod";

const Updates = z.object({
  ok: z.literal(true),
  result: z.array(
    z.object({ update_id: z.number().int().nonnegative() }).passthrough(),
  ),
});

export class TelegramPoller {
  private offset: number | undefined;

  constructor(
    private readonly config: {
      token: string;
      secret: string;
      endpoint: string;
    },
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async poll(signal: AbortSignal): Promise<number> {
    let response: Response;
    try {
      response = await this.fetcher(
        `https://api.telegram.org/bot${this.config.token}/getUpdates`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            offset: this.offset,
            timeout: 30,
            limit: 20,
            allowed_updates: ["message"],
          }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]),
          redirect: "error",
        },
      );
    } catch {
      // Native fetch errors can contain the bot token in their URL/cause.
      throw new Error("Telegram polling network error");
    }
    if (!response.ok)
      throw new Error(`Telegram polling HTTP ${response.status}`);
    const parsed = Updates.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new Error("Telegram polling invalid response");
    let delivered = 0;
    for (const update of parsed.data.result) {
      let accepted: Response;
      try {
        accepted = await this.fetcher(this.config.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-telegram-bot-api-secret-token": this.config.secret,
          },
          body: JSON.stringify(update),
          signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
          redirect: "error",
        });
      } catch {
        throw new Error("Telegram local delivery network error");
      }
      if (!accepted.ok)
        throw new Error(`Telegram local delivery HTTP ${accepted.status}`);
      await accepted.arrayBuffer();
      // Only the next getUpdates call acknowledges this update. If we crash first,
      // Telegram replays it and the application's PostgreSQL deduplication applies.
      // Never initialize from MAX(update_id): Telegram may randomize IDs after a week.
      this.offset = update.update_id + 1;
      delivered++;
    }
    return delivered;
  }
}
