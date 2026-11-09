import { TIER_CODES } from "@/lib/loyalty/rules";

export type OddsPrize = {
  id: string;
  weight: number;
  minimum_tier: string | null;
  issue_cap: number | null;
  issued_count: number;
  active: boolean;
  archived_at: string | null;
  starts_at: string | null;
  ends_at: string | null;
};

export function effectiveOdds(prizes: OddsPrize[], tier: string, now = new Date()) {
  const rank = TIER_CODES.indexOf(tier as (typeof TIER_CODES)[number]);
  const eligible = prizes.filter((p) =>
    p.active && !p.archived_at && p.weight > 0 &&
    (!p.issue_cap || p.issued_count < p.issue_cap) &&
    (!p.starts_at || new Date(p.starts_at) <= now) &&
    (!p.ends_at || new Date(p.ends_at) > now) &&
    (!p.minimum_tier || TIER_CODES.indexOf(p.minimum_tier as (typeof TIER_CODES)[number]) <= rank),
  );
  const total = eligible.reduce((sum, p) => sum + p.weight, 0);
  return eligible.map((p) => ({ id: p.id, percent: Math.round(p.weight / total * 10000) / 100 }));
}

export function validateShares(shares: { id: string; basisPoints: number }[], ids: string[]): boolean {
  return shares.length === ids.length && new Set(shares.map((s) => s.id)).size === ids.length &&
    shares.every((s) => ids.includes(s.id) && Number.isInteger(s.basisPoints) && s.basisPoints > 0 && s.basisPoints <= 10000) &&
    shares.reduce((sum, s) => sum + s.basisPoints, 0) === 10000;
}

export function parseOddsPercent(value: string): number | null {
  const normalized = value.trim().replace(",", ".");
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const basisPoints = Math.round(Number(normalized) * 100);
  return basisPoints >= 1 && basisPoints <= 10000 ? basisPoints : null;
}
