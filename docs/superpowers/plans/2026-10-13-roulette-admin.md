# Roulette Admin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make roulette odds, attempt issuance, promo codes, and draw audit understandable and controllable in the admin UI.

**Architecture:** Keep the existing prize and award tables. Add a durable attempt-credit ledger and promo redemption ledger, move odds writes to a single settings endpoint, and snapshot the eligible pool and random ticket on each spin. Split roulette backend responsibilities into focused modules while keeping `rouletteRoute` as the HTTP entry point.

**Tech Stack:** Next.js 16.3.4, React 19, TypeScript, PostgreSQL, Zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-13-roulette-admin-design.md`

## Global Constraints

- Every successful spin awards one prize; no daily grants or rental grants in the new model.
- Sources: first completed registration after enabling, one attempt per promo redemption, manual admin grant.
- Existing spins, awards, and already granted daily attempts remain readable; daily attempts expire at the end of their Moscow day.
- `ROULETTE_ECONOMICS_APPROVED=1` remains required to open production roulette.
- Do not disturb unrelated uncommitted workspace changes.

## Review Focus

- Two simultaneous spins with one credit: one succeeds and one fails without overconsumption (Task 4).
- Two simultaneous promo redemptions at the global cap: only one succeeds (Task 3).
- Registration activated before enabling: no retroactive credit (Task 2).
- Prize removed or capped after odds configured: effective odds renormalize and an empty pool consumes nothing (Task 4).
- Replayed idempotency key after a successful spin returns the original award (Task 4).

---

### Task 1: Database and compatibility

**Files:** Create `db/migrations/20261013120000_roulette_admin.sql`; modify `src/lib/roulette/index.ts`; test `tests/roulette.integration.test.ts`.

**Interfaces:** Create `roulette_attempt_credits`, `roulette_promo_codes`, `roulette_promo_redemptions`; add `users.first_activated_at`, roulette settings grant/TTL fields, and spin audit columns. Preserve old daily-grant FK for old spins and add nullable new credit FK.

- [ ] Write migration and migration-backed test for constraints, old row compatibility, and first activation time.
- [ ] Run migration test against `rpm_club_test`; expect new and old rows to coexist.
- [ ] Update roulette types and reads; run `npm run typecheck`.

### Task 2: Registration and manual credits

**Files:** Create `src/lib/roulette/credits.ts`; modify `src/lib/jobs/index.ts` and `src/lib/roulette/index.ts`; test `tests/roulette.integration.test.ts`.

**Interfaces:** `reconcileRegistrationCredits(limit?: number): Promise<number>` and `issueManualCredit(input, actor): Promise<Credit>`; credit balance query ignores expired rows and orders by expiry.

- [ ] Test one credit for first activation after rule enable, none for earlier users or repeated activation.
- [ ] Implement idempotent reconciliation and wire it to the worker job loop.
- [ ] Test manual grant authorization, reason, idempotency, and audit; implement endpoint.
- [ ] Run roulette integration tests.

### Task 3: Promo codes

**Files:** Create `src/lib/roulette/promos.ts`; modify `src/lib/roulette/index.ts`; test `tests/roulette.integration.test.ts`.

**Interfaces:** Admin create/list/disable endpoints; client redeem endpoint. Code has >=128 bits of entropy, is displayed once, stored only as a hash. One use per user, global cap checked under row lock; one credit per successful redemption.

- [ ] Test valid, expired, disabled, repeated, and concurrent-cap redemptions.
- [ ] Implement promo code creation, normalized lookup, row-locked redemption and audit.
- [ ] Run roulette integration tests.

### Task 4: Odds and draw audit

**Files:** Create `src/lib/roulette/odds.ts`; modify `src/lib/roulette/index.ts`; test `tests/roulette.test.ts` and `tests/roulette.integration.test.ts`.

**Interfaces:** Admin odds GET/PATCH accepts all published prize shares as integer basis points totaling 10000; `effectiveOdds(prizes, tier)` returns normalized eligible shares. Spin stores eligible pool, random ticket, total weight and credit source atomically.

- [ ] Test sum/version validation and effective odds by tier and cap.
- [ ] Implement atomic odds save without allowing prize-card writes to change weights.
- [ ] Test concurrent spins, replay, empty pool, and matching saved ticket to winner.
- [ ] Implement credit consumption and spin audit snapshot; run integration tests.

### Task 5: Admin and member UI

**Files:** Modify `src/components/admin/roulette.tsx`, `src/components/miniapp/roulette.tsx`, and roulette CSS; test `tests/roulette-admin-render.test.tsx`.

**Interfaces:** Admin sections: state, odds, attempts, promos, prizes, verification. Member shows expiring attempts and promo redemption. Prize form omits weight and groups advanced fields.

- [ ] Write render tests for section labels, odds location, promo form, and missing/empty states.
- [ ] Implement admin forms with version conflicts, loading and error messages, and effective odds preview.
- [ ] Implement member promo form and credit summary; run tests and typecheck.

### Task 6: Verification and rollout

**Files:** Update `docs/ROULETTE.md`; inspect final diff.

- [ ] Run targeted Vitest, typecheck, lint, and build; fix failures caused by this change.
- [ ] Review data migration, permissions, idempotency, economics guard, and unrelated dirty files.
- [ ] Deploy only roulette-related files after backup; migrate and smoke test app and worker while keeping economic launch flag unchanged.
