import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RouletteAdminPage } from "../src/components/admin/roulette";
import { useResource } from "../src/components/shared";

vi.mock("../src/components/shared", async (original) => ({
  ...(await original<typeof import("../src/components/shared")>()),
  useResource: vi.fn(),
}));

describe("roulette admin", () => {
  it("keeps odds and attempts in roulette settings, not the prize summary", () => {
    vi.mocked(useResource).mockImplementation(((path: string) => ({
      data: path === "admin/roulette/settings" ? { enabled: false, approved: false, serverApproved: false, registration_attempts: 1, attempt_ttl_days: 30, award_ttl_days: 30, version: 1 } : { items: [] },
      error: null,
      loading: false,
      refresh: async () => undefined,
    })) as typeof useResource);
    const html = renderToStaticMarkup(createElement(RouletteAdminPage, { staff: { id: "a", name: "Admin", email: "admin@example.test", role: "admin" } }));
    expect(html).toContain("Шансы призов");
    expect(html).toContain("Попытки за регистрацию");
    expect(html).toContain("Промокоды");
    expect(html).toContain("Ручная выдача");
    expect(html).not.toContain("вес 1");
  });
});
