import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { validateTelegramInitData, normalizePhone } from '../src/lib/auth/telegram';
const token = '123456:test-token';
function signed(age = 0) {
  const q = new URLSearchParams({auth_date: String(1800000000-age), user: JSON.stringify({id:12345,first_name:'Роман'}), query_id:'test'});
  const data=[...q.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');
  const secret=createHmac('sha256','WebAppData').update(token).digest();
  q.set('hash',createHmac('sha256',secret).update(data).digest('hex')); return q.toString();
}
describe('Telegram identity boundary',()=>{
  it('accepts fresh signed identity',()=>expect(validateTelegramInitData(signed(),token,1800000000).id).toBe(12345));
  it('rejects tampering',()=>expect(()=>validateTelegramInitData(signed().replace('12345','54321'),token,1800000000)).toThrow());
  it('rejects expired and future credentials',()=>{expect(()=>validateTelegramInitData(signed(301),token,1800000000)).toThrow();expect(()=>validateTelegramInitData(signed(-31),token,1800000000)).toThrow();});
  it('rejects duplicate parameters',()=>expect(()=>validateTelegramInitData(signed()+'&user=x',token,1800000000)).toThrow());
  it('normalizes phone without ambiguity',()=>{expect(normalizePhone('8 (999) 123-45-67')).toBe('+79991234567');expect(normalizePhone('+44 7700 900123')).toBe('+447700900123');expect(()=>normalizePhone('9991234567')).toThrow();});
});
