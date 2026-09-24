import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notificationsRoute } from "../src/lib/notifications/api";
import { defaultNotification } from "../src/lib/notifications/contracts";
import { getProgram } from "../src/lib/loyalty";
import { query } from "../src/lib/db";

vi.mock("../src/lib/db", () => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock("../src/lib/loyalty", () => ({ getProgram: vi.fn() }));
vi.mock("../src/lib/notifications/engine", () => ({
  notificationRules: vi.fn(async () => []),
  recordActivity: vi.fn(),
}));
vi.mock("../src/lib/auth/session", () => ({
  requireStaff: vi.fn(async () => ({ id: "test-admin", role: "admin" })),
  requireSession: vi.fn(),
  rateLimit: vi.fn(),
}));

describe("notification editor program contract", () => {
  beforeEach(() => {
    vi.stubEnv("APP_URL", "https://rpm.example.invalid");
    vi.mocked(query).mockReset().mockResolvedValue([]);
    vi.mocked(getProgram).mockResolvedValue({
      id: "program-test",
      version: 1,
      rewardMode: "discount",
      tiers: [],
      redemptionLimitBps: 0,
      expiryDays: 365,
      referrerReward: "0",
      referredReward: "0",
      programStartsAt: "2026-01-01T00:00:00.000Z",
    });
  });
  afterEach(() => vi.unstubAllEnvs());
  it("returns the active reward mode to the editor", async () => {
    const response = await notificationsRoute(
      new Request("https://rpm.example.invalid/api/admin/notifications"),
      "admin/notifications",
    );
    expect((await response!.json()).rewardMode).toBe("discount");
  });
  it.each(["LOY_01", "EXP_01", "EXP_02", "PROMO_01"] as const)(
    "rejects enabling %s for a discount program before writing settings",
    async (id) => {
      const origin = process.env.APP_URL ?? "http://127.0.0.1:3001";
      const request = new Request(origin + "/api/admin/notifications", {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ ...defaultNotification(id), enabled: true }),
      });
      await expect(
        notificationsRoute(request, "admin/notifications"),
      ).rejects.toMatchObject({
        status: 422,
        code: "NOTIFICATION_UNAVAILABLE",
      });
      expect(query).not.toHaveBeenCalled();
    },
  );
});
