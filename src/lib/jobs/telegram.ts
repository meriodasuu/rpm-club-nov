import { query } from "@/lib/db";
import { getAccountSnapshot } from "@/lib/loyalty";
import { HttpError } from "@/lib/http";
import { ProviderError } from "./provider";
import { clubTriggerMessage } from "@/lib/club/triggers";
import { tierName } from "@/lib/loyalty/rules";
import { reserveNotificationSlot } from "@/lib/notifications/budget";

export interface OutboxEvent {
  id: string;
  event_key: string;
  event_type: string;
  user_id: string | null;
  aggregate_id: string;
  account_version: string;
  payload: Record<string, unknown>;
  created_at: string;
}
export interface Delivery extends OutboxEvent {
  delivery_id: string;
  channel: string;
  target: string;
  attempts: number;
  lease_token: string;
}
export async function telegramMessage(
  event: OutboxEvent,
  target: string,
): Promise<string | null> {
  if (event.event_type === "BOT_WELCOME") {
    const [blocked] = await query<{
      status: string;
      telegram_reachable: boolean;
    }>("SELECT status,telegram_reachable FROM users WHERE telegram_id=$1", [
      target,
    ]);
    if (
      blocked &&
      (blocked.status === "blocked" || !blocked.telegram_reachable)
    )
      return null;
    return "Добро пожаловать в RPM Club — ваш статус внутри RPM.\nОткройте клуб, подтвердите телефон и получите карту участника.";
  }
  if (!event.user_id || event.payload.notify === false) return null;
  const [user] = await query<{
    status: string;
    telegram_id: string | null;
    telegram_reachable: boolean;
    offers_consent: boolean;
    routes_consent: boolean;
    member_since: string | null;
  }>(
    "SELECT u.status,u.telegram_id,u.telegram_reachable,u.offers_consent,u.routes_consent,a.member_since FROM users u JOIN loyalty_accounts a ON a.user_id=u.id WHERE u.id=$1",
    [event.user_id],
  );
  if (
    !user ||
    user.status !== "active" ||
    !user.telegram_reachable ||
    user.telegram_id !== target ||
    !user.member_since ||
    new Date(event.created_at) < new Date(user.member_since)
  )
    return null;
  if (event.event_type === "ROULETTE_ATTEMPTS_GRANTED") {
    const amount = Number(event.payload.granted);
    if (!Number.isInteger(amount) || amount < 1) return null;
    const lastTwo = amount % 100;
    const plural = lastTwo >= 11 && lastTwo <= 14
      ? "попыток"
      : amount % 10 === 1
        ? "попытка"
        : amount % 10 >= 2 && amount % 10 <= 4
          ? "попытки"
          : "попыток";
    const sources: Record<string, string> = {
      registration: "за регистрацию",
      promo: "по промокоду",
      manual: "от администратора",
    };
    const source = sources[String(event.payload.source_type)] ?? "";
    const lines = ["RPM Club 🎡", `Начислено ${amount} ${plural}${source ? ` ${source}` : ""}.`];
    if (typeof event.payload.expires_at === "string") {
      const expires = new Date(event.payload.expires_at);
      if (!Number.isNaN(expires.getTime()))
        lines.push(`Используйте до ${new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeZone: "Europe/Moscow" }).format(expires)}.`);
    }
    return lines.join("\n");
  }
  if (event.event_type === "GIVEAWAY_PUBLISHED") {
    if (typeof event.payload.title !== "string") return null;
    return `RPM Club\nНовый розыгрыш: ${event.payload.title}. Выполните условия аренды и участвуйте автоматически.`;
  }
  if (event.event_type === "GIVEAWAY_WON") {
    if (typeof event.payload.title !== "string") return null;
    return `RPM Club\nПоздравляем! Вы выиграли: ${event.payload.title}. Приз уже добавлен в раздел «Призы».`;
  }
  const snapshot = await getAccountSnapshot(event.user_id);
  if (event.event_type === "TIER_CHANGED") {
    const [replacement] = await query(
      "SELECT id FROM notification_rules WHERE id='LVL_02' AND (config->>'enabled')::boolean AND enabled_at<=$1",
      [event.created_at],
    );
    if (replacement) return null;
  }
  if (event.event_type === "CLUB_TRIGGER")
    return clubTriggerMessage(event, { offers: user.offers_consent, routes: user.routes_consent }, snapshot.tier);
  if (event.event_type === "RPM_DROP") {
    if (
      !user.offers_consent ||
      typeof event.payload.offer_id !== "string" ||
      !/^[0-9a-f-]{36}$/.test(event.payload.offer_id)
    )
      return null;
    if (typeof event.payload.offer_version !== "number") return null;
    const [offer] = await query<{
      title: string;
      description: string;
      offer_type: string;
    }>(
      `SELECT c.offer_snapshot->>'title' title,c.offer_snapshot->>'description' description,c.offer_snapshot->>'offer_type' offer_type FROM offers o
      JOIN offer_campaigns c ON c.offer_id=o.id AND c.offer_version=$2 AND c.id=$3
      JOIN offer_campaign_recipients r ON r.campaign_id=c.id AND r.user_id=$4
      WHERE o.id=$1 AND o.active AND o.archived_at IS NULL
        AND (c.offer_snapshot->>'start_at')::timestamptz<=now() AND (c.offer_snapshot->>'end_at')::timestamptz>now()`,
      [
        event.payload.offer_id,
        event.payload.offer_version,
        event.payload.campaign_id,
        event.user_id,
      ],
    );
    if (!offer || !process.env.APP_URL) return null;
    const action =
      offer.offer_type === "catalog"
        ? "Оформите аренду со скидкой в RPM Club."
        : "Откройте предложение в RPM Club.";
    return `RPM Drop\n${offer.title}\n${offer.description}\n${action}`.slice(
      0,
      4000,
    );
  }
  if (!["BONUS_CHANGED", "TIER_CHANGED"].includes(event.event_type))
    return null;
  const lines = ["RPM Club"];
  if (event.event_key.startsWith("rental:")) {
    const key = event.event_key.slice(
      "rental:".length,
      -`:${event.user_id}`.length,
    );
    const [rental] = await query<{ car_name: string; bonus: string }>(
      `SELECT r.car_name,i.result->>'bonus' AS bonus FROM idempotency_requests i JOIN rentals r ON r.id=(i.result->>'rentalId')::uuid WHERE i.scope='rental' AND i.key=$1 AND r.user_id=$2`,
      [key, event.user_id],
    );
    if (rental)
      lines.push(
        snapshot.program.rewardMode === "discount"
          ? `Аренда ${rental.car_name} завершена.`
          : `Аренда ${rental.car_name}. Начислено ${rental.bonus} RPM Bonus.`,
      );
  }
  const [audit] = await query<{
    before_data: { tier?: string };
    after_data: { tier?: string };
  }>(
    `SELECT before_data,after_data FROM audit_logs WHERE entity_id=$1 AND after_data->>'account_version'=$2 ORDER BY created_at DESC LIMIT 1`,
    [event.user_id, event.account_version],
  );
  if (
    event.event_type === "TIER_CHANGED" ||
    (audit?.before_data?.tier &&
      audit.after_data?.tier !== audit.before_data.tier)
  )
    lines.push(
      `Новый статус: ${tierName(snapshot.program.tiers.find((t) => t.code === snapshot.tier)!)}.`,
      ...snapshot.benefits,
    );
  else
    lines.push(
      `Статус: ${tierName(snapshot.program.tiers.find((t) => t.code === snapshot.tier)!)}.`,
    );
  if (snapshot.program.rewardMode === "discount")
    lines.push(`Скидка по вашей карте: ${snapshot.discount_rate_bps / 100}%.`);
  if (snapshot.program.rewardMode !== "discount")
    lines.push(`Доступно: ${snapshot.bonus_available} RPM Bonus.`);
  if (snapshot.next_tier && snapshot.remaining_amount)
    lines.push(
      `До ${tierName(snapshot.program.tiers.find((t) => t.code === snapshot.next_tier)!)}: ${(BigInt(snapshot.remaining_amount) / 100n).toLocaleString("ru-RU")} ₽ суммы аренд.`,
    );
  return lines.join("\n").slice(0, 4000);
}
export async function deliverTelegram(
  delivery: Delivery,
): Promise<"succeeded" | "suppressed"> {
  const message = await telegramMessage(delivery, delivery.target);
  if (!message) return "suppressed";
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token)
    throw new HttpError(503, "TELEGRAM_NOT_CONFIGURED", "Telegram не настроен");
  const appUrl = process.env.APP_URL;
  const offerId =
    delivery.event_type === "RPM_DROP" &&
    typeof delivery.payload.offer_id === "string" &&
    /^[0-9a-f-]{36}$/i.test(delivery.payload.offer_id)
      ? delivery.payload.offer_id
      : null;
  const [offer] = offerId
    ? await query<{ offer_type: string }>(
        `SELECT c.offer_snapshot->>'offer_type' offer_type FROM offer_campaigns c
         JOIN offer_campaign_recipients r ON r.campaign_id=c.id AND r.user_id=$3
         WHERE c.offer_id=$1 AND c.offer_version=$2 AND c.id=$4`,
        [offerId, delivery.payload.offer_version, delivery.user_id, delivery.payload.campaign_id],
      )
    : [];
  const bookingOffer = offer?.offer_type === "catalog";
  const category =
    delivery.event_type === "RPM_DROP" ||
    (delivery.event_type === "CLUB_TRIGGER" &&
      ["offer_reminder", "new_route", "weather"].includes(
        String(delivery.payload.kind),
      ))
      ? "marketing"
      : ["CLUB_TRIGGER", "TIER_CHANGED"].includes(delivery.event_type)
        ? "service"
        : "transactional";
  if (category !== "transactional" && delivery.user_id) {
    const [preference] = await query<{ enabled: boolean }>(
      "SELECT enabled FROM notification_profiles WHERE user_id=$1",
      [delivery.user_id],
    );
    if (preference?.enabled === false) return "suppressed";
  }
  // Explicitly launched offer campaigns are not lifecycle marketing noise:
  // admins choose the audience and each recipient has consented to marketing.
  // Keep daily limits for automated messages, while allowing multiple offers.
  if (
    delivery.event_type !== "RPM_DROP" &&
    !(await reserveNotificationSlot(
      delivery.target,
      category,
      "outbox:" + delivery.id,
    ))
  ) {
    const [reset] = await query<{ seconds: number }>(
      "SELECT ceil(extract(epoch FROM (((date_trunc('day',now() AT TIME ZONE 'Europe/Moscow')+interval '1 day') AT TIME ZONE 'Europe/Moscow')-now())))::int seconds",
    );
    throw new ProviderError("notification_limit", 429, reset.seconds);
  }
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify({
        chat_id: delivery.target,
        text: message,
        disable_web_page_preview: true,
        ...(appUrl?.startsWith("https://")
          ? {
              reply_markup: {
                inline_keyboard: [
                  [{
                    text: bookingOffer
                      ? "Оформить аренду со скидкой"
                      : offerId
                        ? "Открыть предложение"
                        : "Открыть RPM Club",
                    web_app: {
                      url: offerId
                        ? bookingOffer
                          ? `${appUrl.replace(/\/$/, "")}/rent?offer=${offerId}`
                          : `${appUrl.replace(/\/$/, "")}/offers/${offerId}`
                        : appUrl,
                    },
                  }],
                ],
              },
            }
          : {}),
      }),
    });
  } catch {
    throw new ProviderError("telegram", 503);
  }
  const result = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    error_code?: number;
    parameters?: { retry_after?: number };
  };
  if (!response.ok || result.ok !== true) {
    const status = result.error_code ?? response.status;
    if (status === 403)
      await query(
        "UPDATE users SET telegram_reachable=false WHERE telegram_id=$1",
        [delivery.target],
      );
    const seconds = result.parameters?.retry_after;
    throw new ProviderError(
      "telegram",
      status,
      typeof seconds === "number" && Number.isFinite(seconds)
        ? Math.min(7 * 86400, Math.max(1, seconds))
        : undefined,
    );
  }
  return "succeeded";
}
