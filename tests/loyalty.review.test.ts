import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { query, transaction, closePool } from '../src/lib/db';
import { processRental, adjustRental, cancelRental, creditBonus, debitBonus, getAccountSnapshot, getProgram, publishProgram, recalculateTiers, reconcileAccounts, resolveQualifiedAt } from '../src/lib/loyalty';
const suite = process.env.DATABASE_URL?.includes('rpm_club_test') ? describe : describe.skip;
const admin = { id: 'review-regression', role: 'admin' as const };
const integration = { id: 'integration:rpm', role: 'integration' as const };
const key = () => randomUUID();
async function user() { return (await query<{ id: string }>("INSERT INTO users(name,status) VALUES('Synthetic core review','active') RETURNING id"))[0].id; }
function rental(userId: string) { return { userId, externalRentalId: key(), carName: 'Review car', startDate: '2026-09-01', endDate: '2026-09-02', amountKopecks: '1000000', status: 'completed' as const, paymentStatus: 'paid' as const, qualifiedAt: new Date().toISOString(), idempotencyKey: key() }; }
describe('qualification date policy', () => {
  it('uses actual confirmation for today operational and Moscow day-end for history/past', () => {
    const now = new Date('2026-09-11T09:00:00Z');
    expect(resolveQualifiedAt('2026-09-11', 'operational', undefined, now)).toBe(now.toISOString());
    expect(resolveQualifiedAt('2026-09-11', 'historical', undefined, now)).toBe('2026-09-11T20:59:59.999Z');
    expect(resolveQualifiedAt('2026-09-10', 'operational', undefined, now)).toBe('2026-09-10T20:59:59.999Z');
  });
});
suite('review regressions on PostgreSQL', () => {
  afterAll(closePool);
  it('rejects a future completed rental even while payment is outstanding', async () => {
    const id = await user(), tomorrow = new Date(Date.now() + 27 * 3600000).toISOString().slice(0, 10);
    await expect(processRental({ ...rental(id), startDate: tomorrow, endDate: tomorrow, qualifiedAt: undefined, paymentStatus: 'unpaid' }, admin)).rejects.toMatchObject({ code: 'FUTURE_RENTAL' });
    expect(await query('SELECT id FROM rentals WHERE user_id=$1', [id])).toEqual([]);
    expect(await query('SELECT id FROM outbox_events WHERE user_id=$1', [id])).toEqual([]);
  });
  it('creation and import upserts cannot rewind an existing rental or bypass cancellation', async () => {
    const id = await user(), input = { ...rental(id), status: 'in_progress' as const, paymentStatus: 'unpaid' as const };
    const created = await processRental(input, admin);
    const before = await query('SELECT * FROM rentals WHERE id=$1', [created.rentalId]);
    for (const status of ['accepted', 'cancelled'] as const) {
      await expect(processRental({ ...input, status, idempotencyKey: key() }, admin)).rejects.toMatchObject({ code: 'RENTAL_TRANSITION' });
    }
    await expect(processRental({ ...input, paymentStatus: 'refunded', idempotencyKey: key() }, admin)).rejects.toMatchObject({ code: 'RENTAL_TRANSITION' });
    expect(await query('SELECT * FROM rentals WHERE id=$1', [created.rentalId])).toEqual(before);
    const completed = await processRental({ ...input, status: 'completed', idempotencyKey: key() }, admin);
    await expect(processRental({ ...input, idempotencyKey: key() }, admin)).rejects.toMatchObject({ code: 'RENTAL_TRANSITION' });
    await cancelRental({ rentalId: completed.rentalId, reason: 'Explicit cancellation', idempotencyKey: key() }, admin);
    expect((await query<{ status: string; cancelled_at: Date | null }>('SELECT status,cancelled_at FROM rentals WHERE id=$1', [created.rentalId]))[0]).toMatchObject({ status: 'cancelled', cancelled_at: expect.any(Date) });
    expect(await reconcileAccounts()).toEqual([]);
  });
  it('unpaid → adjustment → paid → cancel uses corrected amount and reconciles', async () => {
    const id = await user(), input = rental(id);
    const original = await processRental({ ...input, paymentStatus: 'unpaid' }, admin);
    await adjustRental({ rentalId: original.rentalId, amountKopecks: '500000', reason: 'correct unpaid amount', idempotencyKey: key() }, admin);
    expect(await reconcileAccounts()).toEqual([]);
    const paid = await processRental({ ...input, idempotencyKey: key() }, admin);
    expect(paid.snapshot).toMatchObject({ total_rental_amount: '500000', bonus_available: '100' });
    expect(await reconcileAccounts()).toEqual([]);
    await cancelRental({ rentalId: original.rentalId, reason: 'cancel paid', idempotencyKey: key() }, admin);
    expect(await getAccountSnapshot(id)).toMatchObject({ total_rental_amount: '0', bonus_available: '0', bonus_debt: '0' });
    expect(await reconcileAccounts()).toEqual([]);
  });
  it('integration adjusts/cancels its source while manual commands and other sources remain forbidden', async () => {
    const id = await user(), own = await processRental({ ...rental(id), source: 'rpm' }, integration);
    await adjustRental({ rentalId: own.rentalId, amountKopecks: '500000', reason: 'integration correction', idempotencyKey: key() }, integration);
    await cancelRental({ rentalId: own.rentalId, reason: 'integration cancellation', idempotencyKey: key() }, integration);
    const foreign = await processRental({ ...rental(id), source: 'other-crm' }, admin);
    await expect(cancelRental({ rentalId: foreign.rentalId, reason: 'foreign', idempotencyKey: key() }, integration)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(adjustRental({ rentalId: foreign.rentalId, amountKopecks: '1', reason: 'foreign', idempotencyKey: key() }, integration)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(processRental({ ...rental(id), source: 'other-crm' }, integration)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(creditBonus({ userId: id, amount: '1', reason: 'manual', idempotencyKey: key() }, integration)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(debitBonus({ userId: id, amount: '1', type: 'manual_debit', reason: 'manual', idempotencyKey: key() }, integration)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(publishProgram({ ...await getProgram(), reason: 'settings', idempotencyKey: key() }, integration)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('today operational without qualifiedAt works and stays duplicate-safe; tomorrow is rejected', async () => {
    const id = await user(), today = new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
    const input = { ...rental(id), startDate: today, endDate: today, qualifiedAt: undefined };
    await expect(processRental(input, admin)).resolves.toMatchObject({ status: 'processed' });
    await expect(processRental({ ...input, idempotencyKey: key() }, admin)).resolves.toMatchObject({ status: 'duplicate' });
    const tomorrow = new Date(Date.now() + 27 * 3600000).toISOString().slice(0, 10);
    await expect(processRental({ ...input, externalRentalId: key(), endDate: tomorrow, idempotencyKey: key() }, admin)).rejects.toMatchObject({ code: 'FUTURE_RENTAL' });
  });
  it.each(['debit', 'snapshot'])('refreshes time after account-lock wait for %s', async (kind) => {
    const id = await user();
    const c = await creditBonus({ userId: id, amount: '100', reason: 'lock expiry test', idempotencyKey: key() }, admin);
    let acquired!: () => void, release!: () => void;
    const ready = new Promise<void>(r => { acquired = r; }), gate = new Promise<void>(r => { release = r; });
    const holder = transaction(async tx => {
      await tx.query('SELECT * FROM loyalty_accounts WHERE user_id=$1 FOR UPDATE', [id]);
      await tx.query("UPDATE bonus_lots SET expires_at=clock_timestamp()+interval '1 second' WHERE credit_transaction_id=$1", [c.transactionId]);
      acquired(); await gate;
      await tx.query('SELECT pg_sleep(greatest(0,extract(epoch FROM (expires_at-clock_timestamp())))+0.1) FROM bonus_lots WHERE credit_transaction_id=$1', [c.transactionId]);
    });
    await ready;
    const pending = kind === 'debit' ? debitBonus({ userId: id, amount: '1', type: 'manual_debit', reason: 'wait', idempotencyKey: key() }, admin) : getAccountSnapshot(id);
    const settled = pending.then(value => ({ value, error: null }), error => ({ value: null, error }));
    try { // Let PostgreSQL confirm the second transaction is actually waiting on the holder.
      const deadline = Date.now() + 5000;
      for (;;) {
        const [row] = await query<{ waiting: boolean }>("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT * FROM loyalty_accounts%') AS waiting");
        if (row.waiting) break;
        if (Date.now() >= deadline) throw new Error('debit/snapshot did not reach account lock');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    } finally { release(); await holder; }
    const outcome = await settled;
    if (kind === 'debit') expect(outcome.error).toMatchObject({ code: 'INSUFFICIENT_BONUS' });
    else expect(outcome.value).toMatchObject({ bonus_available: '0' });
    expect(await getAccountSnapshot(id)).toMatchObject({ bonus_available: '0', bonus_debt: '0' });
  });
  it('recalculates a bounded resumable page and never lowers an achieved tier', async () => {
    const p = await getProgram(), id = await user();
    await processRental({ ...rental(id), amountKopecks: '40000000', mode: 'historical' }, admin);
    const changed = await publishProgram({ ...p, tiers: p.tiers.map((t, i) => ({ ...t, thresholdKopecks: i ? (BigInt(t.thresholdKopecks) * 2n).toString() : '0' })), reason: 'test higher thresholds', idempotencyKey: key() }, admin);
    try {
      const page = await recalculateTiers({ limit: 2, programVersionId: changed.id });
      expect(page.processed).toBe(2); expect(page.done).toBe(false); expect(page.nextCursor).toBeTypeOf('string');
      const next = await recalculateTiers({ limit: 2, cursor: page.nextCursor, programVersionId: changed.id });
      expect(next.processed).toBe(2); expect(next.nextCursor! > page.nextCursor!).toBe(true);
      const previousId = (BigInt('0x' + id.replaceAll('-', '')) - 1n).toString(16).padStart(32, '0').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
      await recalculateTiers({ limit: 1, cursor: previousId, programVersionId: changed.id });
      expect((await getAccountSnapshot(id)).tier).toBe('BLACK');
    } finally { await publishProgram({ ...p, reason: 'restore thresholds', idempotencyKey: key() }, admin); }
  });
  it('publication maintenance persists the cursor and completes only after the final page', async () => {
    const { processProgramRecalculations } = await import('../src/lib/jobs');
    const p = await publishProgram({ ...await getProgram(), reason: 'maintenance page test', idempotencyKey: key() }, admin);
    const [event] = await query<{ id: string }>('SELECT id FROM outbox_events WHERE event_key=$1', [`program:${p.id}`]);
    const last = await query<{ user_id: string }>('SELECT user_id FROM loyalty_accounts ORDER BY user_id DESC LIMIT 4');
    expect(last).toHaveLength(4);
    await query('UPDATE outbox_events SET payload=payload||$2::jsonb WHERE id=$1', [event.id, JSON.stringify({ recalculateCursor: last[3].user_id })]);
    const first = await processProgramRecalculations(2, event.id);
    expect(first).toMatchObject({ eventId: event.id, processed: 2, done: false, nextCursor: last[1].user_id });
    const [saved] = await query<{ payload: { recalculateCursor: string }; expanded_at: Date | null }>('SELECT payload,expanded_at FROM outbox_events WHERE id=$1', [event.id]);
    expect(saved.payload.recalculateCursor).toBe(last[1].user_id); expect(saved.expanded_at).toBeNull();
    expect(await processProgramRecalculations(2, event.id)).toMatchObject({ processed: 1, done: true, nextCursor: null });
    const [completed] = await query<{ expanded_at: Date | null }>('SELECT expanded_at FROM outbox_events WHERE id=$1', [event.id]);
    expect(completed.expanded_at).not.toBeNull();
    expect(await processProgramRecalculations(2, event.id)).toBeNull();
  });
});
