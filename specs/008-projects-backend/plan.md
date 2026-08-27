# Implementation Plan: Projects Backend (Portfolio, Clients, Sites, BOQ, DWR, Revenue, P&L)

**Branch**: `008-projects-backend` | **Date**: 2026-08-27 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/008-projects-backend/spec.md`

## Summary

Build the `projects` schema — the first feature to populate it — delivering: Client and Site
masters (Site replacing 003's placeholder and taking ownership of geofence data from HR), a full
Project portfolio with lock enforcement, BOQ task management with Excel import, Daily Work Reports
with server-side measurement-formula computation, Revenue and RA Bill tracking with a three-state
workflow, project budget entry, cross-module P&L (on-demand via `Promise.allSettled` over four
exported service stubs), and per-project document uploads. Three new `Permission` enum values
extend Settings' 002 enum. See [research.md](research.md) for all eleven architecture decisions.

## Technical Context

**Language/Version**: TypeScript 5.1, Node.js, NestJS 10, Prisma 5 against PostgreSQL — unchanged.

**Primary Dependencies**: Existing only — `class-validator`/`class-transformer`, `@nestjs/swagger`,
`@nestjs/config`, `nestjs-prisma`, 001/002's guards, `exceljs` (pre-approved constitution v1.2.0
for BOQ import), 005's object-storage reference pattern for document uploads. No new architectural
dependency.

**Storage**: PostgreSQL via Prisma — new `projects` schema with 12 tables: `Client`, `Project`,
`Site` (extended from 003's placeholder), `BOQTaskGroup`, `BOQTaskItem`, `DailyWorkReport`,
`DWRTask`, `Revenue`, `RABill`, `WorkOrder`, `ProjectBudget`, `ProjectDocument`.

**Testing**: Jest unit tests for: `ProjectLockGuard`, `DWRTaskService.computeActualQty()`,
`ProjectPnlService.compute()` (all cross-module stubs return 0), BOQ Excel validation logic, RA
Bill state machine transition guard. E2e coverage in `test/projects.e2e-spec.ts` — required for
all endpoints touching financial data (P&L, RA Bills, Budget) and the lock-enforcement path.

**Target Platform**: Linux server (Node.js), same as rest of `buildcore-api`.

**Project Type**: Web service (backend API) — single NestJS project; new `projects` NestJS module
alongside the existing `hr`, `payroll`, `settings`, `shared` modules.

**Performance Goals**: `GET /projects/:id/pnl` responds in under 2 seconds for a project with 12
months of data (cross-module stubs return immediately; real implementations must meet this SLA).
BOQ import of 100 rows under 5 seconds (spec SC-004).

**Constraints**: `projects` module never queries `hr`/`payroll`/`inventory`/`plant`/`partners`
schemas directly — only via exported service calls (Principle I, research.md §3, §10); `Site`
migration is additive (nullable columns) to avoid breaking 003's FK references (research.md §2);
`ProjectLockGuard` is the single enforcement point for the `isLocked` rule across all write
endpoints (research.md §6); all tables `companyId`-scoped with RLS policies (Principle IV);
Permission enum extended in `settings` module's enum, not redefined (research.md §8).

**Scale/Scope**: 12 new tables, ~35 endpoints across 10 controller areas, 3 new Permission enum
values, 4 cross-module service stubs.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Check | Status |
|---|---|---|
| I. Schema-Per-Module Boundaries (NON-NEGOTIABLE) | All 12 new tables land in `projects` schema. Cross-module reads (P&L, employee names, machinery, materials, subcontractors) go via exported service calls — never direct cross-schema queries. `Site` is moved to `projects`; HR reads it via `ProjectsService.getSiteById()`. research.md §2, §3, §10. | PASS |
| II. Validated DTO Contracts (NON-NEGOTIABLE) | Every endpoint in contracts/projects-api.md uses a typed DTO. `ProjectLockGuard` validates `isLocked` before any write reaches a service method. | PASS |
| III. Centralized Configuration & No Hardcoded Values (NON-NEGOTIABLE) | No hardcoded project codes, status values, or category names — all are enums or config-driven. The 10% overrun threshold (FR-009) is a named constant in a shared constants file, not an inline literal. | PASS |
| IV. Multi-Tenant Isolation & PII Protection (NON-NEGOTIABLE) | All 12 tables carry `companyId`; RLS policies enforced on every table. No regulated PII in this module (no Aadhaar/PAN/bank data). Project documents use encrypted object-storage references (same pattern as 005's `EmployeeDocument`). | PASS |
| V. Authentication, Authorization & Secrets Hygiene | Every endpoint behind `JwtAuthGuard` + `@RequirePermission()` using one of three new enum values: `PROJECTS`, `DWR`, `PROJECT_FINANCIALS` (research.md §8). | PASS |
| VI. Observability & Safe Migrations | Site migration is additive (nullable columns) — no data loss risk. `projects` schema tables added in a separate migration from the Site extension. All migrations via `migrate:dev:create`/`migrate:dev`. | PASS |

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

- [ ] Extend `settings.Permission` enum with `PROJECTS`, `DWR`, `PROJECT_FINANCIALS`
- [ ] Add geofence columns (address, latitude, longitude, geofenceRadius) to existing `Site`
  model — additive migration only; existing `hr` FK references unaffected
- [ ] Add all 12 `projects` schema models to `prisma/schema.prisma`
- [ ] Generate and apply migrations (Site extension first; then `projects` schema in one migration)
- [ ] Add RLS policies for all `projects` schema tables
- [ ] Create `project-lock.guard.ts`
- [ ] Create `pnl-sources.interface.ts` with stub implementations (all return 0)
- [ ] Scaffold `ProjectsModule` with the 7 sub-module structure above

**Checkpoint**: Schema, guard, and module scaffold complete. All other phases can proceed in
parallel per user story.

### Phase 2: User Stories 1 & 2 — Clients and Sites (P1)

- [ ] `ClientsController` + `ClientsService` + DTOs
- [ ] `SitesController` + `SitesService` + DTOs (includes `getSiteById()` exported method for HR)
- [ ] Unit tests for duplicate-GSTIN rejection, site status validation
- [ ] E2e tests for `POST /projects/clients`, `POST /projects/sites`

**Checkpoint**: Client and Site CRUD functional; HR geofence validation now uses real radius.

### Phase 3: User Story 3 — Project Portfolio (P1)

- [ ] `ProjectsController` (portfolio) + `ProjectsService` + DTOs
- [ ] Code-series integration (`CodeSeriesService.nextCode('PROJECTS', companyId)`)
- [ ] `GET /projects/:id` aggregated tabs (cross-module calls with stub services)
- [ ] `isLocked` toggle audit logging
- [ ] E2e tests for portfolio CRUD, lock/unlock, `DELETE` 409 guard

**Checkpoint**: Portfolio CRUD and lock enforcement functional.

### Phase 4: User Story 4 — BOQ (P2)

- [ ] `BOQController` + `BOQService` + DTOs
- [ ] `BOQImportService` (exceljs parsing, 9-column validation, CSV error report)
- [ ] `GET /projects/:id/boq/alerts` (Today Task, Delayed, To Be Delayed)
- [ ] Unit tests for BOQ import validation, `doneQty` computation
- [ ] E2e test for import with mixed valid/invalid rows

**Checkpoint**: BOQ management and import functional.

### Phase 5: User Story 5 — DWR (P2)

- [ ] `DWRController` + `DWRService` + DTOs
- [ ] `DWRTaskService.computeActualQty()` with formula and `exceedsScope` flag
- [ ] BOQ `doneQty` increment on DWR submission
- [ ] File attachment endpoint
- [ ] Unit tests for formula computation (zero-value case, scope exceeded)
- [ ] E2e tests for DWR creation, submission, approval

**Checkpoint**: DWR lifecycle fully functional; BOQ progress tracking live.

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

## TODO: Cross-module Service Stubs (to be replaced by features 006/007)

The following stub implementations in `ProjectsModule` return 0 and mark the module unavailable
in the P&L response until the real features ship:

- `PlantServiceStub.getMachineryCostByProject()` → to be replaced by feature 006 (Plant/Machinery)
- `InventoryServiceStub.getMaterialCostByProject()` → to be replaced by feature 007 (Inventory)
- `PartnersServiceStub.getSubcontractorCostByProject()` → to be replaced by feature 007 (Partners)
- `HrPayrollService.getLabourCostByProject()` → HR & Payroll (005) must add `projectId` parameter
  to its payroll line item queries; this feature adds the interface requirement to 005's contract.
