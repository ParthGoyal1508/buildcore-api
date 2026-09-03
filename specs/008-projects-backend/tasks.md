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

- [X] T001 [P] Extend `src/settings/permission.enum.ts` with two new values: `DWR`,
      `PROJECT_FINANCIALS` (`PROJECTS` already exists — reused, not re-added; also add `DWR`/
      `PROJECT_FINANCIALS` to 002's own `permission.enum.ts` addition task if not already applied
      there) — spec FR-016, research.md §8, §14
- [X] T002 [P] Scaffold `src/projects/` directory and `ProjectsModule` in
      `src/projects/projects.module.ts` with the sub-module structure from plan.md
- [X] T003 Create `src/projects/guards/project-lock.guard.ts`: reads `projectId` from route
      params, queries `Project.isLocked`, returns `423` if true — research.md §6
- [X] T004 [P] Create `src/projects/interfaces/pnl-sources.interface.ts` defining the four
      cross-module service interfaces (`PlantService`, `InventoryService`, `PartnersService`,
      `HrPayrollService`). Only `InventoryService`/`PartnersService` get stub implementations
      returning 0 — `PlantService` (006) and `HrPayrollService` (005, amended by this feature) are
      real and injected directly — research.md §10
- [X] T005 [P] Create `src/projects/constants/projects.constants.ts` with `COST_OVERRUN_THRESHOLD
      = 0.10` and `MAX_BOQ_IMPORT_ROWS = 1000` — Constitution Principle III (no hardcoded values)

**Checkpoint**: Module scaffold, lock guard, P&L stubs, and permission enum ready.

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T006 Add new columns to the existing `Site` model (already in the `projects` schema block
      from 003 — do not move it) in `prisma/schema.prisma`: `address String?`,
      `status SiteStatus`, `projectId String?` FK→Project (nullable for backward compat). Do
      **not** touch the existing `latitude`/`longitude`/`geofenceRadiusMeters`/`weeklyOffDay`/
      `holidays` columns — those already exist from 003 — data-model.md §Site, research.md §2
- [X] T007 Add all 11 new `projects` schema models to `prisma/schema.prisma`: `Client`,
      `Project`, `BOQTaskGroup`, `BOQTaskItem`, `DailyWorkReport`, `DWRTask`, `Revenue`,
      `RABill`, `WorkOrder`, `ProjectBudget`, `ProjectDocument` — data-model.md
- [X] T008 Generate and apply the Site extension migration first (`npm run migrate:dev:create`
      for the three new additive `Site` columns only), then generate and apply the `projects`
      schema migration for all 11 new models — Constitution Principle VI (schema-per-module, safe
      migrations)
- [X] T009 Add RLS policies for the 11 new `projects` schema tables (Client, Project, BOQTaskGroup,
      BOQTaskItem, DailyWorkReport, DWRTask, Revenue, RABill, WorkOrder, ProjectBudget,
      ProjectDocument) — `Site`'s RLS policy already exists from 003, no change needed —
      Constitution Principle IV
- [X] T010 [P] Extend `shared.AuditLogEntry.entityType` enum with: `PROJECT`, `CLIENT`, `SITE`,
      `BOQ_GROUP`, `BOQ_ITEM`, `DWR`, `REVENUE`, `RA_BILL`, `WORK_ORDER`, `PROJECT_BUDGET`,
      `PROJECT_DOCUMENT` — contracts/projects-api.md "Audit logging"

**Checkpoint**: Schema and RLS/audit-enum extensions complete. HR's site/geofence call sites are
untouched (research.md §2) — no HR-side task needed. All user story phases can now proceed in
parallel per story grouping.

---

## Phase 3: User Story 1 — Manage Clients (Priority: P1) 🎯 MVP

**Goal**: Full Client CRUD with GSTIN uniqueness, soft-delete guard, paginated list.

**Independent Test**: Create a client, edit it, attempt duplicate GSTIN (→ 409), toggle inactive,
verify listed correctly — without any project data.

### Implementation for User Story 1

- [X] T012 [P] [US1] Create `src/projects/clients/dto/create-client.dto.ts` and
      `update-client.dto.ts` with class-validator decorators for all client fields
- [X] T013 [P] [US1] Implement `ClientsService` in `src/projects/clients/clients.service.ts`:
      `create`, `findAll` (paginated, filtered), `update`, `softDelete` (set inactive), GSTIN
      uniqueness check (→ 409), linked-project guard on delete (→ 409)
- [X] T014 [US1] Implement `ClientsController` in `src/projects/clients/clients.controller.ts`:
      `GET /projects/clients`, `POST /projects/clients`, `PATCH /projects/clients/:id`,
      `DELETE /projects/clients/:id` — all with `@RequirePermission(Permission.PROJECTS)`
- [X] T015 [P] [US1] Unit test `ClientsService`: duplicate GSTIN path, delete with linked
      projects path — `src/projects/clients/clients.service.spec.ts`
- [X] T016 [US1] E2e test: `POST /projects/clients` → 201, duplicate GSTIN → 409, `GET` list
      with search/status filter — `test/projects.e2e-spec.ts` (create the file)

**Checkpoint**: Client CRUD fully functional and independently tested.

---

## Phase 4: User Story 2 — Manage Sites (Priority: P1)

**Goal**: Full Site CRUD extending 003's existing `sites.service.ts` in place — adds
`projectId`/`address`/`status` management and a new `getSiteById()` export for this feature's own
consumers (DWR, BOQ, project detail). 003's existing `getGeofence()`/`getHolidayCalendar()`/
`getWeeklyOffDay()` exports (which HR depends on) are not touched.

**Independent Test**: Create a site with a `projectId`/`address`, edit it, set inactive, confirm
`getSiteById()` returns the full row including 003's pre-existing geofence fields — independent of
any change to HR's own call sites.

### Implementation for User Story 2

- [X] T017 [P] [US2] Create `src/projects/sites/dto/create-site.dto.ts` and
      `update-site.dto.ts` for the new fields (`projectId`, `address`, `status`) — no lat/lng/
      radius validation needed here, those fields and their validation already exist from 003
- [X] T018 [P] [US2] Extend the existing `src/projects/sites/sites.service.ts` (003's file — do
      not create a new one) with: `create`, `findAll` (filtered by projectId/status), `update`,
      `delete` (→ 409 if active employees or DWRs reference site), plus a new `getSiteById(id)`
      exported method (full row) for this feature's own consumers. 003's existing `getGeofence()`/
      `getHolidayCalendar()`/`getWeeklyOffDay()` methods are unchanged
- [X] T019 [US2] Implement `SitesController` in `src/projects/sites/sites.controller.ts`:
      `GET /projects/sites`, `POST /projects/sites`, `GET /projects/sites/:id`,
      `PATCH /projects/sites/:id`, `DELETE /projects/sites/:id` — `Permission.PROJECTS`

**Checkpoint**: Site CRUD functional (projectId/address/status alongside 003's existing geofence
data); `getSiteById()` available for this feature's own use. HR's existing exports are unaffected
— no HR-side task needed.

---

## Phase 5: User Story 3 — Manage Project Portfolio (Priority: P1)

**Goal**: Full Project CRUD with code-series auto-generation, aggregated detail endpoint, lock/
unlock with audit, delete guard.

**Independent Test**: Create a project (auto-generated code), view aggregated detail (empty tabs),
lock it (DWR write → 423), unlock (DWR write succeeds).

### Implementation for User Story 3

- [X] T021 [P] [US3] Create `src/projects/portfolio/dto/create-project.dto.ts` and
      `update-project.dto.ts` covering all project fields from data-model.md
- [X] T022 [P] [US3] Implement `ProjectsService` in
      `src/projects/portfolio/projects.service.ts`: `create` (calls CodeSeriesService for
      auto-code), `findAll` (paginated, search/status/client filtered), `findOne` (with
      aggregated tabs via cross-module stub calls), `update` (audit-log `isLocked` changes),
      `delete` (→ 409 if DWRs/revenue/RA bills/BOQ items exist)
- [X] T023 [US3] Implement `ProjectsController` in
      `src/projects/portfolio/projects.controller.ts`: all 5 CRUD endpoints, `Permission.PROJECTS`
- [X] T024 [P] [US3] Unit test `ProjectsService.findOne()`: verify Inventory/Partners stub calls
      return empty arrays without error; Machinery (006) and Labour (005) calls are real, not
      stubbed — `src/projects/portfolio/projects.service.spec.ts`
- [X] T025 [US3] E2e test: `POST /projects` (auto-code), lock toggle → `POST /projects/dwr` 423,
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
      `import-boq-validate.dto.ts`, `import-boq-confirm.dto.ts` (`{ batchId }`) in
      `src/projects/boq/dto/`
- [ ] T027 [P] [US4] Implement `BOQImportService` in `src/projects/boq/boq-import.service.ts` with
      two methods: `validate(file)` — `exceljs` workbook parsing, 9-column schema validation,
      row-by-row error collection, holds valid rows server-side keyed by a generated `batchId`
      (TTL'd), generates CSV error report as Buffer stored to object storage, returns
      `{ batchId, validRows, errors, errorReportUrl }` without writing anything; and
      `confirm(batchId)` — commits the held valid rows in a single Prisma transaction (group
      created on first reference), returns `{ imported }` — research.md §4, §12
- [ ] T028 [P] [US4] Unit test `BOQImportService`: `validate()` on an all-valid file → 0 errors,
      writes nothing; `validate()` on a file with 3 invalid rows → correct error objects, writes
      nothing; `confirm()` on a validated batch → exactly the valid rows created; file > 1000 rows
      → 413 thrown — `src/projects/boq/boq-import.service.spec.ts`
- [ ] T029 [US4] Implement `BOQService` in `src/projects/boq/boq.service.ts`:
      `createGroup`, `createItem`, `getTree` (groups + items with computed pendingQty/
      avgQtyPerDay/daysToComplete), `getAlerts` (today/delayed/toBeDelayed), `updateDoneQty`
      (called by DWR service on **approval**, not submission — research.md §13), `deleteItem`
      (→ 409 if DWRTask references it)
- [ ] T030 [US4] Implement `BOQController` in `src/projects/boq/boq.controller.ts`: all BOQ
      endpoints from contracts — `Permission.PROJECTS`, `ProjectLockGuard` on writes

**Checkpoint**: BOQ management and import fully functional.

---

## Phase 7: User Story 5 — Daily Work Reports (Priority: P2)

**Goal**: DWR CRUD with server-side Actual Qty computation, BOQ doneQty increment on **approval**
(not submission — master PRD §7.5.3, research.md §13), approve workflow, file attachments.

**Independent Test**: Create DWR with measurement fields → verify server-computed actualQty,
submit → BOQ doneQty unchanged, approve → status = approved and BOQ doneQty increments.

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
      DPR number `{siteCode}-{seq}`, compute actualQty per task), `submit` (status → submitted
      only — does **not** call `BOQService.updateDoneQty()`), `approve` (status → approved,
      audit-log, **then** calls `BOQService.updateDoneQty()` — research.md §13), `findAll`
      (paginated, filtered), `findOne`, `delete` (draft only), `addAttachment`
- [ ] T035 [US5] Implement `DWRController` in `src/projects/dwr/dwr.controller.ts`: all DWR
      endpoints — `Permission.DWR`, `ProjectLockGuard` on writes
- [ ] T036 [US5] E2e test: create DWR → verify actualQty, submit → BOQ doneQty **unchanged**,
      approve → BOQ doneQty increments, locked project → 423 — `test/projects.e2e-spec.ts`

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
period filter. Machinery/Fuel (006) and Labour (005) are real calls; Materials/Subcontractors
(Inventory/Partners) are still stubbed pending those features.

**Independent Test**: Call P&L with seeded revenue/RA bill/logbook/fuel/payroll data; verify
revenueBooked, real Machinery/Fuel/Labour figures, zero actuals from the two remaining stubs,
`unavailableModules` populated only for those two, overrun flag when actual > budget × 1.10.

### Implementation for User Story 7

- [ ] T043 [P] [US7] Create `src/projects/pnl/dto/pnl-query.dto.ts` and
      `src/projects/pnl/dto/pnl-response.dto.ts` matching data-model.md P&L Response Shape
      (6 cost categories: labour, materials, machinery, fuel, subcontractors, overheads)
- [ ] T044 [P] [US7] Create `src/projects/pnl/dto/budget.dto.ts` and
      `src/projects/budget/budget.service.ts`: upsert per category in single Prisma transaction,
      `getByProject` returning all 5 rows (0 for unset)
- [ ] T045 [US7] Implement `PnlService` in `src/projects/pnl/pnl.service.ts`:
      - Resolve date range from `period` + optional `month`/`quarter`/`year` params
      - `Promise.allSettled` over 5 cross-module calls: `HrPayrollService.getLabourCostByProject()`
        (005, real), `InventoryService.getMaterialCostByProject()` (stub), `PlantService
        .getMachineryCostByProject()` and `.getFuelCostByProject()` (006, real, two separate
        calls per master PRD §7.5.4), `PartnersService.getSubcontractorCostByProject()` (stub)
      - Sum `revenueBooked` from approved RABills + received Revenue in date range
      - Merge budget rows for all 6 categories, compute variance/variancePct, set
        `costOverrunAlert` when `actual > budget × COST_OVERRUN_THRESHOLD` — spec FR-009
      - Populate `unavailableModules` from rejected promises (expected only for Inventory/Partners
        until those features ship)
- [ ] T046 [P] [US7] Unit test `PnlService.compute()`: Inventory/Partners stubs return 0 →
      correct zero rows; a stub rejects → `unavailableModules` populated; Machinery/Fuel/Labour
      return real seeded values; actual > budget × 1.10 → overrun flag set —
      `src/projects/pnl/pnl.service.spec.ts`
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

- [ ] T052 [P] Verify `ProjectsModule` exports `SitesService` (extended in place, still importable
      by `HrModule` exactly as 003 wired it) and `ProjectsService` (exported method
      `getProjectById` for use by other modules); confirm no circular import
- [ ] T053 [P] Add Swagger `@ApiTags('Projects')` and `@ApiOperation` decorators to all
      controllers — Constitution Principle II
- [ ] T054 [P] Run `npm run lint` and fix any issues — Constitution dev workflow gate
- [ ] T055 [P] Run `npm run build` (tsc typecheck) and fix any issues — Constitution dev workflow gate
- [ ] T056 Add `TODO(009): replace InventoryServiceStub` and `TODO(007): replace
      PartnersServiceStub` comments in `pnl-sources.interface.ts` — these are the only two
      remaining stubs; `PlantService` (006) and `HrPayrollService` (005) are wired to real
      implementations, not stubs — plan.md TODO section

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

---

## Amendment 2026-09-01 — Project Planning & Target-vs-Actual Reporting

Covers spec FR-019 to FR-035 and plan Phases A1–A4. Task IDs prefixed `TA`. **No new permission
value** — reuses `PROJECTS` and `REPORTS`.

- [ ] TA001 Add `ProjectPhase`, `ProjectActivity`, `ActivityDependency`, `ProjectTarget`,
      `ProjectTargetLine` models to `prisma/schema.prisma`; migration + RLS
- [ ] TA002 [P] Extend `shared.AuditLogEntry.entityType` with `PROJECT_PHASE`, `PROJECT_ACTIVITY`,
      `PROJECT_TARGET` (spec FR-034)
- [ ] TA003 Extend the existing project-lock guard (FR-003) to cover every schedule and target write
      (spec FR-024)
- [ ] TA004 [US9] `PhaseService` and `ActivityService` + controllers: CRUD, `plannedFinish` before
      `plannedStart` → 400, milestone marking, delete guard → 409 for activities with actuals
      (spec FR-025)
- [ ] TA005 [US9] `DependencyService`: typed links (finish_to_start / start_to_start /
      finish_to_finish) with cycle detection → 400 naming the cycle path (spec FR-020)
- [ ] TA006 [US9] Flag dependency violations in planned dates rather than blocking, so a partly
      edited plan can still be saved (spec FR-021)
- [ ] TA007 [US9] Baseline endpoint: reject while `weightagePercent` does not sum to 100, reporting
      the actual sum (spec FR-022); freeze planned dates and quantities as immutable baseline
      values and increment the version (spec FR-023)
- [ ] TA008 [US10] `TargetService` + controller: periodic (weekly|monthly) target sets per activity
      or BOQ item; overlap guard → 409 (spec FR-026)
- [ ] TA009 [US10] `TargetReportService`: actuals summed **only** from approved DWR measurements
      (spec FR-027) so target reporting and BOQ progress can never disagree; unset targets reported
      explicitly rather than as zero (spec FR-028)
- [ ] TA010 [US10] Weightage-weighted project rollup stating whether baseline or current weightages
      were used (spec FR-029)
- [ ] TA011 [US10] Monthly report sourcing man-days, equipment hours, and material consumed via
      `LabourService`, `PlantService`, and `InventoryService` — never a cross-schema query
      (spec FR-033) — **blocked by 013 T060 for man-days**
- [ ] TA012 [US10] Progress-trend series (planned vs actual cumulative) for the matrix's "Monthly
      Report Chart"
- [ ] TA013 [US11] `VarianceService`: per-activity baseline vs current vs actual, status
      (not_started / on_track / behind_schedule / completed), percent complete from quantity where
      available else the manual value with the source marked (spec FR-030)
- [ ] TA014 [US11] `behind_schedule` flagging beyond the configured tolerance with slippage in days;
      critical-path marking on the longest dependency chain (spec FR-031)
- [ ] TA015 [US11] Explicit no-baseline response rather than comparing against unset values
      (spec FR-032)
- [ ] TA016 XLSX/PDF export on all three reports, async above the configured row threshold
      (spec FR-035)
- [ ] TA017 [P] Unit test: cycle detection within and across phases; baseline immutability under
      later planned-date edits (SC-A02, SC-A03)
- [ ] TA018 [P] Unit test: achievement math, unset-target handling, percent-complete source
      selection
- [ ] TA019 [P] E2e test: actuals reconcile exactly with approved DWR measurements (SC-A01)
- [ ] TA020 **P&L extension**: add asset cost via 012's `getAssetCostByProject()` and labour cost
      via 013's `getLabourCostByProject()` to the existing FR-008 P&L — **blocked by 012 T052 and
      013 T060**

---

## Implementation note — 2026-09-03, User Stories 1-3

Phases 1-5 are complete (T001-T025). Phases 6-11 (US4-US8) and every `TA*` amendment
task are untouched, by scope decision.

Deviations from the task text, and why:

- **T001** needed no code. `PROJECTS`, `DWR` and `PROJECT_FINANCIALS` were already in
  the `Permission` enum, which lives in `prisma/schema.prisma`, not at the task's
  stated path `src/settings/permission.enum.ts` — that file does not exist.
- **T004** declares the four P&L source interfaces but injects none of them. The task
  says Plant (006) and HR/Payroll (005) are "real and injected directly": `src/plant`
  does not exist, and no labour-cost-by-project method exists on 005. Both are
  declarations. P&L is US7 and out of scope either way.
- **T006** added `projectId`, `address` and `status` only. `data-model.md` still lists
  a `holidays` column on Site; migration `20260901194500_drop_site_holidays_column`
  removed it and `hr.Holiday` supersedes it.
- **T008** is two migrations, as asked, but `Site.projectId`'s FOREIGN KEY is declared
  in the second rather than the first — `projects.Project` does not exist until then.
- **T019** keeps `GET /projects/sites` as 003's bare-array picker and puts the
  paginated administrative list on `GET /projects/sites/list`. HR's Add Employee form
  reads the picker's response directly and would break on a page envelope. Both reads
  admit `EMPLOYEES` as well as `PROJECTS`, because an HR administrator is not required
  to hold `PROJECTS` and the form is unfillable without a site list. Writes stay
  `PROJECTS`-only.
- **T025** asks for the 423 path as `lock -> POST /projects/dwr -> 423`. The DWR
  endpoints are US5 and do not exist, so `ProjectLockGuard` is covered by
  `src/projects/guards/project-lock.guard.spec.ts` instead; the e2e asserts the
  `isLocked` flag the guard reads, and its audit trail.
- `SitesService` and `ProjectsService` now need `EmployeesService`, while `hr` still
  needs `SitesService` for punch geofencing. That edge is bidirectional and resolved
  with `forwardRef()` on both modules, exactly as `partners.module.ts` predicted. The
  alternative was a cross-schema query, which Principle I forbids.

Pre-existing failures found while verifying, and what was done:

- `test/settings.e2e-spec.ts` teardown violated two foreign keys — vendor categories
  (seeded per company since 007) and `UserRole` rows deleted after their `Role`. All
  40 tests passed; the teardown aborted, leaving orphan companies that broke the next
  run. **Fixed here**, because it blocked verification. Six orphan companies from
  earlier runs were also cleared from the local database.
- `test/my-workspace.e2e-spec.ts` still wrote to the dropped `Site.holidays` column,
  so the whole suite failed to set up. **Fixed here** by using the `hr.Holiday`
  calendar that superseded it.
- Nine punch tests in `test/my-workspace.e2e-spec.ts` fail: a duplicate punch-in
  returns 500 rather than 409, because the same-day guard in `punch.service.ts:290`
  does not match and the database unique constraint catches it instead. **Not fixed**
  — out of scope, and confirmed identical on `main` (84 passed / 9 failed, same test
  names) in an isolated worktree. Feature 003/005 territory.

---

## Phase 12: Convergence

Appended 2026-09-03 by `/speckit-converge`, assessing the shipped US1–US3 code against
spec.md, plan.md and contracts/projects-api.md. Scoped to those three stories — US4–US8
and the `TA*` amendment are correctly unbuilt and are not reported here.

- [ ] T057 Reject a punch at an inactive site per US2/AC4 (missing) — `SiteStatus.inactive`
      is stored and editable but nothing reads it: `SitesService.getGeofence()` does not
      select `status`, and `src/hr/punch/punch.service.ts` has no site-status check, so a
      decommissioned site still accepts attendance. Add `status` to the `getGeofence()`
      projection (or a narrow `isSiteActive()` export) and refuse the punch in
      `punch.service.ts` with the same 409-style rejection the other same-day guards use.
      Cover it in `test/my-workspace.e2e-spec.ts` alongside the geofence cases. Note this
      is the one acceptance criterion of a P1 story that shipped unmet, and it has a real
      consequence: taking a site out of service does not stop attendance being recorded
      against it.
- [ ] T058 Reconcile the project-detail "costing breakdown" per US3/AC3 (partial) —
      the acceptance scenario lists a costing breakdown among the aggregated tabs, but
      `contracts/projects-api.md`'s `GET /projects/:id` response shape does not, and
      `ProjectDetail` follows the contract with six tabs. Costing is the P&L (FR-008,
      US7). Decide which document is right and say so in one of them: either add costing
      to the contract as a US7 deliverable, or amend AC3 to stop naming it.
- [ ] T059 Correct FR-012's reference to `SitesService.getHolidayCalendar()` (contradicts)
      — that method does not exist and cannot, since migration
      `20260901194500_drop_site_holidays_column` removed `Site.holidays` and the
      first-class `hr.Holiday` calendar superseded it. FR-012 and data-model.md's Site
      section both still describe it as a live export HR depends on. Documentation only;
      no code change.
