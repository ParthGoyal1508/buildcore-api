---

description: "Task list for feature implementation"
---

# Tasks: Projects Backend (Portfolio, Clients, Sites, BOQ, DWR, Revenue, P&L)

**Input**: Design documents from `/specs/008-projects-backend/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md,
contracts/projects-api.md, quickstart.md

**Tests**: Included for financial endpoints (P&L, RA Bills, Budget), the lock guard, and the DWR
formula — as required by the constitution for financial data and custom business logic.

**Organization**: Tasks are grouped by user story (from spec.md) to enable independent
implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1–US8)
- Every task includes an exact file path

---

## Phase 1: Setup (Shared Infrastructure)

- [ ] T001 [P] Extend `src/settings/permission.enum.ts` with three new values: `PROJECTS`,
      `DWR`, `PROJECT_FINANCIALS` — spec FR-016, research.md §8
- [ ] T002 [P] Scaffold `src/projects/` directory and `ProjectsModule` in
      `src/projects/projects.module.ts` with the sub-module structure from plan.md
- [ ] T003 Create `src/projects/guards/project-lock.guard.ts`: reads `projectId` from route
      params, queries `Project.isLocked`, returns `423` if true — research.md §6
- [ ] T004 [P] Create `src/projects/interfaces/pnl-sources.interface.ts` defining the four
      cross-module service interfaces (`PlantService`, `InventoryService`, `PartnersService`,
      `HrPayrollService`) and stub implementations returning 0 — research.md §10
- [ ] T005 [P] Create `src/projects/constants/projects.constants.ts` with `COST_OVERRUN_THRESHOLD
      = 0.10` and `MAX_BOQ_IMPORT_ROWS = 1000` — Constitution Principle III (no hardcoded values)

**Checkpoint**: Module scaffold, lock guard, P&L stubs, and permission enum ready.

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [ ] T006 Add geofence columns to existing `Site` model in `prisma/schema.prisma`:
      `address String?`, `latitude Decimal?`, `longitude Decimal?`, `geofenceRadius Int?`,
      `status SiteStatus`, `projectId String?` FK→Project (nullable for backward compat),
      move model to `projects` schema block — data-model.md §Site, research.md §2
- [ ] T007 Add all 11 new `projects` schema models to `prisma/schema.prisma`: `Client`,
      `Project`, `BOQTaskGroup`, `BOQTaskItem`, `DailyWorkReport`, `DWRTask`, `Revenue`,
      `RABill`, `WorkOrder`, `ProjectBudget`, `ProjectDocument` — data-model.md
- [ ] T008 Generate and apply Site extension migration first (`npm run migrate:dev:create` for
      the Site additive columns), then generate and apply the `projects` schema migration for
      all 11 new models — Constitution Principle VI (schema-per-module, safe migrations)
- [ ] T009 Add RLS policies for all `projects` schema tables (Client, Project, Site, BOQTaskGroup,
      BOQTaskItem, DailyWorkReport, DWRTask, Revenue, RABill, WorkOrder, ProjectBudget,
      ProjectDocument) — Constitution Principle IV
- [ ] T010 [P] Extend `shared.AuditLogEntry.entityType` enum with: `PROJECT`, `CLIENT`, `SITE`,
      `BOQ_GROUP`, `BOQ_ITEM`, `DWR`, `REVENUE`, `RA_BILL`, `WORK_ORDER`, `PROJECT_BUDGET`,
      `PROJECT_DOCUMENT` — contracts/projects-api.md "Audit logging"
- [ ] T011 [P] Update `src/hr/sites/sites.service.ts` (or equivalent HR attendance service) to
      call `ProjectsService.getSiteById(siteId)` instead of querying `hr.Site` directly —
      research.md §2 (HR reads geofence data via exported method, not cross-schema query)

**Checkpoint**: Schema, RLS, audit enum, and HR→Projects service wiring complete. All user story
phases can now proceed in parallel per story grouping.

---

## Phase 3: User Story 1 — Manage Clients (Priority: P1) 🎯 MVP

**Goal**: Full Client CRUD with GSTIN uniqueness, soft-delete guard, paginated list.

**Independent Test**: Create a client, edit it, attempt duplicate GSTIN (→ 409), toggle inactive,
verify listed correctly — without any project data.

### Implementation for User Story 1

- [ ] T012 [P] [US1] Create `src/projects/clients/dto/create-client.dto.ts` and
      `update-client.dto.ts` with class-validator decorators for all client fields
- [ ] T013 [P] [US1] Implement `ClientsService` in `src/projects/clients/clients.service.ts`:
      `create`, `findAll` (paginated, filtered), `update`, `softDelete` (set inactive), GSTIN
      uniqueness check (→ 409), linked-project guard on delete (→ 409)
- [ ] T014 [US1] Implement `ClientsController` in `src/projects/clients/clients.controller.ts`:
      `GET /projects/clients`, `POST /projects/clients`, `PATCH /projects/clients/:id`,
      `DELETE /projects/clients/:id` — all with `@RequirePermission(Permission.PROJECTS)`
- [ ] T015 [P] [US1] Unit test `ClientsService`: duplicate GSTIN path, delete with linked
      projects path — `src/projects/clients/clients.service.spec.ts`
- [ ] T016 [US1] E2e test: `POST /projects/clients` → 201, duplicate GSTIN → 409, `GET` list
      with search/status filter — `test/projects.e2e-spec.ts` (create the file)

**Checkpoint**: Client CRUD fully functional and independently tested.

---

## Phase 4: User Story 2 — Manage Sites (Priority: P1)

**Goal**: Full Site CRUD using the extended Site model; exports `getSiteById()` for HR module;
geofence columns included.

**Independent Test**: Create a site with lat/lng/radius, edit it, set inactive, confirm HR's
attendance geofence validation now uses the real radius.

### Implementation for User Story 2

- [ ] T017 [P] [US2] Create `src/projects/sites/dto/create-site.dto.ts` and
      `update-site.dto.ts` with lat/lng range validation (`@Min(-90)/@Max(90)` for lat,
      `@Min(-180)/@Max(180)` for lng, `@IsPositive()` for radius)
- [ ] T018 [P] [US2] Implement `SitesService` in `src/projects/sites/sites.service.ts`:
      `create`, `findAll` (filtered by projectId/status), `findOne`, `update`, `delete` (→ 409
      if active employees or DWRs reference site), plus `getSiteById(id)` exported method for
      HR module consumption
- [ ] T019 [US2] Implement `SitesController` in `src/projects/sites/sites.controller.ts`:
      `GET /projects/sites`, `POST /projects/sites`, `GET /projects/sites/:id`,
      `PATCH /projects/sites/:id`, `DELETE /projects/sites/:id` — `Permission.PROJECTS`
- [ ] T020 [US2] Export `SitesService` from `ProjectsModule` so `HrModule` can inject it
      without a circular dependency — update `projects.module.ts`

**Checkpoint**: Site CRUD functional; HR module can read geofence data via `SitesService`.

---

## Phase 5: User Story 3 — Manage Project Portfolio (Priority: P1)

**Goal**: Full Project CRUD with code-series auto-generation, aggregated detail endpoint, lock/
unlock with audit, delete guard.

**Independent Test**: Create a project (auto-generated code), view aggregated detail (empty tabs),
lock it (DWR write → 423), unlock (DWR write succeeds).

### Implementation for User Story 3

- [ ] T021 [P] [US3] Create `src/projects/portfolio/dto/create-project.dto.ts` and
      `update-project.dto.ts` covering all project fields from data-model.md
- [ ] T022 [P] [US3] Implement `ProjectsService` in
      `src/projects/portfolio/projects.service.ts`: `create` (calls CodeSeriesService for
      auto-code), `findAll` (paginated, search/status/client filtered), `findOne` (with
      aggregated tabs via cross-module stub calls), `update` (audit-log `isLocked` changes),
      `delete` (→ 409 if DWRs/revenue/RA bills/BOQ items exist)
- [ ] T023 [US3] Implement `ProjectsController` in
      `src/projects/portfolio/projects.controller.ts`: all 5 CRUD endpoints, `Permission.PROJECTS`
- [ ] T024 [P] [US3] Unit test `ProjectsService.findOne()`: verify cross-module stubs return
      empty arrays without error — `src/projects/portfolio/projects.service.spec.ts`
- [ ] T025 [US3] E2e test: `POST /projects` (auto-code), lock toggle → `POST /projects/dwr` 423,
      unlock → DWR succeeds, delete with DWRs → 409 — `test/projects.e2e-spec.ts`

**Checkpoint**: Portfolio CRUD and lock enforcement functional and e2e tested.

---

## Phase 6: User Story 4 — Manage BOQ (Priority: P2)

**Goal**: BOQ task group/item CRUD, Excel import with row-level validation and CSV error report,
BOQ alerts (Today/Delayed/To Be Delayed).

**Independent Test**: Create group + items, import a mixed-validity Excel (→ partial import +
error report), check alerts — no DWR data needed.

### Implementation for User Story 4

- [ ] T026 [P] [US4] Create BOQ DTOs: `create-boq-group.dto.ts`, `create-boq-item.dto.ts`,
      `import-boq.dto.ts` in `src/projects/boq/dto/`
- [ ] T027 [P] [US4] Implement `BOQImportService` in `src/projects/boq/boq-import.service.ts`:
      `exceljs` workbook parsing, 9-column schema validation, row-by-row error collection, valid
      rows committed in single Prisma transaction (group created on first reference), CSV error
      report generated as Buffer and stored to object storage, returns
      `{ imported, errors, errorReportUrl }` — research.md §4
- [ ] T028 [P] [US4] Unit test `BOQImportService`: all-valid file → 0 errors; file with 3
      invalid rows → correct error objects; file > 1000 rows → 413 thrown —
      `src/projects/boq/boq-import.service.spec.ts`
- [ ] T029 [US4] Implement `BOQService` in `src/projects/boq/boq.service.ts`:
      `createGroup`, `createItem`, `getTree` (groups + items with computed pendingQty/
      avgQtyPerDay/daysToComplete), `getAlerts` (today/delayed/toBeDelayed), `updateDoneQty`
      (called by DWR service on submission), `deleteItem` (→ 409 if DWRTask references it)
- [ ] T030 [US4] Implement `BOQController` in `src/projects/boq/boq.controller.ts`: all BOQ
      endpoints from contracts — `Permission.PROJECTS`, `ProjectLockGuard` on writes

**Checkpoint**: BOQ management and import fully functional.

---

## Phase 7: User Story 5 — Daily Work Reports (Priority: P2)

**Goal**: DWR CRUD with server-side Actual Qty computation, BOQ doneQty increment on submission,
approve workflow, file attachments.

**Independent Test**: Create DWR with measurement fields → verify server-computed actualQty,
submit → BOQ doneQty increments, approve → status = approved.

### Implementation for User Story 5

- [ ] T031 [P] [US5] Create DWR DTOs: `create-dwr.dto.ts` (with nested `DWRTaskInput[]`),
      `update-dwr.dto.ts` in `src/projects/dwr/dto/`
- [ ] T032 [P] [US5] Implement `DWRTaskService.computeActualQty(nos1, nos2, length, breadth,
      depth, density): number` in `src/projects/dwr/dwr-task.service.ts`: formula = nos1 × nos2
      × length × breadth × depth × density; zero-value handling (→ 0); `exceedsScope` flag check
      against BOQ item's scopeQty — research.md §5
- [ ] T033 [P] [US5] Unit test `DWRTaskService.computeActualQty()`: normal case, zero-value
      case, exceedsScope true and false — `src/projects/dwr/dwr-task.service.spec.ts`
- [ ] T034 [US5] Implement `DWRService` in `src/projects/dwr/dwr.service.ts`: `create` (auto-
      DPR number `{siteCode}-{seq}`, compute actualQty per task), `submit` (status → submitted,
      calls `BOQService.updateDoneQty()`), `approve` (status → approved, audit-log), `findAll`
      (paginated, filtered), `findOne`, `delete` (draft only), `addAttachment`
- [ ] T035 [US5] Implement `DWRController` in `src/projects/dwr/dwr.controller.ts`: all DWR
      endpoints — `Permission.DWR`, `ProjectLockGuard` on writes
- [ ] T036 [US5] E2e test: create DWR → verify actualQty, submit → BOQ doneQty check, approve,
      locked project → 423 — `test/projects.e2e-spec.ts`

**Checkpoint**: DWR lifecycle and BOQ progress tracking fully functional.

---

## Phase 8: User Story 6 — Revenue, RA Bills & Work Orders (Priority: P3)

**Goal**: Revenue CRUD, RA Bill three-state workflow (draft/submitted/approved), Work Order CRUD
— all gated by `PROJECT_FINANCIALS` and `ProjectLockGuard`.

**Independent Test**: Create revenue entry, create RA bill, submit → approve; verify approved
RA bill amount appears in P&L revenueBooked total.

### Implementation for User Story 6

- [ ] T037 [P] [US6] Create revenue/billing DTOs in `src/projects/revenue/dto/`:
      `create-revenue.dto.ts`, `create-ra-bill.dto.ts`, `reject-ra-bill.dto.ts` (requires
      `rejectionRemark`), `create-work-order.dto.ts`
- [ ] T038 [P] [US6] Implement `RevenueService` in `src/projects/revenue/revenue.service.ts`:
      `create`, `findAll`, `update`, `delete` — all audit-logged
- [ ] T039 [US6] Implement `RABillService` in `src/projects/revenue/ra-bill.service.ts`:
      state machine transitions (`submit`, `approve`, `reject` with mandatory remark), out-of-
      order transition → 409, approved bill immutability — research.md §7
- [ ] T040 [P] [US6] Unit test `RABillService` state machine: valid transitions, invalid
      transitions → 409, reject without remark → 400 —
      `src/projects/revenue/ra-bill.service.spec.ts`
- [ ] T041 [US6] Implement `WorkOrderService` in `src/projects/revenue/work-order.service.ts`:
      `create`, `findAll`, `update`, `delete`
- [ ] T042 [US6] Implement `RevenueController` in
      `src/projects/revenue/revenue.controller.ts`: all revenue, RA bill, and work order
      endpoints — `Permission.PROJECT_FINANCIALS`, `ProjectLockGuard`

**Checkpoint**: Full revenue and billing workflow functional.

---

## Phase 9: User Story 7 — Project P&L (Priority: P3)

**Goal**: On-demand P&L computation via `Promise.allSettled`, budget upsert, 10% overrun flag,
period filter.

**Independent Test**: Call P&L with seeded revenue/RA bill data; verify revenueBooked, zero
actuals from stubs, `unavailableModules` populated, overrun flag when actual > budget × 1.10.

### Implementation for User Story 9

- [ ] T043 [P] [US7] Create `src/projects/pnl/dto/pnl-query.dto.ts` and
      `src/projects/pnl/dto/pnl-response.dto.ts` matching data-model.md P&L Response Shape
- [ ] T044 [P] [US7] Create `src/projects/pnl/dto/budget.dto.ts` and
      `src/projects/budget/budget.service.ts`: upsert per category in single Prisma transaction,
      `getByProject` returning all 5 rows (0 for unset)
- [ ] T045 [US7] Implement `PnlService` in `src/projects/pnl/pnl.service.ts`:
      - Resolve date range from `period` + optional `month`/`quarter`/`year` params
      - `Promise.allSettled` over 4 cross-module stub calls
      - Sum `revenueBooked` from approved RABills + received Revenue in date range
      - Merge budget rows, compute variance/variancePct, set `costOverrunAlert` when
        `actual > budget × COST_OVERRUN_THRESHOLD` — spec FR-009, constants T005
      - Populate `unavailableModules` from rejected promises
- [ ] T046 [P] [US7] Unit test `PnlService.compute()`: all stubs return 0 → correct zero rows;
      one stub rejects → `unavailableModules` populated; actual > budget × 1.10 → overrun flag
      set — `src/projects/pnl/pnl.service.spec.ts`
- [ ] T047 [US7] Implement `PnlController` in `src/projects/pnl/pnl.controller.ts` and
      `BudgetController` in `src/projects/pnl/budget.controller.ts` — `Permission.PROJECT_FINANCIALS`
- [ ] T048 [US7] E2e test: seed revenue + approved RA bill → call P&L → verify `revenueBooked`;
      set budgets → verify cost breakdown rows — `test/projects.e2e-spec.ts`

**Checkpoint**: P&L and budget endpoints fully functional and unit/e2e tested.

---

## Phase 10: User Story 8 — Project Documents (Priority: P3)

**Goal**: Per-project file upload/list/delete using object-storage reference pattern from 005.

**Independent Test**: Upload a document, list it, delete it; locked project upload → 423.

### Implementation for User Story 8

- [ ] T049 [P] [US8] Create `src/projects/documents/dto/create-document.dto.ts` with
      `documentType`, `filePath?`, `remark?` fields
- [ ] T050 [US8] Implement `ProjectDocumentService` in
      `src/projects/documents/documents.service.ts`: `upload` (encrypted fileRef via 005's
      object-storage pattern), `findAll` (ordered by documentType), `delete` (removes record +
      schedules storage cleanup)
- [ ] T051 [US8] Implement `ProjectDocumentController` in
      `src/projects/documents/documents.controller.ts`: `POST`, `GET`, `DELETE /projects/:id/
      documents` — `Permission.PROJECTS`, `ProjectLockGuard`

**Checkpoint**: All 8 user stories implemented.

---

## Phase 11: Polish & Cross-Cutting

- [ ] T052 [P] Verify `ProjectsModule` exports `SitesService` (for HR) and `ProjectsService`
      (exported method `getProjectById` for use by other modules); confirm no circular import
- [ ] T053 [P] Add Swagger `@ApiTags('Projects')` and `@ApiOperation` decorators to all
      controllers — Constitution Principle II
- [ ] T054 [P] Run `npm run lint` and fix any issues — Constitution dev workflow gate
- [ ] T055 [P] Run `npm run build` (tsc typecheck) and fix any issues — Constitution dev workflow gate
- [ ] T056 Add `TODO(006): replace PlantServiceStub` and `TODO(007): replace InventoryServiceStub`
      and `TODO(007): replace PartnersServiceStub` comments in `pnl-sources.interface.ts` and
      `TODO(005): add projectId param to getLabourCostByProject` in `HrPayrollService` interface —
      plan.md TODO section

---

## Dependencies

```
US1 (Clients) ─────────────────────────────────────────────────────────┐
US2 (Sites) ──────────────────────────────────────────────────────────┐│
                                                                        ││
Phase 2 (Schema) ─── US3 (Portfolio) ─── US4 (BOQ) ─── US5 (DWR) ───┘│
                  └─ US6 (Revenue)   ─── US7 (P&L) ────────────────────┘
                  └─ US8 (Documents) ────────────────────────────────────
```

US1 and US2 can begin after Phase 2. US3 requires a Client (US1) to create a project.
US4 requires a Project (US3). US5 requires BOQ items (US4). US6 and US7 require a Project (US3).
US8 requires a Project (US3). US7 optionally benefits from US6 data (revenueBooked).

## Parallel execution (same phase)

- T012, T013 and T017, T018 can run in parallel (Clients and Sites are independent)
- T026, T027, T028 can all run in parallel (BOQ DTOs, import service, tests are file-independent)
- T031, T032, T033 can run in parallel (DWR DTOs, formula service, tests are file-independent)
- T037, T038, T039, T040, T041 can run in parallel (different revenue entity files)
- T043, T044, T046 can run in parallel (P&L DTOs, budget service, unit tests)
- T049, T050 can run in parallel (document DTO and service are independent)
- T052–T056 (Phase 11) are all independent polish tasks

## Implementation Strategy

**MVP (Phase 1–5, US1–US3)**: Clients, Sites, Portfolio CRUD with lock enforcement. Delivers
the core project portfolio — everything else builds on this foundation.

**Increment 2 (Phase 6–7, US4–US5)**: BOQ + DWR — the daily operational workflow.

**Increment 3 (Phase 8–10, US6–US8)**: Revenue, P&L, Documents — the financial and
compliance layer.
