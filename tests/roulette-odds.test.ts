import { describe, expect, it } from "vitest";
import { effectiveOdds, parseOddsPercent, validateShares } from "../src/lib/roulette/odds";

describe("roulette odds", () => {
  const prizes = [
    { id: "a", weight: 5000, minimum_tier: null, issue_cap: null, issued_count: 0, active: true, archived_at: null, starts_at: null, ends_at: null },
    { id: "b", weight: 3000, minimum_tier: null, issue_cap: null, issued_count: 0, active: true, archived_at: null, starts_at: null, ends_at: null },
    { id: "c", weight: 2000, minimum_tier: "BLACK", issue_cap: 1, issued_count: 0, active: true, archived_at: null, starts_at: null, ends_at: null },
  ];
  it("renormalizes eligible odds by tier and cap", () => {
    expect(effectiveOdds(prizes, "MEMBER").map((p) => [p.id, p.percent])).toEqual([["a", 62.5], ["b", 37.5]]);
    expect(effectiveOdds(prizes, "BLACK").map((p) => [p.id, p.percent])).toEqual([["a", 50], ["b", 30], ["c", 20]]);
    expect(effectiveOdds([{ ...prizes[2], issued_count: 1 }], "BLACK")).toEqual([]);
  });
  it("requires complete nonnegative shares summing to 100 percent", () => {
    expect(validateShares([{ id: "a", basisPoints: 5000 }, { id: "b", basisPoints: 5000 }], ["a", "b"])).toBe(true);
    expect(validateShares([{ id: "a", basisPoints: 10000 }], ["a", "b"])).toBe(false);
    expect(validateShares([{ id: "a", basisPoints: -1 }, { id: "b", basisPoints: 10001 }], ["a", "b"])).toBe(false);
  });
  it("accepts comma decimals and intermediate input without rounding the field", () => {
    expect(parseOddsPercent("12,34")).toBe(1234);
    expect(parseOddsPercent("0.01")).toBe(1);
    expect(parseOddsPercent("12,")).toBeNull();
    expect(parseOddsPercent("")).toBeNull();
    expect(parseOddsPercent("12.345")).toBeNull();
  });
});
