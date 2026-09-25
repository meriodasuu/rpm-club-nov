import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  mapRoutesSnapshot,
  syncRoutesSnapshot,
} from "../src/lib/club/routes-sync";
import { query, closePool } from "../src/lib/db";
import { syncCatalogSnapshot } from "../src/lib/club/catalog";

const source = (id = randomUUID()) => ({
  id,
  slug: "test-place",
  title: "Маршрут у озера",
  subtitle: "Выходные с RPM",
  description: "Подробное описание маршрута",
  address: "Берег озера",
  mapUrl: "https://yandex.ru/maps/?text=lake",
  directions: "По шоссе направо",
  workingHours: "10:00–20:00",
  image: "/old.jpg",
  images: ["/one.jpg", "/two.jpg"],
  published: true,
  sortOrder: 2,
});
describe("website locations mapping", () => {
  it("preserves descriptions, gallery order, contacts and map links", () => {
    const [r] = mapRoutesSnapshot([source()]);
    expect(r).toMatchObject({
      title: "Маршрут у озера",
      body: "Подробное описание маршрута",
      active: true,
      sortOrder: 2,
      imageUrl: "https://rpmrent.ru/one.jpg",
    });
    expect(r.images.map((i) => i.url)).toEqual([
      "https://rpmrent.ru/one.jpg",
      "https://rpmrent.ru/two.jpg",
    ]);
    expect(r.details).toEqual({
      address: "Берег озера",
      workingHours: "10:00–20:00",
      directions: "По шоссе направо",
      mapUrl: "https://yandex.ru/maps/?text=lake",
      websiteUrl: "https://rpmrent.ru/locations/test-place",
    });
  });
  it("handles drafts, old cover images and missing maps without invented distances", () => {
    const [r] = mapRoutesSnapshot([
      {
        ...source(),
        images: [],
        published: false,
        mapUrl: null,
        address: null,
      },
    ]);
    expect(r.imageUrl).toBe("https://rpmrent.ru/old.jpg");
    expect(r.linkUrl).toBe("https://rpmrent.ru/locations/test-place");
    expect(r.active).toBe(false);
    expect(r.details.address).toBe("");
  });
  it("rejects unsafe links, duplicate IDs and partial malformed snapshots", () => {
    const route = source();
    expect(() => mapRoutesSnapshot([route, route])).toThrow(
      "ROUTE_DUPLICATE_ID",
    );
    expect(() =>
      mapRoutesSnapshot([{ ...route, mapUrl: "javascript:alert(1)" }]),
    ).toThrow();
    expect(() =>
      mapRoutesSnapshot([
        { ...route, images: ["https://user:password@example.com/a.jpg"] },
      ]),
    ).toThrow();
    expect(() =>
      mapRoutesSnapshot([route, { ...source(), title: null }]),
    ).toThrow();
  });
});
const suite = process.env.DATABASE_URL?.includes("rpm_club_test")
  ? describe
  : describe.skip;
suite("PostgreSQL routes mirror", () => {
  afterAll(closePool);
  it("initializes without notifications, preserves IDs, follows edits/publication/deletion and isolates cars", async () => {
    await query("DELETE FROM program_settings WHERE key='routes:sync'");
    const [legacy] = await query<{ id: string }>(
      "INSERT INTO club_content(kind,title,body,active) VALUES('route','Local route','Keep old copy',true) RETURNING id",
    );
    const route = source();
    const [car] = await query<{ id: string }>(
      "INSERT INTO club_content(kind,title,daily_price_kopecks,source,source_id,active) VALUES('car','Car isolation',10000,'rpm-rent',$1,true) RETURNING id",
      [route.id],
    );
    await syncRoutesSnapshot([route]);
    const [initial] = await query<{
      id: string;
      version: number;
      published_at: string | null;
    }>(
      "SELECT id,version,published_at FROM club_content WHERE source='rpm-rent-locations' AND source_id=$1",
      [route.id],
    );
    expect(initial.published_at).toBeNull();
    expect(
      (
        await query(
          "SELECT active,source_deleted,body FROM club_content WHERE id=$1",
          [legacy.id],
        )
      )[0],
    ).toMatchObject({
      active: false,
      source_deleted: true,
      body: "Keep old copy",
    });
    expect((await syncRoutesSnapshot([route])).changed).toBe(0);
    const edited = {
      ...route,
      title: "Новое название",
      slug: "new-slug",
      images: ["/new.jpg"],
      address: "Новый адрес",
      sortOrder: 4,
    };
    await syncRoutesSnapshot([edited]);
    expect(
      (
        await query(
          "SELECT id,title,image_url,route_details,published_at,sort_order FROM club_content WHERE id=$1",
          [initial.id],
        )
      )[0],
    ).toMatchObject({
      id: initial.id,
      title: "Новое название",
      image_url: "https://rpmrent.ru/new.jpg",
      route_details: {
        address: "Новый адрес",
        websiteUrl: "https://rpmrent.ru/locations/new-slug",
      },
      published_at: null,
      sort_order: 4,
    });
    await expect(
      syncRoutesSnapshot([edited, { ...source(), images: null }]),
    ).rejects.toThrow();
    expect(
      (
        await query("SELECT active FROM club_content WHERE id=$1", [initial.id])
      )[0].active,
    ).toBe(true);
    await syncRoutesSnapshot([{ ...edited, published: false }]);
    expect(
      (
        await query("SELECT active FROM club_content WHERE id=$1", [initial.id])
      )[0].active,
    ).toBe(false);
    await syncRoutesSnapshot([]);
    expect(
      (
        await query("SELECT source_deleted FROM club_content WHERE id=$1", [
          initial.id,
        ])
      )[0].source_deleted,
    ).toBe(true);
    expect(
      (await query("SELECT active FROM club_content WHERE id=$1", [car.id]))[0]
        .active,
    ).toBe(true);
    await syncRoutesSnapshot([edited]);
    expect(
      (
        await query(
          "SELECT id,active FROM club_content WHERE source='rpm-rent-locations' AND source_id=$1",
          [route.id],
        )
      )[0],
    ).toMatchObject({ id: initial.id, active: true });
    await syncCatalogSnapshot([]);
    expect(
      (
        await query("SELECT active FROM club_content WHERE id=$1", [initial.id])
      )[0].active,
    ).toBe(true);
    const added = source();
    await syncRoutesSnapshot([edited, added]);
    expect(
      (
        await query(
          "SELECT published_at FROM club_content WHERE source='rpm-rent-locations' AND source_id=$1",
          [added.id],
        )
      )[0].published_at,
    ).not.toBeNull();
  });
});
