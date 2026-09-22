export const TIER_CODES = [
  "MEMBER",
  "DRIVE",
  "BLACK",
  "PLATINUM",
  "RED",
  "SIGNATURE",
] as const;
export type TierCode = (typeof TIER_CODES)[number];
export const CARD_COLORS = [
  "bronze",
  "silver",
  "gold",
  "diamond",
  "red",
  "black",
] as const;
export interface TierRule {
  code: TierCode;
  thresholdKopecks: string;
  rateBps: number;
  benefits: string[];
  displayName?: string;
  color?: (typeof CARD_COLORS)[number];
}
// Existing five-tier programs remain valid until the owner publishes the sixth tier.
export const DEFAULT_TIERS: TierRule[] = TIER_CODES.filter(
  (c) => c !== "PLATINUM",
).map((code, i) => ({
  code,
  thresholdKopecks: ["0", "10000000", "30000000", "70000000", "150000000"][i],
  rateBps: [200, 300, 400, 500, 700][i],
  benefits: [],
}));
export const tierColor = (tier: TierRule) =>
  tier.color ?? CARD_COLORS[TIER_CODES.indexOf(tier.code)];
export const tierName = (tier: TierRule) => tier.displayName || tier.code;
// Stable codes retain historical references; new display names belong to a new edition.
export const APPROVED_TIER_NAMES: Record<TierCode, string> = {
  MEMBER: "Старт",
  DRIVE: "Серебро",
  BLACK: "Золото",
  PLATINUM: "Платина",
  RED: "Black",
  SIGNATURE: "VIP",
};
export function sixTierDraft(tiers: TierRule[]): TierRule[] {
  return TIER_CODES.map((code, index) => ({
    ...(tiers.find((t) => t.code === code) ?? {
      code,
      thresholdKopecks: "",
      rateBps: 0,
      benefits: [],
    }),
    displayName: APPROVED_TIER_NAMES[code],
    color: CARD_COLORS[index],
  }));
}
export function resolveTierBenefits(
  tiers: TierRule[],
  code: TierCode,
): string[] {
  const rank = TIER_CODES.indexOf(code);
  return tiers
    .filter((tier) => TIER_CODES.indexOf(tier.code) <= rank)
    .flatMap((tier) => tier.benefits)
    .filter(
      (benefit, index, all) =>
        all.indexOf(benefit) === index &&
        !(rank >= TIER_CODES.indexOf("RED") && /^1 доставк/i.test(benefit)),
    );
}
export function resolveProgramStartsAt(date: string, previous: string): string {
  // Editing another setting must not normalize an existing instant to Moscow midnight.
  const previousDate = new Date(Date.parse(previous) + 3 * 3600000)
    .toISOString()
    .slice(0, 10);
  return date === previousDate
    ? previous
    : new Date(date + "T00:00:00+03:00").toISOString();
}
export const cardHex = (tier: TierRule) =>
  ({
    bronze: "#69462e",
    silver: "#475361",
    gold: "#756026",
    diamond: "#31596c",
    red: "#930f1c",
    black: "#141416",
  })[tierColor(tier)];
export function parseRubles(value: string): string {
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(value))
    throw new Error(
      "Сумма должна содержать рубли и не более двух знаков копеек",
    );
  const [whole, fraction = ""] = value.replace(",", ".").split(".");
  return (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"))).toString();
}
export function calculateTier(
  amount: string | bigint,
  tiers = DEFAULT_TIERS,
): TierCode {
  return (
    [...tiers]
      .reverse()
      .find((x) => BigInt(amount) >= BigInt(x.thresholdKopecks))?.code ??
    "MEMBER"
  );
}
export function calculateRentalBonus(
  amount: string | bigint,
  rateBps: number,
): string {
  if (
    !Number.isInteger(rateBps) ||
    rateBps < 0 ||
    rateBps > 10000 ||
    BigInt(amount) < 0n
  )
    throw new Error("Invalid bonus calculation");
  return ((BigInt(amount) * BigInt(rateBps)) / 1000000n).toString();
}
export function calculateTierProgress(
  amount: string | bigint,
  tier: TierCode,
  tiers = DEFAULT_TIERS,
) {
  const index = tiers.findIndex((t) => t.code === tier);
  if (index < 0 || index === tiers.length - 1)
    return { next_tier: null, remaining_amount: null, progress_percent: 100 };
  const current = BigInt(tiers[index].thresholdKopecks),
    next = BigInt(tiers[index + 1].thresholdKopecks),
    total = BigInt(amount);
  return {
    next_tier: tiers[index + 1].code,
    remaining_amount: (next > total ? next - total : 0n).toString(),
    progress_percent: Math.max(
      0,
      Math.min(
        100,
        Number(((total - current) * 10000n) / (next - current)) / 100,
      ),
    ),
  };
}
export function maxTier(...tiers: (TierCode | null)[]): TierCode {
  return TIER_CODES[
    Math.max(...tiers.map((x) => (x ? TIER_CODES.indexOf(x) : 0)))
  ];
}
export function resolveQualifiedAt(
  endDate: string,
  mode: "historical" | "operational",
  qualifiedAt?: string,
  confirmedAt = new Date(),
): string {
  if (qualifiedAt) return new Date(qualifiedAt).toISOString();
  const moscowToday = new Date(confirmedAt.getTime() + 3 * 3600000)
    .toISOString()
    .slice(0, 10);
  return mode === "operational" && endDate === moscowToday
    ? confirmedAt.toISOString()
    : `${endDate}T20:59:59.999Z`;
}
