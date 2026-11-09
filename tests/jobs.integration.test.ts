import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { query, closePool } from '../src/lib/db';
import { expandOutbox, claimDelivery, finishDelivery, failDelivery, processJobs } from '../src/lib/jobs';
import { ProviderError, retryDelay } from '../src/lib/jobs/provider';
import { reserveNotificationSlot } from '../src/lib/notifications/budget';
const suite = process.env.DATABASE_URL?.includes('rpm_club_test') ? describe : describe.skip;
async function fixture(notify = true) {
  const telegram = BigInt(`0x${randomBytes(6).toString('hex')}`).toString();
  const [user] = await query<{ id: string }>(`INSERT INTO users(name,status,telegram_id,marketing_consent) VALUES('Synthetic jobs test','active',$1,true) RETURNING id`, [telegram]);
  await query(`UPDATE loyalty_accounts SET member_since=now()-interval '1 minute' WHERE user_id=$1`, [user.id]);
  const [event] = await query<{ id: string }>(`INSERT INTO outbox_events(event_key,event_type,user_id,aggregate_id,account_version,payload) VALUES($1,'BONUS_CHANGED',$2::uuid,($2::uuid)::text,4,$3) RETURNING id`, [randomUUID(), user.id, JSON.stringify({ notify })]);
  return { userId: user.id, eventId: event.id, telegram };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })));
  vi.stubEnv('TELEGRAM_BOT_TOKEN', 'synthetic-token-no-network');
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
afterAll(closePool);
suite('leased outbox deliveries against isolated PostgreSQL entities', () => {
  it('atomically expands an event once into Telegram delivery under concurrent workers', async () => {
    const f = await fixture();
    // Existing registrations must not reactivate retired delivery channels.
    await query(`INSERT INTO wallet_passes(user_id,platform) VALUES($1,'apple'),($1,'google')`, [f.userId]);
    const expanded = await Promise.all([expandOutbox(10, [f.eventId]), expandOutbox(10, [f.eventId])]);
    expect(expanded.reduce((a, b) => a + b, 0)).toBe(1);
    expect((await query<{ channel: string }>('SELECT channel FROM deliveries WHERE event_id=$1 ORDER BY channel', [f.eventId])).map(x => x.channel)).toEqual(['telegram']);
    const claimed = await Promise.all([claimDelivery([f.eventId]), claimDelivery([f.eventId]), claimDelivery([f.eventId])]);
    expect(claimed.filter(Boolean)).toHaveLength(1); expect(await claimDelivery([f.eventId])).toBeNull();
  });
  it('reclaims expired leases and rejects acknowledgement from the old worker', async () => {
    const f = await fixture(); await expandOutbox(10, [f.eventId]);
    const first = (await claimDelivery([f.eventId]))!;
    await query(`UPDATE deliveries SET lease_until=now()-interval '1 second' WHERE id=$1`, [first.delivery_id]);
    const second = (await claimDelivery([f.eventId]))!;
    expect(second.delivery_id).toBe(first.delivery_id); expect(second.lease_token).not.toBe(first.lease_token);
    await finishDelivery(first, 'succeeded', '4');
    expect((await query<{ status: string }>('SELECT status FROM deliveries WHERE id=$1', [first.delivery_id]))[0].status).toBe('processing');
    await finishDelivery(second, 'succeeded', '5');
    expect((await query<{ status: string }>('SELECT status FROM deliveries WHERE id=$1', [first.delivery_id]))[0].status).toBe('succeeded');
  });
  it('stops after seven lost leases and invalidates the last worker token', async () => {
    const f = await fixture(); await expandOutbox(10, [f.eventId]);
    let last = (await claimDelivery([f.eventId]))!;
    for (let attempt = 1; attempt <= 7; attempt++) {
      expect(last.attempts).toBe(attempt);
      await query(`UPDATE deliveries SET lease_until=now()-interval '1 second' WHERE id=$1`, [last.delivery_id]);
      if (attempt < 7) last = (await claimDelivery([f.eventId]))!;
    }
    expect(await claimDelivery([f.eventId])).toBeNull();
    await finishDelivery(last, 'succeeded');
    await failDelivery(last, new ProviderError('telegram', 503));
    const [ended] = await query<{ status: string; attempts: number; lease_token: string | null; lease_until: string | null; last_error: string }>('SELECT status,attempts,lease_token,lease_until,last_error FROM deliveries WHERE id=$1', [last.delivery_id]);
    expect(ended).toMatchObject({ status: 'dead', attempts: 7, lease_token: null, lease_until: null, last_error: 'DELIVERY_ATTEMPTS_EXHAUSTED' });
  });
  it('closes exhausted queued jobs while preserving a live seventh lease', async () => {
    const pending = await fixture(), retry = await fixture(), processing = await fixture();
    const ids = [pending.eventId, retry.eventId, processing.eventId];
    await expandOutbox(10, ids);
    await query(`UPDATE deliveries SET attempts=7,status=CASE WHEN event_id=$1 THEN 'pending' ELSE 'retry' END,next_attempt_at=now()+interval '1 day' WHERE event_id=ANY($2::uuid[])`, [pending.eventId, [pending.eventId, retry.eventId]]);
    await query('UPDATE deliveries SET attempts=6 WHERE event_id=$1', [processing.eventId]);
    const live = (await claimDelivery([processing.eventId]))!;
    expect(live.attempts).toBe(7);
    expect(await claimDelivery(ids)).toBeNull();
    expect((await query<{ status: string }>('SELECT status FROM deliveries WHERE event_id=ANY($1::uuid[])', [[pending.eventId, retry.eventId]])).map(d => d.status)).toEqual(['dead', 'dead']);
    expect((await query<{ status: string; lease_token: string }>('SELECT status,lease_token FROM deliveries WHERE id=$1', [live.delivery_id]))[0]).toMatchObject({ status: 'processing', lease_token: live.lease_token });
    await finishDelivery(live, 'succeeded');
    expect((await query<{ status: string }>('SELECT status FROM deliveries WHERE id=$1', [live.delivery_id]))[0].status).toBe('succeeded');
  });
  it('retries 429 with provider delay; classifies permanent failures and exhausted attempts', async () => {
    const f = await fixture(); await expandOutbox(10, [f.eventId]); const d = (await claimDelivery([f.eventId]))!;
    expect(await failDelivery(d, new ProviderError('telegram', 429, 73))).toBe('retry');
    const [retry] = await query<{ status: string; delay: string }>('SELECT status,extract(epoch FROM next_attempt_at-now())::text AS delay FROM deliveries WHERE id=$1', [d.delivery_id]);
    expect(retry.status).toBe('retry'); expect(Number(retry.delay)).toBeGreaterThan(70);
    await query(`UPDATE deliveries SET status='processing',lease_token=$2 WHERE id=$1`, [d.delivery_id, d.lease_token]);
    expect(await failDelivery(d, new ProviderError('telegram', 400))).toBe('dead');
    await query(`UPDATE deliveries SET status='processing',lease_token=$2 WHERE id=$1`, [d.delivery_id, d.lease_token]);
    expect(await failDelivery({ ...d, attempts: 7 }, new ProviderError('telegram', 503))).toBe('dead');
    expect(retryDelay(1, undefined, () => 0.5)).toBe(60000); expect(retryDelay(6, undefined, () => 0.5)).toBe(86400000);
  });
  it('suppresses previously queued retired channels and still delivers Telegram', async () => {
    const f = await fixture();
    await query(`INSERT INTO deliveries(event_id,channel,target) VALUES($1,'apple',$2),($1,'google',$2)`, [f.eventId,f.userId]);
    const result = await processJobs({ eventIds: [f.eventId], maintenance: false });
    expect(result).toMatchObject({ succeeded: 1, suppressed: 2, retry: 0, dead: 0 });
    const retired = await query<{status:string}>(`SELECT status FROM deliveries WHERE event_id=$1 AND channel<>'telegram'`, [f.eventId]);
    expect(retired).toHaveLength(2); expect(retired.every(d=>d.status==='suppressed')).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain('api.telegram.org');
  });
  it('records a safe diagnostic when delivery fails', async () => {
    const f = await fixture();
    await expandOutbox(10,[f.eventId]); const d=(await claimDelivery([f.eventId]))!;
    expect(await failDelivery(d,new Error('secret must never be stored'))).toBe('retry');
    const [failed]=await query<{last_error:string}>('SELECT last_error FROM deliveries WHERE id=$1',[d.delivery_id]);
    expect(failed.last_error).toBe('DELIVERY_FAILED');
  });
  it('Telegram 403 disables future sends; retries do not contact unreachable recipients', async () => {
    const f = await fixture(); vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, error_code: 403 }), { status: 403 })));
    const result = await processJobs({ eventIds: [f.eventId], maintenance: false }); expect(result.dead).toBe(1);
    expect((await query<{ telegram_reachable: boolean }>('SELECT telegram_reachable FROM users WHERE id=$1', [f.userId]))[0].telegram_reachable).toBe(false);
    await query(`UPDATE deliveries SET status='pending',next_attempt_at=now() WHERE event_id=$1 AND channel='telegram'`, [f.eventId]);
    expect((await processJobs({ eventIds: [f.eventId], maintenance: false })).suppressed).toBe(1); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rechecks marketing consent and suppresses historical pre-activation events', async () => {
    const f = await fixture(); await query(`UPDATE users SET marketing_consent=false WHERE id=$1`, [f.userId]);
    await query(`UPDATE outbox_events SET event_type='RPM_DROP',payload=$2 WHERE id=$1`, [f.eventId, JSON.stringify({ offer_id: randomUUID() })]);
    expect((await processJobs({ eventIds: [f.eventId], maintenance: false })).suppressed).toBe(1); expect(fetch).not.toHaveBeenCalled();
    const g = await fixture(); await query(`UPDATE loyalty_accounts SET member_since=now()+interval '1 hour' WHERE user_id=$1`, [g.userId]);
    await processJobs({ eventIds: [g.eventId], maintenance: false });
    expect((await query<{ status: string }>(`SELECT status FROM deliveries WHERE event_id=$1 AND channel='telegram'`, [g.eventId]))[0].status).toBe('suppressed');
  });
  it('sends an explicitly launched offer campaign even after the daily marketing slot is used', async () => {
    const f = await fixture();
    vi.stubEnv('APP_URL', 'https://club.example');
    const [offer] = await query<{ id: string; version: number }>(
      `INSERT INTO offers(title,description,minimum_tier,start_at,end_at,cta_text,cta_url,active,created_by)
       VALUES('Campaign delivery QA','Test offer','MEMBER',now()-interval '1 hour',now()+interval '1 day','Open','https://rpmrent.ru',true,'jobs-test') RETURNING id,version`,
    );
    const [campaign] = await query<{ id: string }>(
      `INSERT INTO offer_campaigns(offer_id,offer_version,audience,requested_by,offer_snapshot)
       SELECT id,version,jsonb_build_array($2::text),'jobs-test',to_jsonb(o) FROM offers o WHERE id=$1 RETURNING id`,
      [offer.id, f.userId],
    );
    await query(
      'INSERT INTO offer_campaign_recipients(campaign_id,offer_id,user_id) VALUES($1,$2,$3)',
      [campaign.id, offer.id, f.userId],
    );
    await query(
      `UPDATE outbox_events SET event_type='RPM_DROP',aggregate_id=$2,payload=$3 WHERE id=$1`,
      [
        f.eventId,
        offer.id,
        JSON.stringify({
          offer_id: offer.id,
          offer_version: offer.version,
          campaign_id: campaign.id,
        }),
      ],
    );
    expect(
      await reserveNotificationSlot(f.telegram, 'marketing', 'lifecycle:prior'),
    ).toBe(true);

    expect(
      await processJobs({ eventIds: [f.eventId], maintenance: false }),
    ).toMatchObject({ succeeded: 1, retry: 0, dead: 0 });
    const requestBody = JSON.parse(
      vi.mocked(fetch).mock.calls[0][1]!.body as string,
    );
    expect(requestBody.reply_markup.inline_keyboard[0][0].web_app.url).toBe(
      `https://club.example/offers/${offer.id}`,
    );
  });
  it('sends BOT_WELCOME without an activated member account', async () => {
    const [event] = await query<{ id: string }>(`INSERT INTO outbox_events(event_key,event_type,aggregate_id,payload) VALUES($1,'BOT_WELCOME','987654321',$2) RETURNING id`, [randomUUID(), JSON.stringify({ telegram_id: '987654321' })]);
    expect((await processJobs({ eventIds: [event.id], maintenance: false })).succeeded).toBe(1);
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string).text).toContain('Добро пожаловать');
  });
});
