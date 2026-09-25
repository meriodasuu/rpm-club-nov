import { z } from "zod";

export const contentKinds = ["car", "route", "wiki"] as const;
export type ContentKind = (typeof contentKinds)[number];
const https = z
  .string()
  .trim()
  .max(2000)
  .refine((value) => {
    if (!value) return true;
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  }, "Нужна ссылка https://");
export const contentSchema = z
  .object({
    kind: z.enum(contentKinds),
    title: z.string().trim().min(2).max(160),
    summary: z.string().trim().max(500).default(""),
    body: z.string().trim().max(12000).default(""),
    imageUrl: z
      .union([https, z.string().regex(/^\/api\/media\/[a-f0-9-]{36}\.webp$/)])
      .default(""),
    linkUrl: https.default(""),
    category: z
      .enum(["general", "faq", "emergency", "rules"])
      .default("general"),
    dailyPriceKopecks: z
      .string()
      .regex(/^\d{1,12}$/)
      .default("0"),
    distanceKm: z.number().int().min(0).max(50000).default(0),
    durationMinutes: z.number().int().min(0).max(50000).default(0),
    active: z.boolean().default(false),
    expectedVersion: z.number().int().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === "car" && BigInt(value.dailyPriceKopecks) <= 0n)
      ctx.addIssue({
        code: "custom",
        path: ["dailyPriceKopecks"],
        message: "Укажите стоимость суток",
      });
    if (value.active && value.kind !== "car" && !value.body)
      ctx.addIssue({
        code: "custom",
        path: ["body"],
        message: "Добавьте текст перед публикацией",
      });
  });

export interface ClubContent {
  id: string;
  kind: ContentKind;
  title: string;
  summary: string;
  body: string;
  image_url: string;
  link_url: string;
  category: string;
  daily_price_kopecks: string;
  distance_km: number;
  duration_minutes: number;
  active: boolean;
  version: number;
  published_at: string | null;
  source?: string | null;
  source_deleted?: boolean;
  source_synced_at?: string | null;
  image_urls?: { url: string; alt: string }[];
  available?: boolean;
  minimum_rental_days?: number;
  sort_order?: number;
}
export function moscowDate(at = new Date()) {
  return new Date(at.getTime() + 3 * 3600000).toISOString().slice(0, 10);
}
export function rentalDays(start: string, end: string) {
  const valid = (value: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value;
  if (!valid(start) || !valid(end)) throw new Error("Некорректные даты аренды");
  const days = Math.max(1, (Date.parse(end) - Date.parse(start)) / 86400000);
  if (end < start || days > 90)
    throw new Error("Период аренды — от 1 до 90 суток");
  return days;
}
export function rentalQuote(
  dailyPrice: string,
  days: number,
  discountBps: number,
) {
  if (
    !/^\d{1,12}$/.test(dailyPrice) ||
    BigInt(dailyPrice) <= 0n ||
    !Number.isInteger(days) ||
    days < 1 ||
    days > 90 ||
    !Number.isInteger(discountBps) ||
    discountBps < 0 ||
    discountBps >= 10000
  )
    throw new Error("Некорректная стоимость аренды");
  const gross = BigInt(dailyPrice) * BigInt(days);
  const discount = (gross * BigInt(discountBps)) / 10000n;
  return {
    dailyPriceKopecks: dailyPrice,
    days,
    grossKopecks: gross.toString(),
    discountKopecks: discount.toString(),
    totalKopecks: (gross - discount).toString(),
    discountBps,
  };
}
export interface RentalRequest {
  id: string;
  user_id: string;
  car_id: string;
  car_name: string;
  start_date: string;
  end_date: string;
  days: number;
  gross_kopecks: string;
  discount_kopecks: string;
  total_kopecks: string;
  discount_bps: number;
  status: "pending" | "accepted" | "declined" | "cancelled";
  comment: string;
  staff_note: string;
  rental_id: string | null;
  pickup_at?: string | null;
  created_at: string;
  name?: string;
  phone?: string;
}

export const triggerKinds = [
  "before_rental",
  "after_rental",
  "offer_reminder",
  "weather",
  "new_route",
] as const;
export type TriggerKind = (typeof triggerKinds)[number];
export const triggerLabels: Record<TriggerKind, string> = {
  before_rental: "До аренды",
  after_rental: "После аренды",
  offer_reminder: "Новые предложения",
  weather: "Погода перед поездкой",
  new_route: "Новые маршруты",
};
export const triggerSchema = z
  .object({
    kind: z.enum(triggerKinds),
    enabled: z.boolean(),
    message: z.string().trim().min(3).max(1800),
    leadHours: z.number().int().min(0).max(168),
    city: z.string().trim().max(120).default(""),
    latitude: z.number().min(-90).max(90).nullable().default(null),
    longitude: z.number().min(-180).max(180).nullable().default(null),
  })
  .superRefine((value, ctx) => {
    const timed = value.kind === "before_rental" || value.kind === "weather";
    if (timed ? value.leadHours < 1 : value.leadHours !== 0)
      ctx.addIssue({
        code: "custom",
        path: ["leadHours"],
        message: timed
          ? "Укажите от 1 до 168 часов"
          : "Сообщение отправляется сразу после события",
      });
    if (
      value.kind === "weather" &&
      value.enabled &&
      (!value.city || value.latitude === null || value.longitude === null)
    )
      ctx.addIssue({
        code: "custom",
        message: "Для погоды укажите город и координаты",
      });
  });
export interface TriggerRule {
  kind: TriggerKind;
  enabled: boolean;
  message: string;
  lead_hours: number;
  city: string;
  latitude: number | null;
  longitude: number | null;
  enabled_at: string;
}
