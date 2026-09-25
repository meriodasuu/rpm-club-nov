import { z } from "zod";
import { query, transaction, type Db } from "@/lib/db";
import { body, HttpError, json, requireOrigin } from "@/lib/http";
import {
  hashToken,
  randomToken,
  rateLimit,
  sessionCookie,
  STAFF_COOKIE,
} from "./session";
import { verifyPassword } from "./password";

export const staffEmail = z.string().trim().toLowerCase().email().max(254);
export const newPassword = z
  .string()
  .min(15, "Пароль — минимум 15 символов")
  .max(128);
const invalid = () =>
  new HttpError(401, "LOGIN_INVALID", "Неверная почта или пароль");

export async function createPasswordSession(
  tx: Db,
  id: string,
  role: string,
  action: string,
) {
  const token = randomToken();
  await tx.query(
    "INSERT INTO staff_sessions(membership_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')",
    [id, hashToken(token)],
  );
  await tx.query(
    "INSERT INTO audit_logs(actor_id,actor_role,action,entity_type,entity_id,reason) VALUES($1,$2,$3,'staff',$1,'Вход по почте и паролю')",
    [id, role, action],
  );
  return json({ authenticated: true }, 200, {
    "Set-Cookie": sessionCookie(STAFF_COOKIE, token, 3600),
  });
}

export async function staffPasswordLogin(request: Request) {
  requireOrigin(request);
  const { email, password } = await body(
    request,
    z
      .object({ email: staffEmail, password: z.string().min(1).max(128) })
      .strict(),
  );
  await rateLimit("staff-password:global", 60);
  await rateLimit("staff-password:" + hashToken(email), 5);
  const [candidate] = await query<{
    membership_id: string;
    password_hash: string;
  }>(
    `SELECT c.membership_id,c.password_hash FROM staff_password_credentials c JOIN admin_memberships m ON m.id=c.membership_id
     WHERE c.email=$1 AND m.active AND (m.telegram_user_id IS NULL OR EXISTS(SELECT 1 FROM users u WHERE u.id=m.telegram_user_id AND u.status='active'))`,
    [email],
  );
  if (!(await verifyPassword(password, candidate?.password_hash)) || !candidate)
    throw invalid();
  return transaction(async (tx) => {
    const [member] = await tx.query<{ id: string; role: string }>(
      `SELECT m.id,m.role FROM admin_memberships m WHERE m.id=$1 AND m.active AND
       (m.telegram_user_id IS NULL OR EXISTS(SELECT 1 FROM users u WHERE u.id=m.telegram_user_id AND u.status='active')) FOR UPDATE OF m`,
      [candidate.membership_id],
    );
    if (!member) throw invalid();
    // Recheck after hashing: a concurrent reset must invalidate the old password.
    const [credential] = await tx.query(
      "SELECT 1 FROM staff_password_credentials WHERE membership_id=$1 AND email=$2 AND password_hash=$3 FOR UPDATE",
      [member.id, email, candidate.password_hash],
    );
    if (!credential) throw invalid();
    return createPasswordSession(
      tx,
      member.id,
      member.role,
      "staff.password_login",
    );
  });
}
