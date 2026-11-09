import { describe, expect, it } from "vitest";
import { rentalQuoteWithAwards } from "../src/lib/roulette/quote";

describe("loyalty and prize exclusivity", () => {
  it("uses a selected prize instead of the club-card discount", () => {
    const quote = rentalQuoteWithAwards("4500000", 1, 300, [
      {
        id: "award-1",
        title: "Скидка по призу",
        effect_type: "percent",
        effect_value: 1000,
      },
    ]);

    expect(quote.discountKopecks).toBe("0");
    expect(quote.awardDiscountKopecks).toBe("450000");
    expect(quote.totalKopecks).toBe("4050000");
  });
});
