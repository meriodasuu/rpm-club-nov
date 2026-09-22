import { describe, it, expect } from "vitest";
import {
  calculateTier,
  calculateRentalBonus,
  calculateTierProgress,
  parseRubles,
  resolveTierBenefits,
  resolveProgramStartsAt,
  DEFAULT_TIERS,
} from "../src/lib/loyalty";
describe("exact loyalty rules", () => {
  it.each([
    ["9999999", "MEMBER"],
    ["10000000", "DRIVE"],
    ["29999999", "DRIVE"],
    ["30000000", "BLACK"],
    ["69999999", "BLACK"],
    ["70000000", "RED"],
    ["149999999", "RED"],
    ["150000000", "SIGNATURE"],
  ])("tier boundary %s", (amount, tier) =>
    expect(calculateTier(amount)).toBe(tier),
  );
  it("new BLACK tier awards 1400 Bonus on 35000 rubles", () => {
    expect(calculateTier("32200000")).toBe("BLACK");
    expect(calculateRentalBonus("3500000", 400)).toBe("1400");
  });
  it("never uses floating point for money", () => {
    expect(parseRubles("999999999999.99")).toBe("99999999999999");
    expect(calculateRentalBonus("4000099", 200)).toBe("800");
    expect(() => parseRubles("1.001")).toThrow();
    expect(() => parseRubles("1e6")).toThrow();
  });
  it("clamps progress after manual upgrade and reaches maximum", () => {
    expect(calculateTierProgress("0", "BLACK").progress_percent).toBe(0);
    expect(calculateTierProgress("150000000", "SIGNATURE")).toEqual({
      next_tier: null,
      remaining_amount: null,
      progress_percent: 100,
    });
  });
  it("preserves the original program instant when its Moscow date is unchanged", () => {
    expect(
      resolveProgramStartsAt("2026-01-01", "2026-01-01T00:00:00.000Z"),
    ).toBe("2026-01-01T00:00:00.000Z");
    expect(
      resolveProgramStartsAt("2026-01-01", "2025-12-31T21:00:00.000Z"),
    ).toBe("2025-12-31T21:00:00.000Z");
    expect(
      resolveProgramStartsAt("2026-01-02", "2026-01-01T00:00:00.000Z"),
    ).toBe("2026-01-01T21:00:00.000Z");
  });
  it("uses one inherited privilege list and preserves the delivery replacement rule", () => {
    const tiers = DEFAULT_TIERS.map((t) => ({
      ...t,
      benefits:
        t.code === "MEMBER"
          ? ["Клуб"]
          : t.code === "BLACK"
            ? ["1 доставка в квартал", "Клуб"]
            : t.code === "RED"
              ? ["2 доставки в квартал"]
              : [],
    }));
    expect(resolveTierBenefits(tiers, "BLACK")).toEqual([
      "Клуб",
      "1 доставка в квартал",
    ]);
    expect(resolveTierBenefits(tiers, "RED")).toEqual([
      "Клуб",
      "2 доставки в квартал",
    ]);
    expect(resolveTierBenefits(tiers, "SIGNATURE")).toEqual([
      "Клуб",
      "2 доставки в квартал",
    ]);
  });
});
