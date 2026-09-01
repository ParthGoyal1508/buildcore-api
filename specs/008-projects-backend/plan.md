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
