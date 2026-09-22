# RPM Club Implementation Plan

> For agentic workers: use superpowers:subagent-driven-development for delegated isolated modules, with implementation and review in sequence. Do not commit or deploy. The root agent assembles the application and verifies the full flow.

**Goal:** Работающий full-stack RPM Club по `docs/SPECIFICATION.md`.
**Architecture:** Next.js modular monolith, direct transactional PostgreSQL, Telegram sessions, Supabase staff authentication, persistent outbox, provider adapters.
**Tech Stack:** TypeScript, React, Next.js, Tailwind, PostgreSQL/pg, Zod, Vitest, Playwright.
**Spec:** `docs/SPECIFICATION.md`.

## Global constraints

- Русский интерфейс; 5 стабильных tiers; cashback по новому tier; денежные расчёты точные, ledger append-only.
- 0/100000/300000/700000/1500000 ₽; 2/3/4/5/7%; redemption 20%; expiry 365 дней; referral 3000/2000.
- Исторический импорт без cashback; no downgrade; unique external rental; idempotency, audit, outbox в транзакции.
- Настоящие server-backed формы. Production не использует demo-auth и не имитирует внешние интеграции.
- Реальные внешние отправки/облачные изменения не выполняются этим этапом. Локальные синтетические данные разрешены.

## Task 1 — Основа и экономика

Files: `src/lib/db/*`, `src/lib/loyalty/*`, `supabase/migrations/*`, `scripts/migrate.ts`, `scripts/seed.ts`, `tests/loyalty.test.ts`, `tests/loyalty.integration.test.ts`.

- [x] Создать схему, constraints, индексы и миграционный runner.
- [x] Сначала проверить граничные tiers, 287000+35000=BLACK/+1400, paid, duplicate и гонки списаний тестами.
- [x] Реализовать `processRental`, `creditBonus`, `debitBonus`, `reverseTransaction`, `adjustRental`, `cancelRental`, `changeTier`, `publishProgram` и чтение snapshots.
- [x] Проверить expiry/FEFO, debt, referral, audit/outbox, исторический перенос, rollback.
- [x] Создать idempotent seed с синтетическими клиентами; выполнить интеграционные тесты на отдельной локальной БД.

DB interface: `query<T>(text: string, values?: unknown[]): Promise<T[]>`; `transaction<T>(work: (tx: Db) => Promise<T>): Promise<T>`; `Db` exposes query. Core commands accept `Actor {id:string, role:'admin'|'manager'|'integration'|'system'}` and string idempotency keys. Full exported signatures documented by implementer in `docs/CORE-CONTRACT.md` before handoff.

## Task 2 — Mini App и защищённый HTTP слой

Files: `src/app/(miniapp)/*`, `src/components/miniapp/*`, `src/lib/auth/*`, `src/lib/http.ts`, `src/app/api/*`, `tests/auth.test.ts`.

- [x] Telegram HMAC and freshness tests, contact webhook proof, cookies, server-side roles, rate limits and Origin checks.
- [x] Session endpoints and API schema; onboarding, home, tiers, history, profile/referral, offers, legal routes.
- [x] Design tokens and responsive layout from generated concept, values from the authoritative spec.
- [x] Local-only explicit preview login that creates real DB session; disabled in production.
- [x] Tests for invalid auth, role denial and cross-account access.

## Task 3 — Admin и импорт

Files: `src/app/admin/*`, `src/components/admin/*`, `src/lib/imports/*`, `src/lib/admin/*`, `tests/imports.test.ts`.

- [x] Dashboard/customers/rentals/ledger/referral/audit/settings/tiers/team screens and working forms.
- [x] CSV/XLSX parse, limits, preview without economic effects, per-row results, commit/resume.
- [x] Customer actions, exact redemption/corrections, immutable settings versions.
- [x] Drops editor/campaign preview, optional image upload, diagnostics.

## Task 4 — Background delivery

Files: `src/lib/jobs/*`, `scripts/jobs.ts`, `tests/jobs.integration.test.ts`.

- [x] Persistent leases, retries, independent channels, version-safe updates, Telegram delivery.
- [x] Expiration/reconciliation runner; health and configuration diagnostics.
- [x] Contract tests without real user sends; external credential/real-device checks clearly reported separately.

## Task 5 — Сборка и приёмка

Files: `README.md`, `docs/OPERATIONS.md`, `.env.example`, `.github/workflows/ci.yml`, `scripts/smoke-local.mjs`, `docs/ACCEPTANCE.md`.

- [x] Run `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`.
- [x] Real PostgreSQL concurrency tests and browser E2E: client → admin new rental → client balance/tier; import duplicates; role restrictions.
- [x] Inspect 320/390/430 mobile and desktop layouts; fix overflow, interactions and accessibility.
- [x] Review spec coverage and code. Record exact implemented/unverified criteria, setup and run commands.

## Execution record

- 2026-09-11: User authorized implementation of the specification. Created `codex/rpm-club` in the previously empty repository. Existing specification files retained.
- Local PostgreSQL will be used for development/integration checks; external credentials are not assumed present.
- Generated concept is visual guidance. Any erroneous thresholds or extra slogans generated in the image are overridden by the source specification.

- Local implementation and checks completed: 84/84 tests, typecheck, lint, build, HTTP smoke, browser rental flow. See docs/ACCEPTANCE.md for exact evidence and limits.
- [ ] Production acceptance: real Telegram/MFA on devices, representative CRM file, load and backup/restore, A40.
