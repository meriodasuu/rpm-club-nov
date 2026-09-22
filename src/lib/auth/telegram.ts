import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const telegramUser = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  first_name: z.string().max(200),
  last_name: z.string().max(200).optional(),
  username: z.string().max(64).optional(),
  allows_write_to_pm: z.boolean().optional(),
});
export type TelegramUser = z.infer<typeof telegramUser>;
export function validateTelegramInitData(
  raw: string,
  botToken: string,
  now = Math.floor(Date.now() / 1000),
): TelegramUser {
  if (!raw || raw.length > 16384 || !botToken)
    throw new Error("Telegram authorization unavailable");
  const params = new URLSearchParams(raw);
  if ([...params.keys()].some((key) => params.getAll(key).length !== 1))
    throw new Error("Duplicate Telegram fields");
  const hash = params.get("hash") ?? "";
  if (!/^[a-f0-9]{64}$/i.test(hash))
    throw new Error("Invalid Telegram signature");
  const authDate = Number(params.get("auth_date"));
  if (
    !Number.isInteger(authDate) ||
    now - authDate > 300 ||
    authDate - now > 30
  )
    throw new Error("Expired Telegram authorization");
  const data = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(data).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, "hex")))
    throw new Error("Invalid Telegram signature");
  return telegramUser.parse(JSON.parse(params.get("user") ?? "null"));
}
export function normalizePhone(raw: string): string {
  let phone = raw.trim().replace(/[\s()\-]/g, "");
  if (/^8\d{10}$/.test(phone)) phone = "+7" + phone.slice(1);
  if (!/^\+[1-9]\d{7,14}$/.test(phone))
    throw new Error(
      "Укажите телефон в международном формате, например +79991234567",
    );
  return phone;
}
