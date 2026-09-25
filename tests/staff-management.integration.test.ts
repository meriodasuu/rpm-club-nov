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
import { adminRoute } from "../src/lib/api/admin";
import { clientRoute } from "../src/lib/api/client";
import { handle, json } from "../src/lib/http";
import { hashToken, randomToken, requireStaff } from "../src/lib/auth/session";
const suite = process.env.DATABASE_URL?.includes("rpm_club_test")
  ? describe
  : describe.skip;
const origin = "http://127.0.0.1:3001";
async function member() {
  const digits = BigInt(
    "0x" + randomUUID().replaceAll("-", "").slice(0, 10),
  ).toString();
  const phone = "+7" + digits.padStart(10, "0").slice(-10);
  const [user] = await query<{ id: string; phone: string }>(
    "INSERT INTO users(name,phone,telegram_id,status) VALUES('Staff candidate',$1,$2,'active') RETURNING id,phone",
    [phone, digits],
  );
  await query(
    "UPDATE loyalty_accounts SET member_since=now() WHERE user_id=$1",
    [user.id],
  );
  const token = randomToken();
  await query(
    "INSERT INTO miniapp_sessions(user_id,telegram_id,telegram_profile,token_hash,expires_at) VALUES($1,$2,'{}',$3,now()+interval '1 hour')",
    [user.id, digits, hashToken(token)],
  );
  return { ...user, cookie: "rpm_session=" + token };
}
async function staff(owner = false) {
  const u = await member();
  const [m] = await query<{ id: string }>(
    "INSERT INTO admin_memberships(telegram_user_id,name,role,can_manage_staff) VALUES($1,'Test staff','admin',$2) RETURNING id",
    [u.id, owner],
  );
  const token = randomToken();
  await query(
    "INSERT INTO staff_sessions(membership_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')",
    [m.id, hashToken(token)],
  );
  return { user: u, id: m.id, cookie: "rpm_staff=" + token };
}
async function call(path: string, cookie: string, data?: unknown) {
  const req = new Request(origin + "/api/" + path, {
    method: data ? "POST" : "GET",
    headers: { cookie, origin, "Content-Type": "application/json" },
    body: data ? JSON.stringify(data) : undefined,
  });
  return handle(
    async () =>
      (await (path === "me"
        ? clientRoute(req, path)
        : adminRoute(req, path.split("?")[0]))) ?? json({}, 404),
  );
}
suite("staff management authority and entry visibility", () => {
  it("disabling a manager does not promote their stored role", async () => {
    const owner = await staff(true),
      target = await staff();
    await query("UPDATE admin_memberships SET role='manager' WHERE id=$1", [
      target.id,
    ]);
    expect(
      (
        await call("admin/team/telegram", owner.cookie, {
          userId: target.user.id,
          active: false,
        })
      ).status,
    ).toBe(200);
    const [row] = await query(
      "SELECT role,active FROM admin_memberships WHERE id=$1",
      [target.id],
    );
    expect(row).toMatchObject({ role: "manager", active: false });
  });
  beforeAll(() => {
    process.env.APP_URL = origin;
  });
  afterAll(closePool);
  afterEach(() => vi.unstubAllGlobals());
  it("finds an exact Telegram username, verifies it again before granting and keeps access after rename", async () => {
    const owner = await staff(true),
      target = await member();
    const username = "user_" + randomUUID().replaceAll("-", "").slice(0, 12);
    const [row] = await query<{ telegram_id: string }>(
      "UPDATE users SET telegram_username=$2 WHERE id=$1 RETURNING telegram_id",
      [target.id, username],
    );
    process.env.TELEGRAM_BOT_TOKEN = "test:staff";
    const fetchMock = vi
      .fn()
      .mockImplementation(async () =>
        Response.json({
          ok: true,
          result: { id: Number(row.telegram_id), type: "private", username },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const lookup = await call(
      "admin/team/candidates?username=" +
        encodeURIComponent("@" + username.toUpperCase()),
      owner.cookie,
    );
    expect(lookup.status).toBe(200);
    expect(
      (await lookup.json()).items.map((x: { id: string }) => x.id),
    ).toEqual([target.id]);
    expect(
      (await call("admin/team/candidates?username=user", owner.cookie)).status,
    ).toBe(200);
    expect(
      (await call("admin/team/candidates?username=%25", owner.cookie)).status,
    ).toBe(422);
    expect(
      (
        await call("admin/team/telegram", owner.cookie, {
          userId: target.id,
          active: true,
          expectedUsername: "@" + username,
        })
      ).status,
    ).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await query(
      "UPDATE users SET telegram_username='renamed_account' WHERE id=$1",
      [target.id],
    );
    expect((await (await call("me", target.cookie)).json()).staff_access).toBe(
      true,
    );
  });
  it("does not grant by a stale username or when Telegram cannot verify the account", async () => {
    const owner = await staff(true),
      target = await member();
    const [row] = await query<{ telegram_id: string }>(
      "UPDATE users SET telegram_username='old_nickname' WHERE id=$1 RETURNING telegram_id",
      [target.id],
    );
    process.env.TELEGRAM_BOT_TOKEN = "test:staff";
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json({
          ok: true,
          result: {
            id: Number(row.telegram_id),
            type: "private",
            username: "new_nickname",
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    expect(
      (
        await call("admin/team/telegram", owner.cookie, {
          userId: target.id,
          active: true,
          expectedUsername: "old_nickname",
        })
      ).status,
    ).toBe(409);
    fetchMock.mockRejectedValue(new Error("offline"));
    expect(
      (
        await call("admin/team/telegram", owner.cookie, {
          userId: target.id,
          active: true,
          expectedUsername: "old_nickname",
        })
      ).status,
    ).toBe(503);
    expect(
      await query(
        "SELECT id FROM admin_memberships WHERE telegram_user_id=$1",
        [target.id],
      ),
    ).toHaveLength(0);
  });
  it("hides the entry for ordinary members, shows after owner grant and hides after revoke", async () => {
    const owner = await staff(true),
      target = await member();
    expect((await (await call("me", target.cookie)).json()).staff_access).toBe(
      false,
    );
    const lookup = await call(
      "admin/team/candidates?phone=" +
        encodeURIComponent(target.phone.slice(1)),
      owner.cookie,
    );
    expect(lookup.status).toBe(200);
    expect((await lookup.json()).items[0].id).toBe(target.id);
    expect(
      (
        await call("admin/team/telegram", owner.cookie, {
          userId: target.id,
          active: true,
        })
      ).status,
    ).toBe(200);
    expect((await (await call("me", target.cookie)).json()).staff_access).toBe(
      true,
    );
    const [granted] = await query<{ id: string; can_manage_staff: boolean }>(
      "SELECT id,can_manage_staff FROM admin_memberships WHERE telegram_user_id=$1",
      [target.id],
    );
    expect(granted.can_manage_staff).toBe(false);
    const token = randomToken();
    await query(
      "INSERT INTO staff_sessions(membership_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')",
      [granted.id, hashToken(token)],
    );
    const sessionRequest = new Request(origin, {
      headers: { cookie: "rpm_staff=" + token },
    });
    expect((await requireStaff(sessionRequest)).id).toBe(granted.id);
    expect(
      (
        await call("admin/team/telegram", owner.cookie, {
          userId: target.id,
          active: false,
        })
      ).status,
    ).toBe(200);
    expect((await (await call("me", target.cookie)).json()).staff_access).toBe(
      false,
    );
    await expect(requireStaff(sessionRequest)).rejects.toThrow();
  });
  it("denies members and ordinary admins, including the legacy grant endpoint", async () => {
    const admin = await staff(),
      target = await member();
    expect(
      (
        await call("admin/team/telegram", target.cookie, {
          userId: target.id,
          active: true,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await call("admin/team/telegram", admin.cookie, {
          userId: target.id,
          active: true,
          can_manage_staff: true,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          "admin/team/candidates?phone=" + target.phone.slice(1),
          admin.cookie,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call("admin/team", admin.cookie, {
          authUserId: randomUUID(),
          name: "Escalation",
          email: "x@example.invalid",
          role: "admin",
          active: true,
          reason: "No authority",
        })
      ).status,
    ).toBe(403);
  });
  it("protects the owner and rejects blocked or unregistered targets", async () => {
    const owner = await staff(true),
      target = await member();
    expect(
      (
        await call("admin/team/telegram", owner.cookie, {
          userId: owner.user.id,
          active: false,
        })
      ).status,
    ).toBe(409);
    await query("UPDATE users SET status='blocked' WHERE id=$1", [target.id]);
    expect(
      (
        await call("admin/team/telegram", owner.cookie, {
          userId: target.id,
          active: true,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call("admin/team/telegram", owner.cookie, {
          userId: randomUUID(),
          active: true,
        })
      ).status,
    ).toBe(404);
    await query(
      "UPDATE admin_memberships SET can_manage_staff=false WHERE id=$1",
      [owner.id],
    );
    expect(
      (
        await call("admin/team/telegram", owner.cookie, {
          userId: target.id,
          active: true,
        })
      ).status,
    ).toBe(403);
  });
});
