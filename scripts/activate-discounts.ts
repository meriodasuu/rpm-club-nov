import { getProgram, publishProgram } from "../src/lib/loyalty";
import { closePool, query } from "../src/lib/db";

// Explicit one-time publication; never rewrites an existing program or rental.
const expectedVersion = Number(process.argv[2]);
if (!Number.isInteger(expectedVersion) || expectedVersion < 1)
  throw new Error(
    "Pass the reviewed current program version as the first argument.",
  );

try {
  const before = await getProgram();
  if (before.rewardMode === "discount") {
    console.log(
      JSON.stringify({ status: "already_discount", version: before.version }),
    );
  } else {
    if (before.version !== expectedVersion)
      throw new Error("Program changed: review it before publishing.");
    const rentalIds = await query<{ id: string; fingerprint: string }>(
      "SELECT id,md5(to_jsonb(r)::text) fingerprint FROM rentals r ORDER BY id",
    );
    const published = await publishProgram(
      {
        tiers: before.tiers,
        rewardMode: "discount",
        redemptionLimitBps: 0,
        expiryDays: before.expiryDays,
        referrerReward: "0",
        referredReward: "0",
        programStartsAt: before.programStartsAt,
        reason:
          "Скидочная программа по решению заказчика: сохраняем настроенные проценты, пороги и прежние аренды",
        idempotencyKey: "activate-discounts:" + before.id,
      },
      { id: "release:discounts-2026-09-23", role: "system" },
    );
    const after = await query<{ id: string; fingerprint: string }>(
      "SELECT id,md5(to_jsonb(r)::text) fingerprint FROM rentals r WHERE id=ANY($1::uuid[]) ORDER BY id",
      [rentalIds.map((r) => r.id)],
    );
    if (JSON.stringify(after) !== JSON.stringify(rentalIds))
      throw new Error(
        "Existing rental changed during publication; inspect audit before continuing.",
      );
    console.log(
      JSON.stringify({
        status: "published",
        version: published.version,
        mode: published.rewardMode,
        preservedRentals: after.length,
        tiers: published.tiers.map((t) => ({
          code: t.code,
          rateBps: t.rateBps,
        })),
      }),
    );
  }
} finally {
  await closePool();
}
