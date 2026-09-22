import { z } from "zod";

const benefit = z.object({
  title: z.string().trim().min(1).max(120),
  terms: z.string().trim().min(1).max(2000),
});
export const referralProgramSchema = z.object({
  enabled: z.boolean(),
  referrer: benefit,
  referred: benefit,
  expectedVersion: z.number().int().min(0),
  reason: z.string().trim().min(3).max(1000),
});
export const issueAwardSchema = z.object({
  comment: z.string().trim().min(3).max(1000),
  confirmed: z.literal(true),
});
export interface ReferralProgram {
  id: string;
  version: number;
  enabled: boolean;
  referrer: { title: string; terms: string };
  referred: { title: string; terms: string };
  activated_at: string | null;
  created_at: string;
}
export interface ReferralAward {
  id: string;
  referral_id: string;
  beneficiary_user_id: string;
  side: "referrer" | "referred";
  title: string;
  terms: string;
  status: "pending" | "issued" | "cancelled" | "review";
  rental_id: string;
  program_version_id: string;
  created_at: string;
  issued_at: string | null;
  issued_by: string | null;
  issue_comment: string | null;
}
export const awardStatusLabels: Record<ReferralAward["status"], string> = {
  pending: "Ожидает выдачи",
  issued: "Выдана",
  cancelled: "Отменена",
  review: "Выдана · требуется проверка отменённой аренды",
};
