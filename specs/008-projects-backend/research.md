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

## 2. Site ownership: `projects` schema replaces 003's placeholder

**Decision**: `projects` schema owns `Site`. The `hr.Site` stub from feature 003 (id, name,
companyId only) is migrated: this feature's migration adds the geofence columns (address,
latitude, longitude, geofenceRadius) to the existing `Site` table — the table itself moves to
`projects` schema conceptually, and HR's `PunchRecord`/attendance logic now calls
`ProjectsService.getSiteById(siteId)` (an exported in-process method) instead of querying its own
schema's `Site` directly. No data migration is required because the additive columns are nullable.

**Rationale**: The clarification session established this direction (Q2). Sites are a project
concept; HR needs only the geofence radius for validation, which is cleanly served via an exported
method. Putting Site in `projects` avoids an `hr` → `projects` cross-schema query that would
violate Principle I in the opposite direction.

**Alternatives considered**: Keeping `Site` in `hr` schema and having `projects` reference it —
rejected: this inverts the ownership (HR is not the business owner of site geography); it would
also force `ProjectsModule` to import from `HrModule` to list its own sites — backward coupling.

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

## 4. BOQ Excel import: `exceljs` parsing, synchronous for ≤1000 rows

**Decision**: `POST /projects/:id/boq/import` accepts a `multipart/form-data` file upload,
parses it with `exceljs` (pre-approved by constitution v1.2.0), validates each row against the
nine required columns (BOQ No., Task Group, Task Name, Unit, Scope Qty, Start Date, Finish Date,
Duration, Per Day Qty), commits valid rows in a single Prisma transaction (creating groups
on first reference), and returns `{ imported: N, errors: ErrorRow[] }`. If any errors exist, the
response also includes a `errorReportUrl` pointing to a downloadable CSV error report stored in
object storage. Import is synchronous; files exceeding 1,000 rows are rejected with a `413`
before processing.

**Rationale**: `exceljs` is the pre-approved library; synchronous import is spec-mandated for
≤1,000-row files. A single transaction ensures atomic validity — no partial BOQ states. The CSV
error report matches the spec's "downloadable error report" requirement without requiring a
streaming/queue infrastructure this feature doesn't otherwise need.

**Alternatives considered**: Async import with a job queue — rejected: out of scope for this
version per the spec assumption; the 1,000-row limit keeps synchronous processing well under any
reasonable timeout.

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
// Required by features 006/007/008
interface PlantService      { getMachineryCostByProject(projectId: string, range: DateRange): Promise<number> }
interface InventoryService  { getMaterialCostByProject(projectId: string, range: DateRange): Promise<number> }
interface PartnersService   { getSubcontractorCostByProject(projectId: string, range: DateRange): Promise<number> }
// Already in 005 — HR must add the projectId parameter:
interface HrPayrollService  { getLabourCostByProject(projectId: string, range: DateRange): Promise<number> }
```

Until those features ship their implementations, `ProjectsModule` injects stub implementations
that return `0` and mark the module as unavailable. This is captured as a TODO in plan.md and
surfaced in `unavailableModules` in the P&L response.

**Rationale**: Defining the interface contract now prevents future modules from shipping
incompatible signatures; the stub pattern keeps the P&L endpoint fully functional and testable
today without blocking on 006/007.

**Alternatives considered**: Wait for 006/007/008 to ship before implementing P&L — rejected: the
P&L endpoint is valuable even with partial data; the stub pattern is a standard interface-first
design technique.

## 11. Project Code auto-generation

**Decision**: Settings' existing `CodeSeriesService.nextCode('PROJECTS', companyId)` is called
when `POST /projects` receives no `code`. If the `PROJECTS` series type does not yet exist in
Settings' seed data, `ProjectsModule` creates it on first use (with a sensible default prefix,
e.g. `PRJ-`) rather than erroring. The generated code is unique per company.

**Rationale**: Reusing 002's code-series service keeps code-generation logic centralised (Principle
III); adding a PROJECTS series type is a trivial Settings seed extension, not a new mechanism.

**Alternatives considered**: A projects-specific sequential code generator — rejected: duplicates
the settings code-series mechanism for no benefit; also harder to customise prefix/format later.
