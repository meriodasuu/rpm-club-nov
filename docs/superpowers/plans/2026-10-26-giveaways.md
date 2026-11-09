# RPM Club Giveaways Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Use a fresh implementing subagent and an independent reviewing subagent at each task boundary; parallelize only tasks with no shared files or interface dependencies. Quality takes precedence over speed.

**Goal:** Администратор публикует розыгрыш с условиями и отдельным призом для каждого места; система автоматически допускает участников, выбирает победителей и выдаёт призы.

**Architecture:** Отдельный модуль `giveaways` хранит опубликованные правила, состояние проведения, основания допуска и результаты. Существующий учёт аренд и уровней служит источником данных; общий механизм выигрышей рулетки расширяется новым источником без фиктивного прокрута. Проведение выполняется транзакционно фоновым заданием, уведомление доставляется через outbox.

**Tech Stack:** Next.js 16.3.4, React 19.3.0, TypeScript 6.0.3, PostgreSQL, Zod 4.6.2, Vitest 5.0.0.

**Spec:** `docs/superpowers/specs/2026-10-26-giveaways-design.md`

## Global Constraints

- Участие автоматическое; один человек — один равный шанс и не более одного места.
- Период `[starts_at, ends_at)` по Москве; завершение, оплата и внесение аренды должны приходиться на этот период. При отсутствии достоверного времени завершения или оплаты аренда не допускается автоматически.
- Уровень достаточно достигнуть в любой момент периода; минимальный уровень включает все уровни выше.
- Места заполняются от первого по порядку; незаполненные места не получают приз.
- После публикации правила и призы неизменны; до закрытия отмены/корректировки аренд меняют участие, после выбора результат неизменен.
- Каждый приз имеет свой срок действия; выдача выигрыша автоматическая, активация использует существующее подтверждение сотрудника.
- Имена победителей видны участникам клуба; Telegram не является условием успешной выдачи.
- Пользователь уточнил, что RPM Bonus в продукте нет: новый интерфейс розыгрышей не предлагает соответствующий технический тип награды.
- Не изменять чужие незакоммиченные файлы без точечной проверки. В рабочем дереве уже много незакоммиченных изменений, включая рулетку и аренды; перед правкой каждого общего файла просматривать его diff. Не выполнять общий `git add`/коммит чужих изменений.
- Перед написанием Next.js кода прочитать соответствующий раздел `node_modules/next/dist/docs/` согласно `AGENTS.md`.

## File Map

- `db/migrations/20261026100000_giveaway_rental_times.sql`: достоверные отметки событий аренды, происхождение данных и история состояний для восстановления на момент окончания.
- `db/migrations/20261026110000_giveaways.sql`: розыгрыши, призовые места, снимок участников, победители, источник выигрыша, ограничения и индексы.
- `src/lib/giveaways/contracts.ts`: типы API, Zod-схемы и разрешённые типы призов.
- `src/lib/giveaways/eligibility.ts`: определение участников, прогресса и спорных аренд.
- `src/lib/giveaways/draw.ts`: закрытие, случайное распределение мест, выдача и аудит.
- `src/lib/giveaways/index.ts`: маршруты администратора и клиента, права и ошибки.
- `src/lib/roulette/awards.ts` (новый): общий контракт выдачи/активации наград для рулетки и розыгрышей; подключить из `src/lib/roulette/index.ts`.
- `src/components/admin/giveaways.tsx`, `src/app/admin/[section]/page.tsx`, `src/components/admin/shell.tsx`: админка.
- `src/components/miniapp/giveaways.tsx`, `src/components/miniapp/app.tsx`, `src/app/club/giveaways/page.tsx`: клиентский экран.
- `src/lib/jobs/index.ts`, `src/lib/jobs/telegram.ts`, `src/app/api/[...path]/route.ts`: проведение, уведомления и маршрутизация.
- `tests/giveaways*.test.ts`: контрактные и интеграционные проверки; существующие тесты рулетки — регрессия.

## Review Focus

- Аренда с датой окончания внутри периода, но временем оплаты снаружи: не должна попадать в сумму; тест Task 1/3.
- Одновременная отмена аренды и закрытие: результат определяется состоянием зафиксированной транзакции; тест Task 4.
- Два worker-процесса после сбоя: один набор победителей, призов и уведомлений; тест Task 4/5.
- Участников меньше мест: последовательные места с первого, без «дыр»; тест Task 4.
- Технический `bonus` в старой рулетке: не появляется в форме розыгрыша и не принимается API; тест Task 2/6.

---

### Task 1: Достоверное время событий аренды

**Files:** Create `db/migrations/20261026100000_giveaway_rental_times.sql`; Modify `src/lib/loyalty/index.ts`, входы ручной аренды/импорта/интеграции, определённые после просмотра текущих контрактов; Test `tests/giveaways-rental-times.integration.test.ts`.

**Interfaces:** Produces `rentals.completed_at`, `rentals.paid_at`, `rentals.created_at` plus explicit trust metadata for completion/payment, and append-only `giveaway_rental_events(rental_id, changed_at, status, payment_status, current_amount_kopecks, completed_at, paid_at, trust_metadata)`. Capture every relevant insertion, cancellation, refund and amount adjustment transactionally; at close use the latest committed state strictly before `ends_at`. `paid_at` is set when the product records a genuine transition to `paid`, or from a validated source timestamp; historical data without such evidence stays untrusted. Existing `completed_at` backfills must not be treated as proof of actual completion time.

- [ ] Write failing integration tests: operational completion/payment transitions record trusted timestamps once; invalid/missing source times are untrusted; event before start/at end is outside `[start,end)`; an old completed/paid row with only backfilled times is excluded; every cancellation/adjustment records an immutable prior and new state.
- [ ] Run `npm test -- tests/giveaways-rental-times.integration.test.ts`; expect the new assertions to fail.
- [ ] Add migration and update every production path that creates or transitions a rental. Preserve idempotency and existing rental semantics. Do not infer actual payment time from an import date.
- [ ] Run the focused test and existing `tests/loyalty.integration.test.ts`; expect pass.
- [ ] Review the diff; commit only files owned by this task if the worktree permits safe staging.

### Task 2: Схема розыгрыша и контракт админки

**Files:** Create `db/migrations/20261026110000_giveaways.sql`, `src/lib/giveaways/contracts.ts`; Modify `src/lib/giveaways/index.ts` (new), `src/app/api/[...path]/route.ts`; Test `tests/giveaways-admin.integration.test.ts`.

**Interfaces:** `giveawayRoute(request: Request, path: string): Promise<Response | null>`. Entities: `giveaways` (draft/published/cancelled/drawing/completed/failed, immutable published rules, version), `giveaway_places` (unique `(giveaway_id, place)`, prize snapshot, TTL days), `giveaway_entries` (unique giveaway/user, evidence snapshot), `giveaway_winners` (unique giveaway/user and giveaway/place). Publishing requires `starts_at` in the future so event tracking is already active. Prize effects: `percent`, `fixed`, `free_day`, `wash`, `upgrade`, `info`; validate as roulette does, excluding unsupported `bonus`.

- [ ] Write failing API integration tests: manager draft creation/preview/update, publish validation, immutable published rules, cancellation with reason/audit, denied client access, distinct place prizes and TTL, rejected `bonus` and invalid dates/amounts.
- [ ] Run `npm test -- tests/giveaways-admin.integration.test.ts`; expect failure.
- [ ] Implement schema, validation and `admin/giveaways` routes; protect published rows at both API and database level. Use exact period instants stored as `timestamptz`.
- [ ] Run focused tests and `npm run typecheck`; expect pass.
- [ ] Review and safely stage/commit task files only.

### Task 3: Расчёт участников и прогресса

**Files:** Create `src/lib/giveaways/eligibility.ts`; Modify `src/lib/giveaways/index.ts`; Test `tests/giveaways-eligibility.integration.test.ts`.

**Interfaces:** `calculateGiveawayEligibility(tx, giveawayId, asOf): Promise<{entries, excludedRentals}>`; `getGiveawayProgress(userId, giveawayId, asOf): Promise<{qualifyingKopecks: string, thresholdKopecks: string, tierMet: boolean, eligible: boolean}>`. Sum qualifying operational rentals from the latest `giveaway_rental_events` state strictly before `min(asOf, ends_at)`, where trusted completion/payment and original insertion are in `[starts_at, ends_at)` and state is completed+paid. Inspect `tier_events` for achieved level during period and effective level at start. A previously achieved persistent tier counts throughout the period; later achievement counts from event time onward. Never recalculate historic eligibility from current rental/account rows alone.

- [ ] Write failing integration tests: threshold equality, multiple rentals, every time boundary, missing/untrusted timestamps visible as excluded, level reached mid-period, level reached before period, level reached after period, cancellation/adjustment before close, and adjustment after close but before delayed worker.
- [ ] Run `npm test -- tests/giveaways-eligibility.integration.test.ts`; expect failure.
- [ ] Implement indexed SQL/application calculation, including an exclusion reason visible to staff. Recompute progress from current data until close; do not issue prizes here.
- [ ] Run focused tests and `npm run typecheck`; expect pass.
- [ ] Review and safely stage/commit task files only.

### Task 4: Однократное проведение и случайные места

**Files:** Create `src/lib/giveaways/draw.ts`; Modify `src/lib/jobs/index.ts`; Test `tests/giveaways-draw.integration.test.ts`.

**Interfaces:** `drawDueGiveaways(limit: number, now: Date): Promise<{completed: number, failed: number}>`. At close, lock one giveaway, freeze sorted eligible user IDs and evidence, draw without replacement using Node `crypto.randomInt`, assign places `1..min(entries,places)`, and save audit fields. Same transaction must make the draw resumable without replacement of a committed winner list. Worker delay must still use `ends_at` as cutoff.

- [ ] Write failing integration tests: 0/1/N entrants, fewer entrants than places, one chance independent of spend, no duplicate winner, concurrent workers, restart after injected failure, cancellation racing closure, rental adjustment racing closure.
- [ ] Run `npm test -- tests/giveaways-draw.integration.test.ts`; expect failure.
- [ ] Implement transaction/lock, immutable snapshot and result, explicit failed state and operator-visible error. For deterministic tests, inject a bounded integer picker rather than asserting a particular production random outcome.
- [ ] Run focused tests and `npm run typecheck`; expect pass.
- [ ] Review and safely stage/commit task files only.

### Task 5: Выдача выигрышей и уведомления

**Files:** Create `src/lib/roulette/awards.ts`; Modify `db/migrations/20261026110000_giveaways.sql`, `src/lib/roulette/index.ts`, `src/lib/giveaways/draw.ts`, `src/lib/jobs/index.ts`, `src/lib/jobs/telegram.ts`; Test `tests/giveaways-awards.integration.test.ts`, existing `tests/roulette.integration.test.ts`.

**Interfaces:** Extend `roulette_awards` with nullable `spin_id` plus unique nullable `giveaway_winner_id` and database XOR constraint; retain existing claim-code/status/redemption semantics. `issueAwardForGiveaway(tx, winnerId, prizeSnapshot, ttlDays): Promise<Award>` creates one award per winner id, and one outbox event keyed by winner id. Existing roulette issue path remains one award per spin.

- [ ] Write failing tests: one prize per winning place with own TTL, award visible through existing prize list, staff redemption once, retry/concurrent issue no duplicate, Telegram failure leaves award intact and delivery retryable, existing spin award still works.
- [ ] Run `npm test -- tests/giveaways-awards.integration.test.ts tests/roulette.integration.test.ts`; expect failure only for new behavior.
- [ ] Implement shared issuance and source relation, then enqueue and render Telegram notification via existing outbox. Make drawing/issuance commit atomically or use a durable issuance state that retries without altering winners.
- [ ] Run focused tests and `npm run typecheck`; expect pass.
- [ ] Review and safely stage/commit task files only.

### Task 6: Админка розыгрышей

**Files:** Create `src/components/admin/giveaways.tsx`; Modify `src/components/admin/shell.tsx`, `src/app/admin/[section]/page.tsx`; Test `tests/giveaways-admin-render.test.ts` plus browser flow at the existing admin seam.

**Interfaces:** Use `admin/giveaways` routes from Task 2 and participant/result endpoints from Tasks 3–5. Place editor has ordered rows with independent prize/TTL; form excludes `bonus`.

- [ ] Write failing component/browser tests for draft validation, preview, publication, cancellation reason, ordered places, entrants/excluded rentals, results and delivery state.
- [ ] Run focused test; expect failure.
- [ ] Implement screen and navigation using existing admin components. Show immutable published terms and worker errors clearly.
- [ ] Run focused tests and `npm run typecheck`; expect pass.
- [ ] Review and safely stage/commit task files only.

### Task 7: Клиентский экран и публичные результаты

**Files:** Create `src/components/miniapp/giveaways.tsx`, `src/app/club/giveaways/page.tsx`; Modify `src/components/miniapp/app.tsx`, `src/lib/giveaways/index.ts`; Test `tests/giveaways-client.integration.test.ts` and browser flow.

**Interfaces:** `GET me/giveaways` returns published/closed cards and own progress; `GET me/giveaways/:id` returns rules, places, progress/status and results. Public results expose winner display name/place to authenticated club participants only; never expose phone, Telegram ID or rental details of others.

- [ ] Write failing tests for progress/participation, active and finished cards, winner display names, own prize link, nonmember denial and privacy of other fields.
- [ ] Run focused test; expect failure.
- [ ] Implement routes and screen using established Mini App navigation, loading and error states.
- [ ] Run focused tests and `npm run typecheck`; expect pass.
- [ ] Review and safely stage/commit task files only.

### Task 8: End-to-end release gate

**Files:** Modify `docs/ROULETTE.md` or create `docs/GIVEAWAYS.md`; Test `tests/giveaways.integration.test.ts` and existing relevant suites.

**Interfaces:** No new production API. Operational runbook documents job retry, failed state, audit and exclusion review. Public launch requires approved official rules and publication basis for winner names.

- [ ] Write and run a full integration scenario: draft → publish → trusted rentals/level → progress → close → ordered winners → awards → Telegram retry → staff redemption; include cancellation and zero entrants.
- [ ] Run `npm test -- tests/giveaways.integration.test.ts`, relevant roulette/loyalty/jobs suites, `npm run typecheck`, `npm run lint`, `npm run build`; resolve failures caused by this feature.
- [ ] Review migrations against a clean test DB and a populated fixture; document deployment order and rollback limits.
- [ ] Request an independent whole-change review; fix findings and rerun the affected checks.
- [ ] Update the runbook and final acceptance checklist. Keep launch gated on the two legal/official-rule conditions in the spec.

## Execution Order

Tasks 1 and 2 can be investigated in parallel, but their shared rental/API edits must be sequenced. Task 3 depends on 1–2; Task 4 on 3; Task 5 on 4. Tasks 6 and 7 can proceed in parallel after API contracts settle, in separate files with coordinated edits to `src/lib/giveaways/index.ts`. Task 8 closes the work. For each task, an implementer submits a small diff, a separate reviewer checks behavior and existing regressions, and the primary agent integrates only reviewed changes.
