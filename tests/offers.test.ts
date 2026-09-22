import { afterEach, describe, expect, it, vi } from "vitest";
import { operationsRoute } from "../src/lib/api/operations";
import { handle } from "../src/lib/http";
const state = vi.hoisted(() => ({
  codes: ["MEMBER", "DRIVE", "BLACK", "RED", "SIGNATURE"],
  query: vi.fn(),
}));
vi.mock("../src/lib/db", () => ({
  query: state.query,
  transaction: (work: (tx: { query: typeof state.query }) => unknown) =>
    work({ query: state.query }),
}));
vi.mock("../src/lib/loyalty", async (original) => ({
  ...(await original<typeof import("../src/lib/loyalty")>()),
  getProgram: async () => ({ tiers: state.codes.map((code) => ({ code })) }),
}));
vi.mock("../src/lib/auth/session", async (original) => ({
  ...(await original<typeof import("../src/lib/auth/session")>()),
  requireStaff: async () => ({ id: "test-staff", role: "manager" }),
}));
async function save() {
  vi.stubEnv("APP_URL", "http://127.0.0.1:3001");
  state.query.mockImplementation(async (sql: string) =>
    sql.startsWith("INSERT INTO offers") ? [{ id: "saved" }] : [],
  );
  return handle(
    async () =>
      (await operationsRoute(
        new Request("http://127.0.0.1:3001/api/admin/offers", {
          method: "POST",
          headers: {
            origin: "http://127.0.0.1:3001",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            title: "Sixth tier offer",
            description: "Published program audience",
            old_price: null,
            new_price: null,
            minimum_tier: "PLATINUM",
            start_at: "2026-09-20T00:00:00Z",
            end_at: "2026-09-21T00:00:00Z",
            cta_text: "Подробнее",
            cta_url: "https://rpmrent.ru",
            active: true,
          }),
        }),
        "admin/offers",
      ))!,
  );
}
describe("offer audience follows the published program", () => {
  afterEach(() => {
    state.query.mockReset();
    vi.unstubAllEnvs();
  });
  it("accepts the additional tier after publication", async () => {
    state.codes = ["MEMBER", "DRIVE", "BLACK", "PLATINUM", "RED", "SIGNATURE"];
    expect((await save()).status).toBe(200);
    const saved = state.query.mock.calls.find(([sql]) =>
      sql.startsWith("INSERT INTO offers"),
    );
    expect(saved?.[1][8]).toBe("PLATINUM");
  });
  it("rejects an unpublished additional tier without writing an offer", async () => {
    state.codes = ["MEMBER", "DRIVE", "BLACK", "RED", "SIGNATURE"];
    const response = await save();
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "TIER_UNPUBLISHED" });
    expect(state.query).not.toHaveBeenCalled();
  });
});
