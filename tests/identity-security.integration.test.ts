import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { closePool, query } from "../src/lib/db";
import { operationsRoute } from "../src/lib/api/operations";
import {
  hashToken,
  randomToken,
  requireSession,
} from "../src/lib/auth/session";
import { handle } from "../src/lib/http";

const suite = process.env.DATABASE_URL?.includes("rpm_club_test")
  ? describe
  : describe.skip;
const origin = "http://127.0.0.1:3001";
const telegramId = () =>
  BigInt("0x" + randomUUID().replaceAll("-", "").slice(0, 11)).toString();
async function member() {
  const [user] = await query<{ id: string; telegram_id: string }>(
    "INSERT INTO users(name,telegram_id,status) VALUES('Identity security fixture',$1,'active') RETURNING id,telegram_id",
    [telegramId()],
  );
  return user;
}
async function staff(role = "admin") {
  const [membership] = await query<{ id: string }>(
    "INSERT INTO admin_memberships(auth_user_id,email,role) VALUES($1,$2,$3) RETURNING id",
    [randomUUID(), randomUUID() + "@example.invalid", role],
  );
  const token = randomToken();
  await query(
    "INSERT INTO staff_sessions(membership_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')",
    [membership.id, hashToken(token)],
  );
  return { id: membership.id, cookie: "rpm_staff=" + token };
}
async function edit(
  id: string,
  cookie: string,
  telegram: string | null,
  requestOrigin = origin,
) {
  const [account] = await query<{ account_version: string }>(
    "SELECT account_version FROM loyalty_accounts WHERE user_id=$1",
    [id],
  );
  const path = `admin/customers/${id}/identity`;
  return handle(
    async () =>
      (await operationsRoute(
        new Request(origin + "/api/" + path, {
          method: "POST",
          headers: {
            origin: requestOrigin,
            cookie,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: "Verified identity fixture",
            phone: null,
            telegramId: telegram,
            expectedVersion: account.account_version,
            identityVerified: true,
            reason: "Synthetic identity verification",
          }),
        }),
        path,
      ))!,
  );
}

suite("staff identity cannot be reassigned through member editing", () => {
  beforeAll(() => vi.stubEnv("APP_URL", origin));
  afterAll(async () => {
    vi.unstubAllEnvs();
    await closePool();
  });

  it.each([true, false])(
    "rejects changing or removing Telegram with membership active=%s without changing authentication state",
    async (active) => {
      const admin = await staff(),
        user = await member();
      const [membership] = await query<{ id: string }>(
        "INSERT INTO admin_memberships(telegram_user_id,name,role,active) VALUES($1,'Protected staff','admin',$2) RETURNING id",
        [user.id, active],
      );
      const token = randomToken(),
        link = randomToken();
      await query(
        "INSERT INTO staff_sessions(membership_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')",
        [membership.id, hashToken(token)],
      );
      await query(
        "INSERT INTO staff_bot_login_links(code_hash,membership_id,expires_at) VALUES($1,$2,now()+interval '10 minutes')",
        [hashToken(link), membership.id],
      );
      await query(
        "INSERT INTO staff_telegram_mfa(membership_id,secret_encrypted,enrollment_expires_at) VALUES($1,'synthetic-sealed-factor',now()+interval '10 minutes')",
        [membership.id],
      );
      for (const telegram of [telegramId(), null]) {
        const response = await edit(user.id, admin.cookie, telegram);
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({
          code: "STAFF_IDENTITY_LOCKED",
        });
      }
      expect(
        (await query("SELECT telegram_id FROM users WHERE id=$1", [user.id]))[0]
          .telegram_id,
      ).toBe(user.telegram_id);
      expect(
        (
          await query(
            "SELECT revoked_at FROM staff_sessions WHERE token_hash=$1",
            [hashToken(token)],
          )
        )[0].revoked_at,
      ).toBeNull();
      expect(
        await query(
          "SELECT code_hash FROM staff_bot_login_links WHERE code_hash=$1",
          [hashToken(link)],
        ),
      ).toHaveLength(1);
      expect(
        (
          await query(
            "SELECT secret_encrypted FROM staff_telegram_mfa WHERE membership_id=$1",
            [membership.id],
          )
        )[0].secret_encrypted,
      ).toBe("synthetic-sealed-factor");
      expect((await edit(user.id, admin.cookie, user.telegram_id)).status).toBe(
        200,
      );
    },
  );

  it("allows ordinary member identity changes and revokes the old member session", async () => {
    const admin = await staff(),
      user = await member(),
      token = randomToken(),
      replacement = telegramId();
    await query(
      "INSERT INTO miniapp_sessions(user_id,telegram_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
      [user.id, user.telegram_id, hashToken(token)],
    );
    expect((await edit(user.id, admin.cookie, replacement)).status).toBe(200);
    expect(
      (await query("SELECT telegram_id FROM users WHERE id=$1", [user.id]))[0]
        .telegram_id,
    ).toBe(replacement);
    expect(
      (
        await query(
          "SELECT revoked_at FROM miniapp_sessions WHERE token_hash=$1",
          [hashToken(token)],
        )
      )[0].revoked_at,
    ).not.toBeNull();
  });

  it("requires admin authority and the application origin", async () => {
    const user = await member(),
      replacement = telegramId();
    expect((await edit(user.id, "", replacement)).status).toBe(401);
    for (const role of ["viewer", "manager"]) {
      const actor = await staff(role);
      expect((await edit(user.id, actor.cookie, replacement)).status).toBe(403);
    }
    const admin = await staff();
    expect(
      (await edit(user.id, admin.cookie, replacement, "https://other.invalid"))
        .status,
    ).toBe(403);
    expect(
      (await query("SELECT telegram_id FROM users WHERE id=$1", [user.id]))[0]
        .telegram_id,
    ).toBe(user.telegram_id);
  });

  it("rejects an old Telegram session inserted after identity revocation", async () => {
    const admin = await staff(),
      user = await member(),
      token = randomToken();
    // auth/telegram may have read the old identity before the edit's revocation,
    // then finish inserting its session after the edit commits.
    expect((await edit(user.id, admin.cookie, telegramId())).status).toBe(200);
    await query(
      "INSERT INTO miniapp_sessions(user_id,telegram_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
      [user.id, user.telegram_id, hashToken(token)],
    );
    const request = new Request(origin + "/api/me", {
      headers: { cookie: "rpm_session=" + token },
    });
    await expect(requireSession(request)).rejects.toMatchObject({
      code: "SESSION_EXPIRED",
    });
    await expect(requireSession(request, false)).rejects.toMatchObject({
      code: "SESSION_EXPIRED",
    });
  });
});
