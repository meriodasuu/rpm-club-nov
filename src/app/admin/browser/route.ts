import { randomBytes } from "node:crypto";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A standalone document deliberately has no SDKs, analytics or other scripts
// that could read the one-time credential from the URL fragment.
export function GET() {
  const nonce = randomBytes(24).toString("base64");
  return new Response(
    `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>RPM Club · Открытие админ-панели</title>
<style nonce="${nonce}">body{margin:0;background:#080808;color:#fff;font:17px system-ui;display:grid;place-items:center;min-height:100vh}main{max-width:480px;padding:28px}h1{font-size:28px}p{color:#bbb;line-height:1.6}a{color:#fff}</style></head>
<body><main><h1>RPM Club</h1><p id="status" role="status">Открываем админ-панель…</p><a href="https://t.me/rpmclub_bot">Вернуться в Telegram</a><noscript>Для открытия админ-панели включите JavaScript в браузере.</noscript></main>
<script nonce="${nonce}">
const code=location.hash.slice(1);history.replaceState(null,'','/admin/browser');
(async()=>{try{
if(!/^[A-Za-z0-9_-]{43}$/.test(code))throw new Error('Откройте админ-панель через кнопку «Открыть в браузере» в Telegram.');
const response=await fetch('/api/auth/staff/browser-redeem',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})});
const result=await response.json();if(!response.ok)throw new Error(result.message||'Не удалось открыть админ-панель.');
location.replace('/admin/dashboard');
}catch(error){document.getElementById('status').textContent=error.message||'Не удалось открыть админ-панель. Получите новую ссылку в Telegram.';}})();
</script></body></html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        "X-Frame-Options": "DENY",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
