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
      "me/marketing-preferences",
      "analytics",
      "giveaways",
      "leaderboard",
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
        support: "/contacts",
      },
    });
  }
  if (request.method === "GET" && path === "loyalty/tiers")
    return json(await getProgram());
  if (request.method === "GET" && path === "leaderboard") {
    const rows = await query<{
      user_id: string;
      rank: string;
      nickname: string;
      total_rental_amount: string;
    }>(
      `WITH ranked AS (
         SELECT a.user_id,
           dense_rank() OVER (ORDER BY a.total_rental_amount DESC) AS rank,
           coalesce(nullif(u.telegram_username,''), 'Участник #' || left(u.public_member_id,6)) AS nickname,
           a.total_rental_amount::text
         FROM loyalty_accounts a JOIN users u ON u.id=a.user_id
         WHERE u.status='active' AND a.total_rental_amount>0
       )
       SELECT * FROM ranked WHERE rank<=50 OR user_id=$1 ORDER BY rank,user_id`,
      [userId],
    );
    const items = rows.slice(0, 50).map((row) => ({
      rank: Number(row.rank),
      nickname: row.nickname,
      total_rental_amount: row.total_rental_amount,
      isCurrentUser: row.user_id === userId,
    }));
    const own = rows.find((row) => row.user_id === userId);
    return json({
      items,
      currentUser: own
        ? {
            rank: Number(own.rank),
            nickname: own.nickname,
            total_rental_amount: own.total_rental_amount,
            isCurrentUser: Number(own.rank) <= 50,
          }
        : null,
    });
  }
  if (request.method === "GET" && path === "giveaways") {
    return json({ items: await query(
      `SELECT g.id,g.title,g.description,g.rules,g.image_url,g.image_alt,g.minimum_tier,g.minimum_amount_kopecks::text,g.winner_count,g.starts_at,g.ends_at,g.status,
        coalesce(p.qualified_amount_kopecks,0)::text qualified_amount_kopecks,(p.user_id IS NOT NULL) participant,
        coalesce((SELECT jsonb_agg(jsonb_build_object('position',gp.position,'prize',gp.prize_snapshot,'ttlDays',gp.ttl_days) ORDER BY gp.position) FROM giveaway_prizes gp WHERE gp.giveaway_id=g.id),'[]'::jsonb) prizes,
        coalesce((SELECT jsonb_agg(jsonb_build_object('position',w.position,'name',u.name,'status',w.status) ORDER BY w.position) FROM giveaway_winners w JOIN users u ON u.id=w.user_id WHERE w.giveaway_id=g.id),'[]'::jsonb) winners
       FROM giveaways g LEFT JOIN giveaway_participants p ON p.giveaway_id=g.id AND p.user_id=$1
       WHERE g.status IN ('published','drawn') ORDER BY g.ends_at DESC,g.id`, [userId]) });
  }
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
    const offers = await query<{
      personal_snapshot: Record<string, unknown> | null;
      [key: string]: unknown;
    }>(
      `SELECT o.*, personal.offer_snapshot AS personal_snapshot
       FROM offers o
       LEFT JOIN LATERAL (
         SELECT c.offer_snapshot FROM offer_campaigns c
         JOIN offer_campaign_recipients r ON r.campaign_id=c.id AND r.user_id=$2
         WHERE c.offer_id=o.id
           AND (c.offer_snapshot->>'start_at')::timestamptz<=now()
           AND (c.offer_snapshot->>'end_at')::timestamptz>now()
         ORDER BY c.created_at DESC LIMIT 1
       ) personal ON true
       WHERE o.active=true AND o.archived_at IS NULL
         AND (
           personal.offer_snapshot IS NOT NULL
           OR (personal.offer_snapshot IS NULL AND NOT EXISTS (SELECT 1 FROM offer_campaigns c WHERE c.offer_id=o.id)
             AND o.start_at<=now() AND o.end_at>now() AND o.minimum_tier=ANY($1::text[]))
         )
         ${id ? "AND o.id=$3" : ""}
       ORDER BY (personal.offer_snapshot IS NOT NULL) DESC,coalesce((personal.offer_snapshot->>'end_at')::timestamptz,o.end_at) ASC,o.id`,
      id ? [allowed, userId, id] : [allowed, userId],
    );
    const visible = offers.map(({ personal_snapshot, ...offer }) =>
      personal_snapshot
        ? { ...personal_snapshot, personal: true }
        : { ...offer, personal: false },
    );
    if (id && !offers.length) return notFound();
    return json(id ? visible[0] : { items: visible });
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
        "UPDATE users SET marketing_consent=$2,offers_consent=$2,routes_consent=$2,updated_at=now() WHERE id=$1",
        [userId, input.marketingConsent],
      );
      await tx.query(
        "INSERT INTO marketing_consents(user_id,granted,source) VALUES($1,$2,'profile')",
        [userId, input.marketingConsent],
      );
      await tx.query("INSERT INTO marketing_topic_consents(user_id,topic,granted,source) VALUES($1,'offers',$2,'legacy_profile'),($1,'routes',$2,'legacy_profile')", [userId, input.marketingConsent]);
    });
    return json({ ok: true });
  }
  if (path === "me/marketing-preferences") {
    if (request.method === "GET") {
      const [row] = await query<{ offers_consent: boolean; routes_consent: boolean }>("SELECT offers_consent,routes_consent FROM users WHERE id=$1", [userId]);
      return json({ offersEnabled: row.offers_consent, routesEnabled: row.routes_consent });
    }
    if (request.method === "PATCH") {
      requireOrigin(request);
      const input = await body(request, z.object({ topic: z.enum(["offers", "routes"]), enabled: z.boolean() }));
      const result = await transaction(async (tx) => {
        const [current] = await tx.query<{ offers_consent: boolean; routes_consent: boolean }>("SELECT offers_consent,routes_consent FROM users WHERE id=$1 FOR UPDATE", [userId]);
        const offers = input.topic === "offers" ? input.enabled : current.offers_consent;
        const routes = input.topic === "routes" ? input.enabled : current.routes_consent;
        if (offers !== current.offers_consent || routes !== current.routes_consent) {
          await tx.query("UPDATE users SET offers_consent=$2,routes_consent=$3,marketing_consent=$4,updated_at=now() WHERE id=$1", [userId, offers, routes, offers || routes]);
          await tx.query("INSERT INTO marketing_topic_consents(user_id,topic,granted,source) VALUES($1,$2,$3,'profile')", [userId, input.topic, input.enabled]);
        }
        return { offersEnabled: offers, routesEnabled: routes };
      });
      return json(result);
    }
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
