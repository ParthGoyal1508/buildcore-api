# 042: Gap closure — unwired backend features, dead routes, 036 QA backlog (25-10-2026)

**Source:** endpoint-parity audit of 25-10-2026 (every frontend `authFetch`/`apiFetch`/`downloadFile`
call diffed against every NestJS route, both directions, each finding verified by hand) plus the
still-open items in `specs/036-ux-qa-hardening/plan.md`.

**Scope decisions (user, 25-10-2026):**
- Build all 7 unwired-backend UI items.
- Delete dead routes, **except** `POST /approvals/chains` and `DELETE /approvals/chains/:id`,
  which stay for the flow-corrections spec (039).
- Include the 036 behavioral bugs and UX/perf items. Excluded: migration-needing items
  (purchase GST/invoice/accepted-qty, tank capacity, NOC thumbnails, PO hand-typed lines,
  paid-sheet reversal), the RLS bypass allow-list (B15), and housekeeping.
- Cross-company employee profile: **every tab reads the employee's own company**; the profile
  stays reachable. (Fixes the attendance-tab 404 from the Wave-5 user review.)
- Lightweight plan (this file), no full Spec Kit cycle.
- Two waves, parallel agents inside each, **user review between waves**.

## Wave 1 — buildcore-api (2 agents in parallel, worktrees + own DBs)

### Agent 1a: route cleanup + behavioral bugs
- **Delete** (after confirming no use in `scripts/`, `prisma/seed*`, or e2e — "unused by the web
  app" was verified, other callers were not):
  - `POST /projects/ra-bills/:raBillId/signed-copy` (superseded 2026-10-14 by
    `bill-package-debits/:debitId/signed-copy`)
  - `PATCH /plant/logbook/:id` (edits go via `/readings`) and `PATCH /plant/maintenance/:id`
    (edits go via `/job-card` subroutes)
  - `GET /group/employees/search` (frontend declines it by design — `dashboard.ts:489`)
  - `GET /inventory/composite-items/:id`, `GET /workspace-admin/attendance-exceptions/:id`
  - `POST /recruitment/letter-templates/install-standard` — only if nothing in scripts/seeds
    calls it; otherwise keep and document.
  - **Keep** `POST /approvals/chains` + `DELETE /approvals/chains/:id` (earmarked for 039).
- **Bugs:**
  - `PUT /approvals/slot-mappings` must refuse a role belonging to another company.
  - Fuel-recovery recompute must refuse pushing a hire bill's net negative.
  - Logbook sheet: write a day's sheet transactionally so non-reading-rule errors can't leave it
    half-written; correcting a day's readings re-checks the next day's opening reading.
  - Attendance for cross-company profiles: the per-employee attendance read must be servable
    under the employee's own company for a caller who can see the employee (needed for the
    profile-tab decision above; the web wiring is Wave 2).

### Agent 1b: endpoints the UX fixes need
- Labour daily: name/code search parameter on the list endpoint (today the UI filters only the
  loaded page).
- Workers' NOC filter and partners RAG/BOCW filters: server-side filter parameters.
- Operator picker: a `siteId` scope on the operator search, so the picker can offer the
  machine's site instead of the whole company.
- Download controllers: stop overriding the exposed headers so `X-Company-Id` survives on file
  responses (open from 036 Wave 4).
- Account creation: the role list offered for an invite only contains roles the caller can
  actually grant (the server already refuses the others; the list should match).

### Wave 1: outcome (25-10-2026, both worktrees unmerged, awaiting review)

Both agents: `tsc` clean, full unit suite green (3,100+ tests each), no database touched.
Branches: `worktree-agent-a0fbffe7a73b12187` (1a, 6 commits, +884/−739 over 31 files),
`worktree-agent-a2e6c477c346679b2` (1b, 5 commits, +905/−70 over 26 files).

**1a deviations from the plan:**
- `GET /workspace-admin/attendance-exceptions/:punchId` **kept**: the e2e suite reads
  rejected/returned punches through it at 10 sites; now documented on the route.
- Logbook next-day re-check **reverses a documented in-code decision** ("the screen says to
  check the following day") — done on this plan's authority; reviewer should confirm.
- `install-standard` deleted after confirming startup/company-creation sync covers it.
- Slot-mapping fix: foreign-company role now 400 `ROLE_OF_ANOTHER_COMPANY`.
- Attendance month (`GET /hr/attendance/employee/:id`) now serves under the employee's own
  company (RLS-visible callers only); its `companyId` query param dropped.

**1b notes for Wave 2 (parameter contracts):**
- `GET /labour/muster-attendance/daily?search=` (name/code, items only — summary stays whole).
- `GET /labour/workers?nocStatus=open|closed` (whole-register, pager honest).
- `GET /partners/rag?search=&status=verified|submitted|partial|missing`;
  `GET /partners/bocw?search=&status=pending|partial|paid`. Both lists now DTO-validated:
  undeclared query params are 400s. Exports unchanged, unfiltered.
- Operator picker: **no backend change** — pass the machine's `siteId` to `EmployeePicker`
  (`app/ui/plant/pickers.tsx:153`); `/hr/employees` has filtered on it since 005. Caveat:
  needs EMPLOYEES permission (pre-existing).
- `GET /settings/roles?grantable=true` returns only roles the caller may assign; invite form
  should use a distinct query key from the Roles screen's `['roles']`.
- `X-Company-Id` now survives all downloads via `mergeExposedHeaders`
  (`src/common/merge-exposed-headers.ts`); three redundant `setHeader` lines in 1a-owned files
  are harmless and left for later cleanup.

## Wave 2 — buildcore-web (3 agents in parallel, worktrees), after Wave 1 review

- **2a Settings + HR:** letterhead view/upload in company settings (full-page image, like the
  logo; `GET/PUT /settings/companies/:id/letterhead`); face-punch accuracy + enforcement
  controls (`PUT …/punch-accuracy`, `…/punch-enforcement`); staff punch-refusals list
  (`GET /hr/attendance/refusals`, mirroring the labour one); Reimbursement Register screen
  (`GET /hr/reimbursements/register`, status subtotals); account-creation role list (wire 1b);
  employee-profile tabs read the employee's own company (404 fix).
- **2b Plant + Approvals:** reverse action on fuel recoveries
  (`POST /plant/fuel-exceptions/:id/recover/reverse`); approval reassign for SETTINGS holders
  (`POST /approvals/:instanceId/reassign` — hand a pending item to another holder of its
  current level); the 3 plant pickers still capped at 200 (service-bill vendor, equipment page
  site filter, spare-part linked item); operator picker scoped to the machine's site (wire 1b);
  mobile-Safari PDF print/new-tab fallbacks.
- **2c Inventory + Labour + Partners:** purchase edit — date and remarks only, matching
  `UpdatePurchaseDto`; labour daily search box wired to the 1b parameter; workers' NOC filter
  and partners RAG/BOCW filters wired server-side.

### Wave 2: outcome (25-10-2026, three worktrees unmerged, awaiting review)

All three: `tsc --noEmit` clean, eslint clean on touched files (the web repo's conventions —
it has no test runner). Branches `042-wave2a` (+907/−21, 12 files), `042-wave2b` (+403/−103,
12 files), `042-wave2c` (+269/−75, 8 files), all off `origin/main`.

**Judgment calls made (reviewer to confirm):**
- Reassign requires a reason (the DTO demands it; the brief had said optional) and offers any
  active user as target — the server deliberately has no holder restriction; it refuses only
  the person the item awaits. The queue screen doesn't get the action (its items always await
  the caller).
- Job card's operator stays free text — it mirrors the paper card and stores a name, not an
  employee id; converting is a product decision, flagged, not done.
- Letterhead lives on the company modal's Basic Info tab (edit mode); punch settings on a new
  self-saving "Attendance" tab. Refusals and the Register are tabs inside the existing HR
  attendance / reimbursements sections, so no new routes or permission-map entries.
- Export honesty: RAG/BOCW export buttons say "Export all to Excel" while a filter is on (the
  export routes take no filters).

**Known caveats carried to Wave 3 / later:**
- The register endpoint pins page 1 × 100 claims, so its subtotals describe at most 100 rows.
- Reimbursements nav is gated on EMPLOYEES while the backend accepts EMPLOYEES or PAYROLL —
  a PAYROLL-only holder can't reach the register through the nav (pre-existing).
- Cross-company profile: attendance needed no client change (Wave 1a fixed the server); but
  loans/payslips-style tabs are still company-pinned server-side and render EMPTY (not 404)
  for a cross-company employee — backend work if those tabs should be truly cross-company.
- Deployment coupling: the new query params 400 on an older API (forbidNonWhitelisted), so api
  and web must deploy together.
- Fuel-exceptions list now includes `hireBillDeduction`/`operatorRecovery` (fixed on the api
  branch during Wave 2, commit 0658b61) — the reverse action renders only with that api.
- `usePlantEquipment` in use-plant-refs.ts lost its last consumer; cleanup candidate.
- Derived (not live-verified) zod schemas to check in Wave 3: PATCH purchase response;
  reverse-recovery `{reversed}`; reassign response; company `punchAccuracyMaxMetres`/
  `punchBlockEnforced` (+ both PUT responses); letterhead upload/GET; staff refusal rows;
  reimbursement register. Quickest check: sign in on dev and open each new screen.
- Local dev note: a `nest start --watch` running since before the merge keeps regenerating a
  stale `src/metadata.ts` (deleted DTO reference); restart it, delete the file once, and local
  `tsc` is clean again. The branch itself is unaffected (the file is git-ignored).

## Wave 3 — verification (me), after Wave 2 review

`tsc` + unit suites in both repos, e2e where the fixtures allow, and a browser pass over every
new screen and fix — opened and looked at, not just crawled (dropdowns, modals, empty states).
Outcomes get appended to this file.

## Out of scope, tracked for later
- Spec 039: approval-chain lifecycle (the kept chain routes), job card, payroll edits,
  composite items.
- Migration items and B15 (listed above), the data-repair reports (user decision), and the
  untracked `.claude/036-local-dashboard-e2e-edit.patch`.
