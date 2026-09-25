import { z } from "zod";
import { transaction, type Db } from "@/lib/db";
import { HttpError } from "@/lib/http";

const text = z
  .string()
  .nullable()
  .transform((value) => value ?? "");
const optionalNumber = z.number().int().nullable();
const sourceCar = z.object({
  id: z.string().min(1).max(200),
  slug: z.string().min(1).max(200),
  title: z.string().min(2).max(160),
  brand: text,
  model: text,
  bodyType: text,
  vehicleClass: text,
  year: optionalNumber,
  transmission: text,
  engine: text,
  horsepower: optionalNumber,
  driveType: text,
  seats: optionalNumber,
  shortDescription: text,
  description: text,
  pricePerDay: z.number().int().positive().max(9999999999),
  minimumRentalDays: z.number().int().min(1).max(90).nullable(),
  minimumAge: optionalNumber,
  minimumDrivingExperience: optionalNumber,
  mileageLimit: optionalNumber,
  extraMileagePrice: optionalNumber,
  insurance: text,
  features: z.array(z.string()),
  rentalConditions: z.array(z.string()),
  published: z.boolean(),
  available: z.boolean(),
  isDemo: z.boolean(),
  recommendedOrder: z.number().int(),
  images: z.array(z.object({ url: z.string(), alt: text })).max(100),
});

// Match the public wording used by RPM Rent's imported catalog.
function publicCopy(value: string) {
  return value
    .replace(
      /Характеристики и тарифы импортированы из рабочего стандарта RPM\./g,
      "Технические характеристики и условия аренды для этой модели.",
    )
    .replace(
      /Импортировано из рабочего стандарта RPM\./g,
      "Технические характеристики и условия аренды для этой модели.",
    )
    .replace(
      /Тариф на 12 часов не указан/g,
      "Тариф на 12 часов уточняется у менеджера",
    )
    .replace(
      /Тариф на 3–7 суток не указан/g,
      "Тариф на 3–7 суток уточняется у менеджера",
    );
}

export function mapCatalogSnapshot(input: unknown) {
  const cars = z.array(sourceCar).max(200).parse(input);
  if (new Set(cars.map((car) => car.id)).size !== cars.length)
    throw new Error("CATALOG_DUPLICATE_ID");
  return cars.map((car) => {
    const images = car.images.map((image) => {
      const url = new URL(image.url, "https://rpmrent.ru");
      if (url.protocol !== "https:" || url.username || url.password)
        throw new Error("CATALOG_IMAGE_URL");
      return { url: url.href, alt: image.alt || car.title };
    });
    const specs = [
      car.year && `${car.year} г.`,
      car.vehicleClass,
      car.bodyType,
      car.transmission,
      car.driveType,
    ]
      .filter(Boolean)
      .join(" · ");
    const body = [
      publicCopy(car.description),
      car.engine && `Двигатель: ${car.engine}`,
      car.horsepower && `Мощность: ${car.horsepower} л.с.`,
      car.seats && `Мест: ${car.seats}`,
      ...car.features.map(publicCopy),
      car.minimumRentalDays &&
        `Минимальный срок аренды: ${car.minimumRentalDays} сут.`,
      car.minimumAge &&
        `Возраст водителя: от ${Math.max(18, car.minimumAge)} лет`,
      car.minimumDrivingExperience &&
        `Стаж вождения: от ${car.minimumDrivingExperience} мес.`,
      car.mileageLimit && `Лимит пробега: ${car.mileageLimit} км/сутки`,
      car.extraMileagePrice &&
        `Дополнительный пробег: ${car.extraMileagePrice} ₽/км`,
      car.insurance,
      ...car.rentalConditions.map(publicCopy),
      "Залог и окончательные условия подтвердит менеджер. Оплата на месте.",
    ]
      .filter(Boolean)
      .join("\n");
    if (body.length > 12000) throw new Error("CATALOG_DESCRIPTION_TOO_LONG");
    return {
      sourceId: car.id,
      title: car.title,
      summary:
        `${specs}${specs ? "\n" : ""}${publicCopy(car.shortDescription)}`.slice(
          0,
          500,
        ),
      body,
      imageUrl: images[0]?.url ?? "",
      images,
      linkUrl: `https://rpmrent.ru/cars/${encodeURIComponent(car.slug)}`,
      price: (BigInt(car.pricePerDay) * 100n).toString(),
      active: car.published && !car.isDemo,
      available:
        car.available &&
        !car.isDemo &&
        car.minimumRentalDays !== null &&
        car.minimumAge !== null &&
        car.minimumDrivingExperience !== null,
      minimumDays: car.minimumRentalDays ?? 1,
      sortOrder: car.recommendedOrder,
    };
  });
}

export async function syncCatalogSnapshot(input: unknown) {
  // Validate the entire snapshot before modifying anything, including deletions.
  const cars = mapCatalogSnapshot(input);
  return transaction(async (tx) => {
    await tx.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('rpm:catalog-sync',0))",
    );
    let changed = 0;
    for (const car of cars) {
      const saved = await tx.query<{ id: string }>(
        `INSERT INTO club_content(kind,title,summary,body,image_url,image_urls,link_url,daily_price_kopecks,active,available,minimum_rental_days,sort_order,source,source_id,source_synced_at,published_at)
        VALUES('car',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'rpm-rent',$12,now(),CASE WHEN $8 THEN now() ELSE NULL END)
        ON CONFLICT(source,source_id) DO UPDATE SET title=excluded.title,summary=excluded.summary,body=excluded.body,image_url=excluded.image_url,image_urls=excluded.image_urls,link_url=excluded.link_url,daily_price_kopecks=excluded.daily_price_kopecks,active=excluded.active,available=excluded.available,minimum_rental_days=excluded.minimum_rental_days,sort_order=excluded.sort_order,source_deleted=false,source_synced_at=now(),published_at=CASE WHEN excluded.active THEN coalesce(club_content.published_at,now()) ELSE club_content.published_at END,version=club_content.version+1,updated_at=now()
        WHERE (club_content.title,club_content.summary,club_content.body,club_content.image_url,club_content.image_urls,club_content.link_url,club_content.daily_price_kopecks,club_content.active,club_content.available,club_content.minimum_rental_days,club_content.sort_order,club_content.source_deleted)
        IS DISTINCT FROM (excluded.title,excluded.summary,excluded.body,excluded.image_url,excluded.image_urls,excluded.link_url,excluded.daily_price_kopecks,excluded.active,excluded.available,excluded.minimum_rental_days,excluded.sort_order,false) RETURNING id`,
        [
          car.title,
          car.summary,
          car.body,
          car.imageUrl,
          JSON.stringify(car.images),
          car.linkUrl,
          car.price,
          car.active,
          car.available,
          car.minimumDays,
          car.sortOrder,
          car.sourceId,
        ],
      );
      changed += saved.length;
    }
    const removed = await tx.query(
      `UPDATE club_content SET active=false,available=false,source_deleted=true,source_synced_at=now(),version=version+1,updated_at=now() WHERE source='rpm-rent' AND NOT source_deleted AND NOT(source_id=ANY($1::text[])) RETURNING id`,
      [cars.map((car) => car.sourceId)],
    );
    const status = {
      at: new Date().toISOString(),
      total: cars.length,
      published: cars.filter((car) => car.active).length,
      changed,
      removed: removed.length,
    };
    await tx.query(
      "INSERT INTO program_settings(key,value) VALUES('catalog:sync',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()",
      [JSON.stringify(status)],
    );
    if (changed || removed.length)
      await tx.query(
        "INSERT INTO audit_logs(actor_id,actor_role,action,entity_type,entity_id,reason,after_data) VALUES('rpm-rent-catalog','system','catalog.sync','catalog','rpm-rent','Синхронизация автопарка с сайтом RPM Rent',$1)",
        [JSON.stringify(status)],
      );
    return status;
  });
}

export async function assertCatalogBookable(
  tx: Db,
  car: {
    source?: string | null;
    available?: boolean;
    minimum_rental_days?: number;
  },
  days: number,
) {
  if (car.available === false)
    throw new HttpError(
      409,
      "CAR_UNAVAILABLE",
      "Автомобиль временно недоступен для аренды",
    );
  if (days < (car.minimum_rental_days ?? 1))
    throw new HttpError(
      422,
      "RENTAL_MINIMUM",
      `Минимальный срок аренды — ${car.minimum_rental_days} сут.`,
    );
  if (car.source === "rpm-rent") {
    const [state] = await tx.query<{ fresh: boolean }>(
      "SELECT updated_at>now()-interval '2 minutes' AS fresh FROM program_settings WHERE key='catalog:sync'",
    );
    if (!state?.fresh)
      throw new HttpError(
        503,
        "CATALOG_STALE",
        "Каталог временно обновляется. Повторите расчёт позже.",
      );
  }
}
