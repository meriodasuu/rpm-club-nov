import type { Db } from "@/lib/db";
import { rentalQuote } from "@/lib/club/contracts";
import { z } from "zod";

export const rentalAwardSelectionSchema = z
  .array(z.string().uuid())
  .max(1, "К заявке можно применить только один приз")
  .optional()
  .default([]);

export type RentalAwardEffect = {
  id: string;
  title: string;
  terms?: string;
  claim_code?: string;
  effect_type:
    "percent" | "fixed" | "free_day" | "wash" | "upgrade" | "bonus" | "info";
  effect_value: number;
};

export function rentalAwardOption(award: {
  id: string;
  claim_code: string;
  prize_snapshot: Record<string, unknown>;
}): RentalAwardEffect & Record<string, unknown> {
  const snapshot = award.prize_snapshot;
  const title = String(snapshot.title ?? "Приз");
  const effectTypes: RentalAwardEffect["effect_type"][] = [
    "percent",
    "fixed",
    "free_day",
    "wash",
    "upgrade",
    "bonus",
    "info",
  ];
  let effect_type = effectTypes.includes(
    snapshot.effect_type as RentalAwardEffect["effect_type"],
  )
    ? (snapshot.effect_type as RentalAwardEffect["effect_type"])
    : "info";
  let effect_value = Number(snapshot.effect_value ?? 0);
  const percentDiscount = /^скидка\s+(\d+(?:[.,]\d{1,2})?)\s*%/i.exec(title);
  if (effect_type === "info" && percentDiscount) {
    const basisPoints = Math.round(
      Number(percentDiscount[1].replace(",", ".")) * 100,
    );
    if (basisPoints > 0 && basisPoints < 10_000) {
      effect_type = "percent";
      effect_value = basisPoints;
    }
  }
  return {
    ...snapshot,
    id: award.id,
    claim_code: award.claim_code,
    title,
    terms: String(snapshot.terms ?? ""),
    effect_type,
    effect_value,
  };
}

export function rentalPriceAdjustments<T extends { effectKopecks: string }>(
  awards: T[],
) {
  return awards.filter((award) => BigInt(award.effectKopecks) > 0n);
}

export function rentalTotalDiscountKopecks(
  grossKopecks: string,
  totalKopecks: string,
) {
  return (BigInt(grossKopecks) - BigInt(totalKopecks)).toString();
}

export function rentalQuoteWithAwards(
  dailyPrice: string,
  days: number,
  discountBps: number,
  awards: RentalAwardEffect[],
  offerDiscountBps = 0,
) {
  const base = rentalQuote(
    dailyPrice,
    days,
    awards.length ? 0 : Math.max(discountBps, offerDiscountBps),
  );
  let remaining = BigInt(base.totalKopecks);
  const daily = BigInt(dailyPrice);
  const appliedAwards = awards.map((award) => {
    let reduction = 0n;
    if (award.effect_type === "percent")
      reduction = (remaining * BigInt(award.effect_value)) / 10000n;
    else if (award.effect_type === "fixed")
      reduction = BigInt(award.effect_value);
    else if (award.effect_type === "free_day")
      reduction = daily * BigInt(award.effect_value);
    reduction = reduction > remaining ? remaining : reduction;
    remaining -= reduction;
    return { ...award, effectKopecks: reduction.toString() };
  });
  const awardDiscount = BigInt(base.totalKopecks) - remaining;
  return {
    ...base,
    totalKopecks: remaining.toString(),
    awardDiscountKopecks: awardDiscount.toString(),
    awards: appliedAwards,
    discountSource:
      offerDiscountBps >= discountBps && offerDiscountBps > 0
        ? "offer"
        : "club",
    clubDiscountBps: discountBps,
    offerDiscountBps,
  };
}

// Existing requests may already have a reserved prize. Their lifecycle remains intact.
export async function transitionAward(
  db: Db,
  requestId: string,
  status: "accepted" | "declined" | "cancelled" | "completed",
) {
  if (status === "accepted") return;
  const changed = await db.query<{
    id: string;
    previous_status: string;
    new_status: string;
  }>(
    `WITH linked AS (
       SELECT award_id FROM rental_request_awards WHERE request_id=$1
       UNION SELECT roulette_award_id FROM rental_requests WHERE id=$1 AND roulette_award_id IS NOT NULL
     ), changed AS (
       UPDATE roulette_awards a SET
         status=CASE WHEN $2='completed' THEN 'redeemed' WHEN a.expires_at<=now() THEN 'expired' ELSE 'available' END,
         redeemed_at=CASE WHEN $2='completed' THEN now() ELSE a.redeemed_at END,
         reserved_request_id=CASE WHEN $2='completed' THEN a.reserved_request_id ELSE NULL END,
         terminal_reason=CASE WHEN $2='completed' THEN 'rental_completed' WHEN a.expires_at<=now() THEN 'expired' ELSE $2 END
       FROM linked l WHERE a.id=l.award_id AND a.reserved_request_id=$1 AND a.status='reserved'
       RETURNING a.id,a.status
     ) SELECT id,'reserved'::text previous_status,status new_status FROM changed`,
    [requestId, status],
  );
  for (const award of changed)
    await db.query(
      "INSERT INTO audit_logs(actor_id,actor_role,action,entity_type,entity_id,reason,before_data,after_data) VALUES('rental-workflow','system',$1,'roulette_award',$2,$3,$4,$5)",
      [
        `roulette.award.${status}`,
        award.id,
        `Заявка ${requestId}`,
        JSON.stringify({ status: "reserved", requestId }),
        JSON.stringify({ status: award.new_status, requestId }),
      ],
    );
}
