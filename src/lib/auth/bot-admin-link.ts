import { z } from "zod";
import { query, transaction, type Db } from "@/lib/db";
import { body, HttpError, json, requireOrigin } from "@/lib/http";
import { hashToken, randomToken, rateLimit } from "./session";
import { hashPassword } from "./password";
import {
  createPasswordSession,
  newPassword,
  staffEmail,
} from "./password-login";

const expired = () =>
  new HttpError(
    401,
    "ADMIN_LINK_EXPIRED",
    "Ссылка истекла или уже использована. Запросите новую у бота командой /admin.",
  );

async function sendBotMessage(telegramId: string, text: string, url?: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token)
    throw new HttpError(
      503,
      "TELEGRAM_NOT_CONFIGURED",
      "Бот временно недоступен.",
    );
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(8000),
        body: JSON.stringify({
          chat_id: telegramId,
          text,
          protect_content: true,
          link_preview_options: { is_disabled: true },
          ...(url
            ? {
                reply_markup: {
                  inline_keyboard: [
                    [{ text: "Настроить почту и пароль", url }],
                  ],
                },
              }
            : {}),
        }),
      },
    );
    const result = await response.json();
    if (!response.ok || result.ok !== true) throw new Error("send failed");
  } catch {
    throw new HttpError(
      503,
      "ADMIN_LINK_DELIVERY",
      "Не удалось отправить ссылку. Откройте чат с ботом, нажмите «Старт» и повторите запрос.",
    );
  }
}

async function issueAndSend(tx: Db, telegramId: string) {
  const [member] = await tx.query<{ id: string }>(
    `SELECT m.id
     FROM admin_memberships m JOIN users u ON u.id=m.telegram_user_id
     WHERE u.telegram_id=$1 AND u.status='active' AND m.active AND m.role='admin' FOR UPDATE OF m,u`,
    [telegramId],
  );
  if (!member)
    throw new HttpError(403, "STAFF_FORBIDDEN", "Данная команда недоступна.");
  const code = randomToken();
  const appUrl = process.env.APP_URL;
  if (!appUrl)
    throw new HttpError(503, "APP_URL_REQUIRED", "Вход временно недоступен.");
  const url = new URL("/admin/access", appUrl).href + "#" + code;
  // Keep only the latest request. The raw reset credential is never persisted.
  await tx.query(
    "DELETE FROM staff_bot_login_links WHERE membership_id=$1 OR expires_at<now()",
    [member.id],
  );
  await tx.query(
    "INSERT INTO staff_bot_login_links(code_hash,membership_id,expires_at) VALUES($1,$2,now()+interval '10 minutes')",
    [hashToken(code), member.id],
  );
  await sendBotMessage(
    telegramId,
    "Почта и пароль RPM Club\n\nДля обычного входа откройте " +
      new URL("/admin/login", appUrl).href +
      ".\n\nКнопка ниже позволяет задать или заменить вашу почту и пароль. Ссылка действует 10 минут и используется один раз. После сохранения пароля прежние сеансы завершатся. Не пересылайте ссылку.",
    url,
  );
  await tx.query(
    "INSERT INTO audit_logs(actor_id,actor_role,action,entity_type,entity_id,reason) VALUES($1,'admin','staff.bot_link_requested','staff',$1,'Ссылка для входа отправлена в личный чат')",
    [member.id],
  );
  return { sent: true };
}

export async function adminBotCommand(updateId: number, telegramId: string) {
  // Telegram may retry delivery. Serialize before calling the external provider.
  if (
    (
      await query("SELECT update_id FROM telegram_updates WHERE update_id=$1", [
        String(updateId),
      ])
    ).length
  )
    return json({ ok: true });
  await rateLimit("staff-bot-link:" + telegramId, 3);
  await transaction(async (tx) => {
    const rows = await tx.query(
      "INSERT INTO telegram_updates(update_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING update_id",
      [String(updateId)],
    );
    if (!rows.length) return;
    try {
      await issueAndSend(tx, telegramId);
    } catch (error) {
      if (error instanceof HttpError && error.code === "STAFF_FORBIDDEN")
        await sendBotMessage(telegramId, error.message);
      else throw error;
    }
  });
  return json({ ok: true });
}

export async function redeemBotAdminLink(request: Request) {
  requireOrigin(request);
  const { code, credentials } = await body(
    request,
    z
      .object({
        code: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        credentials: z
          .object({ email: staffEmail, password: newPassword })
          .strict()
          .optional(),
      })
      .strict(),
  );
  const codeHash = hashToken(code);
  const [candidate] = await query<{ membership_id: string }>(
    "SELECT membership_id FROM staff_bot_login_links WHERE code_hash=$1 AND expires_at>clock_timestamp()",
    [codeHash],
  );
  if (!candidate) throw expired();
  await rateLimit("staff-bot-verify:" + candidate.membership_id, 10);
  const passwordHash = credentials
    ? await hashPassword(credentials.password)
    : undefined;
  try {
    return await transaction(async (tx) => {
      // Same lock order as staff assignment: membership, then link/factor/session.
      const [member] = await tx.query<{ id: string; telegram_id: string }>(
        `SELECT m.id,u.telegram_id FROM admin_memberships m JOIN users u ON u.id=m.telegram_user_id
       WHERE m.id=$1 AND m.active AND m.role='admin' AND u.status='active' FOR UPDATE OF m,u`,
        [candidate.membership_id],
      );
      if (!member) throw expired();
      const [link] = await tx.query<{ expires_at: Date }>(
        "SELECT expires_at FROM staff_bot_login_links WHERE code_hash=$1 AND expires_at>clock_timestamp() FOR UPDATE",
        [codeHash],
      );
      if (!link) throw expired();
      if (!credentials || !passwordHash)
        return json({ password_setup_required: true });
      await tx.query(
        `INSERT INTO staff_password_credentials(membership_id,email,password_hash) VALUES($1,$2,$3)
       ON CONFLICT(membership_id) DO UPDATE SET email=excluded.email,password_hash=excluded.password_hash,updated_at=now()`,
        [member.id, credentials.email, passwordHash],
      );
      await tx.query("UPDATE admin_memberships SET email=$2 WHERE id=$1", [
        member.id,
        credentials.email,
      ]);
      await tx.query("DELETE FROM staff_bot_login_links WHERE code_hash=$1", [
        codeHash,
      ]);
      await tx.query(
        "UPDATE staff_sessions SET revoked_at=now() WHERE membership_id=$1 AND revoked_at IS NULL",
        [member.id],
      );
      return createPasswordSession(
        tx,
        member.id,
        "admin",
        "staff.password_reset",
      );
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "23505")
      throw new HttpError(
        409,
        "EMAIL_UNAVAILABLE",
        "Эта почта уже используется. Укажите другую.",
      );
    throw error;
  }
}
