import { describe, expect, it } from "vitest";
import { visibleRentalAwards } from "../src/components/miniapp/rental";
import {
  rentalAwardOption,
  rentalAwardSelectionSchema,
  rentalPriceAdjustments,
  rentalQuoteWithAwards,
} from "../src/lib/roulette/quote";

describe("rental award options", () => {
  it("allows at most one prize per rental request", () => {
    expect(
      rentalAwardSelectionSchema.parse([
        "00000000-0000-4000-8000-000000000001",
      ]),
    ).toHaveLength(1);
    expect(() =>
      rentalAwardSelectionSchema.parse([
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000002",
      ]),
    ).toThrow("К заявке можно применить только один приз");
  });

  it("keeps the issued award ID instead of the prize template ID", () => {
    const option = rentalAwardOption({
      id: "issued-award-id",
      claim_code: "RM-123",
      prize_snapshot: { id: "prize-template-id", title: "Скидка" },
    });
    expect(option.id).toBe("issued-award-id");
  });

  it("calculates legacy informational prizes whose title explicitly says a percentage discount", () => {
    const option = rentalAwardOption({
      id: "issued-award-id",
      claim_code: "RM-123",
      prize_snapshot: {
        id: "prize-template-id",
        title: "Скидка 15% на аренду",
        effect_type: "info",
        effect_value: 0,
      },
    });
    expect(option).toMatchObject({
      effect_type: "percent",
      effect_value: 1500,
    });
    expect(rentalQuoteWithAwards("4500000", 1, 0, [option]).totalKopecks).toBe(
      "3825000",
    );
  });

  it("omits non-price prizes from the money breakdown", () => {
    expect(
      rentalPriceAdjustments([
        { id: "discount", effectKopecks: "1000" },
        { id: "wash", effectKopecks: "0" },
      ]),
    ).toHaveLength(1);
  });

  it("keeps the last successful award list while a quote is refreshing or has failed", () => {
    const previous = [
      {
        id: "award-1",
        title: "Скидка",
        claim_code: "RM-123",
        effect_type: "percent",
        effect_value: 1000,
        terms: "",
      },
    ];
    expect(visibleRentalAwards(null, previous)).toBe(previous);
  });
});
