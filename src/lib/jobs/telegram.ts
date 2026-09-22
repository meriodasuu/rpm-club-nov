import { query } from '@/lib/db';
import { getAccountSnapshot, TIER_CODES, type TierCode } from '@/lib/loyalty';
import { HttpError } from '@/lib/http';
import { ProviderError } from './provider';
import { clubTriggerMessage } from '@/lib/club/triggers';

export interface OutboxEvent { id: string; event_key: string; event_type: string; user_id: string | null; aggregate_id: string; account_version: string; payload: Record<string, unknown>; created_at: string }
export interface Delivery extends OutboxEvent { delivery_id: string; channel: string; target: string; attempts: number; lease_token: string }
export async function telegramMessage(event: OutboxEvent, target: string): Promise<string | null> {
  if (event.event_type === 'BOT_WELCOME') {
    const [blocked] = await query<{ status: string; telegram_reachable: boolean }>('SELECT status,telegram_reachable FROM users WHERE telegram_id=$1', [target]);
    if (blocked && (blocked.status === 'blocked' || !blocked.telegram_reachable)) return null;
    return 'Добро пожаловать в RPM Club — ваш статус внутри RPM.\nОткройте клуб, подтвердите телефон и получите карту участника.';
  }
  if (!event.user_id || event.payload.notify === false) return null;
  const [user] = await query<{ status: string; telegram_id: string | null; telegram_reachable: boolean; marketing_consent: boolean; member_since: string | null }>('SELECT u.status,u.telegram_id,u.telegram_reachable,u.marketing_consent,a.member_since FROM users u JOIN loyalty_accounts a ON a.user_id=u.id WHERE u.id=$1', [event.user_id]);
  if (!user || user.status !== 'active' || !user.telegram_reachable || user.telegram_id !== target || !user.member_since || new Date(event.created_at) < new Date(user.member_since)) return null;
  const snapshot = await getAccountSnapshot(event.user_id);
  if (event.event_type === 'CLUB_TRIGGER') return clubTriggerMessage(event, user.marketing_consent, snapshot.tier);
  if (event.event_type === 'RPM_DROP') {
    if (!user.marketing_consent || typeof event.payload.offer_id !== 'string' || !/^[0-9a-f-]{36}$/.test(event.payload.offer_id)) return null;
    if(typeof event.payload.offer_version!=='number')return null;
    const [offer] = await query<{ title: string; description: string; minimum_tier: TierCode; cta_text: string; cta_url: string }>('SELECT title,description,minimum_tier,cta_text,cta_url FROM offers WHERE id=$1 AND version=$2 AND active AND start_at<=now() AND end_at>now()', [event.payload.offer_id,event.payload.offer_version]);
    if (!offer || TIER_CODES.indexOf(snapshot.tier) < TIER_CODES.indexOf(offer.minimum_tier)) return null;
    return `RPM Drop\n${offer.title}\n${offer.description}\n${offer.cta_text}: ${offer.cta_url}`.slice(0, 4000);
  }
  if (!['BONUS_CHANGED', 'TIER_CHANGED'].includes(event.event_type)) return null;
  const lines = ['RPM Club'];
  if (event.event_key.startsWith('rental:')) {
    const key = event.event_key.slice('rental:'.length, -(`:${event.user_id}`.length));
    const [rental] = await query<{ car_name: string; bonus: string }>(`SELECT r.car_name,i.result->>'bonus' AS bonus FROM idempotency_requests i JOIN rentals r ON r.id=(i.result->>'rentalId')::uuid WHERE i.scope='rental' AND i.key=$1 AND r.user_id=$2`, [key, event.user_id]);
    if (rental) lines.push(snapshot.program.rewardMode === 'discount' ? `Аренда ${rental.car_name} завершена.` : `Аренда ${rental.car_name}. Начислено ${rental.bonus} RPM Bonus.`);
  }
  const [audit] = await query<{ before_data: { tier?: string }; after_data: { tier?: string } }>(`SELECT before_data,after_data FROM audit_logs WHERE entity_id=$1 AND after_data->>'account_version'=$2 ORDER BY created_at DESC LIMIT 1`, [event.user_id, event.account_version]);
  if (event.event_type === 'TIER_CHANGED' || (audit?.before_data?.tier && audit.after_data?.tier !== audit.before_data.tier)) lines.push(`Новый статус: ${snapshot.tier}.`, ...snapshot.benefits);
  else lines.push(`Статус: ${snapshot.tier}.`);
  if(snapshot.program.rewardMode === 'discount') lines.push(`Скидка по вашей карте: ${snapshot.discount_rate_bps / 100}%.`);
  if(snapshot.program.rewardMode !== 'discount' || BigInt(snapshot.bonus_available)>0n) lines.push(`Доступно: ${snapshot.bonus_available} RPM Bonus.`);
  if (snapshot.next_tier && snapshot.remaining_amount) lines.push(`До ${snapshot.next_tier}: ${(BigInt(snapshot.remaining_amount) / 100n).toLocaleString('ru-RU')} ₽ суммы аренд.`);
  return lines.join('\n').slice(0, 4000);
}
export async function deliverTelegram(delivery: Delivery): Promise<'succeeded' | 'suppressed'> {
  const message = await telegramMessage(delivery, delivery.target);
  if (!message) return 'suppressed';
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new HttpError(503, 'TELEGRAM_NOT_CONFIGURED', 'Telegram не настроен');
  const appUrl = process.env.APP_URL;
  let response: Response;
  try { response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000), body: JSON.stringify({ chat_id: delivery.target, text: message, disable_web_page_preview: true, ...(appUrl?.startsWith('https://') ? { reply_markup: { inline_keyboard: [[{ text: 'Открыть RPM Club', web_app: { url: appUrl } }]] } } : {}) }) }); }
  catch { throw new ProviderError('telegram', 503); }
  const result = await response.json().catch(() => ({})) as { ok?: boolean; error_code?: number; parameters?: { retry_after?: number } };
  if (!response.ok || result.ok !== true) {
    const status = result.error_code ?? response.status;
    if (status === 403) await query('UPDATE users SET telegram_reachable=false WHERE telegram_id=$1', [delivery.target]);
    const seconds = result.parameters?.retry_after;
    throw new ProviderError('telegram', status, typeof seconds === 'number' && Number.isFinite(seconds) ? Math.min(7 * 86400, Math.max(1, seconds)) : undefined);
  }
  return 'succeeded';
}
