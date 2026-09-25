import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  mapCatalogSnapshot,
  syncCatalogSnapshot,
  assertCatalogBookable,
} from "../src/lib/club/catalog";
import { query, closePool } from "../src/lib/db";

const source = (id = "source-car") => ({
  id,
  slug: "test-car",
  title: "Test car",
  brand: "RPM",
  model: "Test",
  bodyType: "Купе",
  vehicleClass: "Спорт",
  year: 2024,
  transmission: "Автомат",
  engine: "3.0",
  horsepower: 300,
  driveType: "Полный",
  seats: 4,
  shortDescription: "Автомобиль для поездки",
  description: "Описание из сайта",
  pricePerDay: 12345,
  minimumRentalDays: 2,
  minimumDrivingExperience: 36,
  minimumAge: 21,
  mileageLimit: 200,
  extraMileagePrice: 40,
  insurance: "Страхование",
  features: ["Климат"],
  rentalConditions: ["Выдача по согласованию"],
  published: true,
  available: true,
  isDemo: false,
  recommendedOrder: 2,
  images: [{ url: "/api/media/storage?path=cars%2Fimage.jpg", alt: "Фото" }],
});

describe("site catalog mapping", () => {
  it("preserves ruble precision, photo references and rental restrictions", () => {
    const [car] = mapCatalogSnapshot([source()]);
    expect(car.price).toBe("1234500");
    expect(car.imageUrl).toBe(
      "https://rpmrent.ru/api/media/storage?path=cars%2Fimage.jpg",
    );
    expect(car.minimumDays).toBe(2);
    expect(car.body).toContain("300 л.с.");
    expect(car.summary).toContain("2024 г.");
  });
  it("does not publish drafts or demo cars, retains unavailable published cars", () => {
    expect(
      mapCatalogSnapshot([{ ...source(), published: false }])[0].active,
    ).toBe(false);
    expect(mapCatalogSnapshot([{ ...source(), isDemo: true }])[0].active).toBe(
      false,
    );
    expect(
      mapCatalogSnapshot([{ ...source(), available: false }])[0],
    ).toMatchObject({ active: true, available: false });
  });
  it("rejects duplicate IDs and invalid full snapshots before importing", () => {
    expect(() => mapCatalogSnapshot([source(), source()])).toThrow(
      "CATALOG_DUPLICATE_ID",
    );
    expect(() =>
      mapCatalogSnapshot([{ ...source(), pricePerDay: 0 }]),
    ).toThrow();
    expect(() =>
      mapCatalogSnapshot([
        { ...source(), images: [{ url: "javascript:alert(1)", alt: "" }] },
      ]),
    ).toThrow("CATALOG_IMAGE_URL");
  });
});

const suite = process.env.DATABASE_URL?.includes("rpm_club_test")
  ? describe
  : describe.skip;
suite("PostgreSQL catalog mirror", () => {
  afterAll(closePool);
  it("adds, changes, hides, restores and archives without changing IDs or existing requests", async () => {
    const car = source(randomUUID());
    expect((await syncCatalogSnapshot([car])).changed).toBe(1);
    const [initial] = await query<{ id: string; version: number }>(
      "SELECT id,version FROM club_content WHERE source_id=$1",
      [car.id],
    );
    expect((await syncCatalogSnapshot([car])).changed).toBe(0);
    expect(
      (
        await query<{ version: number }>(
          "SELECT version FROM club_content WHERE id=$1",
          [initial.id],
        )
      )[0].version,
    ).toBe(initial.version);
    const changed = {
      ...car,
      title: "Updated",
      pricePerDay: 15000,
      images: [{ url: "/new-photo.webp", alt: "New" }],
    };
    await syncCatalogSnapshot([changed]);
    expect(
      (
        await query(
          "SELECT id,version,title,daily_price_kopecks,image_url FROM club_content WHERE source_id=$1",
          [car.id],
        )
      )[0],
    ).toMatchObject({
      id: initial.id,
      version: initial.version + 1,
      title: "Updated",
      daily_price_kopecks: "1500000",
      image_url: "https://rpmrent.ru/new-photo.webp",
    });
    await syncCatalogSnapshot([{ ...changed, published: false }]);
    expect(
      (
        await query("SELECT active FROM club_content WHERE id=$1", [initial.id])
      )[0].active,
    ).toBe(false);
    await syncCatalogSnapshot([changed]);
    const [user] = await query<{ id: string }>(
      "INSERT INTO users(name,status) VALUES('Catalog synthetic','active') RETURNING id",
    );
    const [request] = await query<{ id: string }>(
      "INSERT INTO rental_requests(user_id,car_id,car_name,start_date,end_date,days,gross_kopecks,discount_kopecks,total_kopecks,discount_bps,program_version_id,request_key) SELECT $1,$2,'Saved title',current_date,current_date+1,1,100,0,100,0,id,$3 FROM program_versions ORDER BY version DESC LIMIT 1 RETURNING id",
      [user.id, initial.id, randomUUID()],
    );
    expect((await syncCatalogSnapshot([])).removed).toBeGreaterThan(0);
    expect(
      (
        await query(
          "SELECT active,source_deleted FROM club_content WHERE id=$1",
          [initial.id],
        )
      )[0],
    ).toEqual({ active: false, source_deleted: true });
    expect(
      (
        await query(
          "SELECT car_id,car_name,total_kopecks FROM rental_requests WHERE id=$1",
          [request.id],
        )
      )[0],
    ).toMatchObject({
      car_id: initial.id,
      car_name: "Saved title",
      total_kopecks: "100",
    });
    await syncCatalogSnapshot([changed]);
    expect(
      (
        await query(
          "SELECT id,active,source_deleted FROM club_content WHERE source_id=$1",
          [car.id],
        )
      )[0],
    ).toEqual({ id: initial.id, active: true, source_deleted: false });
  });
  it("keeps the previous catalog intact on malformed input and blocks stale pricing", async () => {
    const car = source(randomUUID());
    await syncCatalogSnapshot([car]);
    await expect(
      syncCatalogSnapshot([source(randomUUID()), { ...car, pricePerDay: -1 }]),
    ).rejects.toThrow();
    expect(
      (
        await query("SELECT active FROM club_content WHERE source_id=$1", [
          car.id,
        ])
      )[0].active,
    ).toBe(true);
    await expect(
      assertCatalogBookable(
        { query },
        { source: "rpm-rent", minimum_rental_days: 2 },
        1,
      ),
    ).rejects.toMatchObject({ code: "RENTAL_MINIMUM" });
    await expect(
      assertCatalogBookable({ query }, { available: false }, 2),
    ).rejects.toMatchObject({ code: "CAR_UNAVAILABLE" });
    await expect(
      assertCatalogBookable({ query }, { source: "rpm-rent" }, 2),
    ).resolves.toBeUndefined();
    await query(
      "UPDATE program_settings SET updated_at=now()-interval '3 minutes' WHERE key='catalog:sync'",
    );
    await expect(
      assertCatalogBookable({ query }, { source: "rpm-rent" }, 2),
    ).rejects.toMatchObject({ code: "CATALOG_STALE" });
    await syncCatalogSnapshot([car]);
  });
});
