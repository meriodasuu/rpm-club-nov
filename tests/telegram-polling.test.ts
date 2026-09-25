import { describe, expect, it, vi } from "vitest";
import { TelegramPoller } from "../scripts/lib/telegram-polling";

const config = {
  token: "123:synthetic",
  secret: "synthetic-secret",
  endpoint: "http://app:3001/api/telegram/webhook",
};
const signal = new AbortController().signal;

describe("Telegram polling delivery", () => {
  it("acknowledges only successfully persisted updates and retries a failure", async () => {
    let failed = false;
    const polls: Record<string, unknown>[] = [];
    const delivered: number[] = [];
    const fetcher: typeof fetch = async (url, init) => {
      const body = JSON.parse(String(init?.body));
      if (String(url).endsWith("/getUpdates")) {
        polls.push(body);
        return Response.json({
          ok: true,
          result: [10, 11, 12]
            .filter((id) => id >= (body.offset ?? 0))
            .map((update_id) => ({ update_id })),
        });
      }
      expect(url).toBe(config.endpoint);
      expect(
        new Headers(init?.headers).get("x-telegram-bot-api-secret-token"),
      ).toBe(config.secret);
      expect(init?.redirect).toBe("error");
      if (body.update_id === 11 && !failed) {
        failed = true;
        return new Response(null, { status: 503 });
      }
      delivered.push(body.update_id);
      return Response.json({ ok: true });
    };
    const poller = new TelegramPoller(config, fetcher);
    await expect(poller.poll(signal)).rejects.toThrow("HTTP 503");
    expect(delivered).toEqual([10]);
    expect(await poller.poll(signal)).toBe(2);
    expect(polls[0]).not.toHaveProperty("offset");
    expect(polls[1].offset).toBe(11);
    expect(delivered).toEqual([10, 11, 12]);
    await poller.poll(signal);
    expect(polls[2].offset).toBe(13);
  });

  it("starts from Telegram's unconfirmed queue after a restart", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ok: true, result: [] }));
    await new TelegramPoller(config, fetcher).poll(signal);
    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(body).toMatchObject({ timeout: 30, allowed_updates: ["message"] });
    expect(body).not.toHaveProperty("offset");
  });

  it("never advances past a rejected API response or leaks provider errors", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("URL contains " + config.token))
      .mockResolvedValueOnce(
        Response.json(
          { ok: false, description: config.token },
          { status: 409 },
        ),
      )
      .mockResolvedValueOnce(Response.json({ ok: true, result: [] }));
    const poller = new TelegramPoller(config, fetcher);
    await expect(poller.poll(signal)).rejects.toThrow(
      "Telegram polling network error",
    );
    await expect(poller.poll(signal)).rejects.toThrow(
      "Telegram polling HTTP 409",
    );
    await poller.poll(signal);
    for (const [, init] of fetcher.mock.calls)
      expect(JSON.parse(String(init?.body))).not.toHaveProperty("offset");
  });

  it("does not deliver malformed updates or follow a redirect carrying the secret", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ ok: true, result: [{ update_id: "bad" }] }),
      );
    await expect(
      new TelegramPoller(config, fetcher).poll(signal),
    ).rejects.toThrow("invalid response");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]?.redirect).toBe("error");
  });
});
