import { describe, expect, it } from 'vitest';
import { setupTelegram } from '../scripts/lib/telegram-setup';

const env = {
  TELEGRAM_BOT_TOKEN: '123456:synthetic_test_token',
  TELEGRAM_BOT_USERNAME: 'rpm_test_bot',
  TELEGRAM_WEBHOOK_SECRET: 's'.repeat(40),
  APP_URL: 'https://club.example.com',
  LOCAL_PREVIEW: '0',
};
function provider(oldWebhook = '') {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  let webhook = oldWebhook;
  let menu: unknown = { type: 'default' };
  const fetcher: typeof fetch = async (url, init) => {
    const method = String(url).split('/').at(-1)!;
    const body = JSON.parse(String(init?.body ?? '{}'));
    calls.push({ method, body });
    let result: unknown;
    if (method === 'getMe') result = { is_bot: true, username: 'rpm_test_bot', has_main_web_app: false };
    else if (method === 'getWebhookInfo') result = { url: webhook, pending_update_count: 0 };
    else if (method === 'getChatMenuButton') result = menu;
    else if (method === 'setWebhook') { webhook = body.url; result = true; }
    else if (method === 'deleteWebhook') { webhook = ''; result = true; }
    else if (method === 'setChatMenuButton') { menu = JSON.parse(body.menu_button); result = true; }
    else throw new Error('Unexpected API request');
    return Response.json({ ok: true, result });
  };
  return { fetcher, calls };
}

describe('Telegram deployment configuration', () => {
  it('switches the matching webhook to polling without discarding queued commands', async () => {
    const remote = provider('https://club.example.com/api/telegram/webhook');
    const result = await setupTelegram({ ...env, TELEGRAM_UPDATES_MODE: 'polling' }, true, remote.fetcher);
    expect(result).toMatchObject({ updatesMode: 'polling', updatesModeMatches: true, menuMatches: true });
    expect(remote.calls.find(call => call.method === 'deleteWebhook')?.body).toEqual({ drop_pending_updates: false });
    expect(remote.calls.some(call => call.method === 'setWebhook')).toBe(false);
  });
  it('check mode cannot change Telegram settings', async () => {
    const remote = provider();
    const result = await setupTelegram(env, false, remote.fetcher);
    expect(result.applied).toBe(false);
    expect(remote.calls.every(call => call.method.startsWith('get'))).toBe(true);
  });
  it('rejects public preview mode and HTTP before contacting Telegram', async () => {
    const remote = provider();
    await expect(setupTelegram({ ...env, LOCAL_PREVIEW: '1' }, true, remote.fetcher)).rejects.toThrow('LOCAL_PREVIEW');
    await expect(setupTelegram({ ...env, APP_URL: 'http://127.0.0.1:3001' }, true, remote.fetcher)).rejects.toThrow('HTTPS');
    expect(remote.calls).toHaveLength(0);
  });
  it('refuses a different bot or an existing unrelated webhook without mutations', async () => {
    const remote = provider('https://old.example.com/hook');
    await expect(setupTelegram({ ...env, TELEGRAM_BOT_USERNAME: 'other_bot' }, true, remote.fetcher)).rejects.toThrow('username');
    await expect(setupTelegram(env, true, remote.fetcher)).rejects.toThrow('webhook');
    expect(remote.calls.every(call => call.method.startsWith('get'))).toBe(true);
  });
  it('sets verified onboarding and authenticated webhook without dropping updates', async () => {
    const remote = provider();
    const result = await setupTelegram(env, true, remote.fetcher);
    expect(result).toMatchObject({ applied: true, webhookMatches: true, menuMatches: true, mainMiniAppEnabled: false });
    expect(remote.calls.find(call => call.method === 'setWebhook')?.body).toMatchObject({
      url: 'https://club.example.com/api/telegram/webhook', secret_token: env.TELEGRAM_WEBHOOK_SECRET,
      drop_pending_updates: false, allowed_updates: ['message'],
    });
    const menu = remote.calls.find(call => call.method === 'setChatMenuButton')?.body.menu_button;
    expect(typeof menu).toBe('string');
    expect(JSON.parse(menu as string)).toMatchObject({
      type: 'web_app', text: 'RPM Club', web_app: { url: 'https://club.example.com/onboarding' },
    });
    expect(JSON.stringify(result)).not.toContain(env.TELEGRAM_BOT_TOKEN);
    expect(JSON.stringify(result)).not.toContain(env.TELEGRAM_WEBHOOK_SECRET);
  });
  it('does not expose tokens from network errors or redirects', async () => {
    const fetcher: typeof fetch = async () => { throw new Error('Failed URL: ' + env.TELEGRAM_BOT_TOKEN); };
    await expect(setupTelegram(env, false, fetcher)).rejects.toThrow('Telegram getMe: network error');
  });
});
