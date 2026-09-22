import { describe, expect, it } from "vitest";
import {
  contentSchema,
  rentalDays,
  rentalQuote,
  triggerSchema,
} from "../src/lib/club/contracts";
import {
  calculateTier,
  calculateTierProgress,
  DEFAULT_TIERS,
  type TierRule,
} from "../src/lib/loyalty/rules";
import { money } from "../src/lib/ui";
describe("club experience rules", () => {
  it("displays the quoted kopecks exactly, including small and negative amounts", () => {
    expect(money("925092")).toMatch(/9\s250,92 ₽/);
    expect(money("1")).toBe("0,01 ₽");
    expect(money("-50")).toBe("-0,50 ₽");
    expect(money("10000")).toBe("100 ₽");
  });
  it("calculates a discount in kopecks, never a cashback amount", () => {
    expect(rentalQuote("1000099", 3, 750)).toEqual({
      dailyPriceKopecks: "1000099",
      days: 3,
      grossKopecks: "3000297",
      discountKopecks: "225022",
      totalKopecks: "2775275",
      discountBps: 750,
    });
    expect(() => rentalQuote("100", 1, 10000)).toThrow();
  });
  it("checks calendar dates, same-day minimum and bounded duration", () => {
    expect(rentalDays("2026-09-20", "2026-09-20")).toBe(1);
    expect(rentalDays("2026-09-20", "2026-09-23")).toBe(3);
    for (const dates of [
      ["2026-02-30", "2026-03-02"],
      ["2026-09-23", "2026-09-20"],
      ["2026-01-01", "2026-06-01"],
    ])
      expect(() => rentalDays(...(dates as [string, string]))).toThrow();
  });
  it("supports both old programs and the additional level without shifting progress", () => {
    const tiers: TierRule[] = [
      ...DEFAULT_TIERS.slice(0, 3),
      {
        code: "PLATINUM",
        thresholdKopecks: "50000000",
        rateBps: 450,
        benefits: ["Мойка"],
      },
      ...DEFAULT_TIERS.slice(3),
    ];
    expect(calculateTier("50000000", tiers)).toBe("PLATINUM");
    expect(calculateTierProgress("60000000", "PLATINUM", tiers)).toEqual({
      next_tier: "RED",
      remaining_amount: "10000000",
      progress_percent: 50,
    });
    expect(
      calculateTierProgress("100000000", "RED", DEFAULT_TIERS),
    ).toMatchObject({ next_tier: "SIGNATURE", remaining_amount: "50000000" });
    expect(
      calculateTierProgress("200000000", "SIGNATURE", tiers).next_tier,
    ).toBeNull();
  });
  it("rejects unsafe links and publication without content", () => {
    expect(
      contentSchema.safeParse({
        kind: "wiki",
        title: "FAQ",
        body: "Текст",
        active: true,
        linkUrl: "javascript:alert(1)",
      }).success,
    ).toBe(false);
    expect(
      contentSchema.safeParse({ kind: "route", title: "Поездка", active: true })
        .success,
    ).toBe(false);
    expect(
      contentSchema.safeParse({
        kind: "car",
        title: "Машина",
        dailyPriceKopecks: "0",
      }).success,
    ).toBe(false);
    expect(
      triggerSchema.safeParse({
        kind: "weather",
        enabled: true,
        message: "Прогноз",
        leadHours: 24,
      }).success,
    ).toBe(false);
  });
});
