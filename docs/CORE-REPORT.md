# Core handoff — 2026-09-11

Implemented transactional PostgreSQL loyalty services, exact bigint calculations, new-tier cashback, paid qualification, historical import, idempotency, FEFO lots, expiry, reversal debt, adjustments, cumulative redemption limits, referral holds/reversals, immutable program versions, audit/outbox and consistent account snapshots. Contract and exact shared column names: `docs/CORE-CONTRACT.md`; migration SQL is authoritative.

Owned files: `src/lib/db/index.ts`, `src/lib/loyalty/{index,rules,types}.ts`, `db/migrations/{001_core,002_ledger_guards}.sql`, `scripts/{migrate,seed}.ts`, `tests/loyalty{,.integration}.test.ts`, and the two `docs/CORE-*.md` files. No commits, deployments, external sends, or changes to root/UI modules.

## Actual verification

PowerShell, workspace root:

```powershell
& node_modules/.bin/tsx.cmd --env-file=.env.local scripts/migrate.ts
$env:DATABASE_URL='postgresql://rpm@127.0.0.1:55432/rpm_club_test'
& node_modules/.bin/tsx.cmd scripts/migrate.ts
& node_modules/.bin/vitest.cmd run tests/loyalty.test.ts tests/loyalty.integration.test.ts
```

Both migrations applied to `rpm_club` and `rpm_club_test`. Final core test run: **30 passed (11 pure + 19 real PostgreSQL), 2 files passed, 20.08 seconds**. No mock database substitutes. Coverage includes duplicate/concurrent rentals, concurrent overspending and cross-client redemption ownership, exact rounding, historical adjustments, expiry before cron, late expired credits with debt, expiration compensation, original-rate corrections, no downgrade, referral holds/retries/spent-reward reversals, immutable publication, and rollback on audit failure. Reconciliation also verifies lot allocations and qualifying rental totals.

In a separate process without the test URL override:

```powershell
& node_modules/.bin/tsx.cmd --env-file=.env.local scripts/seed.ts
& node_modules/.bin/tsc.cmd --noEmit
& node_modules/.bin/eslint.cmd src/lib/db src/lib/loyalty scripts/migrate.ts scripts/seed.ts tests/loyalty.test.ts tests/loyalty.integration.test.ts
```

Repeated seed, full workspace typecheck and targeted ESLint completed with exit code 0. SQL readback verified Roman (`rpm_82KPX9`): **BLACK, 42,850,000 kopecks, 8,420 available Bonus, zero debt, one historical rental**. Four synthetic members and one Taycan Drop seeded; no real contacts. Roman/Anna synthetic Telegram IDs are `900000001` / `900000004`.

## Integration notes and remaining verification

- Core writes outbox events; worker owns delivery expansion, provider calls and recurring expiry/reconciliation/referral retry/tier recalculation. Those provider flows are outside this report's verification.
- For onboarding, call `bindReferralInTransaction(tx,{userId,code},actor)` before setting `member_since`, retaining the same transaction as consent and activation. Account locks must remain in stable order.
- Read services require caller-side authentication and ownership checks. RLS denies direct anon/authenticated access; the server connection must own the tables or have BYPASSRLS. Supabase Auth membership references are logical in vanilla PostgreSQL and require deployment-specific verification.
- Tests modify only the dedicated test database and intentionally skip without an `rpm_club_test` URL. They do not establish production load, backup/restore, real Telegram delivery, or device acceptance.
- Program start, economic decisions D01–D09/D12, legal content and production credentials still require the launch process. Seed/legal documents explicitly remain synthetic/development content.

## Review fixes — final core handoff

Root authorized corrections for all four findings in `CORE-REVIEW.md` and bounded publication maintenance. Implemented:

1. First qualification uses the adjusted current rental amount; unpaid → adjust → paid → cancel reconciles at every step.
2. `integration:rpm` may create/adjust/cancel only `source='rpm'`; manual Bonus and settings permissions remain closed.
3. Today operational defaults to real confirmation time; historical/past defaults retain Moscow end-of-day. Duplicate hashes remain stable when qualifiedAt was omitted.
4. PostgreSQL wall-clock time is captured after account-lock waits and refreshed before spending. Two-connection regressions cover both debit and snapshot waiting past expiry.
5. Tier recalculation pages at most 100 accounts (default 50). Publication maintenance persists its cursor, serializes workers, and completes the outbox event only after the final page. Achieved tiers never decrease.

Additional owned files for this authorized follow-up: `tests/loyalty.review.test.ts` and only the publication-maintenance portion of `src/lib/jobs/index.ts`. No provider-delivery edits and no migration004 needed. Root owns migration003.

Actual final commands:

```powershell
$env:DATABASE_URL='postgresql://rpm@127.0.0.1:55432/rpm_club_test'
& node_modules/.bin/vitest.cmd run --no-file-parallelism tests/loyalty.test.ts tests/loyalty.integration.test.ts tests/loyalty.review.test.ts
& node_modules/.bin/eslint.cmd src/lib/db src/lib/loyalty src/lib/jobs/index.ts tests/loyalty.test.ts tests/loyalty.integration.test.ts tests/loyalty.review.test.ts
& node_modules/.bin/tsc.cmd --noEmit
```

**Tests: 38/38 passed, three files, 108.03 seconds. Scoped ESLint: passed.** The latest workspace typecheck reports only an unrelated existing root-test assignment at `tests/app.integration.test.ts:160` (`Promise<Response|null>` assigned to `Promise<Response>`); root was notified and that file was not modified. No development or production database writes were performed in this correction round.

Root subsequently reported fixing that test type error and began the full serial integration suite, including migration003. Core performed no further database tests in parallel.
