import { describe, expect, it, vi } from "vitest";
import { rentalQuoteWithAwards } from "../src/lib/roulette/quote";
import { nextReset } from "../src/lib/roulette";

describe("roulette awards and rental quotes", () => {
  it("keeps the club discount when no prize is selected", () => {
    const quote = rentalQuoteWithAwards("100000", 2, 1000, []);
    expect(quote.grossKopecks).toBe("200000");
    expect(quote.discountKopecks).toBe("20000");
    expect(quote.totalKopecks).toBe("180000");
    expect(quote.awards).toEqual([]);
  });

  it("applies successive percent prizes after the stronger club or offer discount", () => {
    const quote = rentalQuoteWithAwards("100000", 2, 1000, [
      { id: "one", title: "Скидка 15%", effect_type: "percent", effect_value: 1500 },
      { id: "two", title: "Скидка 10%", effect_type: "percent", effect_value: 1000 },
    ], 500);

    expect(quote.grossKopecks).toBe("200000");
    expect(quote.discountKopecks).toBe("20000");
    expect(quote.awardDiscountKopecks).toBe("42300");
    expect(quote.totalKopecks).toBe("137700");
    expect(quote.awards.map((award) => award.effectKopecks)).toEqual([
      "27000",
      "15300",
    ]);
  });

  it("applies fixed and free-day prizes to the remaining amount and caps at zero", () => {
    const quote = rentalQuoteWithAwards("100000", 2, 0, [
      { id: "fixed", title: "Скидка 1500 ₽", effect_type: "fixed", effect_value: 150000 },
      { id: "day", title: "Бесплатный день", effect_type: "free_day", effect_value: 1 },
      { id: "wash", title: "Мойка", effect_type: "wash", effect_value: 0 },
    ]);

    expect(quote.awards.map((award) => award.effectKopecks)).toEqual([
      "150000",
      "50000",
      "0",
    ]);
    expect(quote.awardDiscountKopecks).toBe("200000");
    expect(quote.totalKopecks).toBe("0");
  });

  it("sets the daily reset at Moscow midnight across a UTC day boundary", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-09T20:59:59Z"));
      expect(nextReset()).toBe("2026-10-09T21:00:00.000Z");
      vi.setSystemTime(new Date("2026-10-09T21:00:01Z"));
      expect(nextReset()).toBe("2026-10-10T21:00:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });
});
