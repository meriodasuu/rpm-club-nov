import { randomBytes } from "node:crypto";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Standalone document: no third-party SDK can read the link credential.
export function GET() {
  const nonce = randomBytes(24).toString("base64");
  return new Response(
    `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>RPM Club · Вход в админ-панель</title>
<style nonce="${nonce}">*{box-sizing:border-box}body{margin:0;background:#080808;color:#fff;font:16px system-ui;display:grid;place-items:center;min-height:100dvh;padding:24px}main{width:100%;max-width:440px;padding:30px;border:1px solid #333;border-radius:20px;background:#121212}h1{font-size:28px;margin:8px 0 20px}p{color:#bbb;line-height:1.6}label{display:block;margin:24px 0 10px}input{width:100%;font:30px system-ui;letter-spacing:8px;padding:14px;border-radius:10px;border:1px solid #555;background:#080808;color:white;text-align:center}button{width:100%;margin-top:18px;padding:16px;font:600 16px system-ui;border:0;border-radius:10px;background:#e4262f;color:#fff;cursor:pointer}button:disabled{opacity:.5}a{color:#fff}.brand{font-weight:800;letter-spacing:2px}#manual{font-size:14px;letter-spacing:1px;text-align:left}#qr{max-width:100%;height:auto}#error{color:#ff9a9f;min-height:24px}</style></head>
<body><main><div class="brand">RPM CLUB</div><h1>Вход в админ-панель</h1><p id="status" role="status">Проверяем ссылку…</p><section id="enrollment" hidden><p>В Google Authenticator нажмите «+» и отсканируйте QR-код.</p><img id="qr" width="220" height="220" alt="QR для Google Authenticator"><label for="manual">Ключ для ручного ввода</label><input id="manual" readonly><p>При ручном вводе выберите тип кода «По времени». Сохраните запись RPM Club — она понадобится для следующих входов.</p></section><form id="login" hidden><label for="otp">Код Google Authenticator</label><input id="otp" name="otp" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" placeholder="000000" required><button id="submit" type="submit">Войти</button></form><p id="error" role="alert"></p><p>Нужна новая ссылка? Отправьте <b>/admin</b> <a href="https://t.me/rpmclub_bot" rel="noreferrer">боту RPM Club</a>.</p><noscript>Для входа включите JavaScript.</noscript></main>
<script nonce="${nonce}">
const code=location.hash.slice(1);history.replaceState(null,'','/admin/access');
const status=document.getElementById('status'),form=document.getElementById('login'),error=document.getElementById('error'),submit=document.getElementById('submit'),otp=document.getElementById('otp');
async function check(value){const response=await fetch('/api/auth/staff/bot-redeem',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({code,otp:value})});const result=await response.json();if(!response.ok)throw new Error(result.message||'Не удалось войти.');return result;}
(async()=>{try{if(!/^[A-Za-z0-9_-]{43}$/.test(code))throw new Error('Откройте ссылку из личного сообщения бота.');const result=await check();if(result.enrollment){status.textContent='Первый вход: привяжите Google Authenticator и подтвердите настройку 6-значным кодом.';document.getElementById('enrollment').hidden=false;document.getElementById('qr').src=result.enrollment.qrCode;const manual=document.getElementById('manual');manual.value=result.enrollment.manualKey;manual.addEventListener('focus',()=>manual.select());submit.textContent='Подтвердить и войти';}else{status.textContent='Введите 6-значный код для RPM Club из Google Authenticator.';}form.hidden=false;if(!result.enrollment)otp.focus();}catch(e){status.textContent='Вход по ссылке недоступен.';error.textContent=e.message;}})();
form.addEventListener('submit',async event=>{event.preventDefault();submit.disabled=true;error.textContent='';try{const result=await check(otp.value);if(result.authenticated)location.replace('/admin/dashboard');}catch(e){error.textContent=e.message;otp.value='';otp.focus();}finally{submit.disabled=false;}});
</script></body></html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        "X-Frame-Options": "DENY",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
