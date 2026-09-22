import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { query, closePool } from "../src/lib/db";
import { authRoute } from "../src/lib/auth/routes";
import { handle } from "../src/lib/http";
const sdk = vi.hoisted(() => ({
  signInWithPassword: vi.fn(),
  listFactors: vi.fn(),
  enroll: vi.fn(),
  challengeAndVerify: vi.fn(),
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      signInWithPassword: sdk.signInWithPassword,
      mfa: {
        listFactors: sdk.listFactors,
        enroll: sdk.enroll,
        challengeAndVerify: sdk.challengeAndVerify,
      },
    },
  }),
}));
const suite = process.env.DATABASE_URL?.includes("rpm_club_test")
  ? describe
  : describe.skip;
const origin = "http://127.0.0.1:3001";
async function login(data: Record<string, unknown>) {
  return handle(
    async () =>
      (await authRoute(
        new Request(origin + "/api/auth/staff/login", {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify(data),
        }),
        "auth/staff/login",
      ))!,
  );
}
suite("staff MFA enrollment boundary", () => {
  beforeAll(() => {
    vi.stubEnv("APP_URL", origin);
    vi.stubEnv("SUPABASE_URL", "https://synthetic.supabase.invalid");
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "synthetic-key");
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await closePool();
  });
  it("issues a staff session only after a newly enrolled factor is verified", async () => {
    const id = randomUUID(),
      factorId = randomUUID(),
      email = id + "@example.invalid";
    await query(
      "INSERT INTO admin_memberships(auth_user_id,email,name,role) VALUES($1,$2,'MFA test','admin')",
      [id, email],
    );
    sdk.signInWithPassword.mockResolvedValue({
      data: { user: { id } },
      error: null,
    });
    sdk.listFactors.mockResolvedValue({
      data: { totp: [], all: [] },
      error: null,
    });
    sdk.enroll.mockResolvedValue({
      data: { id: factorId, totp: { qr_code: "<svg></svg>" } },
      error: null,
    });
    const first = await login({ email, password: "synthetic-only" });
    expect(first.headers.get("set-cookie")).toBeNull();
    expect(await first.json()).toMatchObject({
      mfa_required: true,
      enrollment: { factorId },
    });
    sdk.listFactors.mockResolvedValue({
      data: {
        totp: [],
        all: [{ id: factorId, factor_type: "totp", status: "unverified" }],
      },
      error: null,
    });
    sdk.challengeAndVerify
      .mockResolvedValueOnce({ error: { message: "wrong code" } })
      .mockResolvedValueOnce({ data: {}, error: null });
    const bad = await login({
      email,
      password: "synthetic-only",
      otp: "000000",
      factorId,
    });
    expect(bad.status).toBe(401);
    expect(bad.headers.get("set-cookie")).toBeNull();
    const good = await login({
      email,
      password: "synthetic-only",
      otp: "123456",
      factorId,
    });
    expect(good.status).toBe(200);
    expect(good.headers.get("set-cookie")).toContain("HttpOnly");
    expect(sdk.challengeAndVerify).toHaveBeenLastCalledWith({
      factorId,
      code: "123456",
    });
  });
  it("checks role again before inserting the authenticated session", async () => {
    const id = randomUUID(),
      email = id + "@example.invalid";
    await query(
      "INSERT INTO admin_memberships(auth_user_id,email,name,role) VALUES($1,$2,'MFA race','admin')",
      [id, email],
    );
    sdk.signInWithPassword.mockResolvedValue({
      data: { user: { id } },
      error: null,
    });
    sdk.listFactors.mockResolvedValue({
      data: { totp: [{ id: randomUUID(), status: "verified" }], all: [] },
      error: null,
    });
    sdk.challengeAndVerify.mockImplementationOnce(async () => {
      await query(
        "UPDATE admin_memberships SET active=false WHERE auth_user_id=$1",
        [id],
      );
      return { error: null };
    });
    const result = await login({
      email,
      password: "synthetic-only",
      otp: "123456",
    });
    expect(result.status).toBe(409);
    expect(result.headers.get("set-cookie")).toBeNull();
  });
});
