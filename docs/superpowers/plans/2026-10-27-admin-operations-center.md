# RPM Club Admin Operations Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the local RPM Club dashboard faster for manager daily work through client search, focused shortcuts, and clearer visual hierarchy.

**Architecture:** Add a small reusable customer quick-search component that uses the existing customer endpoint and navigates to the existing profile route. Compose it into the shell and dashboard without changing APIs or permissions. Refresh only the relevant admin CSS and retain the existing dark RPM visual language.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, lucide-react, existing `useResource` data layer, CSS.

**Spec:** `docs/superpowers/specs/2026-10-27-admin-operations-center-design.md`

## Global Constraints

- Work locally only; do not publish or change production.
- Do not change API, database schema, business rules, roles, or permissions.
- Do not add dependencies.
- Keep data-changing actions on their existing pages or dialogs.

## Review Focus

- Empty search must not navigate or show misleading results; covered in Task 1.
- A manager must not see admin-only actions; covered in Task 2.
- A selected customer result must route to the existing customer detail page; covered in Task 1.
- Dashboard must remain usable at a narrow desktop/tablet width; covered in Task 3 visual QA.
- Existing dashboard analytics and links must remain visible and functional; covered in Task 2 and Task 3.

---

### Task 1: Customer quick-search component

**Files:**
- Create: `src/components/admin/customer-quick-search.tsx`
- Modify: `src/components/admin/shell.tsx`
- Test: local browser check of empty, no-result, and selected-result states

**Interfaces:**
- Consumes: `useResource<{ items: Row[] }>("admin/customers?q=...")` and the existing `/admin/customers/[id]` route.
- Produces: `CustomerQuickSearch({ compact?: boolean }): JSX.Element` for shell and dashboard placement.

- [ ] **Step 1: Write the component acceptance cases**

Document and verify three UI states: empty input has no result list; a query with no match displays a clear no-result state; clicking a result routes to `/admin/customers/{id}`.

- [ ] **Step 2: Verify the cases fail before implementation**

Run: local browser check on the current admin dashboard.
Expected: no contextual search control exists in the shell.

- [ ] **Step 3: Implement `CustomerQuickSearch` in `src/components/admin/customer-quick-search.tsx`**

Debounce trimmed input, fetch through the existing customer API, render accessible search/result states, and use `useRouter().push` for the existing client-card route.

- [ ] **Step 4: Add compact shell placement in `src/components/admin/shell.tsx`**

Place the search where it does not displace the current page context; retain all role checks and navigation behavior.

- [ ] **Step 5: Verify the cases pass**

Run: local browser check of the three states above.
Expected: clear empty/no-result behavior and valid navigation.

### Task 2: Manager-first dashboard composition

**Files:**
- Modify: `src/components/admin/pages.tsx`
- Modify: `src/components/admin/tables.tsx` only if a small presentational helper prevents duplication
- Test: local browser check of dashboard shortcuts and recent-activity data

**Interfaces:**
- Consumes: existing dashboard `stats`, `recent`, `distribution`, and `program` response fields.
- Consumes: `CustomerQuickSearch` from Task 1.
- Produces: dashboard workbench with search, three existing-route shortcuts, and a recent-actions panel.

- [ ] **Step 1: Define dashboard acceptance cases**

Confirm that search, «Клиенты», «Добавить аренду», and «Импортировать» appear before KPI cards; confirm that empty `recent` renders an explicit empty state; confirm analytics sections remain below.

- [ ] **Step 2: Verify the cases fail before implementation**

Run: local browser check of dashboard.
Expected: the current page begins with title/KPIs and has no workbench/recent-action block.

- [ ] **Step 3: Implement the dashboard workbench in `src/components/admin/pages.tsx`**

Reuse existing routes and data only. «Добавить аренду» links to the existing rentals workflow rather than adding a mutation path. Render recent records defensively from existing `recent` fields and a clear empty state if none exist.

- [ ] **Step 4: Verify dashboard cases pass**

Run: local browser check.
Expected: primary actions are above the fold and analytics are preserved.

### Task 3: Premium operational CSS and local QA

**Files:**
- Modify: `src/app/globals.css`
- Test: `npm run typecheck`, `npm run lint`, local desktop/narrow viewport QA

**Interfaces:**
- Consumes: classes from Tasks 1–2.
- Produces: responsive, keyboard-visible, dark RPM interface styling.

- [ ] **Step 1: Add styles for quick search, workbench, action cards, recent activity, and compact quick links**

Use the existing dark palette and red `--red` accent; include visible focus states and responsive grid collapse without horizontal clipping.

- [ ] **Step 2: Run static verification**

Run: `npm run typecheck` and `npm run lint`.
Expected: both commands pass.

- [ ] **Step 3: Run desktop and narrow local visual QA**

Check: dashboard initial state, customer search result/navigation, all action shortcuts, collapsed workbench layout, keyboard focus, sidebar and topbar clipping.
Expected: no clipped essential controls, low-contrast primary controls, or broken existing sections.

- [ ] **Step 4: Commit**

```bash
git add src/components/admin/customer-quick-search.tsx src/components/admin/shell.tsx src/components/admin/pages.tsx src/app/globals.css docs/superpowers/plans/2026-10-27-admin-operations-center.md
git commit -m "feat: add admin operations center"
```
