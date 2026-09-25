import { z } from "zod";
import { randomUUID } from "node:crypto";
import { query, transaction } from "@/lib/db";
import { bindReferralInTransaction } from "@/lib/loyalty";
import { body, HttpError, json, requireOrigin } from "@/lib/http";
import {
  CLIENT_COOKIE,
  STAFF_COOKIE,
  cookieValue,
  hashToken,
  randomToken,
  rateLimit,
  requireLocalPreview,
  requireSession,
  secretMatches,
  sessionCookie,
} from "./session";
import { normalizePhone, validateTelegramInitData } from "./telegram";
import { adminBotCommand, redeemBotAdminLink } from "./bot-admin-link";
import { staffPasswordLogin } from "./password-login";

export async function authRoute(
  request: Request,
  path: string,
): Promise<Response | null> {
  if (
    request.method === "POST" &&
    [
      "auth/staff/bot-link",
      "auth/staff/telegram",
      "auth/staff/browser-link",
      "auth/staff/browser-redeem",
    ].includes(path)
  )
    throw new HttpError(
      410,
      "STAFF_BOT_ONLY",
      "Вход из Mini App отключён. Отправьте /admin боту RPM Club и откройте ссылку в браузере.",
    );
  if (request.method === "POST" && path === "auth/staff/bot-redeem")
    return redeemBotAdminLink(request);
  if (request.method === "POST" && path === "auth/telegram") {
    requireOrigin(request);
    const { initData } = await body(
      request,
      z.object({ initData: z.string().max(16384) }),
    );
    let profile;
    try {
      profile = validateTelegramInitData(
        initData,
        process.env.TELEGRAM_BOT_TOKEN ?? "",
      );
    } catch {
      throw new HttpError(
        401,
        "TELEGRAM_INVALID",
        "Не удалось подтвердить вход. Откройте приложение из Telegram заново.",
      );
    }
    await rateLimit("telegram:" + profile.id, 10);
    const [user] = await query<{ id: string; status: string }>(
      "SELECT id,status FROM users WHERE telegram_id=$1",
      [String(profile.id)],
    );
    if (user?.status === "blocked")
      throw new HttpError(
        403,
        "MEMBER_BLOCKED",
        "Доступ к клубу приостановлен. Свяжитесь с RPM.",
      );
    if (user)
      await query(
        "UPDATE users SET telegram_username=$2,updated_at=now() WHERE id=$1",
        [user.id, profile.username ?? null],
      );
    const token = randomToken();
    await query(
      "INSERT INTO miniapp_sessions(token_hash,user_id,telegram_id,telegram_profile,expires_at) VALUES($1,$2,$3,$4,now()+interval '24 hours')",
      [
        hashToken(token),
        user?.id ?? null,
        String(profile.id),
        JSON.stringify(profile),
      ],
    );
    return json({ onboarding_required: user?.status !== "active" }, 200, {
      "Set-Cookie": sessionCookie(CLIENT_COOKIE, token),
    });
  }
  if (request.method === "POST" && path === "me/contact-request") {
    requireOrigin(request);
    const session = await requireSession(request, false);
    await rateLimit("contact:" + session.telegram_id, 5);
    await query(
      "INSERT INTO contact_requests(session_id,telegram_id,expires_at) VALUES($1,$2,now()+interval '5 minutes')",
      [session.id, session.telegram_id],
    );
    return json({ requested: true });
  }
  if (request.method === "GET" && path === "me/onboarding") {
    const session = await requireSession(request, false);
    const [contact] = await query<{ phone: string }>(
      "SELECT phone FROM contact_requests WHERE session_id=$1 AND consumed_at IS NOT NULL AND expires_at>now() ORDER BY consumed_at DESC LIMIT 1",
      [session.id],
    );
    const documents = await query(
      "SELECT id,type,version,title FROM legal_documents WHERE published_at<=now() ORDER BY type,published_at DESC",
    );
    const unique = documents.filter(
      (d, index) =>
        documents.findIndex((other) => other.type === d.type) === index,
    );
    return json({
      active: session.user_status === "active",
      contact_verified: !!contact?.phone,
      phone: contact?.phone ?? null,
      documents: unique,
    });
  }
  if (request.method === "POST" && path === "me/activate") {
    requireOrigin(request);
    const session = await requireSession(request, false);
    const input = await body(
      request,
      z.object({
        documentIds: z.array(z.string().uuid()).length(3),
        referralCode: z.string().max(30).optional(),
        marketingConsent: z.boolean().default(false),
      }),
    );
    // Activation is serialized per Telegram identity; a second submission observes the first result.
    const result = await transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        "activate:" + session.telegram_id,
      ]);
      const [current] = await tx.query<{
        id: string;
        status: string;
        phone: string | null;
      }>("SELECT id,status,phone FROM users WHERE telegram_id=$1 FOR UPDATE", [
        session.telegram_id,
      ]);
      if (current?.status === "blocked")
        throw new HttpError(
          403,
          "MEMBER_BLOCKED",
          "Доступ к клубу приостановлен",
        );
      if (current?.status === "active") {
        await tx.query("UPDATE miniapp_sessions SET user_id=$2 WHERE id=$1", [
          session.id,
          current.id,
        ]);
        return { id: current.id, existing: true };
      }
      const contacts = await tx.query<{ phone: string }>(
        "SELECT phone FROM contact_requests WHERE session_id=$1 AND consumed_at IS NOT NULL AND expires_at>now() ORDER BY consumed_at DESC LIMIT 1",
        [session.id],
      );
      const phone = contacts[0]?.phone;
      if (!phone)
        throw new HttpError(
          422,
          "CONTACT_REQUIRED",
          "Подтвердите номер телефона",
        );
      const docs = await tx.query<{ id: string; type: string }>(
        `SELECT DISTINCT ON(type) id,type FROM legal_documents WHERE published_at<=now() ORDER BY type,published_at DESC`,
      );
      if (
        docs.length !== 3 ||
        docs.some((d) => !input.documentIds.includes(d.id))
      )
        throw new HttpError(
          409,
          "RULES_CHANGED",
          "Документы обновились. Прочитайте актуальную редакцию.",
        );
      const [match] = await tx.query<{
        id: string;
        telegram_id: string | null;
        status: string;
      }>("SELECT id,telegram_id,status FROM users WHERE phone=$1 FOR UPDATE", [
        phone,
      ]);
      if (
        match?.status === "blocked" ||
        (match?.telegram_id && match.telegram_id !== session.telegram_id) ||
        (current && match && current.id !== match.id) ||
        (current?.phone && current.phone !== phone)
      )
        throw new HttpError(
          409,
          "IDENTITY_CONFLICT",
          "Не удалось связать профиль. Обратитесь в RPM.",
        );
      const name = [
        session.telegram_profile.first_name,
        session.telegram_profile.last_name,
      ]
        .filter(Boolean)
        .join(" ");
      const userId = match?.id ?? current?.id ?? randomUUID();
      if (!match && !current)
        await tx.query(
          "INSERT INTO users(id,name,phone,telegram_id,telegram_username,status,marketing_consent,telegram_reachable) VALUES($1,$2,$3,$4,$5,'pending',$6,$7)",
          [
            userId,
            name,
            phone,
            session.telegram_id,
            session.telegram_profile.username ?? null,
            input.marketingConsent,
            // A verified contact arrived in this bot's private chat. This is
            // stronger evidence than the optional initData permission flag.
            true,
          ],
        );
      else
        await tx.query(
          "UPDATE users SET telegram_id=$2,telegram_username=$3,marketing_consent=$4,phone=COALESCE(phone,$5),telegram_reachable=true,updated_at=now() WHERE id=$1",
          [
            userId,
            session.telegram_id,
            session.telegram_profile.username ?? null,
            input.marketingConsent,
            phone,
          ],
        );
      await tx.query(
        "INSERT INTO loyalty_accounts(user_id) VALUES($1) ON CONFLICT DO NOTHING",
        [userId],
      );
      await tx.query("UPDATE miniapp_sessions SET user_id=$2 WHERE id=$1", [
        session.id,
        userId,
      ]);
      for (const doc of docs)
        await tx.query(
          "INSERT INTO consent_acceptances(user_id,document_id,source) VALUES($1,$2,'telegram') ON CONFLICT DO NOTHING",
          [userId, doc.id],
        );
      await tx.query(
        "INSERT INTO marketing_consents(user_id,granted,source) VALUES($1,$2,'onboarding')",
        [userId, input.marketingConsent],
      );
      if (input.referralCode)
        await bindReferralInTransaction(
          tx,
          { userId, code: input.referralCode },
          { id: userId, role: "system" },
        );
      await tx.query(
        "UPDATE users SET status='active',updated_at=now() WHERE id=$1 AND status='pending'",
        [userId],
      );
      await tx.query(
        "UPDATE loyalty_accounts SET member_since=COALESCE(member_since,now()) WHERE user_id=$1",
        [userId],
      );
      return { id: userId, existing: false };
    });
    return json({ activated: true, userId: result.id });
  }
  if (request.method === "POST" && path === "telegram/webhook") {
    if (
      !secretMatches(
        request.headers.get("x-telegram-bot-api-secret-token"),
        process.env.TELEGRAM_WEBHOOK_SECRET,
      )
    )
      throw new HttpError(401, "WEBHOOK_UNAUTHORIZED", "Unauthorized");
    const update = await body(
      request,
      z.object({
        update_id: z.number().int(),
        message: z
          .object({
            from: z.object({ id: z.number().int() }),
            chat: z.object({ id: z.number().int(), type: z.string() }),
            contact: z
              .object({
                user_id: z.number().int().optional(),
                phone_number: z.string(),
              })
              .optional(),
            text: z.string().optional(),
          })
          .optional(),
      }),
    );
    const commandMessage = update.message;
    if (
      commandMessage?.chat.type === "private" &&
      commandMessage.chat.id === commandMessage.from.id &&
      /^\/admin(?:@rpmclub_bot)?\s*$/i.test(commandMessage.text ?? "")
    )
      return adminBotCommand(update.update_id, String(commandMessage.from.id));
    await transaction(async (tx) => {
      const inserted = await tx.query(
        "INSERT INTO telegram_updates(update_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING update_id",
        [String(update.update_id)],
      );
      if (!inserted.length) return;
      const m = update.message;
      if (!m || m.chat.type !== "private") return;
      if (m.contact?.user_id === m.from.id) {
        let phone: string;
        try {
          phone = normalizePhone(
            m.contact.phone_number.startsWith("+")
              ? m.contact.phone_number
              : "+" + m.contact.phone_number,
          );
        } catch {
          return;
        }
        await tx.query(
          "UPDATE contact_requests SET phone=$2,consumed_at=now() WHERE telegram_id=$1 AND expires_at>now() AND consumed_at IS NULL",
          [String(m.from.id), phone],
        );
      }
      await tx.query(
        "UPDATE users SET telegram_reachable=true WHERE telegram_id=$1",
        [String(m.from.id)],
      );
      if (m.text?.startsWith("/start"))
        await tx.query(
          `INSERT INTO outbox_events(event_key,event_type,aggregate_id,payload) VALUES($1,'BOT_WELCOME',$2,$3) ON CONFLICT DO NOTHING`,
          [
            "welcome:" + update.update_id,
            String(m.from.id),
            JSON.stringify({ telegram_id: String(m.from.id) }),
          ],
        );
    });
    return json({ ok: true });
  }
  if (request.method === "POST" && path === "auth/staff/login")
    return staffPasswordLogin(request);
  if (request.method === "POST" && path === "auth/local") {
    requireOrigin(request);
    requireLocalPreview(request);
    const { mode } = await body(
      request,
      z.object({
        mode: z.enum(["client", "admin", "manager", "viewer", "new"]),
      }),
    );
    const token = randomToken();
    if (mode === "client" || mode === "new") {
      const [user] = await query<{
        id: string;
        telegram_id: string;
        name: string;
      }>(`SELECT id,telegram_id,name FROM users WHERE public_member_id=$1`, [
        mode === "client" ? "rpm_82KPX9" : "rpm_NEW2026",
      ]);
      if (!user)
        throw new HttpError(
          409,
          "SEED_REQUIRED",
          "Сначала загрузите локальные тестовые данные",
        );
      await query(
        "INSERT INTO miniapp_sessions(token_hash,user_id,telegram_id,telegram_profile,expires_at) VALUES($1,$2,$3,$4,now()+interval '24 hours')",
        [
          hashToken(token),
          user.id,
          user.telegram_id ?? "900000001",
          JSON.stringify({
            id: Number(user.telegram_id ?? 900000001),
            first_name: user.name,
          }),
        ],
      );
      return json({ redirect: "/home" }, 200, {
        "Set-Cookie": sessionCookie(CLIENT_COOKIE, token),
      });
    }
    const email = `${mode}@local.rpm.invalid`;
    const [staff] = await query<{ id: string }>(
      `INSERT INTO admin_memberships(auth_user_id,email,name,role,active) VALUES($1,$2,$3,$4,true) ON CONFLICT(auth_user_id) DO UPDATE SET active=true RETURNING id`,
      [
        mode === "admin"
          ? "10000000-0000-4000-8000-000000000001"
          : mode === "manager"
            ? "10000000-0000-4000-8000-000000000002"
            : "10000000-0000-4000-8000-000000000003",
        email,
        "Локальный " + mode,
        mode,
      ],
    );
    await query(
      "INSERT INTO staff_sessions(token_hash,membership_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
      [hashToken(token), staff.id],
    );
    return json({ redirect: "/admin/dashboard" }, 200, {
      "Set-Cookie": sessionCookie(STAFF_COOKIE, token, 3600),
    });
  }
  if (
    request.method === "POST" &&
    ["auth/logout", "auth/staff/logout"].includes(path)
  ) {
    requireOrigin(request);
    const isStaff = path.includes("staff");
    const name = isStaff ? STAFF_COOKIE : CLIENT_COOKIE;
    const token = cookieValue(request, name);
    if (token)
      await query(
        `UPDATE ${isStaff ? "staff_sessions" : "miniapp_sessions"} SET revoked_at=now() WHERE token_hash=$1`,
        [hashToken(token)],
      );
    return json({ ok: true }, 200, {
      "Set-Cookie": sessionCookie(name, "", 0),
    });
  }
  return null;
}
