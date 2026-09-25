import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { authRoute } from "../src/lib/auth/routes";
import { handle } from "../src/lib/http";
import { closePool, query } from "../src/lib/db";
import { hashPassword } from "../src/lib/auth/password";
import { hashToken, requireStaff } from "../src/lib/auth/session";
const suite = process.env.DATABASE_URL?.includes("rpm_club_test")
  ? describe
  : describe.skip;
const origin = "http://127.0.0.1:3001";
const password = "Synthetic test password 123!";
async function call(email: string, value = password, requestOrigin = origin) {
  return handle(
    async () =>
      (await authRoute(
        new Request(origin + "/api/auth/staff/login", {
          method: "POST",
          headers: {
            origin: requestOrigin,
            "content-type": "application/json",
          },
          body: JSON.stringify({ email, password: value }),
        }),
        "auth/staff/login",
      ))!,
  );
}
function request(cookie: string) {
  return new Request(origin, { headers: { cookie } });
}
async function fixture() {
  const email = randomUUID() + "@example.test";
  const [member] = await query<{ id: string }>(
    "INSERT INTO admin_memberships(auth_user_id,email,name,role) VALUES($1,$2,'Password test','admin') RETURNING id",
    [randomUUID(), email],
  );
  await query(
    "INSERT INTO staff_password_credentials(membership_id,email,password_hash) VALUES($1,$2,$3)",
    [member.id, email, await hashPassword(password)],
  );
  return { ...member, email };
}
suite("Staff email/password authentication", () => {
  beforeAll(() => {
    process.env.APP_URL = origin;
  });
  afterAll(closePool);
  it("allows two independent devices without MFA; logging one out keeps the other signed in", async () => {
    const staff = await fixture();
    const first = await call("  " + staff.email.toUpperCase() + "  ");
    const second = await call(staff.email);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await first.json()).toEqual({ authenticated: true });
    const cookie1 = first.headers.get("set-cookie")!.split(";")[0];
    const cookie2 = second.headers.get("set-cookie")!.split(";")[0];
    expect(cookie1).not.toBe(cookie2);
    expect(first.headers.get("set-cookie")).toContain("HttpOnly");
    expect((await requireStaff(request(cookie1))).id).toBe(staff.id);
    expect((await requireStaff(request(cookie2))).id).toBe(staff.id);
    const logout = await authRoute(
      new Request(origin + "/api/auth/staff/logout", {
        method: "POST",
        headers: { origin, cookie: cookie1 },
      }),
      "auth/staff/logout",
    );
    expect(logout!.status).toBe(200);
    await expect(requireStaff(request(cookie1))).rejects.toThrow();
    expect((await requireStaff(request(cookie2))).id).toBe(staff.id);
    await query("UPDATE admin_memberships SET active=false WHERE id=$1", [
      staff.id,
    ]);
    await expect(requireStaff(request(cookie2))).rejects.toThrow();
    expect((await call(staff.email)).status).toBe(401);
  });
  it("uses the same failure for unknown and wrong passwords, limits guesses, rejects foreign origins", async () => {
    const staff = await fixture();
    const wrong = await call(staff.email, "wrong password");
    const unknown = await call(randomUUID() + "@example.test");
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect((await wrong.json()).message).toBe((await unknown.json()).message);
    expect(wrong.headers.get("set-cookie")).toBeNull();
    expect(
      (await call(staff.email, password, "https://foreign.test")).status,
    ).toBe(403);
    for (let i = 0; i < 4; i++)
      expect((await call(staff.email, "incorrect")).status).toBe(401);
    expect((await call(staff.email)).status).toBe(429);
    expect(
      await query("SELECT id FROM staff_sessions WHERE membership_id=$1", [
        staff.id,
      ]),
    ).toHaveLength(0);
    expect(
      await query("SELECT key FROM rate_limits WHERE key=$1", [
        "staff-password:" + hashToken(staff.email),
      ]),
    ).toHaveLength(1);
  });
  it("rejects blocked linked Telegram accounts and preserves assigned roles", async () => {
    const staff = await fixture();
    await query("UPDATE admin_memberships SET role='viewer' WHERE id=$1", [
      staff.id,
    ]);
    const response = await call(staff.email);
    const cookie = response.headers.get("set-cookie")!.split(";")[0];
    expect((await requireStaff(request(cookie))).role).toBe("viewer");
    await expect(requireStaff(request(cookie), "admin")).rejects.toThrow();
    const [user] = await query<{ id: string }>(
      "INSERT INTO users(name,status) VALUES('Blocked staff','blocked') RETURNING id",
    );
    await query(
      "UPDATE admin_memberships SET auth_user_id=NULL,telegram_user_id=$2 WHERE id=$1",
      [staff.id, user.id],
    );
    expect((await call(staff.email)).status).toBe(401);
    await expect(requireStaff(request(cookie))).rejects.toThrow();
  });
});
