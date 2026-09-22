import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { query,closePool } from '../src/lib/db';
import { processRental,creditBonus,debitBonus,cancelRental,adjustRental,reverseTransaction,getAccountSnapshot,bindReferral,reconcileAccounts,changeTier,publishProgram,getProgram,expireBonuses,retryReferrals } from '../src/lib/loyalty';
const suite=process.env.DATABASE_URL?.includes('rpm_club_test')?describe:describe.skip;
const actor={id:'test',role:'admin' as const};
const key=()=>randomUUID();
async function user(){return (await query<{id:string}>("INSERT INTO users(name,status) VALUES('Synthetic integration user','active') RETURNING id"))[0].id;}
async function referralPair(){const referrer=await user(),referred=await user();for(const id of [referrer,referred])await query('UPDATE users SET phone=$2 WHERE id=$1',[id,`+7${BigInt('0x'+key().replaceAll('-','').slice(0,10)).toString().padStart(10,'0').slice(-10)}`]);const [r]=await query<{referral_code:string}>('SELECT referral_code FROM users WHERE id=$1',[referrer]);await bindReferral({userId:referred,code:r.referral_code},actor);return {referrer,referred,code:r.referral_code};}
function rental(userId:string,amountKopecks='3500000',mode:'historical'|'operational'='operational'){return {userId,externalRentalId:key(),carName:'Test car',startDate:'2026-09-01',endDate:'2026-09-02',qualifiedAt:new Date().toISOString(),amountKopecks,status:'completed' as const,paymentStatus:'paid' as const,mode,idempotencyKey:key()};}
suite('real PostgreSQL economics',()=>{
  afterAll(closePool);
  it('historical, new tier cashback, duplicate conflict and concurrent duplicate',async()=>{
    const id=await user();await processRental(rental(id,'28700000','historical'),actor);
    const input=rental(id);const results=await Promise.all([processRental(input,actor),processRental({...input,idempotencyKey:key()},actor)]);
    expect(results.map(x=>x.status).sort()).toEqual(['duplicate','processed']);
    const snapshot=await getAccountSnapshot(id);expect(snapshot.tier).toBe('BLACK');expect(snapshot.total_rental_amount).toBe('32200000');expect(snapshot.bonus_available).toBe('1400');
    await expect(processRental({...input,amountKopecks:'3500001',idempotencyKey:key()},actor)).rejects.toMatchObject({code:'RENTAL_CONFLICT'});
  });
  it('unpaid has no economics; later paid qualifies once',async()=>{
    const id=await user();const input={...rental(id),paymentStatus:'unpaid' as const};await processRental(input,actor);expect((await getAccountSnapshot(id)).bonus_available).toBe('0');
    await processRental({...input,paymentStatus:'paid',idempotencyKey:key()},actor);expect((await getAccountSnapshot(id)).bonus_available).toBe('700');
  });
  it('parallel spending cannot overdraw; cumulative rental cap holds',async()=>{
    const id=await user();await creditBonus({userId:id,amount:'1000',reason:'test',idempotencyKey:key()},actor);
    const results=await Promise.allSettled([1,2].map(()=>debitBonus({userId:id,amount:'800',type:'manual_debit',reason:'test',idempotencyKey:key()},actor)));
    expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect((await getAccountSnapshot(id)).bonus_available).toBe('200');
    await creditBonus({userId:id,amount:'10000',reason:'test',idempotencyKey:key()},actor);
    const debit={userId:id,amount:'8000',type:'rental_payment' as const,externalRentalId:key(),eligiblePriceKopecks:'4000000',reason:'discount',idempotencyKey:key()};await debitBonus(debit,actor);
    await expect(debitBonus({...debit,amount:'1',idempotencyKey:key()},actor)).rejects.toMatchObject({code:'REDEMPTION_LIMIT'});
  });
  it('cancellation creates debt, next credit covers debt; no downgrade',async()=>{
    const id=await user();await processRental(rental(id,'28700000','historical'),actor);const result=await processRental(rental(id),actor);
    await debitBonus({userId:id,amount:'1200',type:'manual_debit',reason:'test',idempotencyKey:key()},actor);await cancelRental({rentalId:result.rentalId,reason:'cancel',idempotencyKey:key()},actor);
    expect((await getAccountSnapshot(id))).toMatchObject({bonus_available:'0',bonus_debt:'1200',tier:'BLACK',total_rental_amount:'28700000'});
    await creditBonus({userId:id,amount:'1500',reason:'test',idempotencyKey:key()},actor);expect((await getAccountSnapshot(id))).toMatchObject({bonus_available:'300',bonus_debt:'0'});
  });
  it('adjustments use original rate and full rounded entitlement',async()=>{
    const id=await user();const r=await processRental(rental(id,'10000'),actor);await adjustRental({rentalId:r.rentalId,amountKopecks:'14999',reason:'adjust',idempotencyKey:key()},actor);await adjustRental({rentalId:r.rentalId,amountKopecks:'15000',reason:'adjust',idempotencyKey:key()},actor);
    expect((await getAccountSnapshot(id)).bonus_available).toBe('3');
  });
  it('FEFO, expiry before cron, reversal retains original expiry',async()=>{
    const id=await user();const early=await creditBonus({userId:id,amount:'100',expiresAt:new Date(Date.now()+3600000).toISOString(),reason:'test',idempotencyKey:key()},actor);await creditBonus({userId:id,amount:'100',expiresAt:new Date(Date.now()+7200000).toISOString(),reason:'test',idempotencyKey:key()},actor);
    const debit=await debitBonus({userId:id,amount:'120',type:'manual_debit',reason:'test',idempotencyKey:key()},actor);
    expect((await query<{remaining_amount:string}>('SELECT remaining_amount FROM bonus_lots WHERE credit_transaction_id=$1',[early.transactionId]))[0].remaining_amount).toBe('0');
    await query("UPDATE bonus_lots SET expires_at=now()-interval '1 second' WHERE credit_transaction_id=$1",[early.transactionId]);await reverseTransaction({transactionId:debit.transactionId,reason:'refund',idempotencyKey:key()},actor);expect((await getAccountSnapshot(id)).bonus_available).toBe('100');
  });
  it('referral issued exactly once and both rewards reversed',async()=>{
    const referrer=await user(),referred=await user();const prefix=`+79${Date.now().toString().slice(-8)}`;await query('UPDATE users SET phone=$2 WHERE id=$1',[referrer,`${prefix}1`]);await query('UPDATE users SET phone=$2 WHERE id=$1',[referred,`${prefix}2`]);
    const code=(await query<{referral_code:string}>('SELECT referral_code FROM users WHERE id=$1',[referrer]))[0].referral_code;await bindReferral({userId:referred,code},actor);const r=await processRental(rental(referred,'100000'),actor);
    expect((await getAccountSnapshot(referrer)).bonus_available).toBe('3000');expect((await getAccountSnapshot(referred)).bonus_available).toBe('2020');await cancelRental({rentalId:r.rentalId,reason:'cancel referral',idempotencyKey:key()},actor);expect((await getAccountSnapshot(referrer)).bonus_available).toBe('0');expect((await getAccountSnapshot(referred)).bonus_available).toBe('0');
  });
  it('concurrent different rentals retain both totals and credits',async()=>{const id=await user();await Promise.all([processRental(rental(id,'1000000'),actor),processRental(rental(id,'2000000'),actor)]);expect(await getAccountSnapshot(id)).toMatchObject({total_rental_amount:'3000000',bonus_available:'600'});});
  it('rental registration and redemption cannot race across customer ownership',async()=>{const owner=await user(),other=await user(),externalRentalId=key();await creditBonus({userId:other,amount:'1000',reason:'test',idempotencyKey:key()},actor);const results=await Promise.allSettled([processRental({...rental(owner),externalRentalId},actor),debitBonus({userId:other,amount:'100',type:'rental_payment',externalRentalId,eligiblePriceKopecks:'100000',reason:'test',idempotencyKey:key()},actor)]);expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect(results.filter(x=>x.status==='rejected')).toHaveLength(1);});
  it('blocked referral holds both rewards and resumes only once',async()=>{const {referrer,referred}=await referralPair();await query("UPDATE users SET status='blocked' WHERE id=$1",[referrer]);await processRental(rental(referred,'100000'),actor);expect((await getAccountSnapshot(referrer)).bonus_available).toBe('0');expect((await getAccountSnapshot(referred)).bonus_available).toBe('20');await query("UPDATE users SET status='active' WHERE id=$1",[referrer]);await retryReferrals();await retryReferrals();expect((await getAccountSnapshot(referrer)).bonus_available).toBe('3000');expect((await getAccountSnapshot(referred)).bonus_available).toBe('2020');});
  it('spent referral rewards reverse into debt and are never reissued',async()=>{const {referrer,referred}=await referralPair();const r=await processRental(rental(referred,'100000'),actor);for(const id of [referrer,referred])await debitBonus({userId:id,amount:'1000',type:'manual_debit',reason:'test spend referral',idempotencyKey:key()},actor);await cancelRental({rentalId:r.rentalId,reason:'cancel first referral rental',idempotencyKey:key()},actor);expect((await getAccountSnapshot(referrer)).bonus_debt).toBe('1000');expect((await getAccountSnapshot(referred)).bonus_debt).toBe('1000');await processRental(rental(referred,'100000'),actor);await retryReferrals();expect((await getAccountSnapshot(referrer)).bonus_debt).toBe('1000');expect((await getAccountSnapshot(referred)).bonus_debt).toBe('980');});
  it('importing already expired opening credit records expiry without a new balance',async()=>{const id=await user();await creditBonus({userId:id,amount:'500',expiresAt:'2025-01-01T00:00:00Z',reason:'opening_balance',idempotencyKey:key()},actor);expect(await getAccountSnapshot(id)).toMatchObject({bonus_available:'0',bonus_debt:'0'});const entries=await query('SELECT * FROM bonus_transactions WHERE user_id=$1',[id]);expect(entries).toHaveLength(2);});
  it('expired available lots cannot be spent and reversal does not reclaim expiration',async()=>{const id=await user();const c=await creditBonus({userId:id,amount:'100',reason:'test',idempotencyKey:key()},actor);await query("UPDATE bonus_lots SET expires_at=now()-interval '1 second' WHERE credit_transaction_id=$1",[c.transactionId]);await expect(debitBonus({userId:id,amount:'1',type:'manual_debit',reason:'test',idempotencyKey:key()},actor)).rejects.toMatchObject({code:'INSUFFICIENT_BONUS'});expect((await getAccountSnapshot(id)).bonus_available).toBe('0');await expireBonuses();await expireBonuses();await reverseTransaction({transactionId:c.transactionId,reason:'test',idempotencyKey:key()},actor);expect(await getAccountSnapshot(id)).toMatchObject({bonus_available:'0',bonus_debt:'0'});});
  it('expired cashback cannot cover existing debt; expiration repeats safely',async()=>{
    const id=await user();const c=await creditBonus({userId:id,amount:'1000',reason:'test',idempotencyKey:key()},actor);await debitBonus({userId:id,amount:'1000',type:'manual_debit',reason:'test',idempotencyKey:key()},actor);await reverseTransaction({transactionId:c.transactionId,reason:'test',idempotencyKey:key()},actor);
    const p=await getProgram();try{await publishProgram({...p,expiryDays:1,reason:'test immediate expiration',idempotencyKey:key()},actor);const old=new Date(Date.now()-2*86400000),date=old.toISOString().slice(0,10);await processRental({...rental(id,'100000'),startDate:date,endDate:date,qualifiedAt:old.toISOString()},actor);const ledger=await query<{type:string;amount:string}>('SELECT type,amount FROM bonus_transactions WHERE user_id=$1 ORDER BY created_at,id',[id]);expect(ledger).toEqual(expect.arrayContaining([expect.objectContaining({type:'rental_cashback',amount:'20'}),expect.objectContaining({type:'expiration',amount:'-20'})]));}finally{await publishProgram({...p,reason:'restore expiry after test',idempotencyKey:key()},actor);}
    expect(await getAccountSnapshot(id)).toMatchObject({bonus_available:'0',bonus_debt:'1000'});await expireBonuses();await expireBonuses();expect((await getAccountSnapshot(id)).bonus_debt).toBe('1000');
  });
  it('cancelled historical adjustments never award cashback',async()=>{const id=await user();const r=await processRental(rental(id,'40000000','historical'),actor);await adjustRental({rentalId:r.rentalId,amountKopecks:'50000000',reason:'history correction',idempotencyKey:key()},actor);expect((await getAccountSnapshot(id)).bonus_available).toBe('0');await cancelRental({rentalId:r.rentalId,reason:'history cancellation',idempotencyKey:key()},actor);expect(await getAccountSnapshot(id)).toMatchObject({total_rental_amount:'0',tier:'BLACK',bonus_available:'0'});});
  it('manual upgrade removal cannot downgrade and upgrade is recorded',async()=>{const id=await user();await changeTier({userId:id,tier:'RED',reason:'test upgrade',idempotencyKey:key()},actor);await changeTier({userId:id,tier:null,reason:'remove override',idempotencyKey:key()},actor);expect((await getAccountSnapshot(id)).tier).toBe('RED');const rows=await query('SELECT * FROM tier_events WHERE user_id=$1',[id]);expect(rows).toHaveLength(1);});
  it('manual action rolls back fully if audit cannot be written',async()=>{
    const id=await user();await query("CREATE OR REPLACE FUNCTION reject_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.actor_id='rollback-test' THEN RAISE EXCEPTION 'test audit failure'; END IF; RETURN NEW; END $$");await query('CREATE TRIGGER reject_test_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_test_audit()');
    try{await expect(creditBonus({userId:id,amount:'100',reason:'rollback',idempotencyKey:key()},{id:'rollback-test',role:'admin'})).rejects.toThrow('test audit failure');expect((await getAccountSnapshot(id)).bonus_available).toBe('0');expect(await query('SELECT * FROM bonus_transactions WHERE user_id=$1',[id])).toHaveLength(0);expect(await query('SELECT * FROM outbox_events WHERE user_id=$1',[id])).toHaveLength(0);}finally{await query('DROP TRIGGER reject_test_audit ON audit_logs');await query('DROP FUNCTION reject_test_audit()');}
  });
  it('published rules are immutable and corrections preserve original rate',async()=>{
    const before=await getProgram();const id=await user();const r=await processRental(rental(id,'1000000'),actor);const changed={...before,tiers:before.tiers.map(t=>({...t,rateBps:1000})),reason:'test publication',idempotencyKey:key()};
    try{const published=await publishProgram(changed,actor);await expect(query('UPDATE program_versions SET expiry_days=1 WHERE id=$1',[published.id])).rejects.toThrow('append-only');await adjustRental({rentalId:r.rentalId,amountKopecks:'2000000',reason:'same original rate',idempotencyKey:key()},actor);expect((await getAccountSnapshot(id)).bonus_available).toBe('400');await processRental(rental(id,'1000000'),actor);expect((await getAccountSnapshot(id)).bonus_available).toBe('1400');}finally{await publishProgram({...before,reason:'restore test program',idempotencyKey:key()},actor);}
  });
  it('all ledger projections reconcile',async()=>{expect(await reconcileAccounts()).toEqual([]);});
});
