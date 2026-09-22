import { describe, it, expect } from "vitest";
import {
  defaultNotification,
  notificationRuleSchema,
  notificationIds,
  renderNotification,
} from "../src/lib/notifications/contracts";
import { sixTierDraft, DEFAULT_TIERS } from "../src/lib/loyalty/rules";
describe("approved notification and tier contracts", () => {
  it("prepares six distinct named levels without mutating financial history or inventing a new threshold", () => {
    const source = structuredClone(DEFAULT_TIERS),
      draft = sixTierDraft(source);
    expect(draft.map((t) => t.displayName)).toEqual([
      "Старт",
      "Серебро",
      "Золото",
      "Платина",
      "Black",
      "VIP",
    ]);
    expect(draft[3].thresholdKopecks).toBe("");
    expect(source).toEqual(DEFAULT_TIERS);
    expect(draft[4].code).not.toBe(draft[5].code);
  });
  it("validates all defaults and rejects unavailable online payment and unknown variables", () => {
    for (const id of notificationIds)
      expect(
        notificationRuleSchema.safeParse(defaultNotification(id)).success,
      ).toBe(true);
    for (const id of ["PAY_01", "PAY_02", "CARD_01"] as const)
      expect(
        notificationRuleSchema.safeParse({
          ...defaultNotification(id),
          enabled: true,
        }).success,
      ).toBe(false);
    expect(
      notificationRuleSchema.safeParse({
        ...defaultNotification("RIDE_01"),
        body: "{secret}",
      }).success,
    ).toBe(false);
  });
  it("renders missing values without raw placeholders and does not promise cashback after a ride", () => {
    expect(renderNotification("{first_name}: {bonus_balance}", {})).toBe(
      "участник клуба: 0",
    );
    expect(defaultNotification("RIDE_02").body).not.toContain("{bonus_added}");
  });
});
