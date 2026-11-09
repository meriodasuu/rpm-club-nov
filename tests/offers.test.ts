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
async function save(
  ctaUrl = "https://rpmrent.ru",
  origin = "http://127.0.0.1:3001",
  imageUrl = "",
  extra: Record<string, unknown> = {},
) {
  vi.stubEnv("APP_URL", origin);
  state.query.mockImplementation(async (sql: string) => {
    if (sql.startsWith("SELECT title,image_url,daily_price_kopecks"))
      return [
        {
          title: "Car",
          image_url: "/images/car.png",
          daily_price_kopecks: "100000",
        },
      ];
    return sql.startsWith("INSERT INTO offers") ? [{ id: "saved" }] : [];
  });
  return handle(
    async () =>
      (await operationsRoute(
        new Request(origin + "/api/admin/offers", {
          method: "POST",
          headers: {
            origin,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            offer_type: "free",
            car_id: null,
            discount_bps: null,
            title: "Sixth tier offer",
            description: "Published program audience",
            old_price: null,
            new_price: null,
            minimum_tier: "PLATINUM",
            start_at: "2026-09-20T00:00:00Z",
            end_at: "2026-09-21T00:00:00Z",
            cta_text: "Подробнее",
            cta_url: ctaUrl,
            image_url: imageUrl,
            active: true,
            ...extra,
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
  it("accepts the configured Club origin but rejects a lookalike host", async () => {
    state.codes = ["MEMBER", "DRIVE", "BLACK", "PLATINUM", "RED", "SIGNATURE"];
    const origin = "https://club.rpm-rent.ru";
    expect((await save(origin + "/contacts", origin)).status).toBe(200);
    state.query.mockClear();
    expect((await save(origin + ".example.com/contacts", origin)).status).toBe(
      422,
    );
    expect(state.query).not.toHaveBeenCalled();
  });
  it("accepts an HTTPS image URL from the car catalog", async () => {
    state.codes = ["MEMBER", "DRIVE", "BLACK", "PLATINUM", "RED", "SIGNATURE"];
    const imageUrl =
      "https://rpmrent.ru/api/media/storage?path=cars%2Fphoto.jpg";
    expect((await save("https://rpmrent.ru", undefined, imageUrl)).status).toBe(
      200,
    );
    const saved = state.query.mock.calls.find(([sql]) =>
      sql.startsWith("INSERT INTO offers"),
    );
    expect(saved?.[1][4]).toBe(imageUrl);
  });
  it("rejects insecure external image URLs", async () => {
    state.codes = ["MEMBER", "DRIVE", "BLACK", "PLATINUM", "RED", "SIGNATURE"];
    const response = await save(
      "https://rpmrent.ru",
      undefined,
      "http://evil.test/photo.jpg",
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "IMAGE_URL" });
    expect(state.query).not.toHaveBeenCalled();
  });
  it("rejects a free offer with a car or an old price", async () => {
    state.codes = ["MEMBER", "DRIVE", "BLACK", "PLATINUM", "RED", "SIGNATURE"];
    const response = await save(undefined, undefined, undefined, {
      car_id: "00000000-0000-4000-8000-000000000001",
      old_price: "10000",
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "OFFER_TYPE" });
    expect(state.query).not.toHaveBeenCalled();
  });
  it("rejects a catalog offer without a car and discount", async () => {
    state.codes = ["MEMBER", "DRIVE", "BLACK", "PLATINUM", "RED", "SIGNATURE"];
    const response = await save(undefined, undefined, undefined, {
      offer_type: "catalog",
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "OFFER_TYPE" });
    expect(state.query).not.toHaveBeenCalled();
  });
  it("calculates catalog price from the current car price on the server", async () => {
    state.codes = ["MEMBER", "DRIVE", "BLACK", "PLATINUM", "RED", "SIGNATURE"];
    const response = await save(undefined, undefined, undefined, {
      offer_type: "catalog",
      car_id: "00000000-0000-4000-8000-000000000001",
      discount_bps: 1500,
    });
    expect(response.status).toBe(200);
    const saved = state.query.mock.calls.find(([sql]) =>
      sql.startsWith("INSERT INTO offers"),
    );
    expect(saved?.[1].slice(3, 8)).toEqual([
      "Car",
      "/images/car.png",
      "Published program audience",
      "100000",
      "85000",
    ]);
  });
  it("archives an offer with an audit record", async () => {
    state.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith("SELECT * FROM offers WHERE id=$1 FOR UPDATE"))
        return [{ version: 2, archived_at: null, active: true }];
      if (sql.startsWith("UPDATE offers SET active=false"))
        return [
          { version: 3, archived_at: "2026-10-09T00:00:00Z", active: false },
        ];
      return [];
    });
    vi.stubEnv("APP_URL", "http://127.0.0.1:3001");
    const response = await handle(
      async () =>
        (await operationsRoute(
          new Request(
            "http://127.0.0.1:3001/api/admin/offers/00000000-0000-4000-8000-000000000001",
            {
              method: "DELETE",
              headers: {
                origin: "http://127.0.0.1:3001",
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ expected_version: 2 }),
            },
          ),
          "admin/offers/00000000-0000-4000-8000-000000000001",
        ))!,
    );
    expect(response.status).toBe(200);
    expect(
      state.query.mock.calls.some(([sql]) => sql.includes("'offer.archive'")),
    ).toBe(true);
  });
});
