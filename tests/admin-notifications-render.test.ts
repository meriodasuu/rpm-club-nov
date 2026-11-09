import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LifecycleNotifications } from "../src/components/admin/notifications";
import { useResource } from "../src/components/shared";
import { defaultNotification } from "../src/lib/notifications/contracts";

vi.mock("../src/components/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/components/shared")>()),
  useResource: vi.fn(),
}));

function render(rewardMode: "discount" | "cashback") {
  vi.mocked(useResource).mockReturnValue({
    data: {
      rewardMode,
      limits: { service: 1, marketing: 1 },
      stats: [],
      logs: [],
      rules: (
        ["LOY_01", "EXP_01", "EXP_02", "PROMO_01", "RIDE_01"] as const
      ).map((id) => ({
        id,
        version: 1,
        config: { ...defaultNotification(id), enabled: true },
      })),
    },
    error: null,
    loading: false,
    refresh: async () => undefined,
  });
  return renderToStaticMarkup(createElement(LifecycleNotifications));
}

describe("notification editor availability", () => {
  it("marks stored enabled bonus rules unavailable and hides their forms in discount mode", () => {
    const html = render("discount");
    expect(html.match(/Недоступно при скидочной программе/g)).toHaveLength(4);
    expect(html.match(/Изменить текст и условия/g)).toHaveLength(1);
    expect(html).not.toContain("{bonus_balance}");
    expect(html).not.toContain("{bonus_added}");
    expect(html).not.toContain("Профиль и Bonus");
    expect(html).toContain("Первая поездка состоялась");
  });
  it("keeps the existing bonus rule editor available for legacy cashback programs", () => {
    const html = render("cashback");
    expect(html).not.toContain("Недоступно при скидочной программе");
    expect(html.match(/Изменить текст и условия/g)).toHaveLength(5);
    expect(html).toContain("{bonus_balance}");
  });
});
