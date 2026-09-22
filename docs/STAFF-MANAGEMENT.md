# Staff management

Implemented 2026-09-14.

Only members with an active Telegram-linked admin membership receive `staff_access: true` in `/api/me`. Since September 16 the Mini App no longer renders any administrator entry. Staff request browser login using `/admin` in the private bot chat. Disabling a membership removes its capability, revokes sessions and deletes outstanding login links; protected APIs independently check permissions on every request.

The verified owner `@wthtwn` (Telegram ID `1017878611`, confirmed phone ending in `1842`) has the separate database capability `can_manage_staff`. It was explicitly assigned to the existing membership, with an audit record. It is never granted automatically from a phone number, username or request payload. Ordinary admins cannot delegate access through either the Telegram management API or the legacy email management API.

## Owner workflow

1. Click the prominent `Добавить админа` shortcut in the admin toolbar (shown only to staff with management authority). It opens Сотрудники and scrolls directly to the add-administrator form.
2. Enter the new administrator's full phone number and click Найти пользователя. The person must first register in @rpmclub_bot, confirm their phone and have an active Telegram-linked account.
3. Check the displayed name/account and click Назначить администратором.
4. The new administrator sends `/admin` to the bot, opens their personal link in a browser, enrolls Google Authenticator on the first visit and confirms the six-digit code. They do not acquire staff-management authority. Users without an active admin grant receive «Данная команда недоступна.» without a link.
5. Отключить доступ revokes their active staff sessions. Reactivating access requires the owner; the owner's own capability cannot be changed through this form.

Phone lookup is exact and rate limited. Assignment uses the selected immutable user ID, rechecks eligibility and owner authority in a transaction, and audits changes. No synthetic users or grants to third parties were created in the cloud for testing.

## Verification

Current September 16 browser-only flow: 107 tests passed, including first-login MFA enrollment, preservation of existing factors, removal of the Mini App entry and server rejection of retired routes. See [current login workflow](ADMIN-BOT-LOGIN.md). The historical September 14 verification follows.

102 tests passed. New tests cover entry visibility before grant/after grant/after revoke, ordinary-admin and member denial, the legacy grant endpoint, owner protection, blocked/unknown targets, revoked management authority and preservation of the stored role when disabling a manager. The existing manager-to-admin MFA regression now uses an explicitly authorized owner fixture.

Browser QA in separate owner/member/admin contexts verified phone search, assignment, owner-only form visibility, and removal of the member's entry after revocation, with no page errors. Screenshots and the local QA script are in ignored `.local/qa/` and `.local/staff-management-qa.mjs`. TypeScript, ESLint and optimized build passed. Cloud migration and the owner capability were verified; the Supabase security advisor reported no findings.

The owner shortcut was also tested at 390 × 844: it is visible without scrolling, opens the correct form, and is absent for ordinary admins. This addresses the collapsed icon-only sidebar on narrow screens. The backend permission boundary is unchanged.
