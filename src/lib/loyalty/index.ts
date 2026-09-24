import { createHash,randomUUID } from 'node:crypto';
import { query,transaction,type Db } from '../db';
import { qualifyManualReferral,createManualAwards,cancelManualAwards } from '../referrals';
import { TIER_CODES,calculateTier,calculateTierProgress,calculateRentalBonus,maxTier,resolveQualifiedAt,resolveTierBenefits,type TierCode,type TierRule } from './rules';
export * from './rules';
export interface Actor { id:string; role:'admin'|'manager'|'integration'|'system' }
export class LoyaltyError extends Error { constructor(public code:string,message:string,public status=400){super(message);} }
export interface Program { rewardMode?:'cashback'|'discount'; id:string;version:number;tiers:TierRule[];redemptionLimitBps:number;expiryDays:number;referrerReward:string;referredReward:string;programStartsAt:string }
interface Account {user_id:string;calculated_tier:TierCode;achieved_tier:TierCode;manual_override:TierCode|null;total_rental_amount:string;bonus_available:string;bonus_pending:string;bonus_debt:string;account_version:string;member_since:string|null}
export interface User {id:string;name:string;phone:string|null;telegram_id:string|null;telegram_username:string|null;public_member_id:string;referral_code:string;status:string;marketing_consent:boolean;created_at:string}
export interface AccountSnapshot extends Omit<Account,'user_id'> {user:User;tier:TierCode;next_tier:TierCode|null;remaining_amount:string|null;progress_percent:number;cashback_rate_bps:number;discount_rate_bps:number;benefits:string[];program:Program}
export interface RentalInput {userId:string;externalRentalId:string;carName:string;startDate:string;endDate:string;amountKopecks:string;status:'accepted'|'completed'|'in_progress'|'cancelled';paymentStatus:'paid'|'unpaid'|'partial'|'refunded';qualifiedAt?:string;pickupAt?:string;source?:string;mode?:'historical'|'operational';idempotencyKey:string;reason?:string;importBatchId?:string;programVersionId?:string}
export interface RentalResult {status:'processed'|'duplicate';rentalId:string;bonus:string;snapshot:AccountSnapshot}
interface Rental {id:string;user_id:string;source:string;external_rental_id:string;amount_kopecks:string;current_amount_kopecks:string;status:string;payment_status:string;payload_hash:string;is_qualified:boolean;cancelled_at:string|null;net_cashback:string;applied_rate_bps:number;program_version_id:string;mode:string;qualified_at:string}
interface Entry {id:string;user_id:string;amount:string;type:string;rental_id:string|null;external_rental_id:string|null;program_version_id:string}
interface Lot {id:string;credit_transaction_id:string;remaining_amount:string;expires_at:Date|string;available_at:Date|string}
interface Referral {id:string;referrer_id:string;referred_id:string;status:string;qualifying_rental_id:string|null;referrer_reward:string|null;referred_reward:string|null;program_version_id:string|null;manual_version_id:string|null}
const db:Db={query};
const system:Actor={id:'system',role:'system'};
const operationTimes=new WeakMap<Db,string>();
async function refreshOperationTime(tx:Db){const [row]=await tx.query<{at:Date}>('SELECT clock_timestamp() AS at');const at=row.at.toISOString();operationTimes.set(tx,at);return at;}
async function operationTime(tx:Db){return operationTimes.get(tx)??refreshOperationTime(tx);}
function integrationSource(actor:Actor){return actor.id.startsWith('integration:')?actor.id.slice('integration:'.length):null;}
function authorizeRentalSource(actor:Actor,source:string){if(actor.role==='integration'&&(!integrationSource(actor)||integrationSource(actor)!==source))fail('FORBIDDEN','Аренда принадлежит другому источнику',403);}
function fail(code:string,message:string,status=400):never {throw new LoyaltyError(code,message,status);}
function integer(value:string,positive=true){if(typeof value!=='string'||!/^\d+$/.test(value)||BigInt(value)>(2n**63n-1n)|| (positive&&BigInt(value)===0n))fail('INVALID_AMOUNT','Некорректная сумма');return BigInt(value);}
function reason(value:string){if(!value?.trim())fail('REASON_REQUIRED','Укажите причину');}
function authorize(actor:Actor,admin=false){if(!(admin?['admin','system']:['admin','manager','integration','system']).includes(actor.role))fail('FORBIDDEN','Недостаточно прав',403);}
function canonical(value:unknown):string {if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;if(value&&typeof value==='object')return `{${Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;return JSON.stringify(value);}
function hash(value:unknown){return createHash('sha256').update(canonical(value)).digest('hex');}
async function command<T>(scope:string,input:{idempotencyKey:string},actor:Actor,work:(tx:Db)=>Promise<T>,admin=false):Promise<T>{
  authorize(actor,admin);if(actor.role==='integration'&&!['rental','adjust_rental','cancel_rental'].includes(scope))fail('FORBIDDEN','Интеграции доступны только операции её аренд',403);if(!input.idempotencyKey||input.idempotencyKey.length>200)fail('IDEMPOTENCY_REQUIRED','Нужен ключ операции');
  const payloadHash=hash(actor.role==='integration'?{input,integrationSource:integrationSource(actor)}:input);
  return transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${scope}:${input.idempotencyKey}`]);
    const old=await tx.query<{payload_hash:string;result:T}>('SELECT * FROM idempotency_requests WHERE scope=$1 AND key=$2',[scope,input.idempotencyKey]);
    if(old.length){if(old[0].payload_hash!==payloadHash)fail('IDEMPOTENCY_CONFLICT','Ключ операции уже использован для других данных',409);return old[0].result;}
    const result=await work(tx);await tx.query('INSERT INTO idempotency_requests(scope,key,payload_hash,result) VALUES($1,$2,$3,$4)',[scope,input.idempotencyKey,payloadHash,JSON.stringify(result)]);return result;
  });
}
async function program(tx:Db,id?:string):Promise<Program>{
  const rows=await tx.query<{id:string;version:number;tiers:TierRule[];redemption_limit_bps:number;expiry_days:number;referrer_reward:string;referred_reward:string;program_starts_at:Date;reward_mode:'cashback'|'discount'}>(`SELECT * FROM program_versions ${id?'WHERE id=$1':'ORDER BY version DESC LIMIT 1'}`,id?[id]:[]);
  if(!rows.length)fail('PROGRAM_MISSING','Настройки программы не найдены',503);const p=rows[0];return {id:p.id,version:p.version,rewardMode:p.reward_mode,tiers:p.tiers,redemptionLimitBps:p.redemption_limit_bps,expiryDays:p.expiry_days,referrerReward:p.referrer_reward,referredReward:p.referred_reward,programStartsAt:p.program_starts_at.toISOString()};
}
export async function getProgram(){return program(db);}
async function lockAccounts(tx:Db,ids:string[]){const unique=[...new Set(ids)].sort();const rows=await tx.query<Account>('SELECT * FROM loyalty_accounts WHERE user_id=ANY($1::uuid[]) ORDER BY user_id FOR UPDATE',[unique]);if(rows.length!==unique.length)fail('USER_NOT_FOUND','Участник не найден',404);await refreshOperationTime(tx);}
async function account(tx:Db,id:string){const rows=await tx.query<Account>('SELECT * FROM loyalty_accounts WHERE user_id=$1',[id]);if(!rows.length)fail('USER_NOT_FOUND','Участник не найден',404);return rows[0];}
async function snapshot(tx:Db,id:string):Promise<AccountSnapshot>{
  const a=await account(tx,id),p=await program(tx);
  const [user]=await tx.query<User>('SELECT id,name,phone,telegram_id,telegram_username,public_member_id,referral_code,status,marketing_consent,created_at FROM users WHERE id=$1',[id]);
  const tier=maxTier(a.calculated_tier,a.achieved_tier,a.manual_override);
  const benefits=resolveTierBenefits(p.tiers,tier);
  return {user:{...user,created_at:new Date(user.created_at).toISOString()},tier,calculated_tier:a.calculated_tier,achieved_tier:a.achieved_tier,manual_override:a.manual_override,total_rental_amount:a.total_rental_amount,bonus_available:a.bonus_available,bonus_pending:a.bonus_pending,bonus_debt:a.bonus_debt,account_version:a.account_version,member_since:a.member_since?new Date(a.member_since).toISOString():null,...calculateTierProgress(a.total_rental_amount,tier,p.tiers),cashback_rate_bps:p.rewardMode==='discount'?0:(p.tiers.find(x=>x.code===tier)?.rateBps??0),discount_rate_bps:p.rewardMode==='discount'?(p.tiers.find(x=>x.code===tier)?.rateBps??0):0,benefits,program:p};
}
async function audit(tx:Db,actor:Actor,action:string,id:string,why:string,before:unknown,after:unknown,key:string,entity='loyalty_account'){await tx.query('INSERT INTO audit_logs(actor_id,actor_role,action,entity_type,entity_id,reason,before_data,after_data,request_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[actor.id,actor.role,action,entity,id,why,JSON.stringify(before),JSON.stringify(after),key]);}
async function event(tx:Db,id:string,type:string,key:string,payload:unknown={}){const a=await account(tx,id);await tx.query('INSERT INTO outbox_events(event_key,event_type,user_id,aggregate_id,account_version,payload) VALUES($1,$2,$3::uuid,($3::uuid)::text,$4,$5) ON CONFLICT(event_key) DO NOTHING',[key,type,id,a.account_version,JSON.stringify(payload)]);}
async function finish(tx:Db,id:string,actor:Actor,action:string,why:string,key:string,before:unknown,notify=true){await tx.query('UPDATE loyalty_accounts SET account_version=account_version+1 WHERE user_id=$1',[id]);const after=await snapshot(tx,id);await audit(tx,actor,action,id,why,before,after,key);await event(tx,id,'BONUS_CHANGED',`${action}:${key}:${id}`,{notify});return after;}
async function tierUpdate(tx:Db,id:string,p:Program,actor:Actor,why:string,rentalId?:string,previousTier?:TierCode){const a=await account(tx,id),old=previousTier??maxTier(a.calculated_tier,a.achieved_tier,a.manual_override),calculated=calculateTier(a.total_rental_amount,p.tiers),achieved=maxTier(a.achieved_tier,calculated,a.manual_override);await tx.query('UPDATE loyalty_accounts SET calculated_tier=$2,achieved_tier=$3 WHERE user_id=$1',[id,calculated,achieved]);if(TIER_CODES.indexOf(achieved)>TIER_CODES.indexOf(old)){await tx.query('INSERT INTO tier_events(user_id,from_tier,to_tier,reason,rental_id,program_version_id,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,old,achieved,why,rentalId??null,p.id,actor.id]);await event(tx,id,'TIER_CHANGED',`tier:${id}:${achieved}`,{tier:achieved,notify:false});}return achieved;}
async function entry(tx:Db,id:string,amount:bigint,type:string,key:string,p:Program,actor:Actor,why:string,rentalId?:string|null,externalId?:string|null,reversesId?:string){const [row]=await tx.query<{id:string}>('INSERT INTO bonus_transactions(user_id,amount,type,business_key,program_version_id,actor_id,reason,rental_id,external_rental_id,reverses_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',[id,amount.toString(),type,key,p.id,actor.id,why,rentalId??null,externalId??null,reversesId??null]);return row.id;}
async function allocate(tx:Db,transactionId:string,lotId:string,amount:bigint,kind:string){if(amount>0n)await tx.query('INSERT INTO bonus_allocations(transaction_id,lot_id,amount,kind) VALUES($1,$2,$3,$4)',[transactionId,lotId,amount.toString(),kind]);}
async function expire(tx:Db,id:string,p:Program){const at=await operationTime(tx);const lots=await tx.query<Lot>('SELECT * FROM bonus_lots WHERE user_id=$1 AND remaining_amount>0 AND expires_at<=$2::timestamptz ORDER BY expires_at,id FOR UPDATE',[id,at]);for(const lot of lots){const amount=BigInt(lot.remaining_amount),eid=await entry(tx,id,-amount,'expiration',`expiry:${lot.id}:${randomUUID()}`,p,system,'Истёк срок Bonus');await allocate(tx,eid,lot.id,amount,'expiration');await tx.query('UPDATE bonus_lots SET remaining_amount=0 WHERE id=$1',[lot.id]);await tx.query('UPDATE loyalty_accounts SET bonus_available=bonus_available-$2,account_version=account_version+1 WHERE user_id=$1',[id,amount.toString()]);await event(tx,id,'BONUS_CHANGED',`expiration:${eid}`,{notify:false});}return lots.length;}
async function credit(tx:Db,id:string,amount:bigint,type:string,key:string,p:Program,actor:Actor,why:string,expiry:string,rentalId?:string|null,externalId?:string|null,reversesId?:string){
  const at=await operationTime(tx),tid=await entry(tx,id,amount,type,key,p,actor,why,rentalId,externalId,reversesId);const expired=new Date(expiry).getTime()<=Date.parse(at);const a=await account(tx,id),offset=expired?0n:(BigInt(a.bonus_debt)<amount?BigInt(a.bonus_debt):amount);const [lot]=await tx.query<{id:string}>('INSERT INTO bonus_lots(user_id,credit_transaction_id,issued_amount,remaining_amount,available_at,expires_at) VALUES($1,$2,$3,$4,$6,$5) RETURNING id',[id,tid,amount.toString(),(amount-offset).toString(),expiry,at]);
  await allocate(tx,tid,lot.id,offset,'debt_offset');
  if(expired){const eid=await entry(tx,id,-amount,'expiration',`immediate-expiry:${tid}`,p,system,'Срок Bonus истёк до обработки');await allocate(tx,eid,lot.id,amount,'expiration');await tx.query('UPDATE bonus_lots SET remaining_amount=0 WHERE id=$1',[lot.id]);}
  else await tx.query('UPDATE loyalty_accounts SET bonus_debt=bonus_debt-$2,bonus_available=bonus_available+$3 WHERE user_id=$1',[id,offset.toString(),(amount-offset).toString()]);return tid;
}
async function consume(tx:Db,id:string,tid:string,amount:bigint,kind:string,preferredLot?:string){
  const lots=await tx.query<Lot>('SELECT * FROM bonus_lots WHERE user_id=$1 AND remaining_amount>0 AND expires_at>$3::timestamptz ORDER BY (id=$2::uuid) DESC NULLS LAST,expires_at,available_at,id FOR UPDATE',[id,preferredLot??null,await operationTime(tx)]);let left=amount;
  for(const lot of lots){if(left===0n)break;const used=BigInt(lot.remaining_amount)<left?BigInt(lot.remaining_amount):left;await tx.query('UPDATE bonus_lots SET remaining_amount=remaining_amount-$2 WHERE id=$1',[lot.id,used.toString()]);await allocate(tx,tid,lot.id,used,kind);left-=used;}
  if(kind==='spend'&&left>0n)fail('INSUFFICIENT_BONUS','Недостаточно доступных Bonus');await tx.query('UPDATE loyalty_accounts SET bonus_available=bonus_available-$2,bonus_debt=bonus_debt+$3 WHERE user_id=$1',[id,(amount-left).toString(),left.toString()]);return left;
}
async function blocked(tx:Db,id:string){const [u]=await tx.query<{status:string}>('SELECT status FROM users WHERE id=$1',[id]);if(u.status==='blocked')fail('USER_BLOCKED','Участник заблокирован',403);}
async function rentalLockIds(tx:Db,id:string){await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`referral-binding:${id}`]);const refs=await tx.query<{referrer_id:string}>('SELECT referrer_id FROM referrals WHERE referred_id=$1',[id]);return [id,...refs.map(x=>x.referrer_id)];}
export async function getAccountSnapshotInTransaction(tx:Db,userId:string){await lockAccounts(tx,[userId]);await blocked(tx,userId);return snapshot(tx,userId);}
export async function getAccountSnapshot(userId:string){return transaction(async tx=>{await lockAccounts(tx,[userId]);await expire(tx,userId,await program(tx));return snapshot(tx,userId);});}
export async function creditBonus(input:{userId:string;amount:string;expiresAt?:string;reason:string;idempotencyKey:string;type?:'manual_credit'},actor:Actor){reason(input.reason);const amount=integer(input.amount);return command('credit',input,actor,async tx=>{await lockAccounts(tx,[input.userId]);const p=await program(tx);await expire(tx,input.userId,p);const before=await snapshot(tx,input.userId);const expiry=input.expiresAt??new Date(Date.parse(await operationTime(tx))+p.expiryDays*86400000).toISOString();if(!Number.isFinite(Date.parse(expiry))||(Date.parse(expiry)<=Date.parse(await operationTime(tx))&&input.reason!=='opening_balance'))fail('INVALID_EXPIRY','Срок начисления должен быть в будущем');if(input.reason==='opening_balance'&&!input.expiresAt)fail('EXPIRY_REQUIRED','Для переноса баланса нужен явный срок');const transactionId=await credit(tx,input.userId,amount,'manual_credit',`credit:${input.idempotencyKey}`,p,actor,input.reason,expiry);return {transactionId,snapshot:await finish(tx,input.userId,actor,'credit',input.reason,input.idempotencyKey,before)};});}
export async function debitBonus(input:{userId:string;amount:string;type:'manual_debit'|'rental_payment';externalRentalId?:string;eligiblePriceKopecks?:string;reason:string;idempotencyKey:string},actor:Actor){reason(input.reason);const amount=integer(input.amount);return command('debit',input,actor,async tx=>{if(input.type==='rental_payment'&&input.externalRentalId)await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`rental:${input.externalRentalId}`]);await lockAccounts(tx,[input.userId]);await blocked(tx,input.userId);const p=await program(tx);await expire(tx,input.userId,p);const before=await snapshot(tx,input.userId);
  if(input.type==='rental_payment'){
    if(!input.externalRentalId||!input.eligiblePriceKopecks)fail('RENTAL_REQUIRED','Укажите аренду и стоимость до скидки');const price=integer(input.eligiblePriceKopecks);
    const rentals=await tx.query<{user_id:string;cancelled_at:string|null}>('SELECT user_id,cancelled_at FROM rentals WHERE external_rental_id=$1',[input.externalRentalId]);if(rentals.length&&(rentals[0].user_id!==input.userId||rentals[0].cancelled_at))fail('RENTAL_CONFLICT','Аренда недоступна для списания',409);
    await tx.query('INSERT INTO redemption_references(external_rental_id,user_id,eligible_price_kopecks) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[input.externalRentalId,input.userId,price.toString()]);const [ref]=await tx.query<{user_id:string;eligible_price_kopecks:string}>('SELECT * FROM redemption_references WHERE external_rental_id=$1 FOR UPDATE',[input.externalRentalId]);if(ref.user_id!==input.userId||ref.eligible_price_kopecks!==price.toString())fail('RENTAL_CONFLICT','Стоимость или участник аренды отличается',409);
    const [sum]=await tx.query<{used:string}>("SELECT (-coalesce(sum(amount),0))::text AS used FROM bonus_transactions WHERE external_rental_id=$1 AND (type='rental_payment' OR (type='reversal' AND reverses_id IN (SELECT id FROM bonus_transactions WHERE type='rental_payment' AND external_rental_id=$1)))",[input.externalRentalId]);if(amount+BigInt(sum.used)>BigInt(calculateRentalBonus(price,p.redemptionLimitBps)))fail('REDEMPTION_LIMIT','Превышен лимит Bonus для аренды');
  } else if(input.type!=='manual_debit')fail('INVALID_TYPE','Неверный тип списания');
  await refreshOperationTime(tx);await expire(tx,input.userId,p);if(amount>BigInt((await account(tx,input.userId)).bonus_available))fail('INSUFFICIENT_BONUS','Недостаточно доступных Bonus');const transactionId=await entry(tx,input.userId,-amount,input.type,`debit:${input.idempotencyKey}`,p,actor,input.reason,null,input.externalRentalId);await consume(tx,input.userId,transactionId,amount,'spend');return {transactionId,snapshot:await finish(tx,input.userId,actor,'debit',input.reason,input.idempotencyKey,before)};
});}

async function rewardReferral(tx:Db,ref:Referral,rentalId:string,p:Program,actor:Actor){
  if(!['bound','qualified'].includes(ref.status))return;
  if(ref.manual_version_id){await createManualAwards(tx,ref,ref.qualifying_rental_id!,actor);return;}
  if(ref.status==='bound'){
    const [count]=await tx.query<{count:string}>('SELECT count(*)::text AS count FROM rentals WHERE user_id=$1 AND is_qualified',[ref.referred_id]);
    if(count.count!=='1'){await tx.query("UPDATE referrals SET status='ineligible',reason='existing_rentals' WHERE id=$1",[ref.id]);return;}
    if(await qualifyManualReferral(tx,ref,rentalId,p.id,actor))return;
    if(p.rewardMode==='discount'){await tx.query("UPDATE referrals SET status='ineligible',reason='manual_program_not_configured',qualifying_rental_id=$2,program_version_id=$3 WHERE id=$1",[ref.id,rentalId,p.id]);return;}
    await tx.query("UPDATE referrals SET status='qualified',qualifying_rental_id=$2,referrer_reward=$3,referred_reward=$4,program_version_id=$5 WHERE id=$1",[ref.id,rentalId,p.referrerReward,p.referredReward,p.id]);ref={...ref,status:'qualified',qualifying_rental_id:rentalId,referrer_reward:p.referrerReward,referred_reward:p.referredReward,program_version_id:p.id};
  }
  const states=await tx.query<{status:string}>('SELECT status FROM users WHERE id=ANY($1::uuid[])',[ [ref.referrer_id,ref.referred_id] ]);if(states.some(x=>x.status==='blocked')){await tx.query("UPDATE referrals SET reason='blocked_hold' WHERE id=$1",[ref.id]);return;}
  const rewardProgram=await program(tx,ref.program_version_id!);
  for(const [id,value] of [[ref.referrer_id,ref.referrer_reward!],[ref.referred_id,ref.referred_reward!]]){await expire(tx,id,rewardProgram);const before=await snapshot(tx,id);if(BigInt(value)>0n){const tid=await credit(tx,id,BigInt(value),'referral_reward',`referral:${ref.id}:${id}`,rewardProgram,actor,'Реферальная награда',new Date(Date.parse(await operationTime(tx))+rewardProgram.expiryDays*86400000).toISOString(),ref.qualifying_rental_id);await tx.query('INSERT INTO referral_rewards(referral_id,beneficiary_user_id,transaction_id) VALUES($1,$2,$3)',[ref.id,id,tid]);}await tx.query('UPDATE loyalty_accounts SET account_version=account_version+1 WHERE user_id=$1',[id]);await audit(tx,actor,'referral_award',id,'Первая оплаченная аренда',before,await snapshot(tx,id),ref.id);await event(tx,id,'BONUS_CHANGED',`referral:${ref.id}:${id}`,{notify:true});}
  await tx.query("UPDATE referrals SET status='rewarded',rewarded_at=now(),reason=NULL WHERE id=$1",[ref.id]);
}

export async function processRental(input:RentalInput,actor:Actor):Promise<RentalResult>{
  authorizeRentalSource(actor,input.source??'manual');
  integer(input.amountKopecks);if(!input.externalRentalId||input.externalRentalId.length>128||!input.carName?.trim()||input.carName.length>200)fail('INVALID_RENTAL','Некорректные данные аренды');
  const validDate=(v:string)=>/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
  if(!validDate(input.startDate)||!validDate(input.endDate)||input.startDate>input.endDate)fail('INVALID_DATE','Некорректные даты аренды');
  if(!['accepted','completed','in_progress','cancelled'].includes(input.status)||!['paid','unpaid','partial','refunded'].includes(input.paymentStatus))fail('INVALID_STATUS','Некорректный статус аренды');
  const mode=input.mode??'operational';
  if(input.qualifiedAt&&!Number.isFinite(Date.parse(input.qualifiedAt)))fail('INVALID_DATE','Некорректное время квалификации');
  const qualifiedAt=resolveQualifiedAt(input.endDate,mode,input.qualifiedAt);
  if(!Number.isFinite(Date.parse(qualifiedAt))||Date.parse(qualifiedAt)<Date.parse(input.endDate+'T00:00:00+03:00'))fail('INVALID_DATE','Некорректное время квалификации');
  const qualifying=input.status==='completed'&&input.paymentStatus==='paid';if((qualifying&&Date.parse(qualifiedAt)>Date.now())||(input.status==='completed'&&Date.parse(input.endDate+'T00:00:00+03:00')>Date.now()))fail('FUTURE_RENTAL','Завершение аренды не может быть в будущем');
  return command('rental',input,actor,tx=>processRentalTransaction(tx,input,actor,qualifiedAt,mode));
}
async function processRentalTransaction(tx:Db,input:RentalInput,actor:Actor,qualifiedAt:string,mode:'historical'|'operational'):Promise<RentalResult>{
  if(input.pickupAt && (!Number.isFinite(Date.parse(input.pickupAt)) || new Date(Date.parse(input.pickupAt)+3*3600000).toISOString().slice(0,10)!==input.startDate))fail('INVALID_PICKUP','Время выдачи должно соответствовать дате начала аренды');
  const qualifying=input.status==='completed'&&input.paymentStatus==='paid';
  // Omitted confirmation time is a stable payload field; the first persisted rental keeps its actual timestamp.
  const normalized={userId:input.userId,externalRentalId:input.externalRentalId,carName:input.carName.trim(),startDate:input.startDate,endDate:input.endDate,amountKopecks:BigInt(input.amountKopecks).toString(),status:input.status,paymentStatus:input.paymentStatus,qualifiedAt:input.qualifiedAt?new Date(qualifiedAt).toISOString():null,mode,...(input.pickupAt?{pickupAt:new Date(input.pickupAt).toISOString()}:{})};const payloadHash=hash(normalized);
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`rental:${input.externalRentalId}`]);
    await lockAccounts(tx,await rentalLockIds(tx,input.userId));const p=await program(tx,input.programVersionId);await expire(tx,input.userId,p);
    const before=await snapshot(tx,input.userId);const old=await tx.query<Rental>('SELECT * FROM rentals WHERE external_rental_id=$1 FOR UPDATE',[input.externalRentalId]);
    const refs=await tx.query<{user_id:string}>('SELECT user_id FROM redemption_references WHERE external_rental_id=$1',[input.externalRentalId]);if(refs.length&&refs[0].user_id!==input.userId)fail('RENTAL_CONFLICT','Аренда связана с другим участником',409);
    if(old.length){const r=old[0];authorizeRentalSource(actor,r.source);if(r.payload_hash===payloadHash)return {status:'duplicate',rentalId:r.id,bonus:r.net_cashback,snapshot:before};
      // A recorded nonqualifying rental may advance to completed+paid, but immutable identity/price/dates must match.
      const [same]=await tx.query<{matches:boolean}>('SELECT user_id=$2::uuid AND amount_kopecks=$3 AND car_name=$4 AND start_date=$5::date AND end_date=$6::date AND mode=$7 AS matches FROM rentals WHERE id=$1',[r.id,input.userId,input.amountKopecks,input.carName.trim(),input.startDate,input.endDate,mode]);
      if(r.is_qualified||r.cancelled_at||r.status==='cancelled'||!same.matches)fail('RENTAL_CONFLICT','Аренда с этим ID содержит другие данные',409);
      // Creation/import endpoints share the same forward-only lifecycle as the status editor.
      // Cancellations must use cancelRental so existing redemptions are also reversed.
      const stages=['accepted','in_progress','completed'];
      if(stages.indexOf(input.status)<stages.indexOf(r.status)||input.paymentStatus==='refunded')fail('RENTAL_TRANSITION','Обратный переход недоступен. Для возврата используйте отмену аренды.',409);
    }
    const historical=mode==='historical'||Date.parse(qualifiedAt)<Date.parse(p.programStartsAt);let rentalId=old[0]?.id;
    if(rentalId)await tx.query('UPDATE rentals SET status=$2,payment_status=$3,qualified_at=$4,payload_hash=$5,program_version_id=$6,is_qualified=$7,pickup_at=coalesce($8::timestamptz,pickup_at),processed_at=now() WHERE id=$1',[rentalId,input.status,input.paymentStatus,qualifiedAt,payloadHash,p.id,qualifying,input.pickupAt??null]);
    else {const [r]=await tx.query<{id:string}>('INSERT INTO rentals(external_rental_id,user_id,source,car_name,start_date,end_date,amount_kopecks,current_amount_kopecks,status,payment_status,qualified_at,program_version_id,import_batch_id,payload_hash,mode,is_qualified,pickup_at,processed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now()) RETURNING id',[input.externalRentalId,input.userId,input.source??'manual',input.carName.trim(),input.startDate,input.endDate,input.amountKopecks,input.status,input.paymentStatus,qualifiedAt,p.id,input.importBatchId??null,payloadHash,mode,qualifying,input.pickupAt??null]);rentalId=r.id;}
    const qualifyingAmount=old[0]?.current_amount_kopecks??input.amountKopecks;
    let bonus='0';if(qualifying){await tx.query('UPDATE loyalty_accounts SET total_rental_amount=total_rental_amount+$2 WHERE user_id=$1',[input.userId,qualifyingAmount]);const tier=await tierUpdate(tx,input.userId,p,actor,input.reason??'Завершённая оплаченная аренда',rentalId);const rate=historical||p.rewardMode==='discount'?0:(p.tiers.filter(x=>TIER_CODES.indexOf(x.code)<=TIER_CODES.indexOf(tier)).at(-1)?.rateBps??0);bonus=calculateRentalBonus(qualifyingAmount,rate);
      await tx.query('UPDATE rentals SET applied_rate_bps=$2,net_cashback=$3 WHERE id=$1',[rentalId,rate,bonus]);
      if(BigInt(bonus)>0n)await credit(tx,input.userId,BigInt(bonus),'rental_cashback',`rental:${rentalId}`,p,actor,'Cashback за аренду',new Date(Date.parse(qualifiedAt)+p.expiryDays*86400000).toISOString(),rentalId);
      const referral=await tx.query<Referral>('SELECT * FROM referrals WHERE referred_id=$1 FOR UPDATE',[input.userId]);if(referral.length){if(historical)await tx.query("UPDATE referrals SET status='ineligible',reason='historical_rental' WHERE id=$1 AND status='bound'",[referral[0].id]);else await rewardReferral(tx,referral[0],rentalId,p,actor);}
    }
    return {status:'processed',rentalId,bonus,snapshot:await finish(tx,input.userId,actor,'rental',input.reason??(historical?'Исторический перенос':'Аренда'),input.idempotencyKey,before,!historical&&qualifying)};
}
export const processCompletedRental=processRental;
export async function createRequestedRental(tx:Db,input:Pick<RentalInput,'userId'|'externalRentalId'|'carName'|'startDate'|'endDate'|'amountKopecks'|'idempotencyKey'|'reason'|'pickupAt'>,actor:Actor){
  authorize(actor);await blocked(tx,input.userId);
  return processRentalTransaction(tx,{...input,status:'accepted',paymentStatus:'unpaid',source:'miniapp',mode:'operational'},actor,resolveQualifiedAt(input.endDate,'operational'),'operational');
}

export async function updateRentalStatus(input:{rentalId:string;status:RentalInput['status'];paymentStatus:RentalInput['paymentStatus'];expectedVersion:number;reason:string;idempotencyKey:string},actor:Actor):Promise<RentalResult>{
  reason(input.reason);
  if(!['accepted','in_progress','completed','cancelled'].includes(input.status)||!['paid','unpaid','partial','refunded'].includes(input.paymentStatus)||!Number.isInteger(input.expectedVersion)||input.expectedVersion<1)fail('INVALID_STATUS','Некорректный статус или версия аренды');
  return command('rental_status',input,actor,async tx=>{
    const r=await rentalForCorrection(tx,input.rentalId);
    const [details]=await tx.query<{version:number;car_name:string;start_date:string;end_date:string;mode:'historical'|'operational'}>("SELECT version,car_name,to_char(start_date,'YYYY-MM-DD') start_date,to_char(end_date,'YYYY-MM-DD') end_date,mode FROM rentals WHERE id=$1",[r.id]);
    if(details.version!==input.expectedVersion)fail('RENTAL_STALE','Аренда уже изменена. Обновите список и повторите действие.',409);
    if(r.status===input.status&&r.payment_status===input.paymentStatus)return {status:'duplicate',rentalId:r.id,bonus:'0',snapshot:await snapshot(tx,r.user_id)};
    if(r.cancelled_at||r.status==='cancelled')fail('RENTAL_CANCELLED','Отменённую аренду нельзя возобновить',409);
    if(input.status==='cancelled'){
      const result=await correctRental(tx,r,0n,true,input.idempotencyKey,actor,input.reason);
      await tx.query('UPDATE rentals SET payment_status=$2 WHERE id=$1',[r.id,input.paymentStatus]);
      await audit(tx,actor,'rental_status',r.id,input.reason,{status:r.status,paymentStatus:r.payment_status},{status:input.status,paymentStatus:input.paymentStatus},input.idempotencyKey,'rental');
      return {status:'processed',rentalId:r.id,bonus:'0',snapshot:result.snapshot};
    }
    const stages=['accepted','in_progress','completed'];
    if(stages.indexOf(input.status)<stages.indexOf(r.status)||r.is_qualified||input.paymentStatus==='refunded')fail('RENTAL_TRANSITION','Обратный переход недоступен. Для возврата используйте отмену аренды.',409);
    const qualifiedAt=resolveQualifiedAt(details.end_date,details.mode);
    if(input.status==='completed'&&Date.parse(details.end_date+'T00:00:00+03:00')>Date.now())fail('FUTURE_RENTAL','Завершение аренды не может быть в будущем');
    const rental:RentalInput={userId:r.user_id,externalRentalId:r.external_rental_id,carName:details.car_name,startDate:details.start_date,endDate:details.end_date,amountKopecks:r.amount_kopecks,status:input.status,paymentStatus:input.paymentStatus,source:r.source,mode:details.mode,idempotencyKey:input.idempotencyKey,reason:input.reason};
    const result=await processRentalTransaction(tx,rental,actor,qualifiedAt,details.mode);
    await audit(tx,actor,'rental_status',r.id,input.reason,{status:r.status,paymentStatus:r.payment_status},{status:input.status,paymentStatus:input.paymentStatus,bonus:result.bonus},input.idempotencyKey,'rental');
    return result;
  });
}

async function uncompensated(tx:Db,e:Entry){const [r]=await tx.query<{reversed:string}>("SELECT coalesce(sum(abs(amount)),0)::text AS reversed FROM bonus_transactions WHERE reverses_id=$1 AND type='reversal'",[e.id]);return (BigInt(e.amount)<0n?-BigInt(e.amount):BigInt(e.amount))-BigInt(r.reversed);}
async function reverseCredit(tx:Db,e:Entry,amount:bigint,key:string,actor:Actor,why:string){
  const p=await program(tx,e.program_version_id);const remaining=await uncompensated(tx,e);if(amount>remaining||amount<=0n)fail('REVERSAL_LIMIT','Операция уже компенсирована',409);
  const [lot]=await tx.query<Lot>('SELECT * FROM bonus_lots WHERE credit_transaction_id=$1 FOR UPDATE',[e.id]);if(!lot)fail('REVERSAL_UNSUPPORTED','Нет исходного начисления');
  // Expired credit is compensated together with its expiration: it cannot become fresh debt.
  const expirations=await tx.query<{id:string;amount:string;compensated:string}>("SELECT t.id,t.amount,coalesce((SELECT sum(amount) FROM bonus_transactions r WHERE r.reverses_id=t.id),0)::text AS compensated FROM bonus_allocations a JOIN bonus_transactions t ON t.id=a.transaction_id WHERE a.lot_id=$1 AND a.kind='expiration' ORDER BY t.created_at,t.id",[lot.id]);
  let expiredToOffset=amount,expired=0n;
  for(const ex of expirations){const available=-BigInt(ex.amount)-BigInt(ex.compensated),part=available<expiredToOffset?available:expiredToOffset;if(part>0n){await entry(tx,e.user_id,part,'reversal',`${key}:expiration:${ex.id}`,p,actor,why,e.rental_id,null,ex.id);expired+=part;expiredToOffset-=part;}if(expiredToOffset===0n)break;}
  const tid=await entry(tx,e.user_id,-amount,'reversal',key,p,actor,why,e.rental_id,e.external_rental_id,e.id);
  await consume(tx,e.user_id,tid,amount-expired,'reversal',lot.id);return tid;
}
async function reverseDebit(tx:Db,e:Entry,key:string,actor:Actor,why:string){
  if(!['manual_debit','rental_payment'].includes(e.type))fail('REVERSAL_UNSUPPORTED','Эта проводка не отменяется вручную');
  const amount=await uncompensated(tx,e);if(amount<=0n)fail('REVERSAL_LIMIT','Операция уже компенсирована',409);
  const at=await operationTime(tx),p=await program(tx,e.program_version_id),tid=await entry(tx,e.user_id,amount,'reversal',key,p,actor,why,e.rental_id,e.external_rental_id,e.id);
  const allocations=await tx.query<{lot_id:string;amount:string;expires_at:Date}>('SELECT a.lot_id,a.amount,l.expires_at FROM bonus_allocations a JOIN bonus_lots l ON l.id=a.lot_id WHERE a.transaction_id=$1 AND a.kind=\'spend\' ORDER BY l.expires_at,l.id',[e.id]);
  for(const a of allocations){const value=BigInt(a.amount);await allocate(tx,tid,a.lot_id,value,'restore');
    if(a.expires_at.getTime()<=Date.parse(at)){const expiredId=await entry(tx,e.user_id,-value,'expiration',`${key}:expired-restore:${a.lot_id}`,p,system,'Возврат Bonus с истёкшим сроком');await allocate(tx,expiredId,a.lot_id,value,'expiration');}
    else{const balance=await account(tx,e.user_id),offset=BigInt(balance.bonus_debt)<value?BigInt(balance.bonus_debt):value;await allocate(tx,tid,a.lot_id,offset,'debt_offset');await tx.query('UPDATE bonus_lots SET remaining_amount=remaining_amount+$2 WHERE id=$1',[a.lot_id,(value-offset).toString()]);await tx.query('UPDATE loyalty_accounts SET bonus_available=bonus_available+$2,bonus_debt=bonus_debt-$3 WHERE user_id=$1',[e.user_id,(value-offset).toString(),offset.toString()]);}
  }
  return tid;
}
export async function reverseTransaction(input:{transactionId:string;reason:string;idempotencyKey:string},actor:Actor){reason(input.reason);return command('reverse',input,actor,async tx=>{
  const [e]=await tx.query<Entry>('SELECT * FROM bonus_transactions WHERE id=$1',[input.transactionId]);if(!e)fail('TRANSACTION_NOT_FOUND','Операция не найдена',404);await lockAccounts(tx,[e.user_id]);await expire(tx,e.user_id,await program(tx));const before=await snapshot(tx,e.user_id);
  if(!['manual_credit','manual_debit','rental_payment'].includes(e.type))fail('REVERSAL_UNSUPPORTED','Cashback и referral отменяются через аренду');
  const transactionId=BigInt(e.amount)>0n?await reverseCredit(tx,e,await uncompensated(tx,e),`reverse:${input.idempotencyKey}`,actor,input.reason):await reverseDebit(tx,e,`reverse:${input.idempotencyKey}`,actor,input.reason);
  return {transactionId,snapshot:await finish(tx,e.user_id,actor,'reverse',input.reason,input.idempotencyKey,before)};
});}
async function correctRental(tx:Db,r:Rental,newAmount:bigint,cancel:boolean,key:string,actor:Actor,why:string){
  authorizeRentalSource(actor,r.source);
  const p=await program(tx,r.program_version_id);const before=await snapshot(tx,r.user_id);if(r.cancelled_at)fail('RENTAL_CANCELLED','Аренда уже отменена',409);
  let entitled=0n;if(r.is_qualified){entitled=cancel?0n:BigInt(calculateRentalBonus(newAmount,r.applied_rate_bps));const delta=entitled-BigInt(r.net_cashback);
    if(delta>0n)await credit(tx,r.user_id,delta,'rental_cashback',`adjust:${key}:credit`,p,actor,why,new Date(new Date(r.qualified_at).getTime()+p.expiryDays*86400000).toISOString(),r.id);
    else if(delta<0n){let left=-delta;const credits=await tx.query<Entry>("SELECT * FROM bonus_transactions WHERE rental_id=$1 AND user_id=$2 AND type='rental_cashback' ORDER BY created_at DESC,id DESC",[r.id,r.user_id]);for(const e of credits){const available=await uncompensated(tx,e),part=available<left?available:left;if(part>0n){await reverseCredit(tx,e,part,`adjust:${key}:${e.id}`,actor,why);left-=part;}if(left===0n)break;}if(left>0n)fail('LEDGER_MISMATCH','Начисления аренды не сходятся',500);}
    await tx.query('UPDATE loyalty_accounts SET total_rental_amount=total_rental_amount+$2 WHERE user_id=$1',[r.user_id,(newAmount-BigInt(r.current_amount_kopecks)).toString()]);
  }
  await tx.query('INSERT INTO rental_adjustments(rental_id,operation_key,before_amount,after_amount,before_status,after_status,reason,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[r.id,key,r.current_amount_kopecks,newAmount.toString(),r.status,cancel?'cancelled':r.status,why,actor.id]);
  await tx.query('UPDATE rentals SET current_amount_kopecks=$2,net_cashback=$3,status=CASE WHEN $4 THEN \'cancelled\' ELSE status END,cancelled_at=CASE WHEN $4 THEN now() ELSE cancelled_at END WHERE id=$1',[r.id,newAmount.toString(),entitled.toString(),cancel]);
  if(cancel){
    await cancelManualAwards(tx,r.id,actor,why,key);
    const refs=await tx.query<Referral>('SELECT * FROM referrals WHERE qualifying_rental_id=$1 FOR UPDATE',[r.id]);for(const ref of refs){if(ref.status==='rewarded'){const rewards=await tx.query<Entry>('SELECT t.* FROM referral_rewards rw JOIN bonus_transactions t ON t.id=rw.transaction_id WHERE rw.referral_id=$1',[ref.id]);for(const e of rewards){const rewardBefore=await snapshot(tx,e.user_id);await expire(tx,e.user_id,p);const amount=await uncompensated(tx,e);if(amount>0n)await reverseCredit(tx,e,amount,`cancel:${key}:referral:${e.id}`,actor,why);if(e.user_id!==r.user_id)await finish(tx,e.user_id,actor,'referral_reversed',why,`${key}:${e.id}`,rewardBefore);}}await tx.query("UPDATE referrals SET status='reversed',reason=$2 WHERE id=$1",[ref.id,why]);}
    const payments=await tx.query<Entry>("SELECT * FROM bonus_transactions WHERE external_rental_id=$1 AND type='rental_payment' ORDER BY created_at,id",[r.external_rental_id]);for(const e of payments)if(await uncompensated(tx,e)>0n)await reverseDebit(tx,e,`cancel:${key}:payment:${e.id}`,actor,why);
  }
  await tierUpdate(tx,r.user_id,await program(tx),actor,why,r.id);return {rentalId:r.id,snapshot:await finish(tx,r.user_id,actor,cancel?'cancel_rental':'adjust_rental',why,key,before)};
}
async function rentalForCorrection(tx:Db,rentalId:string){const [r]=await tx.query<Rental>('SELECT * FROM rentals WHERE id=$1',[rentalId]);if(!r)fail('RENTAL_NOT_FOUND','Аренда не найдена',404);await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`rental:${r.external_rental_id}`]);await lockAccounts(tx,await rentalLockIds(tx,r.user_id));await expire(tx,r.user_id,await program(tx));const [locked]=await tx.query<Rental>('SELECT * FROM rentals WHERE id=$1 FOR UPDATE',[rentalId]);return locked;}
export async function adjustRental(input:{rentalId:string;amountKopecks:string;reason:string;idempotencyKey:string},actor:Actor){reason(input.reason);const amount=integer(input.amountKopecks);return command('adjust_rental',input,actor,async tx=>correctRental(tx,await rentalForCorrection(tx,input.rentalId),amount,false,input.idempotencyKey,actor,input.reason));}
export async function cancelRental(input:{rentalId:string;reason:string;idempotencyKey:string},actor:Actor){reason(input.reason);return command('cancel_rental',input,actor,async tx=>{const r=await rentalForCorrection(tx,input.rentalId);authorizeRentalSource(actor,r.source);if(r.cancelled_at)return {rentalId:r.id,snapshot:await snapshot(tx,r.user_id)};return correctRental(tx,r,0n,true,input.idempotencyKey,actor,input.reason);});}

export async function changeTier(input:{userId:string;tier:TierCode|null;reason:string;idempotencyKey:string},actor:Actor){reason(input.reason);if(input.tier!==null&&!TIER_CODES.includes(input.tier))fail('INVALID_TIER','Неизвестный уровень');return command('tier',input,actor,async tx=>{await lockAccounts(tx,[input.userId]);const before=await snapshot(tx,input.userId);if(input.tier&&!before.program.tiers.some(t=>t.code===input.tier))fail('INVALID_TIER','Уровень ещё не опубликован');if(input.tier&&TIER_CODES.indexOf(input.tier)<TIER_CODES.indexOf(before.tier))fail('TIER_DOWNGRADE','Понижение уровня не разрешено');await tx.query('UPDATE loyalty_accounts SET manual_override=$2 WHERE user_id=$1',[input.userId,input.tier]);await tierUpdate(tx,input.userId,await program(tx),actor,input.reason,undefined,before.tier);return finish(tx,input.userId,actor,'tier',input.reason,input.idempotencyKey,before);},true);}
export async function publishProgram(input:{rewardMode?:'cashback'|'discount';tiers:TierRule[];redemptionLimitBps:number;expiryDays:number;referrerReward:string;referredReward:string;programStartsAt:string;reason:string;idempotencyKey:string},actor:Actor){
  reason(input.reason);const codes=input.tiers.map(t=>t.code);const expected=TIER_CODES.filter(c=>codes.includes(c));if(![5,6].includes(codes.length)||codes.some((c,i)=>c!==expected[i])||TIER_CODES.filter(c=>c!=='PLATINUM').some(c=>!codes.includes(c))||input.tiers.some((t)=>!TIER_CODES.includes(t.code)||!Number.isInteger(t.rateBps)||t.rateBps<0||t.rateBps>(input.rewardMode==='discount'?9999:10000)||!Array.isArray(t.benefits)||t.benefits.some(b=>typeof b!=='string')))fail('INVALID_PROGRAM','Проверьте уровни и ставки');
  input.tiers.forEach(t=>integer(t.thresholdKopecks,false));if(input.tiers[0].thresholdKopecks!=='0'||input.tiers.some((t,i)=>i>0&&BigInt(t.thresholdKopecks)<=BigInt(input.tiers[i-1].thresholdKopecks)))fail('INVALID_PROGRAM','Пороги должны строго возрастать от нуля');
  if(!Number.isInteger(input.redemptionLimitBps)||input.redemptionLimitBps<0||input.redemptionLimitBps>10000||!Number.isInteger(input.expiryDays)||input.expiryDays<1||input.expiryDays>36500||!Number.isFinite(Date.parse(input.programStartsAt)))fail('INVALID_PROGRAM','Неверные настройки программы');integer(input.referrerReward,false);integer(input.referredReward,false);
  return command('program',input,actor,async tx=>{await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('program-publish',0))");const before=await program(tx);if(before.tiers.some(t=>!codes.includes(t.code)))fail('TIER_REMOVAL','Удаление опубликованного уровня недоступно');const [used]=await tx.query<{exists:boolean}>("SELECT EXISTS(SELECT 1 FROM rentals WHERE mode='operational' AND is_qualified) AS exists");if(used.exists&&Date.parse(input.programStartsAt)!==Date.parse(before.programStartsAt))fail('START_DATE_LOCKED','Дата старта уже используется');const [row]=await tx.query<{id:string}>('INSERT INTO program_versions(version,tiers,redemption_limit_bps,expiry_days,referrer_reward,referred_reward,program_starts_at,published_by,reward_mode) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',[before.version+1,JSON.stringify(input.tiers),input.redemptionLimitBps,input.expiryDays,input.referrerReward,input.referredReward,input.programStartsAt,actor.id,input.rewardMode??'cashback']);const after=await program(tx,row.id);await audit(tx,actor,'publish_program',row.id,input.reason,before,after,input.idempotencyKey,'program');await tx.query("INSERT INTO outbox_events(event_key,event_type,aggregate_id,payload) VALUES($1,'PROGRAM_PUBLISHED',$2,$3)",[`program:${row.id}`,row.id,JSON.stringify({programVersionId:row.id})]);return after;},true);
}
export async function bindReferralInTransaction(tx:Db,input:{userId:string;code:string},actor:Actor){authorize(actor);
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`referral-binding:${input.userId}`]);
  const [referrer]=await tx.query<User>('SELECT * FROM users WHERE referral_code=$1',[input.code.trim().toUpperCase()]);if(!referrer)return {status:'invalid'};await lockAccounts(tx,[input.userId,referrer.id]);const [user]=await tx.query<User>('SELECT * FROM users WHERE id=$1',[input.userId]);
  const existing=await tx.query('SELECT id FROM referrals WHERE referred_id=$1',[input.userId]);if(existing.length)return {status:'already_bound'};const [count]=await tx.query<{count:string}>('SELECT count(*)::text AS count FROM rentals WHERE user_id=$1 AND is_qualified',[input.userId]);
  const a=await account(tx,input.userId);if(a.member_since)return {status:'activation_completed'};
  if(!user.phone||!referrer.phone||user.id===referrer.id||user.phone===referrer.phone||referrer.status==='blocked'||user.status==='blocked'||count.count!=='0')return {status:'ineligible'};
  const [r]=await tx.query<{id:string}>("INSERT INTO referrals(referrer_id,referred_id,code_snapshot,status) VALUES($1,$2,$3,'bound') RETURNING id",[referrer.id,user.id,referrer.referral_code]);await audit(tx,actor,'bind_referral',r.id,'Код при активации',null,{referrerId:referrer.id,referredId:user.id},r.id,'referral');return {status:'bound'};
}
export async function bindReferral(input:{userId:string;code:string},actor:Actor){return transaction(tx=>bindReferralInTransaction(tx,input,actor));}
export async function retryReferrals(){const refs=await query<Referral>("SELECT * FROM referrals WHERE status='qualified' AND (manual_version_id IS NULL OR NOT EXISTS(SELECT 1 FROM referral_manual_awards a WHERE a.referral_id=referrals.id)) ORDER BY created_at LIMIT 100");for(const ref of refs)await transaction(async tx=>{await lockAccounts(tx,[ref.referrer_id,ref.referred_id]);const [current]=await tx.query<Referral>('SELECT * FROM referrals WHERE id=$1 FOR UPDATE',[ref.id]);await rewardReferral(tx,current,current.qualifying_rental_id!,await program(tx,current.program_version_id!),system);});return refs.length;}
export async function expireBonuses(limit=100){const ids=await query<{user_id:string}>('SELECT DISTINCT user_id FROM bonus_lots WHERE remaining_amount>0 AND expires_at<=clock_timestamp() LIMIT $1',[Math.max(1,Math.min(limit,1000))]);let count=0;for(const {user_id} of ids)count+=await transaction(async tx=>{await lockAccounts(tx,[user_id]);return expire(tx,user_id,await program(tx));});return count;}
export interface RecalculateTiersResult {processed:number;changed:number;nextCursor:string|null;done:boolean}
export async function recalculateTiers(input:{limit?:number;cursor?:string|null;programVersionId?:string}={}):Promise<RecalculateTiersResult>{
  const limit=Math.max(1,Math.min(Math.trunc(input.limit??50),100));
  if(!Number.isFinite(limit)||(input.cursor&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.cursor)))fail('INVALID_CURSOR','Некорректный курсор пересчёта');
  const p=await program(db,input.programVersionId);
  const rows=await query<{user_id:string}>('SELECT user_id FROM loyalty_accounts WHERE ($1::uuid IS NULL OR user_id>$1::uuid) ORDER BY user_id LIMIT $2',[input.cursor??null,limit+1]);
  let changed=0;
  for(const {user_id} of rows.slice(0,limit))await transaction(async tx=>{
    await tx.query("SET LOCAL lock_timeout='2s'");
    await lockAccounts(tx,[user_id]);await expire(tx,user_id,p);
    const before=await snapshot(tx,user_id);await tierUpdate(tx,user_id,p,system,'Новая версия программы');const after=await snapshot(tx,user_id);
    if(before.tier!==after.tier||before.calculated_tier!==after.calculated_tier){await finish(tx,user_id,system,'recalculate_tier','Новая версия программы',`${p.id}:${user_id}`,before);changed++;}
  });
  const processed=Math.min(rows.length,limit),done=rows.length<=limit;
  return {processed,changed,nextCursor:done?null:rows[processed-1].user_id,done};
}
export async function reconcileAccounts(){
  const mismatches=await query<{userId:string;expected:string;actual:string}>(`SELECT a.user_id AS "userId",coalesce(t.balance,0)::text AS expected,(a.bonus_available-a.bonus_debt)::text AS actual FROM loyalty_accounts a LEFT JOIN (SELECT user_id,sum(amount) AS balance FROM bonus_transactions GROUP BY user_id)t ON t.user_id=a.user_id LEFT JOIN (SELECT user_id,sum(remaining_amount) AS remaining FROM bonus_lots GROUP BY user_id)l ON l.user_id=a.user_id WHERE coalesce(t.balance,0)<>a.bonus_available-a.bonus_debt OR coalesce(l.remaining,0)<>a.bonus_available`);
  mismatches.push(...await query<{userId:string;expected:string;actual:string}>(`SELECT l.user_id AS "userId",(l.issued_amount-coalesce(a.used,0))::text AS expected,l.remaining_amount::text AS actual FROM bonus_lots l LEFT JOIN (SELECT lot_id,sum(CASE WHEN kind='restore' THEN -amount ELSE amount END) AS used FROM bonus_allocations GROUP BY lot_id)a ON a.lot_id=l.id WHERE l.issued_amount-coalesce(a.used,0)<>l.remaining_amount`));
  mismatches.push(...await query<{userId:string;expected:string;actual:string}>(`SELECT a.user_id AS "userId",coalesce(r.total,0)::text AS expected,a.total_rental_amount::text AS actual FROM loyalty_accounts a LEFT JOIN (SELECT user_id,sum(current_amount_kopecks) AS total FROM rentals WHERE is_qualified GROUP BY user_id)r ON r.user_id=a.user_id WHERE coalesce(r.total,0)<>a.total_rental_amount`));
  for(const m of mismatches)await query("INSERT INTO operational_errors(kind,entity_id,details) SELECT 'ledger_reconciliation',$1,$2 WHERE NOT EXISTS(SELECT 1 FROM operational_errors WHERE kind='ledger_reconciliation' AND entity_id=$1 AND resolved_at IS NULL)",[m.userId,JSON.stringify(m)]);return mismatches;
}
export async function getHistory(userId:string,kind:'rentals'|'bonus',limit=50,cursor?:string){
  const size=Math.max(1,Math.min(limit,100)),table=kind==='rentals'?'rentals':'bonus_transactions';let values:unknown[]=[userId,size+1],condition='';
  if(cursor){let parsed:{at:string;id:string};try{parsed=JSON.parse(Buffer.from(cursor,'base64url').toString());if(typeof parsed.at!=='string'||!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?Z$/.test(parsed.at)||parsed.at.startsWith('0000')||!Number.isFinite(Date.parse(parsed.at))||new Date(parsed.at).toISOString().slice(0,10)!==parsed.at.slice(0,10)||typeof parsed.id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(parsed.id))throw new Error();}catch{fail('INVALID_CURSOR','Некорректный курсор');}condition=' AND (t.created_at,t.id)<($3::timestamptz,$4::uuid)';values=[...values,parsed.at,parsed.id];}
  // PostgreSQL retains microseconds; converting the cursor through JS Date skips rows within the same millisecond.
  const rows=await query<Record<string,unknown>>(`SELECT t.*,to_char(t.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS pagination_at ${kind==='bonus'?',l.remaining_amount,l.expires_at':",to_char(t.start_date,'YYYY-MM-DD') start_date,to_char(t.end_date,'YYYY-MM-DD') end_date"} FROM ${table} t ${kind==='bonus'?'LEFT JOIN bonus_lots l ON l.credit_transaction_id=t.id':''} WHERE t.user_id=$1${condition} ORDER BY t.created_at DESC,t.id DESC LIMIT $2`,values);
  const more=rows.length>size,page=rows.slice(0,size),last=page.at(-1),items=page.map(row=>{const item={...row};delete item.pagination_at;return item;});
  return {items,nextCursor:more&&last?Buffer.from(JSON.stringify({at:last.pagination_at,id:last.id})).toString('base64url'):null};
}
