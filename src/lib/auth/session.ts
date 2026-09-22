import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { query } from "@/lib/db";
import { HttpError } from "@/lib/http";
import type { TelegramUser } from "./telegram";

export const CLIENT_COOKIE = "rpm_session";
export const STAFF_COOKIE = "rpm_staff";
export const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export const randomToken = () => randomBytes(32).toString("base64url");
export function secretMatches(
  actual: string | null,
  expected: string | undefined,
) {
  if (!actual || !expected || expected.length < 16) return false;
  return timingSafeEqual(
    createHash("sha256").update(actual).digest(),
    createHash("sha256").update(expected).digest(),
  );
}
export function cookieValue(request: Request, name: string): string | null {
  const value = request.headers
    .get("cookie")
    ?.split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith(name + "="))
    ?.slice(name.length + 1);
  return value && /^[A-Za-z0-9_-]{40,128}$/.test(value) ? value : null;
}
export function sessionCookie(name: string, token: string, maxAge = 86400) {
  return `${name}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${process.env.NODE_ENV === "production" || process.env.APP_URL?.startsWith("https:") ? "; Secure" : ""}`;
}
export type ClientSession = {
  id: string;
  user_id: string | null;
  telegram_id: string;
  telegram_profile: TelegramUser;
  user_status: string | null;
};
export async function requireSession(
  request: Request,
  active = true,
): Promise<ClientSession> {
  const token = cookieValue(request, CLIENT_COOKIE);
  if (!token)
    throw new HttpError(401, "AUTH_REQUIRED", "Откройте RPM Club из Telegram");
  const [session] = await query<ClientSession>(
    `SELECT s.*,u.status user_status FROM miniapp_sessions s LEFT JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND s.revoked_at IS NULL`,
    [hashToken(token)],
  );
  if (!session)
    throw new HttpError(
      401,
      "SESSION_EXPIRED",
      "Сессия истекла. Откройте RPM Club заново.",
    );
  if (session.user_status === "blocked")
    throw new HttpError(
      403,
      "MEMBER_BLOCKED",
      "Доступ к клубу приостановлен. Свяжитесь с RPM.",
    );
  if (active && (!session.user_id || session.user_status !== "active"))
    throw new HttpError(
      403,
      "ONBOARDING_REQUIRED",
      "Завершите вступление в RPM Club",
    );
  return session;
}
export type Staff = {
  can_manage_staff?: boolean;
  id: string;
  auth_user_id: string | null;
  telegram_user_id?: string | null;
  name: string;
  email: string | null;
  role: "viewer" | "manager" | "admin";
  active: boolean;
};
const roleRank = { viewer: 0, manager: 1, admin: 2 };
export async function requireStaff(
  request: Request,
  minimum: Staff["role"] = "viewer",
): Promise<Staff> {
  const token = cookieValue(request, STAFF_COOKIE);
  if (!token)
    throw new HttpError(
      401,
      "STAFF_AUTH_REQUIRED",
      "Войдите в панель управления",
    );
  const [staff] = await query<Staff>(
    `SELECT m.* FROM staff_sessions s JOIN admin_memberships m ON m.id=s.membership_id WHERE s.token_hash=$1 AND s.expires_at>now() AND s.revoked_at IS NULL AND m.active=true AND (m.telegram_user_id IS NULL OR EXISTS(SELECT 1 FROM users u WHERE u.id=m.telegram_user_id AND u.status='active'))`,
    [hashToken(token)],
  );
  if (!staff)
    throw new HttpError(
      401,
      "STAFF_SESSION_EXPIRED",
      "Сессия сотрудника истекла",
    );
  if (roleRank[staff.role] < roleRank[minimum])
    throw new HttpError(
      403,
      "FORBIDDEN",
      "Недостаточно прав для этого действия",
    );
  return staff;
}
export async function rateLimit(key: string, limit: number) {
  const [row] = await query<{ count: number }>(
    `INSERT INTO rate_limits(key,count,window_start) VALUES($1,1,now()) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN rate_limits.window_start<now()-interval '1 minute' THEN 1 ELSE rate_limits.count+1 END,window_start=CASE WHEN rate_limits.window_start<now()-interval '1 minute' THEN now() ELSE rate_limits.window_start END RETURNING count`,
    [key],
  );
  if (row.count > limit)
    throw new HttpError(
      429,
      "RATE_LIMITED",
      "Слишком много запросов. Попробуйте через минуту.",
    );
}
export function localPreviewEnabled() {
  return (
    process.env.NODE_ENV !== "production" && process.env.LOCAL_PREVIEW === "1"
  );
}
export function requireLocalPreview(request: Request) {
  const host = new URL(request.url).hostname;
  if (
    !localPreviewEnabled() ||
    !["localhost", "127.0.0.1", "[::1]"].includes(host)
  )
    throw new HttpError(404, "NOT_FOUND", "Страница не найдена");
}
