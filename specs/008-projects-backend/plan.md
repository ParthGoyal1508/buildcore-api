# Implementation Plan: Projects Backend (Portfolio, Clients, Sites, BOQ, DWR, Revenue, P&L)

**Branch**: `008-projects-backend` | **Date**: 2026-08-27 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/008-projects-backend/spec.md`

## Summary

Build the `projects` schema — populated for the first time by 003's minimal `Site` table, now
substantially extended by this feature — delivering: Client and Site masters (Site already lives
in `projects` schema and already carries geofence/holiday data from 003; this feature adds
`projectId`/`address`/`status` and a general-purpose `getSiteById()` export alongside 003's
existing narrow geofence exports, which HR keeps using unchanged), a full Project portfolio with
lock enforcement, BOQ task management with a two-step validate-then-confirm Excel import, Daily
Work Reports with server-side measurement-formula computation and Approved-only BOQ progress
counting, Revenue and RA Bill tracking with a three-state workflow, project budget entry,
cross-module P&L (on-demand via `Promise.allSettled` — Machinery/Fuel real via 006, Labour real
via a 005 amendment this feature required, Material/Subcontractor still stubbed pending
Inventory/Partners), and per-project document uploads. `PROJECTS` is reused from Settings' 002
enum; `DWR` and `PROJECT_FINANCIALS` are genuinely new and have been reconciled into 002's own
spec as the canonical enum source. See [research.md](research.md) for all fourteen architecture
decisions (eleven original + corrections/additions from the master-PRD alignment audit).

## Technical Context

**Language/Version**: TypeScript 5.1, Node.js, NestJS 10, Prisma 5 against PostgreSQL — unchanged.

**Primary Dependencies**: Existing only — `class-validator`/`class-transformer`, `@nestjs/swagger`,
`@nestjs/config`, `nestjs-prisma`, 001/002's guards, `exceljs` (pre-approved constitution v1.2.0
for BOQ import), 005's object-storage reference pattern for document uploads. No new architectural
dependency.

**Storage**: PostgreSQL via Prisma — `projects` schema (already exists from 003, which put `Site`
there) gets 11 new tables from this feature plus an additive extension to `Site`: `Client`,
`Project`, `Site` (extended — `projectId`/`address`/`status` added; geofence fields already
existed from 003), `BOQTaskGroup`, `BOQTaskItem`, `DailyWorkReport`, `DWRTask`, `Revenue`,
`RABill`, `WorkOrder`, `ProjectBudget`, `ProjectDocument`.

**Testing**: Jest unit tests for: `ProjectLockGuard`, `DWRTaskService.computeActualQty()` and the
approve-only `doneQty` update path, `ProjectPnlService.compute()` (Inventory/Partners stubs return
0; Machinery/Fuel/Labour call real 006/005 methods), BOQ Excel two-step validate/confirm logic, RA
Bill state machine transition guard. E2e coverage in `test/projects.e2e-spec.ts` — required for
all endpoints touching financial data (P&L, RA Bills, Budget) and the lock-enforcement path.

**Target Platform**: Linux server (Node.js), same as rest of `buildcore-api`.

**Project Type**: Web service (backend API) — single NestJS project; new `projects` NestJS module
alongside the existing `hr`, `payroll`, `settings`, `shared` modules.

**Performance Goals**: `GET /projects/:id/pnl` responds in under 2 seconds for a project with 12
months of data (cross-module stubs return immediately; real implementations must meet this SLA).
BOQ import of 100 rows under 5 seconds (spec SC-004).

**Constraints**: `projects` module never queries `hr`/`payroll`/`inventory`/`plant`/`partners`
schemas directly — only via exported service calls (Principle I, research.md §3, §10); `Site`'s
extension is additive (nullable new columns only — geofence columns are untouched, not re-added)
to avoid breaking 003's FK references or HR's existing exported-method call sites (research.md
§2); `ProjectLockGuard` is the single enforcement point for the `isLocked` rule across all write
endpoints (research.md §6); all tables `companyId`-scoped with RLS policies (Principle IV);
Permission enum extended in `settings` module's own canonical enum, not redefined locally
(research.md §8, §14); BOQ import never commits from the `validate` call (research.md §12); BOQ
`doneQty` only moves on DWR approval, never submission (research.md §13).

**Scale/Scope**: 11 new tables + 1 extended (`Site`), ~36 endpoints across 10 controller areas, 2
new Permission enum values (`DWR`, `PROJECT_FINANCIALS`; `PROJECTS` reused), 2 cross-module
service stubs (Inventory, Partners — Machinery/Fuel and Labour are real via 006/005).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Check | Status |
|---|---|---|
| I. Schema-Per-Module Boundaries (NON-NEGOTIABLE) | All 11 new tables land in `projects` schema, which already existed (003 put `Site` there). Cross-module reads (P&L, employee names, machinery, materials, subcontractors) go via exported service calls — never direct cross-schema queries. HR keeps reading `Site` geofence/holiday data via 003's existing `SitesService.getGeofence()`/`.getHolidayCalendar()`/`.getWeeklyOffDay()`, unchanged; this feature's own consumers use a new, separate `getSiteById()`. research.md §2, §3, §10. | PASS |
| II. Validated DTO Contracts (NON-NEGOTIABLE) | Every endpoint in contracts/projects-api.md uses a typed DTO. `ProjectLockGuard` validates `isLocked` before any write reaches a service method. | PASS |
| III. Centralized Configuration & No Hardcoded Values (NON-NEGOTIABLE) | No hardcoded project codes, status values, or category names — all are enums or config-driven. The 10% overrun threshold (FR-009) is a named constant in a shared constants file, not an inline literal. | PASS |
| IV. Multi-Tenant Isolation & PII Protection (NON-NEGOTIABLE) | All 12 tables carry `companyId`; RLS policies enforced on every table. No regulated PII in this module (no Aadhaar/PAN/bank data). Project documents use encrypted object-storage references (same pattern as 005's `EmployeeDocument`). | PASS |
| V. Authentication, Authorization & Secrets Hygiene | Every endpoint behind `JwtAuthGuard` + `@RequirePermission()` using `PROJECTS` (reused from 002), `DWR`, or `PROJECT_FINANCIALS` (both new, reconciled into 002's own enum — research.md §8, §14). | PASS |
| VI. Observability & Safe Migrations | `Site`'s extension is additive (new nullable columns only; existing geofence columns untouched) — no data loss risk. `projects` schema's 11 new tables added in a separate migration from the `Site` extension. All migrations via `migrate:dev:create`/`migrate:dev`. | PASS |

**Post-design re-check**: data-model.md and contracts/projects-api.md keep every table
tenant-scoped, every financial endpoint permission-gated with `PROJECT_FINANCIALS`, cross-module
calls via interfaces not direct queries, and the lock guard applied consistently. Still PASS.

## Project Structure

### Documentation (this feature)

```text
specs/008-projects-backend/
├── plan.md                    # This file
├── research.md                # Phase 0 output
├── data-model.md              # Phase 1 output
├── quickstart.md              # Phase 1 output
└── contracts/
    └── projects-api.md        # Phase 1 output
```

### Source Code

```text
src/
├── projects/
│   ├── projects.module.ts
│   ├── clients/
│   │   ├── clients.controller.ts
│   │   ├── clients.service.ts
│   │   └── dto/
│   │       ├── create-client.dto.ts
│   │       └── update-client.dto.ts
│   ├── sites/
│   │   ├── sites.controller.ts
│   │   ├── sites.service.ts
│   │   └── dto/
│   ├── portfolio/
│   │   ├── projects.controller.ts
│   │   ├── projects.service.ts
│   │   └── dto/
│   ├── boq/
│   │   ├── boq.controller.ts
│   │   ├── boq.service.ts
│   │   ├── boq-import.service.ts   # exceljs parsing + CSV error report
│   │   └── dto/
│   ├── dwr/
│   │   ├── dwr.controller.ts
│   │   ├── dwr.service.ts
│   │   └── dto/
│   ├── revenue/
│   │   ├── revenue.controller.ts
│   │   ├── revenue.service.ts
│   │   └── dto/
│   ├── pnl/
│   │   ├── pnl.controller.ts
│   │   └── pnl.service.ts          # Promise.allSettled over 4 cross-module stubs
│   ├── guards/
│   │   └── project-lock.guard.ts   # 423 if Project.isLocked
│   └── interfaces/
│       └── pnl-sources.interface.ts # contracts 4 source-module services must satisfy
├── settings/
│   └── permission.enum.ts          # MODIFIED: +PROJECTS, +DWR, +PROJECT_FINANCIALS

prisma/
└── schema.prisma                   # MODIFIED: projects schema, 12 new models, Site extended

test/
└── projects.e2e-spec.ts            # new
```

## Implementation Phases

### Phase 1: Schema & Shared Infrastructure

- [ ] Extend `settings.Permission` enum with `DWR`, `PROJECT_FINANCIALS` (`PROJECTS` already
  exists — reused, not re-added) — also reflected in 002's own data-model.md/tasks.md
- [ ] Add `projectId`, `address`, `status` columns to the existing `Site` model — additive
  migration only; 003's geofence columns (`latitude`/`longitude`/`geofenceRadiusMeters`) and
  `weeklyOffDay`/`holidays` are untouched, and existing FK references (HR's `PunchRecord`) are
  unaffected
- [ ] Add the 11 new `projects` schema models to `prisma/schema.prisma`
- [ ] Generate and apply migrations (Site extension first; then the 11 new tables in one migration)
- [ ] Add RLS policies for all `projects` schema tables
- [ ] Create `project-lock.guard.ts`
- [ ] Create `pnl-sources.interface.ts`: stub implementations for Inventory/Partners only (return
  0); wire the real `PlantService.getMachineryCostByProject()`/`.getFuelCostByProject()` (006) and
  `HrPayrollService.getLabourCostByProject()` (005, amended by this feature) — not stubs
- [ ] Scaffold `ProjectsModule` with the 7 sub-module structure above

**Checkpoint**: Schema, guard, and module scaffold complete. All other phases can proceed in
parallel per user story.

### Phase 2: User Stories 1 & 2 — Clients and Sites (P1)

- [ ] `ClientsController` + `ClientsService` + DTOs
- [ ] `SitesController` + `SitesService` + DTOs, extending 003's existing `sites.service.ts` in
  place (adds `projectId`/`address`/`status` CRUD and a new `getSiteById()` export for this
  feature's own consumers — 003's `getGeofence()`/`getHolidayCalendar()`/`getWeeklyOffDay()`
  exports are untouched)
- [ ] Unit tests for duplicate-GSTIN rejection, site status validation
- [ ] E2e tests for `POST /projects/clients`, `POST /projects/sites`

**Checkpoint**: Client and Site CRUD functional (Sites now carry `projectId`/`address`/`status`
alongside 003's existing geofence/holiday data); HR's attendance geofence validation is unaffected
by this feature (it was already using real radius data from 003).

### Phase 3: User Story 3 — Project Portfolio (P1)

- [ ] `ProjectsController` (portfolio) + `ProjectsService` + DTOs
- [ ] Code-series integration (`CodeSeriesService.nextCode('PROJECTS', companyId)`)
- [ ] `GET /projects/:id` aggregated tabs (cross-module calls with stub services)
- [ ] `isLocked` toggle audit logging
- [ ] E2e tests for portfolio CRUD, lock/unlock, `DELETE` 409 guard

**Checkpoint**: Portfolio CRUD and lock enforcement functional.

### Phase 4: User Story 4 — BOQ (P2)

- [ ] `BOQController` + `BOQService` + DTOs
- [ ] `BOQImportService` (exceljs parsing, 9-column validation, CSV error report) with two
  endpoints: `POST .../boq/import/validate` (parse + report, no writes) and
  `POST .../boq/import/confirm { batchId }` (commits the validated batch) — research.md §12
- [ ] `GET /projects/:id/boq/alerts` (Today Task, Delayed, To Be Delayed)
- [ ] Unit tests for BOQ import validate/confirm split, `doneQty` computation
- [ ] E2e test for validate → mixed valid/invalid report → confirm → only valid rows created

**Checkpoint**: BOQ management and import functional.

### Phase 5: User Story 5 — DWR (P2)

- [ ] `DWRController` + `DWRService` + DTOs
- [ ] `DWRTaskService.computeActualQty()` with formula and `exceedsScope` flag, computed and
  stored at creation regardless of status
- [ ] BOQ `doneQty` increment on DWR **approval** — not submission (research.md §13)
- [ ] File attachment endpoint
- [ ] Unit tests for formula computation (zero-value case, scope exceeded) and for `doneQty`
  remaining unchanged through submission and only moving on approval
- [ ] E2e tests for DWR creation, submission (doneQty unchanged), approval (doneQty updates)

**Checkpoint**: DWR lifecycle fully functional; BOQ progress tracking live and Approved-only.

### Phase 6: User Stories 6 & 7 — Revenue, RA Bills, Budget, P&L (P3)

- [ ] `RevenueController` + `RevenueService` + DTOs
- [ ] `RABillController` + `RABillService` with state machine transitions + DTOs
- [ ] `WorkOrderController` + `WorkOrderService` + DTOs
- [ ] `BudgetController` + `BudgetService` (upsert per category)
- [ ] `PnlController` + `PnlService` (Promise.allSettled, 10% overrun flag, period filter)
- [ ] Unit tests for RA Bill transition guard, P&L computation with stubs
- [ ] E2e tests for RA Bill workflow, P&L endpoint with partial unavailability

**Checkpoint**: Financial workflows and P&L endpoint functional.

### Phase 7: User Story 8 — Project Documents (P3)

- [ ] `ProjectDocumentController` + `ProjectDocumentService` + DTOs
- [ ] Object-storage reference pattern (same as 005's `EmployeeDocument`)
- [ ] E2e test for document upload, list, delete

**Checkpoint**: All user stories complete.

## TODO: Cross-module Service Stubs (remaining — corrected, research.md §10)

Only two of the original four P&L sources are still stubbed. Machinery/Fuel (006) and Labour (005)
are real, not stub, as of this feature's master-PRD alignment audit:

- `InventoryServiceStub.getMaterialCostByProject()` → to be replaced by feature 009 (Inventory)
- `PartnersServiceStub.getSubcontractorCostByProject()` → to be replaced by feature 007 (Partners)
- ~~`PlantServiceStub.getMachineryCostByProject()`/`.getFuelCostByProject()`~~ → real, implemented
  by feature 006 (Plant/Machinery) — wire directly, no stub needed
- ~~`HrPayrollService.getLabourCostByProject()`~~ → real, added directly to 005's own spec/
  data-model/tasks as part of this feature's build-out (`PayrollLineItem.projectId`, FR-046,
  005's research.md §16) — wire directly, no stub needed

---

## Amendment 2026-09-01 — Project Planning & Target-vs-Actual Reporting

Covers spec FR-019 to FR-035. Adds 4 `projects` tables; **no new permission value** (reuses
`PROJECTS` and `REPORTS`).

**Constitution re-check**: Principle I — all 4 tables in `projects`; man-days, equipment hours, and
material consumed for the monthly report come through `LabourService`, `PlantService`, and
`InventoryService`, never a cross-schema query (FR-033), consistent with FR-008's existing P&L rule.
Principle III — behind-schedule tolerance is configured, not a literal. Principle IV — `companyId` +
RLS. Principle V — no new permission. PASS.

### Phase A1: Schema

- [ ] Add `ProjectPhase`, `ProjectActivity`, `ActivityDependency`, `ProjectTarget` /
      `ProjectTargetLine` models; migration + RLS
- [ ] Extend `shared.AuditLogEntry.entityType` with `PROJECT_PHASE`, `PROJECT_ACTIVITY`,
      `PROJECT_TARGET`
- [ ] Extend the existing project-lock guard (FR-003) to cover all schedule and target writes
      (FR-024)

### Phase A2: US9 — Schedule (P2)

- [ ] `PhaseService`, `ActivityService` + controllers (CRUD, date-order validation, milestone
      marking, delete guard for activities with actuals → 409 — FR-025)
- [ ] `DependencyService`: typed links with cycle detection naming the cycle path (FR-020);
      dependency violations flagged, not blocked (FR-021)
- [ ] Baseline endpoint: weightage-sums-to-100 gate (FR-022), freeze planned values as immutable
      baseline, increment version (FR-023)
- [ ] Unit test: cycle detection within and across phases; baseline immutability under later edits
      (SC-A02)
- [ ] E2e test: baseline gate rejects a 97% weightage sum reporting the actual total

### Phase A3: US10 — Targets & Reporting (P2)

- [ ] `TargetService` + controller (periodic target sets, overlap guard → 409 — FR-026)
- [ ] `TargetReportService`: actuals summed from approved DWR measurements only (FR-027), unset
      targets reported explicitly rather than as zero (FR-028), weightage-weighted rollup stating
      its basis (FR-029)
- [ ] Monthly report pulling man-days / equipment hours / material via the cross-module services
      (FR-033); progress-trend series for the chart
- [ ] XLSX/PDF export, async above threshold (FR-035)
- [ ] Unit test: achievement math; unset-target handling; actuals reconcile with DWR (SC-A01)

### Phase A4: US11 — Schedule Variance (P3)

- [ ] `VarianceService`: per-activity status, percent complete from quantity where available else
      the manual value with the source marked (FR-030), behind-schedule flagging with day slippage
      and critical-path marking (FR-031), explicit no-baseline response (FR-032)
- [ ] Unit test: percent-complete source selection; slippage computation; no-baseline path

---

## Amendment 2026-10-03 — BOQ entry and import (FR-036 – FR-046)

**What changed in this plan**: Phase 4 above is superseded in three specifics and otherwise stands.
Its `BOQImportService (exceljs parsing, 9-column validation, …)` line is wrong on both counts —
`exceljs` cannot read the client's file, and there is no 9-column schedule — and Phase 1's schema
work needs one migration it never anticipated. Nothing else in this plan is touched: US1–US3,
US5–US8 and the 2026-09-01 planning amendment are unchanged, and the phases below are additive.

**Why now**: nothing writes a BOQ, so 018's billing cannot be used. See spec Amendment 2026-10-03.

### Verified before planning, not assumed

- **No code reads the programme fields.** `perDayQty`, `avgQtyPerDay` and `daysToComplete` appear
  nowhere in `src/`. The only existing reads of either BOQ table are
  `ProjectsService.getActivityById` and `getBoqItemById`, which select `id`, `name`/`taskName`,
  `boqNo` and `projectId` only. Making the programme fields nullable therefore breaks no consumer —
  checked rather than hoped, because the opposite finding would have changed this plan's order.
- **`getAlerts` has no implementation to change.** There is no `src/projects/boq/` directory and no
  DWR module; the alert behaviour FR-037 constrains is being written for the first time, not
  retrofitted.
- **`ProjectLockGuard` already exists** (`src/projects/guards/project-lock.guard.ts`, research §6),
  so the lock rule is `@UseGuards()` on the new writes and nothing more.
- **The fixture is 680KB, not 3.6MB**, and is already committed at `docs/BOQ_794578.xls`.

### Phase B1: The migration that makes a tender schedule storable

- [ ] One migration making `BOQTaskItem.startDate`, `finishDate`, `duration`, `perDayQty` and
      `BOQTaskGroup.startDate`, `finishDate` nullable (FR-037). Widening a column to nullable is
      safe on a populated table and these tables are empty in every environment, so no backfill.
- [ ] `SELECT set_config('app.is_super_admin','true',true)` first, per the RLS migration convention.
- [ ] No new table and no new RLS policy: nothing is added, only relaxed.

**Checkpoint**: a BOQ line can exist without a programme.

### Phase B2: The parser boundary (constitution v1.5.0)

- [ ] `BoqWorkbookReader` in `src/projects/boq/boq-workbook.reader.ts` — the **only** place SheetJS
      is imported. It takes a buffer and returns plain rows (`{ rowNumber, cells: (string | number |
      null)[] }`); no caller ever holds a workbook, a worksheet or a cell object, which is what makes
      replacing the library one file's work.
- [ ] `xlsx` pinned to `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` with the lockfile
      integrity hash committed. **Not** `npm install xlsx`: the registry build is 0.20.5's
      predecessor 0.18.5, carrying CVE-2023-30533 and CVE-2024-22363. Prohibited by the constitution,
      so a lockfile entry resolving to `registry.npmjs.org` fails review.
- [ ] Both formats through one entry point: `.xlsx` continues to `exceljs`, `.xls` to SheetJS. The
      reader decides from the content, not the filename — a renamed file is the common case.
- [ ] **The refusal is the point of this phase.** A workbook that cannot be parsed, parses to zero
      sheets, or yields no candidate schedule rows throws a named refusal
      (`BOQ_WORKBOOK_UNREADABLE`, `BOQ_WORKBOOK_EMPTY`). `exceljs` returns `{ worksheets: [] }` for
      the client's real file with no error at all — verified 2026-10-03 — so the empty case is a
      *measured* behaviour of a library we keep, not a defensive hypothetical.
- [ ] Unit tests on the reader alone: a real `.xls`, a real `.xlsx`, a text file renamed `.xls`, and
      a workbook with no sheets.

**Checkpoint**: bytes become rows, or a refusal that says which condition it hit.

### Phase B3: `validate` — everything decided before anything is written

- [ ] `BOQImportService.validate(projectId, buffer)` → `{ batchId, groups, lines, totals, errors,
      warnings, errorReportUrl? }`, writing **nothing**.
- [ ] **Where the batch is held**: in process memory, keyed by `batchId`, with a TTL and a cap on
      concurrent batches. Rejected: a staged table in the manner of 017's `StagedProjectDocument`,
      which would need an RLS policy, a sweep and a retention answer for data whose entire purpose
      is to be discarded minutes later; the only cost of losing a batch is re-uploading the file.
      **Named trade-off**: a batch validated on one instance is invisible to another, so this holds
      only while the API runs as a single instance. Horizontally scaling it is the trigger to move
      the batch into Postgres, and that is recorded here rather than discovered as an intermittent
      "batch not found".
- [ ] **Hierarchy** (FR-038): a row with a description and no quantity opens a group; rows below it
      are its items until the next such row. Deeper nesting folds the outer heading text into the
      group name. A quantity row before any heading goes to a group named for the sheet and raises a
      **warning**, not an error — the rows are good and the structure is merely unstated.
- [ ] **Units** (FR-041): `normaliseUnit()` lowercases, strips periods and collapses whitespace, so
      `R. Mtr.`, `R.Mtr.` and `R mtr` agree. The source string is stored verbatim on the line; the
      normalised form is for matching only. `Excess (+)`, which appears *in the units column* on the
      quoted-rate row, must resolve to no unit rather than to a unit named "excess".
- [ ] **Block discipline** (FR-042): read only the columns of the identified schedule. The sample
      carries a second block at columns 238–242 with 216 item-shaped rows — artefacts of the
      template's other BOQ types, which the workbook names in its own defined names (`Percentage`,
      `Discount BoQ`, `Negative BoQ`, Item Rate, Turnkey). A scan for "populated columns" finds them
      and doubles the tender silently.
- [ ] **Pre-GST columns** (FR-043): Excise Duty, VAT, DGS&D/RITES inspection, Cenvat credit are
      read, found blank, and dropped. They are not errors and they are not data.
- [ ] **Arithmetic** (FR-044): line amount is `quantity × rate`, computed as `Prisma.Decimal`. The
      file's own figures carry float noise (`178.09326499999995`, `29961506.782150004`) and are used
      only as the thing to reconcile against, never as input.
- [ ] **The percentage** (FR-039, FR-040): locate `Excess (+)` / `Quoted Rate` in the footer. Found
      → carried on the batch for `confirm` to set. Not found → `quotedPercentage: null` and a
      first-class entry in the report. **Never 0**: zero is a valid percentage, so that failure is
      silent and under-bills every line by the true figure — 2.46% and ₹7.37 lakh on this file.
- [ ] **Reconciliation** (FR-045): report the derived schedule total and derived quoted total beside
      the two the workbook states, with the difference. An import that read the file correctly can
      prove it.
- [ ] **The row cap is judged on candidate schedule rows, not raw sheet rows.** Research §4's
      1,000-row `413` predates the sample, whose sheet holds far more raw rows than schedule lines
      once the second block and the headings are accounted for. Judged on raw rows, the client's own
      file could be refused for being too large while containing 312 lines.

**Checkpoint**: the client's file produces a report that reconciles, and the database is untouched.

### Phase B4: `confirm` — one transaction, once

- [ ] `confirm(batchId)` commits in a single `$transaction`: groups created on first reference, then
      their items, then `Project.quotedPercentage` **only if the percentage was found**.
- [ ] **Idempotent by consuming the batch**: the batch is removed as the transaction commits, so a
      second confirm is refused (`BOQ_BATCH_NOT_FOUND`) rather than appending the schedule again. A
      double-submitted confirm is the ordinary way a 312-line tender gets entered twice, and the
      duplicate would be indistinguishable from a real re-tender.
- [ ] Unit tests: confirm writes exactly the validated lines; a second confirm is refused; a batch
      with no percentage leaves `quotedPercentage` untouched rather than writing 0.

**Checkpoint**: a BOQ exists, and 018's billing has something to measure against.

### Phase B5: Entry by hand, and the alerts

- [ ] `BOQService`: `createGroup`, `createItem`, `getTree` (with `pendingQty`, `avgQtyPerDay`,
      `daysToComplete` computed), `getAlerts`, `updateDoneQty` (called on DWR **approval**, research
      §13), `deleteItem` (`409` if a `DWRTask`, `ClientBillLine` or `WorkOrderBOQItem` references it
      — three relations, not one).
- [ ] `getAlerts` returns four groups, not three: Today, Delayed, To Be Delayed and **Unplanned**
      (FR-037). An unplanned line appears in exactly one of them and it is the fourth.
- [ ] `BOQController` with `Permission.PROJECTS` and `ProjectLockGuard` on every write.
- [ ] DTOs with the programme fields optional, matching FR-037 rather than the August DTO sketch.

**Checkpoint**: a BOQ can be entered without a spreadsheet at all.

### Test strategy, stated because the fixture is client data

The real file is the only honest test of FR-042 and FR-045, and it is 680KB of a client's tender
already committed at `docs/BOQ_794578.xls`. Two tiers, so that neither its presence nor its absence
decides whether the suite is meaningful:

- [ ] **A committed synthetic `.xls`** reproducing each pathology in miniature: two levels with
      heading rows carrying no quantity, one unit spelled four ways, a second item-shaped block in
      far columns, the four blank tax columns, float-noisy totals, and a footer percentage. Every
      assertion that must hold forever runs against this.
- [ ] **An opt-in test against the real file** that skips with a stated reason when the file is
      absent, asserting the three figures only it can: **~312 lines and not ~528**, the 26 unit
      spellings resolving to ~12 units with `Excess (+)` resolving to none, and the computed grand
      total against the file's own `2,99,61,506.78` and `3,06,98,559.85`.
- [ ] A skipped test reports as skipped, never as passed. The repository must stay usable by someone
      who cannot hold the client's tender data.

### Constitution re-check, post-design (v1.5.0)

- **Principle III, centralized config**: the batch TTL, the concurrent-batch cap and the 1,000-row
  threshold go in centralized config, not inline constants. Three numbers that will be tuned the
  first time somebody uploads something unusual.
- **v1.5.0's boundary clause**: satisfied by `BoqWorkbookReader` being the sole importer of `xlsx`
  and returning plain rows. A test asserts no other file imports it, because the constraint decays
  silently — the second import would work perfectly and nobody would notice.
- **FR-014 audit**: "BOQ import" is already in FR-014's list, so `confirm` writes **one** audit
  entry naming the project, the batch, the line and group counts and whether the quoted percentage
  was set — not 312 entries. One import is one act; 312 rows in the log would bury the next thing.
- **Principle IV**: the uploaded workbook is client commercial data. It is parsed in memory and not
  persisted — no object-storage write, so no new blob to encrypt or audit. Worth stating because the
  obvious next feature request ("keep the file we imported") would change that answer.
