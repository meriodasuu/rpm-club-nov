import { describe, expect, it } from "vitest";
import {
  rentalQuoteWithAwards,
  rentalTotalDiscountKopecks,
} from "../src/lib/roulette/quote";

describe("rental discounts persisted with the request", () => {
  it("includes club and prize discounts in the total deduction", () => {
    expect(rentalTotalDiscountKopecks("4500000", "3825000")).toBe("675000");
  });

  it("does not combine a club-card discount with a prize discount", () => {
    const quote = rentalQuoteWithAwards("4500000", 1, 300, [
      {
        id: "award-1",
        title: "Скидка по призу",
        effect_type: "fixed",
        effect_value: 1359697,
      },
    ]);

    expect(quote.discountKopecks).toBe("0");
    expect(quote.awardDiscountKopecks).toBe("1359697");
    expect(quote.totalKopecks).toBe("3140303");
  });
});
