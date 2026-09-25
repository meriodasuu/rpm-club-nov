import { randomBytes } from "node:crypto";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Standalone document: no third-party SDK can read the link credential.
export function GET() {
  const nonce = randomBytes(24).toString("base64");
  return new Response(
    `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>RPM Club · Вход в админ-панель</title>
<style nonce="${nonce}">*{box-sizing:border-box}body{margin:0;background:#080808;color:#fff;font:16px system-ui;display:grid;place-items:center;min-height:100dvh;padding:24px}main{width:100%;max-width:440px;padding:30px;border:1px solid #333;border-radius:20px;background:#121212}h1{font-size:28px;margin:8px 0 20px}p{color:#bbb;line-height:1.6}label{display:block;margin:24px 0 10px}input{width:100%;font:16px system-ui;letter-spacing:normal;padding:14px;border-radius:10px;border:1px solid #555;background:#080808;color:white;text-align:left}button{width:100%;margin-top:18px;padding:16px;font:600 16px system-ui;border:0;border-radius:10px;background:#e4262f;color:#fff;cursor:pointer}button:disabled{opacity:.5}a{color:#fff}.brand{font-weight:800;letter-spacing:2px}#error{color:#ff9a9f;min-height:24px}</style></head>
<body><main><div class="brand">RPM CLUB</div><h1>Почта и пароль</h1><p id="status" role="status">Проверяем ссылку…</p><form id="login" hidden><label for="email">Почта для входа</label><input id="email" name="email" type="email" autocomplete="username" maxlength="254" required><label for="password">Новый пароль</label><input id="password" name="password" type="password" autocomplete="new-password" minlength="15" maxlength="128" required><p>Минимум 15 символов. Можно использовать несколько слов.</p><label for="repeat">Повторите пароль</label><input id="repeat" type="password" autocomplete="new-password" minlength="15" maxlength="128" required><button id="submit" type="submit">Сохранить и войти</button></form><p id="error" role="alert"></p><p>Нужна новая ссылка? Отправьте <b>/admin</b> <a href="https://t.me/rpmclub_bot" rel="noreferrer">боту RPM Club</a>.</p><p><a href="/admin/login">Уже есть пароль — войти</a></p><noscript>Для входа включите JavaScript.</noscript></main>
<script nonce="${nonce}">
const code=location.hash.slice(1);history.replaceState(null,'','/admin/access');
const status=document.getElementById('status'),form=document.getElementById('login'),error=document.getElementById('error'),submit=document.getElementById('submit'),email=document.getElementById('email'),password=document.getElementById('password'),repeat=document.getElementById('repeat');
async function check(credentials){const response=await fetch('/api/auth/staff/bot-redeem',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({code,credentials})});const result=await response.json();if(!response.ok)throw new Error(result.message||'Не удалось сохранить пароль.');return result;}
(async()=>{try{if(!/^[A-Za-z0-9_-]{43}$/.test(code))throw new Error('Откройте ссылку из личного сообщения бота.');await check();status.textContent='Задайте почту и пароль для входа. После сохранения прежние сеансы завершатся.';form.hidden=false;email.focus();}catch(e){status.textContent='Ссылка недоступна.';error.textContent=e.message;}})();
form.addEventListener('submit',async event=>{event.preventDefault();if(submit.disabled)return;error.textContent='';if(password.value!==repeat.value){error.textContent='Пароли не совпадают.';return;}submit.disabled=true;try{const result=await check({email:email.value,password:password.value});if(result.authenticated)location.replace('/admin/dashboard');}catch(e){error.textContent=e.message;}finally{submit.disabled=false;}});
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
