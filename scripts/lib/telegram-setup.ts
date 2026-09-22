import { isIP } from 'node:net';
import { z } from 'zod';

type Environment = Record<string, string | undefined>;
const Bot = z.object({ is_bot: z.literal(true), username: z.string(), has_main_web_app: z.boolean().optional() });
const Hook = z.object({ url: z.string(), pending_update_count: z.number().optional(), last_error_date: z.number().optional() });
const Menu = z.object({ type: z.string(), web_app: z.object({ url: z.string() }).optional() });

export async function setupTelegram(env: Environment, apply: boolean, fetcher: typeof fetch = fetch) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token || !/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error('Set TELEGRAM_BOT_TOKEN in .env.local');
  const username = env.TELEGRAM_BOT_USERNAME;
  if (!username || !/^[A-Za-z0-9_]{5,32}$/.test(username)) throw new Error('Set TELEGRAM_BOT_USERNAME without @');
  let origin: URL;
  try { origin = new URL(env.APP_URL ?? ''); } catch { throw new Error('APP_URL requires a public HTTPS origin'); }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash ||
      origin.pathname !== '/' || (origin.port && origin.port !== '443') || isIP(origin.hostname) ||
      !origin.hostname.includes('.') || /\.(localhost|local|internal)$/.test(origin.hostname)) {
    throw new Error('APP_URL requires a public HTTPS origin without a path, credentials or custom port');
  }
  if (env.LOCAL_PREVIEW !== '0') throw new Error('Set LOCAL_PREVIEW=0 before public Telegram setup');
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || !/^[A-Za-z0-9_-]{32,256}$/.test(secret)) throw new Error('Set TELEGRAM_WEBHOOK_SECRET: 32–256 URL-safe characters');
  const webhookUrl = new URL('/api/telegram/webhook', origin).href;
  const miniAppUrl = new URL('/onboarding', origin).href;
  async function call<T>(method: string, schema: z.ZodType<T>, payload: Record<string, unknown> = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetcher(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(15000), redirect: 'error',
      });
    } catch { throw new Error(`Telegram ${method}: network error (details hidden to protect token)`); }
    const data = await response.json().catch(() => null);
    const parsed = z.object({ ok: z.literal(true), result: schema }).safeParse(data);
    if (!response.ok || !parsed.success) throw new Error(`Telegram ${method}: rejected or invalid response (HTTP ${response.status})`);
    return parsed.data.result;
  }
  const bot = await call('getMe', Bot);
  if (bot.username.toLowerCase() !== username.toLowerCase()) throw new Error('Bot username does not match TELEGRAM_BOT_USERNAME; no settings changed');
  let hook = await call('getWebhookInfo', Hook);
  let menu = await call('getChatMenuButton', Menu);
  if (apply) {
    if (hook.url && hook.url !== webhookUrl) throw new Error('An existing different webhook is configured; resolve the bot/destination before replacing it');
    // Never discard queued contacts or user commands during setup.
    await call('setWebhook', z.literal(true), {
      url: webhookUrl, secret_token: secret, allowed_updates: ['message'],
      drop_pending_updates: false, max_connections: 10,
    });
    await call('setChatMenuButton', z.literal(true), {
      menu_button: { type: 'web_app', text: 'RPM Club', web_app: { url: miniAppUrl } },
    });
    hook = await call('getWebhookInfo', Hook);
    menu = await call('getChatMenuButton', Menu);
    if (hook.url !== webhookUrl || menu.type !== 'web_app' || menu.web_app?.url !== miniAppUrl) {
      throw new Error('Telegram settings were not confirmed; check mode reports current state');
    }
  }
  return {
    applied: apply, username: bot.username, miniAppUrl, webhookUrl,
    webhookMatches: hook.url === webhookUrl,
    menuMatches: menu.type === 'web_app' && menu.web_app?.url === miniAppUrl,
    mainMiniAppEnabled: bot.has_main_web_app === true,
    pendingUpdates: hook.pending_update_count ?? 0,
    lastWebhookErrorAt: hook.last_error_date ?? null,
  };
}
