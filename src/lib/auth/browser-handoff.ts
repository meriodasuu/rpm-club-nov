import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { z } from "zod";
import { transaction, type Db } from "@/lib/db";
import { body, HttpError, json, requireOrigin } from "@/lib/http";
import {
  cookieValue,
  hashToken,
  randomToken,
  rateLimit,
  requireStaff,
  sessionCookie,
  STAFF_COOKIE,
} from "./session";

// Only the recipient's random one-time code can decrypt the session token.
// The database stores its SHA-256 hash, never the code or the derived key.
function transferKey(code: string) {
  return Buffer.from(
    hkdfSync("sha256", code, "rpm-browser-handoff", "session-token-v1", 32),
  );
}
function seal(token: string, code: string, sessionId: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", transferKey(code), iv);
  cipher.setAAD(Buffer.from(sessionId));
  return Buffer.concat([
    iv,
    cipher.update(token, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
}
function unseal(value: string, code: string, sessionId: string) {
  const bytes = Buffer.from(value, "base64");
  const cipher = createDecipheriv(
    "aes-256-gcm",
    transferKey(code),
    bytes.subarray(0, 12),
  );
  cipher.setAAD(Buffer.from(sessionId));
  cipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([
    cipher.update(bytes.subarray(12, -16)),
    cipher.final(),
  ]).toString("utf8");
}
const expired = () =>
  new HttpError(
    401,
    "BROWSER_LINK_EXPIRED",
    "Ссылка истекла или уже использована. Получите новую ссылку в админ-панели Telegram.",
  );
async function lockSession(tx: Db, tokenHash: string) {
  const [session] = await tx.query<{
    id: string;
    token_hash: string;
    expires_at: Date;
    membership_id: string;
    role: string;
  }>(
    `SELECT s.id,s.token_hash,s.expires_at,s.membership_id,m.role FROM staff_sessions s
     JOIN admin_memberships m ON m.id=s.membership_id
     WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND m.active
     AND (m.telegram_user_id IS NULL OR EXISTS(SELECT 1 FROM users u WHERE u.id=m.telegram_user_id AND u.status='active'))
     FOR UPDATE OF s,m`,
    [tokenHash],
  );
  if (!session) throw expired();
  return session;
}
export async function createBrowserLink(request: Request) {
  requireOrigin(request);
  const staff = await requireStaff(request);
  await rateLimit("staff-browser:" + staff.id, 10);
  const token = cookieValue(request, STAFF_COOKIE)!;
  return transaction(async (tx) => {
    const session = await lockSession(tx, hashToken(token));
    const code = randomToken();
    const expiresAt = new Date(
      Math.min(Date.now() + 120000, new Date(session.expires_at).getTime()),
    );
    await tx.query(
      "DELETE FROM staff_browser_handoffs WHERE expires_at<now()",
      [],
    );
    await tx.query(
      "INSERT INTO staff_browser_handoffs(code_hash,session_id,token_encrypted,expires_at) VALUES($1,$2,$3,$4)",
      [hashToken(code), session.id, seal(token, code, session.id), expiresAt],
    );
    const origin = new URL(process.env.APP_URL ?? request.url).origin;
    return json({
      url: origin + "/admin/browser#" + code,
      expiresAt: expiresAt.toISOString(),
    });
  });
}
export async function redeemBrowserLink(request: Request) {
  requireOrigin(request);
  const { code } = await body(
    request,
    z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }),
  );
  return transaction(async (tx) => {
    const [candidate] = await tx.query<{ token_hash: string }>(
      "SELECT s.token_hash FROM staff_browser_handoffs h JOIN staff_sessions s ON s.id=h.session_id WHERE h.code_hash=$1 AND h.expires_at>clock_timestamp()",
      [hashToken(code)],
    );
    if (!candidate) throw expired();
    // Lock the source session before consuming the code: logout and concurrent
    // handoffs serialize here without creating or prolonging a staff session.
    const session = await lockSession(tx, candidate.token_hash);
    const [handoff] = await tx.query<{ token_encrypted: string }>(
      "DELETE FROM staff_browser_handoffs WHERE code_hash=$1 AND session_id=$2 AND expires_at>clock_timestamp() RETURNING token_encrypted",
      [hashToken(code), session.id],
    );
    if (!handoff) throw expired();
    const token = unseal(handoff.token_encrypted, code, session.id);
    if (hashToken(token) !== session.token_hash) throw expired();
    const maxAge = Math.floor(
      (new Date(session.expires_at).getTime() - Date.now()) / 1000,
    );
    if (maxAge < 1) throw expired();
    await tx.query(
      "INSERT INTO audit_logs(actor_id,actor_role,action,entity_type,entity_id,reason) VALUES($1,$2,'staff.browser_open','staff_session',$3,'Текущая сессия открыта в браузере')",
      [session.membership_id, session.role, session.id],
    );
    return json({ redirect: "/admin/dashboard" }, 200, {
      "Set-Cookie": sessionCookie(STAFF_COOKIE, token, maxAge),
    });
  });
}
