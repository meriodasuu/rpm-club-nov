import { afterEach, describe, expect, it, vi } from "vitest";
import { safeMaintenanceCode } from "../src/lib/jobs/diagnostics";
import { contentSchema } from "../src/lib/club/contracts";
import { referralProgramSchema } from "../src/lib/referrals/contracts";
describe("admin UX contracts", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("never stores arbitrary maintenance exception messages or codes", () => {
    expect(
      safeMaintenanceCode({ code: "42P01", message: "secret://password" }),
    ).toBe("42P01");
    expect(safeMaintenanceCode({ code: "secret://password" })).toBe(
      "UNEXPECTED_ERROR",
    );
    expect(safeMaintenanceCode(new Error("private-token"))).toBe(
      "UNEXPECTED_ERROR",
    );
  });
  it("accepts only generated local image paths and https images", () => {
    vi.stubEnv("NODE_ENV", "production");
    const base = { kind: "wiki", title: "Фото" };
    expect(
      contentSchema.safeParse({
        ...base,
        imageUrl: "/api/media/00000000-0000-4000-8000-000000000000.webp",
      }).success,
    ).toBe(true);
    for (const imageUrl of [
      "/api/media/../../.env",
      "//evil.test/image",
      "javascript:alert(1)",
      "http://evil.test/image",
    ])
      expect(contentSchema.safeParse({ ...base, imageUrl }).success).toBe(
        false,
      );
  });
  it("requires meaningful terms for both sides and a version", () => {
    const input = {
      enabled: true,
      referrer: { title: "Подарок", terms: "Получить в офисе" },
      referred: { title: "Доставка", terms: "Одна доставка" },
      expectedVersion: 0,
      reason: "Запуск",
    };
    expect(referralProgramSchema.safeParse(input).success).toBe(true);
    expect(
      referralProgramSchema.safeParse({
        ...input,
        referred: { title: " ", terms: "" },
      }).success,
    ).toBe(false);
  });
});
