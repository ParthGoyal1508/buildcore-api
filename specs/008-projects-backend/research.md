# Research: Projects Backend (Portfolio, Clients, Sites, BOQ, DWR, Revenue, P&L)

## 1. Schema placement

**Decision**: A single new `projects` schema owns all entities introduced by this feature:
`Client`, `Project`, `Site`, `BOQTaskGroup`, `BOQTaskItem`, `DailyWorkReport`, `DWRTask`,
`Revenue`, `RABill`, `WorkOrder`, `ProjectBudget`, `ProjectDocument`. The `projects` schema is
already named in the constitution's canonical module list (Principle I) — this feature is
its first concrete population.

**Rationale**: Every entity is squarely a project-management concern; there is no cross-module
ownership ambiguity. Grouping them under a single schema gives `ProjectsModule` a clean extraction
boundary for Phase 2, per the HLD §10 rationale the constitution encodes.

**Alternatives considered**: Splitting `Client` into `shared` or `settings` — rejected: clients
are only referenced by projects in the current system; there is no evidence of cross-module
client reuse in other PRDs. Adding it to `shared` now for speculative reuse would bloat that
schema; if reuse materialises later, a constitution amendment handles it.

## 2. Site ownership: `projects` schema already owns `Site` (corrected — was a false narrative)

**Decision**: `projects` schema already owns `Site` — feature 003 built it there directly (not in
`hr`), complete with geofence fields (`latitude`, `longitude`, `geofenceRadiusMeters`) and
`weeklyOffDay`/`holidays`, specifically anticipating this feature's needs (003's own research.md
documents this placement choice). This feature does **not** move Site or re-add geofence columns.
It extends the existing table additively with `projectId`, `address`, `status`. HR's attendance
module keeps calling 003's existing exported methods — `SitesService.getGeofence(siteId)`,
`.getHolidayCalendar(siteId)`, `.getWeeklyOffDay(siteId)` — completely unchanged; this feature adds
a separate, new `getSiteById(siteId)` export (returns the full Site row, not just geofence fields)
for its own consumers (DWR, BOQ, project-detail views) that need more than HR's narrow slice.

**Correction context**: The original draft of this research entry and the spec's clarification
answer both wrongly asserted that 003 had built only a bare `hr.Site` placeholder (id/name/
companyId) that this feature would "move to `projects`" and add geofence columns to — both false:
the schema was already `projects`, and geofence was already there. That false premise also implied
HR would need to switch its call sites to a new `getSiteById()`, an unnecessary and disruptive
change to code 003 already built and 005 (attendance computation, research.md §6 there) already
depends on. Found and corrected during 008's master-PRD alignment audit, by re-reading 003's
data-model.md/tasks.md directly rather than trusting this feature's own prior description of it.

**Rationale**: Sites are a project concept; HR needs only the geofence/holiday/weekly-off slice for
validation, which 003 already serves via narrow exported methods — no reason to widen or rename
that contract just because a broader consumer (this feature) also needs Site data, for a different
purpose, via its own new method.

**Alternatives considered**: Having HR switch to the new `getSiteById()` for consistency — rejected:
churn with no benefit; 003's narrow methods are already the right shape for what HR actually needs,
and changing a working exported contract without a functional reason increases risk for free.

## 3. P&L on-demand calculation via `Promise.allSettled`

**Decision**: `ProjectPnlService.compute(projectId, period)` issues **five** cross-module calls in
parallel using `Promise.allSettled`: `HrPayrollService.getLabourCostByProject(projectId, dateRange)`,
`InventoryService.getMaterialCostByProject(projectId, dateRange)`,
`PlantService.getMachineryCostByProject(projectId, dateRange)`,
`PlantService.getFuelCostByProject(projectId, dateRange)`,
`PartnersService.getSubcontractorCostByProject(projectId, dateRange)`. Machinery and Fuel are
two separate calls and two separate P&L lines (master PRD §7.5.4). No stored snapshot — every `GET /projects/:id/pnl` request recomputes.

**Rationale**: On-demand was the clarification-session answer (Q1 of spec clarifications). The
four calls are independent and can run in parallel; `allSettled` rather than `Promise.all` is the
right primitive because a missing plant-module setup should not 500 an otherwise valid P&L call
(spec edge case). The four service methods don't yet exist in 006–007 features; this feature
defines the contract they must satisfy and provides the zero-value fallback so the P&L endpoint
ships without blocking on those features.

**Alternatives considered**: A scheduled background job that materialises P&L as a cached snapshot
— rejected: the clarification session chose on-demand; a snapshot would also require cache
invalidation logic whenever any source module's data changes, a significant complexity for a
module-boundary system.

## 4. BOQ Excel import: `exceljs` parsing, two-step validate-then-confirm (corrected — see §12)

**Decision**: `POST /projects/:id/boq/import/validate` accepts a `multipart/form-data` file
upload, parses it with `exceljs` (pre-approved by constitution v1.2.0), validates each row against
the nine required columns (BOQ No., Task Group, Task Name, Unit, Scope Qty, Start Date, Finish
Date, Duration, Per Day Qty), and returns `{ batchId, validRows: Row[], errors: ErrorRow[] }`
without writing anything — the parsed valid rows are held server-side (keyed by `batchId`, TTL'd)
rather than committed. `POST /projects/:id/boq/import/confirm { batchId }` then commits the held
valid rows in a single Prisma transaction (creating groups on first reference). If any errors
exist, the validate response also includes an `errorReportUrl` pointing to a downloadable CSV.
Both steps are synchronous; files exceeding 1,000 rows are rejected with a `413` before processing.

**Rationale**: `exceljs` is the pre-approved library; synchronous processing is spec-mandated for
≤1,000-row files. A single transaction on confirm ensures atomic validity — no partial BOQ states.
The CSV error report matches the spec's "downloadable error report" requirement without requiring
a streaming/queue infrastructure this feature doesn't otherwise need. The two-step split (see §12
for why this replaced an earlier single-step design) lets the admin review the error report and
decide whether to proceed before anything is written, matching master PRD §7.5.3.

**Alternatives considered**: Async import with a job queue — rejected: out of scope for this
version per the spec assumption; the 1,000-row limit keeps synchronous processing well under any
reasonable timeout. A single blind-commit endpoint (the original design) — rejected, see §12.

## 5. DWR Actual Qty: server-side computation

**Decision**: `DWRTaskService.computeActualQty(nos1, nos2, length, breadth, depth, density)`
computes `nos1 × nos2 × length × breadth × depth × density` server-side. The client submits raw
components in the DTO; the server stores the computed `actualQty` on `DWRTask`. If any component
is zero, the result is zero (spec edge case). The `exceedsScope` flag is set if
`currentDoneQty + actualQty > boqItem.scopeQty`.

**Rationale**: Server-side computation is mandated by FR-005 to prevent client-submitted totals
from diverging from formula-computed values. The formula is simple arithmetic with no ambiguity.

**Alternatives considered**: Accepting client-computed `actualQty` directly — rejected: FR-005
explicitly disallows this; a compromised client could submit inflated BOQ progress.

`actualQty` is computed and stored at DWR creation time regardless of status; it is only *applied*
to the BOQ item's `doneQty` when the DWR is approved, not when computed or submitted — see §13.

## 6. Project lock enforcement: `ProjectLockGuard`

**Decision**: A reusable `ProjectLockGuard` NestJS guard is applied via `@UseGuards()` on all
DWR, Revenue, RABill, BOQ write, WorkOrder, and ProjectDocument write endpoints. The guard
resolves `projectId` from route params, queries `Project.isLocked`, and returns `423 Locked` with
a descriptive message if true. It adds one DB read per guarded request but avoids duplicating lock
checks across eight controller methods.

**Rationale**: A guard keeps the lock-enforcement concern in one auditable place; if the rule
changes (e.g., admins can always unlock-write), the change is a one-line guard update rather than
a surgical edit across eight controllers.

**Alternatives considered**: Per-service `isLocked` check inside each service method — rejected:
harder to audit (scattered), not consistently applied if a new endpoint is added without remembering
to add the check.

## 7. RA Bill state machine

**Decision**: `RABill.status` is an enum `draft | submitted | approved`. Transitions:
`draft → submitted` (via `PATCH .../submit`), `submitted → approved` (via `PATCH .../approve`),
`submitted → draft` (via `PATCH .../reject`, with mandatory `rejectionRemark`). Out-of-order
transitions return `409 Conflict` with a message indicating the current state and valid next
states. Approved bills are immutable (no further edits, no reversal in this version).

**Rationale**: Explicit transition endpoints are cleaner than a generic `PATCH { status }` that
requires the server to validate arbitrary transitions client-side errors could bypass. Three states
cover the PRD's workflow; the spec clarified (Q4 of spec) that Approved is the terminal state.

**Alternatives considered**: A generic `PATCH /ra-bills/:id { status }` with server-side
transition validation — acceptable, but the named-endpoint pattern makes the valid transitions
self-documenting in Swagger and easier to permission-gate independently if needed later.

## 8. Permission enum extension

**Decision**: Three new values — `PROJECTS`, `DWR`, `PROJECT_FINANCIALS` — are added to
`settings.Permission` enum (the same enum features 001–005 have been extending). This means
`ProjectsModule` imports `SettingsModule`'s exported `RequirePermission` decorator, exactly as
HrPayrollModule does. The Settings module owns the canonical enum; no new enum type is created.

**Rationale**: Clarification session Q1 established three values. Adding to the existing enum is
the constitution's own Principle V pattern, already demonstrated by HR's six enum additions; no
architectural decision needed here.

**Alternatives considered**: A projects-specific `ProjectsPermission` enum — rejected: would
fragment permission management across modules; the Settings enum is the single source of truth
per the pattern established in 002 and reused through 005.

## 9. `ProjectBudget` upsert pattern

**Decision**: `PUT /projects/:id/budget` accepts `{ budgets: Array<{ category, amount }> }` and
upserts all five categories atomically in a single Prisma transaction using `upsert` per row (or
`createMany` with `skipDuplicates` + prior delete, whichever Prisma supports cleanly for the
five-row fixed set). A unique constraint on `(projectId, category)` enforces the one-row-per-
category invariant. Missing categories in the payload are left at their current value (partial
update is allowed).

**Rationale**: Upsert is the right semantic for a fixed-set, re-settable configuration: it handles
both first-time budget entry and subsequent revisions without a client-side GET-then-PUT cycle.

**Alternatives considered**: Five separate `PATCH /projects/:id/budget/:category` endpoints —
rejected: more HTTP round-trips for the common "set all five budgets at once" use case; also
harder to do atomically.

## 10. Cross-module P&L service interface contracts

**Decision**: This feature defines the signatures the four source-module services MUST satisfy
for P&L to work, even though those modules (Plant, Inventory, Partners) are not yet fully specced:

```typescript
// Machinery/Fuel already implemented by 006 (getMachineryCostByProject/getFuelCostByProject
// were built there per the 006 reconciliation — no stub needed for these two):
interface PlantService      { getMachineryCostByProject(projectId: string, range: DateRange): Promise<number>;
                               getFuelCostByProject(projectId: string, range: DateRange): Promise<number> }
// Not yet implemented anywhere — this feature defines the contract, injects a zero-returning stub,
// and surfaces `unavailableModules` until 007/009 add the real methods:
interface InventoryService  { getMaterialCostByProject(projectId: string, range: DateRange): Promise<number> }
interface PartnersService   { getSubcontractorCostByProject(projectId: string, range: DateRange): Promise<number> }
// Added to 005 directly as part of this feature's build-out (research.md §16 there, FR-046) —
// not a stub; PayrollLineItem.projectId + the method both ship together with this feature:
interface HrPayrollService  { getLabourCostByProject(projectId: string, range: DateRange): Promise<number> }
```

Until Inventory/Partners ship their implementations, `ProjectsModule` injects stub implementations
for those two that return `0` and mark the module as unavailable. This is captured as a TODO in
plan.md and surfaced in `unavailableModules` in the P&L response. Machinery/Fuel (006) and Labour
(005, amended by this feature) are real, not stubbed.

**Rationale**: Defining the interface contract now prevents future modules from shipping
incompatible signatures; the stub pattern keeps the P&L endpoint fully functional and testable
today without blocking on Inventory/Partners. Labour was originally assumed to already exist in
005 (a false assumption, corrected above) — since it's the largest cost line in a construction
P&L, amending 005 now was chosen over adding it to the stub list.

**Alternatives considered**: Stubbing Labour like Inventory/Partners instead of amending 005 —
rejected: Labour is typically the dominant cost category in construction P&L (master PRD §7.5.4
lists it first), so shipping the P&L with a permanently-zero Labour line would defeat the feature's
core "no cost overrun surprises" value proposition from day one.

## 11. Project Code auto-generation

**Decision**: Settings' existing `CodeSeriesService.nextCode('PROJECTS', companyId)` is called
when `POST /projects` receives no `code`. If the `PROJECTS` series type does not yet exist in
Settings' seed data, `ProjectsModule` creates it on first use (with a sensible default prefix,
e.g. `PRJ-`) rather than erroring. The generated code is unique per company.

**Rationale**: Reusing 002's code-series service keeps code-generation logic centralised (Principle
III); adding a PROJECTS series type is a trivial Settings seed extension, not a new mechanism.

**Alternatives considered**: A projects-specific sequential code generator — rejected: duplicates
the settings code-series mechanism for no benefit; also harder to customise prefix/format later.

## 12. BOQ import: validate-then-confirm, not a blind single-step commit

**Decision**: Split BOQ Excel import into `POST .../boq/import/validate` (parse + validate, return
report, write nothing) and `POST .../boq/import/confirm` (commit a previously-validated batch) —
see §4's updated decision for the mechanics.

**Rationale**: The original design (a single `POST .../boq/import` that validated and committed
valid rows in the same call) directly contradicted master PRD §7.5.3 ("Errors displayed per row
before import confirmed") and §11's cross-cutting import pattern (shared with Attendance Import,
003/005), both of which describe a review step between validation and commit. Found during the
master-PRD alignment audit sweep — this feature's BOQ import was the one import flow in the
codebase that hadn't followed the already-established two-step convention.

**Alternatives considered**: None — this brings BOQ import in line with an already-established,
already-audited pattern rather than inventing a new one.

## 13. BOQ `doneQty` counts only Approved DWRs, not Submitted

**Decision**: `doneQty`/`pendingQty`/`avgQtyPerDay`/`daysToComplete` update when a DWR is
**approved** (`PATCH /projects/dwr/:id/approve`), not when it's submitted. A submitted-but-
unapproved DWR's `actualQty` is computed and stored on the `DWRTask` row but does not yet count
toward the BOQ item's progress.

**Rationale**: Master PRD §7.5.3 is explicit: "Only Approved DWRs count toward project progress %
calculation." The original draft's FR-006/US5 AC2 incremented `doneQty` on submission, which would
let an unreviewed, potentially-erroneous site-supervisor entry move official BOQ progress before a
Project Manager ever looks at it — undermining the entire point of the Draft → Submitted →
Approved review workflow (§7 in this file). Found during the master-PRD alignment audit sweep.

**Alternatives considered**: Counting Submitted DWRs provisionally with a separate "approved
doneQty" vs. "provisional doneQty" pair of fields — rejected: the master PRD's single-sentence
rule doesn't call for two parallel progress figures, and it would complicate every downstream
consumer (BOQ alerts, P&L activity level) that just wants one authoritative progress number.

## 14. `DWR`/`PROJECT_FINANCIALS` permission values reconciled into 002

**Decision**: `PROJECTS` is reused verbatim from 002's pre-built enum (it already anticipated this
module). `DWR` and `PROJECT_FINANCIALS` are genuinely new — 002 only ever pre-built one coarse
`PROJECTS` value, not the finer daily-work-report/financial split this feature's data sensitivity
requires. Both new values have been added directly to 002's own data-model.md and tasks.md
(the canonical enum definition), not just asserted here.

**Rationale**: The established convention from the Partners/Inventory reconciliation earlier in
this audit was "reuse existing values, never invent duplicates" — but that convention addressed
features that invented *renamed duplicates* of concepts 002 already covered. `DWR`/
`PROJECT_FINANCIALS` are not duplicates of anything already in the enum; they're a legitimate new
trust-level split (a site supervisor filing DWRs should not automatically see RA Bill/P&L
financial data). The fix here is narrower: make sure the *canonical* enum list (002's own spec)
reflects the addition, rather than leaving 002's spec silently out of date relative to what every
other feature that reads its enum now assumes exists.

**Alternatives considered**: Folding DWR and PROJECT_FINANCIALS entry under the existing coarse
`PROJECTS` value — rejected: the clarification session (Q of spec) already established the
business need for the finer split (a site supervisor filing DWRs should not automatically see RA
Bill/P&L financial data); collapsing them back to one value would re-introduce the access-control
gap the clarification was meant to close.
