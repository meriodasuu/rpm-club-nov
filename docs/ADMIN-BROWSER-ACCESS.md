# Administrator entry and browser access

Обновление 16 сентября 2026: пользовательский сценарий заменён входом по ссылке от бота с обязательным кодом Google Authenticator. См. [актуальную инструкцию](ADMIN-BOT-LOGIN.md). Ниже сохранено описание прежнего переноса сессии для совместимости.

Implemented 2026-09-14.

- The Telegram menu label is `RPM Club`, for both the default menu and the owner's explicit chat override.
- Staff see a full-width `Админ-панель` button at the top of Home and Profile. It reuses an authenticated staff session; otherwise it opens the existing Telegram + MFA sign-in.
- The admin toolbar offers `Открыть в браузере`. Its dialog prepares a single-use link, then offers an external-browser button and a copy action for a computer. Opening the dialog first ensures the final browser launch is directly triggered by a user click.
- The external browser receives the exact current staff cookie, backed by the same `staff_sessions` row. There is no new staff session, repeated MFA challenge or expiry extension. Logging out in either context revokes access in both.
- A phone cannot directly launch an application on another computer. The copy action lets the administrator open the link on that computer within two minutes.

## Handoff boundary

`POST /api/auth/staff/browser-link` requires a valid staff session, same-origin request and rate limit. It issues a random 256-bit code. Only its hash is stored alongside an AES-256-GCM encrypted session token. The encryption key is derived from the random code using HKDF-SHA256 with a separate context; the source session ID is authenticated as AAD.

The code is in the URL fragment, excluded from HTTP access logs. `/admin/browser` is a standalone document without Telegram SDK, analytics or third-party scripts; it clears the fragment before exchanging the code via a same-origin POST. CSP disallows arbitrary scripts, frames and external connections. Referrer-Policy is explicitly `no-referrer`, including the Next.js header configuration.

Redemption locks and rechecks the original staff session and membership, verifies expiry/revocation/user blocking, and atomically deletes the one-time record. A concurrent second redemption fails. Cookie lifetime is capped to the source session's remaining lifetime. Invalid links never set a session cookie. Successful handoff is audited without credentials. Expired handoff records are pruned when another link is generated.

## Verification

- 98 tests passed, including concurrent redemption, unchanged session count and expiry, shared logout, revoked/expired sessions, disabled staff, blocked users and foreign-origin rejection.
- TypeScript, ESLint and optimized Next.js build passed.
- Browser plugin not available; used regular Playwright with installed Edge in headless mode. Tested a 390 × 844 profile and a separate 1440 × 1000 browser context. The prominent entry, existing-session navigation, cross-browser cookie reuse, replay failure, CSP/referrer headers and absence of page errors were checked. Local screenshots are in ignored `.local/qa/`.
- Cloud migration `20260914130334_staff_browser_handoffs.sql` applied. RLS enabled, anonymous/authenticated clients have no access, backend role has required privileges. Supabase security advisor returned no findings.
- The operating-system handoff from a real Telegram client remains a user-device check; local browser tests cover the receiving browser and session exchange.
