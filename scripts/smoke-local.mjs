import assert from 'node:assert/strict';
const base=process.argv[2]??'http://127.0.0.1:3001';
if(!['localhost','127.0.0.1'].includes(new URL(base).hostname))throw new Error('Smoke uses local preview only');
async function get(path,cookie=''){return fetch(base+'/api/'+path,{headers:{cookie},signal:AbortSignal.timeout(45000)});}
async function post(path,data,cookie=''){return fetch(base+'/api/'+path,{method:'POST',headers:{origin:base,cookie,'content-type':'application/json','idempotency-key':crypto.randomUUID()},body:JSON.stringify(data),signal:AbortSignal.timeout(45000)});}
async function login(mode){const r=await post('auth/local',{mode});assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0];}
assert.equal((await get('health')).status,200);assert.equal((await get('ready')).status,200);assert.equal((await get('me')).status,401);
const cookie=await login('client');const me=await (await get('me',cookie)).json();assert.equal(me.user.public_member_id,'rpm_82KPX9');assert.match(me.bonus_available,/^\d+$/);assert.equal((await get('me/qr',cookie)).status,200);
const history=await (await get('me/transactions',cookie)).json();assert.ok(history.items.length);console.log('Client snapshot / QR / history:',{tier:me.tier,bonus:me.bonus_available,total:me.total_rental_amount,lots:history.items.filter(r=>r.expires_at).length});
const viewer=await login('viewer');assert.equal((await post('admin/bonus/credit',{userId:me.user.id,amount:'1',reason:'Must be rejected'},viewer)).status,403);
const admin=await login('admin');for(const path of ['admin/dashboard','admin/customers','admin/rentals?status=completed','admin/transactions?type=manual_credit','admin/settings','admin/imports','admin/offers','admin/referrals','admin/audit','admin/team','admin/deliveries'])assert.equal((await get(path,admin)).status,200,path);
assert.equal((await post('auth/logout',{},cookie)).status,200);assert.equal((await get('me',cookie)).status,401);
console.log('Local HTTP smoke passed; no external sends and no financial changes.');
