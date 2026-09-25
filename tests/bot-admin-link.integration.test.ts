import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";
import { query, closePool } from "../src/lib/db";
import { authRoute } from "../src/lib/auth/routes";
import { handle } from "../src/lib/http";
import { hashToken, randomToken, requireStaff } from "../src/lib/auth/session";
const suite = process.env.DATABASE_URL?.includes("rpm_club_test")
  ? describe
  : describe.skip;
const origin = "http://127.0.0.1:3001",
  botToken = "123456:bot-link-test",
  webhookSecret = "test-webhook-secret-at-least-32-characters";
async function call(
  path: string,
  payload: object = {},
  cookie = "",
  requestOrigin = origin,
) {
  return handle(
    async () =>
      (await authRoute(
        new Request(origin + "/api/" + path, {
          method: "POST",
          headers: {
            origin: requestOrigin,
            cookie,
            "Content-Type": "application/json",
            "x-telegram-bot-api-secret-token": webhookSecret,
          },
          body: JSON.stringify(payload),
        }),
        path,
      ))!,
  );
}
async function fixture(admin = true) {
  const telegram = String(
    BigInt("0x" + randomUUID().replaceAll("-", "").slice(0, 11)),
  );
  const [user] = await query<{ id: string }>(
    "INSERT INTO users(name,telegram_id,status) VALUES('Bot link test',$1,'active') RETURNING id",
    [telegram],
  );
  const [member] = admin
    ? await query<{ id: string }>(
        "INSERT INTO admin_memberships(telegram_user_id,name,role) VALUES($1,'Bot link test','admin') RETURNING id",
        [user.id],
      )
    : [];
  const session = randomToken();
  await query(
    "INSERT INTO miniapp_sessions(token_hash,user_id,telegram_id,telegram_profile,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')",
    [
      hashToken(session),
      user.id,
      telegram,
      JSON.stringify({ id: Number(telegram), first_name: "Test" }),
    ],
  );
  return {
    userId: user.id,
    memberId: member?.id,
    telegram,
    cookie: "rpm_session=" + session,
  };
}
async function issue(admin: { telegram: string }) {
  return call("telegram/webhook", {
    update_id: Math.floor(Math.random() * 1e12),
    message: {
      from: { id: Number(admin.telegram) },
      chat: { id: Number(admin.telegram), type: "private" },
      text: "/admin",
    },
  });
}
function mockBot() {
  const messages: {
    chat_id: string;
    text: string;
    reply_markup?: { inline_keyboard: { url: string }[][] };
  }[] = [];
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    messages.push(JSON.parse(String(init?.body)));
    return new Response(
      JSON.stringify({ ok: true, result: { message_id: 1 } }),
    );
  });
  vi.stubGlobal("fetch", fetcher);
  return {
    messages,
    fetcher,
    code: () =>
      new URL(
        messages.at(-1)!.reply_markup!.inline_keyboard[0][0].url,
      ).hash.slice(1),
  };
}
suite("Bot links and password setup", () => {
  beforeAll(() => {
    process.env.APP_URL = origin;
    process.env.TELEGRAM_BOT_TOKEN = botToken;
    process.env.TELEGRAM_WEBHOOK_SECRET = webhookSecret;
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(closePool);
  it("rejects retired Mini App entry points and replies to ordinary users without a link", async () => {
    const bot = mockBot(),
      outsider = await fixture(false);
    for (const path of [
      "auth/staff/bot-link",
      "auth/staff/telegram",
      "auth/staff/browser-link",
      "auth/staff/browser-redeem",
    ]) {
      const response = await call(path, {}, outsider.cookie);
      expect(response.status).toBe(410);
      expect(response.headers.get("set-cookie")).toBeNull();
    }
    expect((await issue(outsider)).status).toBe(200);
    expect(bot.messages.at(-1)!.text).toBe("Данная команда недоступна.");
    expect(bot.messages.at(-1)!.reply_markup).toBeUndefined();
  });
  it("sets credentials without MFA, consumes a link exactly once and issues a session", async () => {
    const bot = mockBot(),
      admin = await fixture();
    expect((await issue(admin)).status).toBe(200);
    expect(bot.messages[0].chat_id).toBe(admin.telegram);
    expect(bot.messages[0].text).not.toContain("Authenticator");
    const code = bot.code();
    const before = await call("auth/staff/bot-redeem", { code });
    expect(await before.json()).toEqual({ password_setup_required: true });
    expect(before.headers.get("set-cookie")).toBeNull();
    const credentials = {
      email: randomUUID() + "@example.test",
      password: "Synthetic password for tests!",
    };
    expect(
      (
        await call("auth/staff/bot-redeem", {
          code,
          credentials: { ...credentials, password: "short" },
        })
      ).status,
    ).toBe(422);
    const attempts = await Promise.all([
      call("auth/staff/bot-redeem", { code, credentials }),
      call("auth/staff/bot-redeem", { code, credentials }),
    ]);
    expect(attempts.map((r) => r.status).sort()).toEqual([200, 401]);
    const cookie = attempts
      .find((r) => r.ok)!
      .headers.get("set-cookie")!
      .split(";")[0];
    expect(
      (await requireStaff(new Request(origin, { headers: { cookie } }))).id,
    ).toBe(admin.memberId);
    const [stored] = await query<{ password_hash: string }>(
      "SELECT password_hash FROM staff_password_credentials WHERE membership_id=$1",
      [admin.memberId],
    );
    expect(stored.password_hash).toMatch(/^scrypt-v1\$/);
    expect(stored.password_hash).not.toContain(credentials.password);
    expect(
      (await call("auth/staff/bot-redeem", { code, credentials })).status,
    ).toBe(401);
    await query("UPDATE admin_memberships SET active=false WHERE id=$1", [
      admin.memberId,
    ]);
    await expect(
      requireStaff(new Request(origin, { headers: { cookie } })),
    ).rejects.toThrow();
  });
  it("rejects replaced, expired and revoked links; rate limits inspection", async () => {
    const bot = mockBot(),
      admin = await fixture();
    await issue(admin);
    const old = bot.code();
    await issue(admin);
    const code = bot.code();
    expect((await call("auth/staff/bot-redeem", { code: old })).status).toBe(
      401,
    );
    expect(
      (
        await call(
          "auth/staff/bot-redeem",
          { code },
          "",
          "https://foreign.test",
        )
      ).status,
    ).toBe(403);
    await query("UPDATE admin_memberships SET active=false WHERE id=$1", [
      admin.memberId,
    ]);
    expect((await call("auth/staff/bot-redeem", { code })).status).toBe(401);
    await query("UPDATE admin_memberships SET active=true WHERE id=$1", [
      admin.memberId,
    ]);
    await query(
      "UPDATE staff_bot_login_links SET expires_at=now()-interval '1 second' WHERE code_hash=$1",
      [hashToken(code)],
    );
    expect((await call("auth/staff/bot-redeem", { code })).status).toBe(401);
    await issue(admin);
    const fresh = bot.code();
    await query("DELETE FROM rate_limits WHERE key=$1", [
      "staff-bot-verify:" + admin.memberId,
    ]);
    for (let i = 0; i < 10; i++)
      expect(
        (await call("auth/staff/bot-redeem", { code: fresh })).status,
      ).toBe(200);
    expect((await call("auth/staff/bot-redeem", { code: fresh })).status).toBe(
      429,
    );
  });
  it("resets a password atomically, revokes every old session and rejects another member's email", async () => {
    const bot = mockBot(),
      admin = await fixture(),
      other = await fixture();
    const credentials = {
      email: randomUUID() + "@example.test",
      password: "Original synthetic password!",
    };
    await issue(admin);
    const first = await call("auth/staff/bot-redeem", {
      code: bot.code(),
      credentials,
    });
    const cookie1 = first.headers.get("set-cookie")!.split(";")[0];
    const second = await call("auth/staff/login", credentials);
    const cookie2 = second.headers.get("set-cookie")!.split(";")[0];
    await issue(other);
    const otherCode = bot.code();
    expect(
      (
        await call("auth/staff/bot-redeem", {
          code: otherCode,
          credentials: {
            ...credentials,
            email: credentials.email.toUpperCase(),
          },
        })
      ).status,
    ).toBe(409);
    expect(
      await query(
        "SELECT membership_id FROM staff_password_credentials WHERE membership_id=$1",
        [other.memberId],
      ),
    ).toHaveLength(0);
    await issue(admin);
    const password = "Replacement synthetic password!";
    const reset = await call("auth/staff/bot-redeem", {
      code: bot.code(),
      credentials: { ...credentials, password },
    });
    expect(reset.status).toBe(200);
    for (const cookie of [cookie1, cookie2])
      await expect(
        requireStaff(new Request(origin, { headers: { cookie } })),
      ).rejects.toThrow();
    expect((await call("auth/staff/login", credentials)).status).toBe(401);
    expect(
      (await call("auth/staff/login", { ...credentials, password })).status,
    ).toBe(200);
  });
  it("does not issue links to unknown, blocked or revoked users and never enrolls without a valid link", async () => {
    const bot = mockBot();
    for (const mode of ["unknown", "blocked", "revoked"]) {
      const user = await fixture(mode !== "unknown");
      if (mode === "blocked")
        await query("UPDATE users SET status='blocked' WHERE id=$1", [
          user.userId,
        ]);
      if (mode === "revoked")
        await query("UPDATE admin_memberships SET active=false WHERE id=$1", [
          user.memberId,
        ]);
      expect((await issue(user)).status).toBe(200);
      expect(bot.messages.at(-1)!.text).toBe("Данная команда недоступна.");
      expect(bot.messages.at(-1)!.reply_markup).toBeUndefined();
      if (user.memberId)
        expect(
          await query(
            "SELECT membership_id FROM staff_telegram_mfa WHERE membership_id=$1",
            [user.memberId],
          ),
        ).toHaveLength(0);
    }
    expect(
      (await call("auth/staff/bot-redeem", { code: randomToken() })).status,
    ).toBe(401);
  });
  it("handles /admin once, rejects group requests and retries failed Telegram sends without leaving usable links", async () => {
    const bot = mockBot(),
      admin = await fixture();
    const update = {
      update_id: Math.floor(Math.random() * 1e12),
      message: {
        from: { id: Number(admin.telegram) },
        chat: { id: Number(admin.telegram), type: "private" },
        text: "/admin",
      },
    };
    expect((await call("telegram/webhook", update)).status).toBe(200);
    expect((await call("telegram/webhook", update)).status).toBe(200);
    expect(bot.messages).toHaveLength(1);
    expect(
      (
        await call("telegram/webhook", {
          ...update,
          update_id: update.update_id + 1,
          message: { ...update.message, chat: { id: -100, type: "group" } },
        })
      ).status,
    ).toBe(200);
    expect(bot.messages).toHaveLength(1);
    bot.fetcher.mockRejectedValueOnce(new Error("offline"));
    const failed = { ...update, update_id: update.update_id + 2 };
    expect((await call("telegram/webhook", failed)).status).toBe(503);
    expect(
      await query("SELECT update_id FROM telegram_updates WHERE update_id=$1", [
        String(failed.update_id),
      ]),
    ).toHaveLength(0);
    expect((await call("telegram/webhook", failed)).status).toBe(200);
    expect(bot.messages).toHaveLength(2);
  });
});
