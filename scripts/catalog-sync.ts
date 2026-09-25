import pg from "pg";
import { writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { syncCatalogSnapshot } from "../src/lib/club/catalog";
import { syncRoutesSnapshot } from "../src/lib/club/routes-sync";
import { closePool } from "../src/lib/db";

const shutdown = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => shutdown.abort());
let client: pg.Client | undefined;
try {
  const url = new URL(process.env.CATALOG_DATABASE_URL ?? "");
  if (
    url.hostname !== "rpm-rent-db-1" ||
    url.username !== "rpm_club_catalog_reader"
  )
    throw new Error("CATALOG_DATABASE_URL must use the private catalog reader");
  client = new pg.Client({
    connectionString: url.href,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    application_name: "rpm-club-catalog",
  });
  let dirty = true;
  let wake: (() => void) | undefined;
  let connectionLost = false;
  client.on("error", () => {
    connectionLost = true;
    wake?.();
  });
  client.on("notification", () => {
    dirty = true;
    wake?.();
  });
  await client.connect();
  const lock = await client.query(
    "SELECT pg_try_advisory_lock(hashtextextended('rpm:catalog-reader',0)) AS acquired",
  );
  if (!lock.rows[0].acquired)
    throw new Error("Another catalog reader is already running");
  // LISTEN before the first snapshot: changes committed during import cannot be missed.
  await client.query("LISTEN rpm_club_catalog_changed");
  while (!shutdown.signal.aborted) {
    if (connectionLost) throw new Error("Catalog connection lost");
    dirty = false;
    const result = await client.query("SELECT car FROM rpm_club_catalog.cars");
    const status = await syncCatalogSnapshot(result.rows.map((row) => row.car));
    await writeFile("/tmp/rpm-catalog-heartbeat", String(Date.now()));
    if (status.changed || status.removed) console.log(JSON.stringify(status));
    try {
      const routes = await client.query(
        "SELECT route FROM rpm_club_catalog.routes LIMIT 5001",
      );
      const routeStatus = await syncRoutesSnapshot(
        routes.rows.map((row) => row.route),
      );
      await writeFile("/tmp/rpm-routes-heartbeat", String(Date.now()));
      if (routeStatus.changed || routeStatus.removed || routeStatus.archived)
        console.log(JSON.stringify({ routes: routeStatus }));
    } catch {
      console.error(
        "Route synchronization failed; previous routes retained. Car synchronization continues.",
      );
    }
    if (!dirty && !shutdown.signal.aborted && !connectionLost) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          shutdown.signal.removeEventListener("abort", done);
          wake = undefined;
          resolve();
        };
        const timer = setTimeout(done, 15000);
        wake = done;
        shutdown.signal.addEventListener("abort", done, { once: true });
      });
    }
  }
} catch {
  // Never log connection strings or raw pg errors; they may contain credentials.
  console.error(
    "Catalog synchronization failed; existing catalog retained, reconnecting after restart",
  );
  process.exitCode = 1;
  if (!shutdown.signal.aborted) await sleep(5000);
} finally {
  await client?.end().catch(() => {});
  await closePool();
}
