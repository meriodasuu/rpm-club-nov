import { z } from "zod";
import { getReferralProgram } from "@/lib/referrals";
import QRCode from "qrcode";
import { query, transaction } from "@/lib/db";
import {
  getAccountSnapshot,
  getHistory,
  getProgram,
  TIER_CODES,
} from "@/lib/loyalty";
import { requireSession, rateLimit } from "@/lib/auth/session";
import { body, json, notFound, requireOrigin } from "@/lib/http";

export async function clientRoute(
  request: Request,
  path: string,
): Promise<Response | null> {
  if (
    ![
      "me",
      "me/qr",
      "loyalty/tiers",
      "offers",
      "me/rentals",
      "me/transactions",
      "me/referral",
      "me/preferences",
      "analytics",
    ].includes(path) &&
    !/^offers\/[a-f0-9-]{36}$/.test(path)
  )
    return null;
  const session = await requireSession(request);
  const userId = session.user_id!;
  await rateLimit("client:" + userId, 120);
  if (request.method === "GET" && path === "me/qr") {
    const [u] = await query<{ public_member_id: string }>(
      "SELECT public_member_id FROM users WHERE id=$1",
      [userId],
    );
    const svg = await QRCode.toString(
      (process.env.APP_URL ?? new URL(request.url).origin) +
        "/m/" +
        u.public_member_id,
      { type: "svg", margin: 2, width: 240 },
    );
    return new Response(svg, {
      headers: {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "private, no-store",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  }
  if (request.method === "GET" && path === "me") {
    const snapshot = await getAccountSnapshot(userId);
    const [staff] = await query(
      "SELECT id FROM admin_memberships WHERE telegram_user_id=$1 AND active=true AND role='admin'",
      [userId],
    );
    return json({
      ...snapshot,
      staff_access: !!staff,
      links: {
        catalog: process.env.CATALOG_URL ?? "https://rpmrent.ru/cars",
        support: process.env.SUPPORT_URL ?? "https://rpmrent.ru",
      },
    });
  }
  if (request.method === "GET" && path === "loyalty/tiers")
    return json(await getProgram());
  if (
    request.method === "GET" &&
    ["me/rentals", "me/transactions"].includes(path)
  ) {
    const url = new URL(request.url);
    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .parse(url.searchParams.get("limit") ?? 20);
    return json(
      await getHistory(
        userId,
        path === "me/rentals" ? "rentals" : "bonus",
        limit,
        url.searchParams.get("cursor") ?? undefined,
      ),
    );
  }
  if (
    request.method === "GET" &&
    (path === "offers" || path.startsWith("offers/"))
  ) {
    const account = await getAccountSnapshot(userId);
    const allowed = TIER_CODES.slice(0, TIER_CODES.indexOf(account.tier) + 1);
    const id = path.split("/")[1];
    const offers = await query(
      `SELECT * FROM offers WHERE active=true AND start_at<=now() AND end_at>now() AND minimum_tier=ANY($1::text[]) ${id ? "AND id=$2" : ""} ORDER BY start_at DESC,id LIMIT 30`,
      id ? [allowed, id] : [allowed],
    );
    if (id && !offers.length) return notFound();
    return json(id ? offers[0] : { items: offers });
  }
  if (request.method === "GET" && path === "me/referral") {
    const [user] = await query<{ referral_code: string }>(
      "SELECT referral_code FROM users WHERE id=$1",
      [userId],
    );
    const items = await query(
      "SELECT r.id,r.status,r.rewarded_at,r.created_at FROM referrals r WHERE referrer_id=$1 ORDER BY created_at DESC LIMIT 100",
      [userId],
    );
    const bot = process.env.TELEGRAM_BOT_USERNAME;
    const referralProgram = await getReferralProgram();
    return json({
      code: user.referral_code,
      url: bot
        ? `https://t.me/${bot}?startapp=ref_${user.referral_code}`
        : null,
      items,
      program: referralProgram
        ? {
            id: referralProgram.id,
            version: referralProgram.version,
            enabled: referralProgram.enabled,
            activated_at: referralProgram.activated_at,
            referrer: referralProgram.referrer,
            referred: referralProgram.referred,
          }
        : null,
      awards: await query(
        "SELECT id,title,terms,status,issued_at,created_at FROM referral_manual_awards WHERE beneficiary_user_id=$1 ORDER BY created_at DESC LIMIT 100",
        [userId],
      ),
    });
  }
  if (request.method === "PATCH" && path === "me/preferences") {
    requireOrigin(request);
    const input = await body(
      request,
      z.object({ marketingConsent: z.boolean() }),
    );
    await transaction(async (tx) => {
      await tx.query(
        "UPDATE users SET marketing_consent=$2,updated_at=now() WHERE id=$1",
        [userId, input.marketingConsent],
      );
      await tx.query(
        "INSERT INTO marketing_consents(user_id,granted,source) VALUES($1,$2,'profile')",
        [userId, input.marketingConsent],
      );
    });
    return json({ ok: true });
  }
  if (request.method === "POST" && path === "analytics") {
    requireOrigin(request);
    const input = await body(
      request,
      z.object({
        eventId: z.string().uuid(),
        name: z.enum(["club_opened", "offer_viewed", "offer_clicked"]),
        entityId: z.string().max(128).optional(),
      }),
    );
    await query(
      "INSERT INTO analytics_events(event_id,user_id,name,entity_id,properties) VALUES($1,$2,$3,$4,'{}') ON CONFLICT(event_id) DO NOTHING",
      [input.eventId, userId, input.name, input.entityId ?? null],
    );
    return json({ ok: true });
  }
  return null;
}
