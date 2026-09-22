# Vercel deployment

Target: `rpm-club-demo` in `meriodasuus-projects`. Publish a Preview deployment first.

## Prepared on 2026-09-13

- Restored Supabase project `RPM-RENT` (`yzxzkhrjnkotfnywnfxb`).
- Applied migrations 001–006, `20260914130334_staff_browser_handoffs.sql`, `20260914132008_staff_management_permission.sql` and `20260916074532_staff_bot_login_links.sql`.
- Created the dedicated `rpm_club_app` database login. RLS is enabled on all 51 application tables after the September 16 login-link migration; only the backend role has application policies.
- Copied three test legal documents, without users, sessions, or notification deliveries.
- Verified the transaction pooler at `aws-1-eu-west-1.pooler.supabase.com:6543`, including TLS certificate validation.
- Stored deployment values in ignored `.env.vercel`. Never commit this file or `.local/vercel-db.json`.
- Supabase security advisor returned no findings after fixing function search paths and extension placement.

The CA is obtained from Supabase's Studio configuration: `https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt`. Its base64 representation is `DATABASE_SSL_CA_BASE64`; certificate and hostname validation remain enabled.

## Published Preview — 2026-09-22

- Current URL: https://rpm-club-demo-mxfygis2t-meriodasuus-projects.vercel.app/onboarding
- Deployment: `dpl_5DFKiC8ejDrG4a3pCcrwSKE6hEdP`, READY. Implementation commit `5b0a3dd` on `codex/rpm-club`; direct CLI deployment, no Git remote is configured.
- Includes the admin UX/referral package and 14 applicable lifecycle scenarios, booking drafts, shared daily limits and six-tier discount-program preparation. CARD_01/PAY_01/PAY_02 explicitly unavailable: card issued on registration, payment on site.
- Applied `20260922120313_manual_referral_awards.sql` and `20260922144120_lifecycle_notifications.sql`, recording their exact local SHA-256 in schema_migrations. All 61 application tables have RLS; Supabase Security Advisor returned no findings.
- 169 tests / 27 files passed, TypeScript, ESLint and both local/Vercel builds passed. Local browser checks and limitations: ADMIN-UX-RELEASE.md.
- Telegram webhook, default menu and owner chat menu read back with the new origin; pending updates 0. Vault `rpm_club_worker_origin` updated to this deployment. No test messages sent to real customers.
- Business activation remains separate: customer publishes discount thresholds/rates/benefits and referral terms, then enables chosen lifecycle rules. Existing working program remains v1 with five cashback tiers until that publication.

## Previous previews

- Latest URL: https://rpm-club-demo-60tjc4mpc-meriodasuus-projects.vercel.app/onboarding
- Latest deployment: `dpl_AHs74hTAZBtnYMMBSydxaDBbpjPk`, `READY` (2026-09-20). Exact Moscow pickup times, a two-hour rental reminder, completion notifications independent of payment, and publication announcements. Applied `20260920164023_notification_timing.sql`; registry checksum matches the local migration. Weather city is Saint Petersburg; provider key and timing remain pending.
- Checks for this deployment: 143 tests in 23 files; seven timing tests repeated after the calendar-date regression fix; TypeScript, ESLint, Vercel build, and four real-API browser scenarios passed. Browser plugin not available; used local Playwright/Edge at 1440×1000 and 390×844. No page or console errors in the final run. Artifacts: `C:/Users/wthtw/AppData/Local/Temp/rpm-notification-qa/`.
- Bot menu/webhook readback matched the new origin. Four approved rules were enabled at 17:08:14 UTC; the next cron response at 17:09 UTC was HTTP 200, heartbeat 17:09:02 UTC, zero old trigger events queued. Weather remains disabled.
- Previous URL: https://rpm-club-demo-jxw65j6l8-meriodasuus-projects.vercel.app/onboarding
- Previous deployment: `dpl_AEb4D59XWVvai1CdeaV3555ezyPK`, status `READY` (2026-09-20). The member card is available inside Mini App; retired external issuance routes, UI, provider adapters and dependencies have been removed. Existing queued deliveries for retired channels are suppressed without external calls. Default and owner chat menus and webhook read back with this origin; pending Telegram updates: 0. The scheduler origin in Vault was updated. Browser MFA and `/admin` access rules are unchanged.
- Applied `20260920105641_club_experience.sql`, `20260920111756_club_wiki_starter.sql` and `20260920114306_club_job_extensions.sql` to the cloud database. All 54 application tables have RLS. Supabase security advisor returned no findings. The live program remains version 1 with five cashback tiers; all five new notification rules were disabled at that earlier release.
- Checks at the earlier release: 110 tests in 17 files, TypeScript, ESLint and the Vercel production build passed. Tests for removed providers were retired; delivery tests now verify that historical channels never send and Telegram still works. Browser checks covered mobile card swiping and profile QR, administrator customer details and delivery diagnostics, omitted API fields, and HTTP 404 for removed routes. No real customer messages were sent by these checks. The customer Word report was updated and visually checked after rendering with Microsoft Word.
- Supabase cron job `rpm-club-dispatch` calls the protected worker every minute. The first observed successful run returned HTTP 200 at 2026-09-20 11:51 UTC, with zero queued sends, retries or failures; the maintenance heartbeat updated.
- After switching to the latest origin, the 14:00 UTC run also succeeded with HTTP 200 and an updated heartbeat; zero sends, retries or failures.

- Previous deployment: https://rpm-club-demo-4vqbantj7-meriodasuus-projects.vercel.app/onboarding — `dpl_Cnvxyv2v3gyNXdSzDkdsaHCoYpYi`, `READY` (2026-09-20). Cards, rental requests, fleet, routes, Wiki, discount-program settings and automatic notification rules; 122 tests passed at that release.
- September 16 deployment: https://rpm-club-demo-np34810ng-meriodasuus-projects.vercel.app/onboarding — `dpl_6q88GchwdZXcmkEp6NX8tSRjuZJF`, `READY`. First browser Google Authenticator enrollment; Mini App entry and old routes disabled.

- Previous verified URL: https://rpm-club-demo-ds9195f8u-meriodasuus-projects.vercel.app/onboarding
- Previous deployment: `dpl_AtQJb5k6s4XDmAVzEToK8UbbJSbJ`, Vercel status `READY` (2026-09-14). See the latest deployment record below for the bot-link login release.
- Bot: https://t.me/rpmclub_bot — webhook and `RPM Club` menu button point to this deployment and were verified via Telegram API.
- The user confirmed that the Mini App opens inside Telegram.
- Cloud database verification recorded two Telegram updates, one registered user, one successful notification delivery, and no failed deliveries.
- The September 16 release passed 107 tests, including first browser MFA enrollment, denial to ordinary users, rejection of retired Mini App routes and owner-managed staff access. Browser QA verified link → first Google Authenticator setup → dashboard, existing-factor login and absence of the Mini App entry. These tests remain in the latest passing suite. See [Bot-link login](ADMIN-BOT-LOGIN.md).

The owner's existing Telegram membership has `can_manage_staff=true`; other memberships default to false. Staff management now supports looking up registered users by phone, assigning administrators and revoking their access. Both the new Telegram and legacy email grant endpoints enforce this capability. See [Staff management](STAFF-MANAGEMENT.md).

## Future deployments

1. Vercel CLI is authorized and this workspace is linked to the existing project.
2. Set Preview environment variables from `.env.vercel`. Keep `LOCAL_PREVIEW=0`. Leave `APP_URL` unset for the deployment hostname provided by `VERCEL_URL`, or set the final stable origin explicitly.
3. Deploy, inspect the build result, and test Telegram authorization against the cloud instance.
4. Verify the existing webhook belongs to the previous RPM deployment, then update the webhook and menu to the new deployment without dropping pending updates. Save the new origin in `.env.vercel`'s `APP_URL` and run `scripts/telegram-setup.ts --check` with that environment. The generic setup script deliberately refuses to replace a different existing webhook.
5. Update the Supabase Vault secret `rpm_club_worker_origin` to the new HTTPS origin without a trailing slash. Keep `rpm_club_worker_secret` synchronized with the deployment's `CRON_SECRET`. Verify a subsequent cron run, the HTTP response status and the `jobs:last-run` heartbeat. Never print secret values or store them in migrations.

Successful API writes on Vercel trigger a bounded notification worker after the response. Supabase cron now also calls `/api/internal/jobs` every minute with `Authorization: Bearer <CRON_SECRET>` for idle-time retries, queued imports, expiry and maintenance. The token and deployment origin are stored in Vault. The repeatable scheduling template is `supabase/operations/club-scheduler.sql`; it requires provisioned Vault secrets. The local five-second test worker is separate from this cloud scheduler. Weather notifications additionally require `OPEN_METEO_API_KEY` and an administrator-configured city.

The public deployment does not enable the localhost-only demo login. The owner explicitly assigns Telegram memberships. Administrators send `/admin` in the private bot chat to receive a ten-minute single-use link. Google Authenticator enrollment now occurs on the first browser visit; existing verified factors are preserved. Mini App entry and its old authentication/link routes are disabled (410). Users without active admin rights receive «Данная команда недоступна.». A fresh TOTP code creates a one-hour staff session. Role and member status are rechecked at redemption and on protected requests. See [Bot-link login](ADMIN-BOT-LOGIN.md).

The Main Mini App profile launch button is not enabled in BotFather; the configured chat menu button opens the application.

## Telegram menu refresh

On 2026-09-13, Vercel request logs confirmed that the owner's Telegram client still opened the previous `6taf7qmci` deployment after the default menu was changed. An explicit chat menu for Telegram ID `1017878611` refreshed it. On 2026-09-14 the label was restored to `RPM Club` at the user's request. Future deployment rotations must update this chat override as well as the default menu and webhook, or move both to a stable application origin. Existing message buttons retain their original deployment URLs.
