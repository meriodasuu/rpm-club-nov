import { afterEach, describe, expect, it, vi } from "vitest";
import { telegramNotification } from "../src/lib/notifications/engine";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.APP_URL;
});

describe("notification photo delivery", () => {
  it("sends an uploaded photo with caption and button", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.APP_URL = "https://club.example.com";
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetch);
    await telegramNotification(
      "123",
      "Заголовок\nТекст",
      "https://club.example.com/home",
      "Открыть",
      "/api/media/123e4567-e89b-12d3-a456-426614174000.webp",
    );
    expect(fetch.mock.calls[0][0]).toContain("/sendPhoto");
    const payload = JSON.parse(fetch.mock.calls[0][1].body);
    expect(payload.photo).toBe(
      "https://club.example.com/api/media/123e4567-e89b-12d3-a456-426614174000.webp",
    );
    expect(payload.caption).toBe("Заголовок\nТекст");
    expect(payload.reply_markup.inline_keyboard[0][0].text).toBe("Открыть");
  });
});
