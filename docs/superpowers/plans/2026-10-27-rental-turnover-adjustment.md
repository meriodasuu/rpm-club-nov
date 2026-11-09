# Rental Turnover Adjustment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Managers can add or subtract a customer's rental turnover and immediately recalculate the displayed tier.

**Architecture:** Store signed turnover adjustments in an append-only table and update the account atomically under the existing account lock. Expose it through a manager API endpoint and customer-card dialog. The mini-app consumes the existing account snapshot, so no client API contract changes are needed.

**Tech Stack:** Next.js 16 route handler, TypeScript, PostgreSQL, Zod, React, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-27-rental-turnover-adjustment-design.md`

## Global Constraints

- Manager/admin authorization, origin verification, idempotency, audit logging and account locks remain mandatory.
- A debit may not produce a negative total.
- The automatic tier follows the adjusted total, while a manual tier override remains effective.

## Review Focus

- Repeat of the same idempotency key must not change the total twice — Task 1 test.
- Debit equal to the balance is permitted; a larger debit is rejected — Task 1 test.
- Both an upgrade and a downgrade update the returned snapshot — Task 1 test.
- Viewer role is forbidden — Task 2 test.
- UI sends a signed operation only after a customer and positive value are supplied — Task 3 typecheck/manual review.

### Task 1: Turnover adjustment domain operation

**Files:**
- Create: `db/migrations/20261027140000_rental_turnover_adjustments.sql`
- Modify: `src/lib/loyalty/index.ts`
- Test: `tests/app.integration.test.ts`

- [ ] Write integration tests for a positive adjustment, a valid debit, an overdraw rejection, replay safety and tier changes.
- [ ] Verify the new tests fail because the route and operation do not exist.
- [ ] Add immutable storage and `adjustRentalTurnover(input, actor)` with locking, audit and account snapshot output.
- [ ] Verify targeted tests pass.

### Task 2: Protected admin endpoint

**Files:**
- Modify: `src/lib/api/admin.ts`
- Test: `tests/app.integration.test.ts`

- [ ] Wire `POST admin/customers/:id/rental-turnover` with manager authorization and Zod validation.
- [ ] Verify the route test passes and viewer access is refused.

### Task 3: Customer-card controls

**Files:**
- Modify: `src/components/admin/forms.tsx`
- Modify: `src/components/admin/pages.tsx`

- [ ] Add dialogs for turnover credit/debit, submitting the new endpoint with a reason and idempotency key.
- [ ] Add actions beside the customer turnover value and refresh the snapshot on success.
- [ ] Run the full test suite, typecheck, lint and production build.
