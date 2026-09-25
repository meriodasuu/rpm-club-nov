import { z } from "zod";
import { transaction } from "@/lib/db";

const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .nullable()
    .transform((v) => v ?? "");
const location = z.object({
  id: z.string().min(1).max(200),
  slug: z.string().min(1).max(200),
  title: z.string().min(2).max(160),
  subtitle: z.string().max(500),
  description: z.string().max(10000),
  address: optionalText(300),
  mapUrl: optionalText(2000),
  directions: optionalText(5000),
  workingHours: optionalText(300),
  image: z.string().max(2000),
  images: z.array(z.string().max(2000)).max(50),
  published: z.boolean(),
  sortOrder: z.number().int().min(0).max(100000),
});
function httpsUrl(value: string) {
  const url = new URL(value, "https://rpmrent.ru");
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("ROUTE_URL_INVALID");
  return url.href;
}
export function mapRoutesSnapshot(input: unknown) {
  const rows = z.array(location).max(5000).parse(input);
  if (new Set(rows.map((r) => r.id)).size !== rows.length)
    throw new Error("ROUTE_DUPLICATE_ID");
  return rows.map((row) => {
    const images = (
      row.images.length ? row.images : row.image ? [row.image] : []
    ).map((url) => ({ url: httpsUrl(url), alt: row.title }));
    const websiteUrl = `https://rpmrent.ru/locations/${encodeURIComponent(row.slug)}`;
    return {
      sourceId: row.id,
      title: row.title,
      summary: row.subtitle,
      body: row.description,
      images,
      imageUrl: images[0]?.url ?? "",
      linkUrl: row.mapUrl ? httpsUrl(row.mapUrl) : websiteUrl,
      active: row.published,
      sortOrder: row.sortOrder,
      details: {
        address: row.address,
        workingHours: row.workingHours,
        directions: row.directions,
        mapUrl: row.mapUrl ? httpsUrl(row.mapUrl) : "",
        websiteUrl,
      },
    };
  });
}
export async function syncRoutesSnapshot(input: unknown) {
  const routes = mapRoutesSnapshot(input);
  return transaction(async (tx) => {
    await tx.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('rpm:routes-sync',0))",
    );
    const initialized =
      (await tx.query("SELECT 1 FROM program_settings WHERE key='routes:sync'"))
        .length > 0;
    let changed = 0;
    for (const route of routes) {
      const saved = await tx.query(
        `INSERT INTO club_content(kind,title,summary,body,image_url,image_urls,link_url,route_details,active,sort_order,source,source_id,source_synced_at,published_at)
        VALUES('route',$1,$2,$3,$4,$5,$6,$7,$8,$9,'rpm-rent-locations',$10,now(),CASE WHEN $8 AND $11 THEN now() ELSE NULL END)
        ON CONFLICT(source,source_id) DO UPDATE SET title=excluded.title,summary=excluded.summary,body=excluded.body,image_url=excluded.image_url,image_urls=excluded.image_urls,link_url=excluded.link_url,route_details=excluded.route_details,active=excluded.active,sort_order=excluded.sort_order,source_deleted=false,source_synced_at=now(),version=club_content.version+1,updated_at=now(),
        published_at=CASE WHEN excluded.active AND NOT club_content.active AND club_content.published_at IS NULL THEN now() ELSE club_content.published_at END
        WHERE (club_content.title,club_content.summary,club_content.body,club_content.image_url,club_content.image_urls,club_content.link_url,club_content.route_details,club_content.active,club_content.sort_order,club_content.source_deleted)
        IS DISTINCT FROM (excluded.title,excluded.summary,excluded.body,excluded.image_url,excluded.image_urls,excluded.link_url,excluded.route_details,excluded.active,excluded.sort_order,false) RETURNING id`,
        [
          route.title,
          route.summary,
          route.body,
          route.imageUrl,
          JSON.stringify(route.images),
          route.linkUrl,
          JSON.stringify(route.details),
          route.active,
          route.sortOrder,
          route.sourceId,
          initialized,
        ],
      );
      changed += saved.length;
    }
    const removed = await tx.query(
      "UPDATE club_content SET active=false,source_deleted=true,source_synced_at=now(),version=version+1,updated_at=now() WHERE kind='route' AND source='rpm-rent-locations' AND NOT source_deleted AND NOT(source_id=ANY($1::text[])) RETURNING id",
      [routes.map((r) => r.sourceId)],
    );
    // Preserve old Club-only content as an archive after the first valid source read.
    const archived = await tx.query(
      "UPDATE club_content SET active=false,source_deleted=true,version=version+1,updated_at=now() WHERE kind='route' AND source IS NULL AND NOT source_deleted RETURNING id",
    );
    const status = {
      at: new Date().toISOString(),
      total: routes.length,
      published: routes.filter((r) => r.active).length,
      changed,
      removed: removed.length,
      archived: archived.length,
    };
    await tx.query(
      "INSERT INTO program_settings(key,value) VALUES('routes:sync',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()",
      [JSON.stringify(status)],
    );
    if (changed || removed.length || archived.length)
      await tx.query(
        "INSERT INTO audit_logs(actor_id,actor_role,action,entity_type,entity_id,reason,after_data) VALUES('rpm-rent-routes','system','routes.sync','catalog','rpm-rent-locations','Синхронизация маршрутов с сайтом RPM Rent',$1)",
        [JSON.stringify(status)],
      );
    return status;
  });
}
