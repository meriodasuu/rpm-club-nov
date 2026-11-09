import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { query, closePool, transaction } from '../src/lib/db';
import { processRental, updateRentalStatus, adjustRental, cancelRental, type RentalInput } from '../src/lib/loyalty';
import { normalizeRentalRow } from '../src/lib/imports/parser';
import { operationsRoute } from '../src/lib/api/operations';
import pg from 'pg';

const suite = process.env.DATABASE_URL?.includes('rpm_club_test') ? describe : describe.skip;
const actor = { id: 'giveaway-times-test', role: 'admin' as const };
const key = () => randomUUID();
async function input(): Promise<RentalInput> {
  const [u] = await query<{id:string}>("INSERT INTO users(name,status) VALUES('Giveaway rental times','active') RETURNING id");
  return { userId:u.id, externalRentalId:key(), carName:'Test', startDate:'2026-09-01', endDate:'2026-09-02', amountKopecks:'100000', status:'accepted', paymentStatus:'unpaid', idempotencyKey:key() };
}
const row = async (id:string) => (await query<Record<string, unknown>>('SELECT * FROM rentals WHERE id=$1',[id]))[0];
suite('giveaway rental evidence on real PostgreSQL', () => {
  afterAll(closePool);
  it('operational transitions stamp reliable times once, and retries add no history', async () => {
    const data=await input(); const r=await processRental(data,actor);
    const completed={...data,status:'completed' as const,idempotencyKey:key()};
    await processRental(completed,actor);
    const first=await row(r.rentalId);
    expect(first.trust_metadata).toMatchObject({completion:'operational_transition',payment:'untrusted'});
    expect(first.paid_at).toBeNull();
    const paid={...completed,paymentStatus:'paid' as const,idempotencyKey:key()};
    await processRental(paid,actor); await processRental(paid,actor);
    const last=await row(r.rentalId);
    expect(last.completed_at).toEqual(first.completed_at);
    expect(last.paid_at).toBeInstanceOf(Date);
    expect(last.trust_metadata).toMatchObject({completion:'operational_transition',payment:'operational_transition'});
    expect(await query('SELECT * FROM giveaway_rental_events WHERE rental_id=$1',[r.rentalId])).toHaveLength(3);
  });
  it('initial historical completed/paid records cannot turn backfilled or qualification dates into evidence', async () => {
    const r=await processRental({...await input(),status:'completed',paymentStatus:'paid',mode:'historical',qualifiedAt:'2026-09-02T12:00:00Z'},actor);
    const state=await row(r.rentalId);
    expect(state.trust_metadata).toEqual({completion:'untrusted',payment:'untrusted'});
    expect(state.paid_at).toBeNull();
  });
  it('validated source dates are retained; malformed source dates are rejected without creating evidence', async () => {
    const data={...await input(),status:'completed' as const,paymentStatus:'paid' as const,completedAt:'2026-09-02T12:00:00Z',paidAt:'2026-09-02T13:00:00Z'};
    const r=await processRental(data,actor); const state=await row(r.rentalId);
    expect(state.trust_metadata).toEqual({completion:'validated_source',payment:'validated_source'});
    expect(state.paid_at).toEqual(new Date(data.paidAt));
    for (const paidAt of ['invalid','2026-02-30T12:00:00Z','2099-01-01T12:00:00Z','2026-09-02'])
      await expect(processRental({...await input(),paymentStatus:'paid',paidAt},actor)).rejects.toMatchObject({code:'INVALID_RENTAL_TIME'});
    // A period ending at the payment instant excludes this rental; starting there includes it.
    const [bounds]=await query<{before:boolean;at:boolean}>("SELECT paid_at < $2::timestamptz AS before, paid_at >= $2::timestamptz AS at FROM rentals WHERE id=$1",[r.rentalId,data.paidAt]);
    expect(bounds).toEqual({before:false,at:true});
  });
  it('CSV/integration normalization preserves explicit timestamps without deriving them from qualified_at', () => {
    const data={external_id:key(),phone:'+79991234567',customer_name:'Test',car_name:'Test',start_date:'2026-09-01',end_date:'2026-09-02',rental_amount:'1000',status:'completed',payment_status:'paid',qualified_at:'2026-09-02T14:00:00Z'};
    expect(normalizeRentalRow(data)).not.toHaveProperty('paidAt',data.qualified_at);
    expect(normalizeRentalRow({...data,completed_at:'2026-09-02T12:00:00Z',paid_at:'2026-09-02T13:00:00Z'})).toMatchObject({completedAt:'2026-09-02T12:00:00Z',paidAt:'2026-09-02T13:00:00Z'});
    expect(()=>normalizeRentalRow({...data,paid_at:'invalid'})).toThrow();
  });
  it('an operational batch import cannot treat its arrival as completion or payment', async () => {
    const data=await input(); const r=await processRental(data,actor);
    await processRental({...data,status:'completed',paymentStatus:'paid',importBatchId:key(),idempotencyKey:key()},actor);
    expect((await row(r.rentalId)).trust_metadata).toEqual({completion:'untrusted',payment:'untrusted'});
    expect((await row(r.rentalId)).paid_at).toBeNull();
  });
  it('the external integration route never infers source event times from webhook arrival', async () => {
    const previous=process.env.INTEGRATION_API_KEY;
    process.env.INTEGRATION_API_KEY='giveaway-test-integration-secret';
    try {
      const data=await input();
      const phone='+7'+BigInt('0x'+key().replaceAll('-','').slice(0,10)).toString().padStart(10,'0').slice(-10);
      await query('UPDATE users SET phone=$2 WHERE id=$1',[data.userId,phone]);
      const payload={external_id:data.externalRentalId,phone,customer_name:'External times',car_name:'Test',start_date:data.startDate,end_date:data.endDate,rental_amount:'1000',status:'accepted',payment_status:'unpaid'};
      const send=async (body:Record<string,unknown>)=>{
        const response=await operationsRoute(new Request('http://localhost/api/integrations/rentals',{method:'POST',headers:{authorization:'Bearer '+process.env.INTEGRATION_API_KEY,'content-type':'application/json','idempotency-key':key()},body:JSON.stringify(body)}),'integrations/rentals');
        expect(response?.status).toBe(201);
        return response!.json() as Promise<{rentalId:string}>;
      };
      const r=await send(payload);
      await send({...payload,status:'completed',payment_status:'paid'});
      expect((await row(r.rentalId)).trust_metadata).toEqual({completion:'untrusted',payment:'untrusted'});
      expect((await row(r.rentalId)).paid_at).toBeNull();
      const explicit=await send({...payload,external_id:key(),status:'completed',payment_status:'paid',completed_at:'2026-09-02T12:00:00Z',paid_at:'2026-09-02T13:00:00Z'});
      expect((await row(explicit.rentalId)).trust_metadata).toEqual({completion:'validated_source',payment:'validated_source'});
    } finally {
      if(previous===undefined) delete process.env.INTEGRATION_API_KEY;
      else process.env.INTEGRATION_API_KEY=previous;
    }
  });
  it('draw MVCC reads do not invert writer row locks while holding the evidence lock', async () => {
    const data=await input(); const r=await processRental(data,actor);
    const writer=new pg.Client({connectionString:process.env.DATABASE_URL});
    const draw=new pg.Client({connectionString:process.env.DATABASE_URL});
    await writer.connect(); await draw.connect();
    let pending:Promise<pg.QueryResult>|undefined;
    try {
      await writer.query('BEGIN'); await draw.query('BEGIN');
      await writer.query("SET LOCAL statement_timeout='5s'");
      await draw.query("SET LOCAL statement_timeout='5s'");
      const writerPid=(await writer.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      const drawPid=(await draw.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      await writer.query('SELECT user_id FROM loyalty_accounts WHERE user_id=$1 FOR UPDATE',[data.userId]);
      await writer.query('SELECT id FROM rentals WHERE id=$1 FOR UPDATE',[r.rentalId]);
      await draw.query("SELECT pg_advisory_xact_lock(hashtextextended('giveaway-rental-evidence',0))");
      pending=writer.query("UPDATE rentals SET status='completed',payment_status='paid' WHERE id=$1",[r.rentalId]);
      // Observe the real dependency, rather than assuming the UPDATE has started.
      let blockers:number[]=[];
      for(let i=0;i<100;i++) {
        blockers=(await draw.query('SELECT pg_blocking_pids($1) blockers',[writerPid])).rows[0].blockers;
        if(blockers.includes(drawPid)) break;
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      expect(blockers).toContain(drawPid);
      const state=(await draw.query('SELECT r.status,a.total_rental_amount FROM rentals r JOIN loyalty_accounts a ON a.user_id=r.user_id WHERE r.id=$1',[r.rentalId])).rows[0];
      expect(state.status).toBe('accepted');
      const evidence=(await draw.query('SELECT status FROM giveaway_rental_events WHERE rental_id=$1 ORDER BY id DESC LIMIT 1',[r.rentalId])).rows[0];
      expect(evidence.status).toBe('accepted');
      await draw.query('COMMIT');
      await pending;
      await writer.query('COMMIT');
      expect((await row(r.rentalId)).status).toBe('completed');
    } finally {
      await draw.query('ROLLBACK');
      if(pending) await pending.catch(()=>undefined);
      await writer.query('ROLLBACK');
      await writer.end(); await draw.end();
    }
  });
  it('status editor retains supplied completion and captures later payment separately', async () => {
    const r=await processRental(await input(),actor);
    let state=await row(r.rentalId);
    await updateRentalStatus({rentalId:r.rentalId,status:'completed',paymentStatus:'unpaid',completedAt:'2026-09-02T12:00:00Z',expectedVersion:Number(state.version),reason:'actual completion',idempotencyKey:key()},actor);
    state=await row(r.rentalId);
    expect(state.completed_at).toEqual(new Date('2026-09-02T12:00:00Z'));
    expect(state.trust_metadata).toMatchObject({completion:'validated_source',payment:'untrusted'});
    await updateRentalStatus({rentalId:r.rentalId,status:'completed',paymentStatus:'paid',expectedVersion:Number(state.version),reason:'payment received',idempotencyKey:key()},actor);
    expect((await row(r.rentalId)).completed_at).toEqual(state.completed_at);
  });
  it('adjustment and cancellation preserve append-only prior states', async () => {
    const r=await processRental({...await input(),status:'completed',paymentStatus:'paid'},actor);
    await adjustRental({rentalId:r.rentalId,amountKopecks:'90000',reason:'adjustment',idempotencyKey:key()},actor);
    await cancelRental({rentalId:r.rentalId,reason:'cancellation',idempotencyKey:key()},actor);
    const events=await query<{id:string;status:string;current_amount_kopecks:string}>('SELECT * FROM giveaway_rental_events WHERE rental_id=$1 ORDER BY id',[r.rentalId]);
    expect(events.map(e=>[e.status,e.current_amount_kopecks])).toEqual([['completed','100000'],['completed','90000'],['cancelled','0']]);
    await expect(query('UPDATE giveaway_rental_events SET current_amount_kopecks=0 WHERE id=$1',[events[0].id])).rejects.toThrow(/immutable/i);
    await expect(query('DELETE FROM giveaway_rental_events WHERE id=$1',[events[0].id])).rejects.toThrow(/immutable/i);
  });
  it('refund history is atomic with the rental and disappears on rollback', async () => {
    const r=await processRental({...await input(),status:'completed',paymentStatus:'paid'},actor);
    await expect(transaction(async tx=>{
      await tx.query("UPDATE rentals SET payment_status='refunded' WHERE id=$1",[r.rentalId]);
      throw new Error('test rollback');
    })).rejects.toThrow('test rollback');
    expect((await row(r.rentalId)).payment_status).toBe('paid');
    expect(await query('SELECT id FROM giveaway_rental_events WHERE rental_id=$1',[r.rentalId])).toHaveLength(1);
    const state=await row(r.rentalId);
    await updateRentalStatus({rentalId:r.rentalId,status:'cancelled',paymentStatus:'refunded',expectedVersion:Number(state.version),reason:'refund',idempotencyKey:key()},actor);
    const [last]=await query<{status:string;payment_status:string}>('SELECT * FROM giveaway_rental_events WHERE rental_id=$1 ORDER BY id DESC LIMIT 1',[r.rentalId]);
    expect(last).toMatchObject({status:'cancelled',payment_status:'refunded'});
  });
});
