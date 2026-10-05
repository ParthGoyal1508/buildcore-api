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

- [ ] ~~T026~~ **SUPERSEDED by T084** (2026-10-03) — the DTOs are right in shape and wrong in
      detail: the programme fields are optional now (FR-037).
  Original: [P] [US4] Create BOQ DTOs: `create-boq-group.dto.ts`, `create-boq-item.dto.ts`,
      `import-boq-validate.dto.ts`, `import-boq-confirm.dto.ts` (`{ batchId }`) in
      `src/projects/boq/dto/`
- [ ] ~~T027~~ **SUPERSEDED by T063–T079** (2026-10-03) — **wrong on both of its two named
      specifics.** `exceljs` cannot read the client's `.xls` (it returns zero sheets and throws
      nothing, research §15), and there is no 9-column schedule: the real sheet carries Item
      Description, Quantity, Units, Basic Rate, four blank pre-GST tax columns and Total Amount,
      with no Task Group column and no programme dates.
  Original: [P] [US4] Implement `BOQImportService` in `src/projects/boq/boq-import.service.ts` with
      two methods: `validate(file)` — `exceljs` workbook parsing, 9-column schema validation,
      row-by-row error collection, holds valid rows server-side keyed by a generated `batchId`
      (TTL'd), generates CSV error report as Buffer stored to object storage, returns
      `{ batchId, validRows, errors, errorReportUrl }` without writing anything; and
      `confirm(batchId)` — commits the held valid rows in a single Prisma transaction (group
      created on first reference), returns `{ imported }` — research.md §4, §12
- [ ] ~~T028~~ **SUPERSEDED by T075–T079** (2026-10-03) — the three cases it names are kept and
      joined by the ones the client's file made necessary.
  Original: [P] [US4] Unit test `BOQImportService`: `validate()` on an all-valid file → 0 errors,
      writes nothing; `validate()` on a file with 3 invalid rows → correct error objects, writes
      nothing; `confirm()` on a validated batch → exactly the valid rows created; file > 1000 rows
      → 413 thrown — `src/projects/boq/boq-import.service.spec.ts`
- [ ] ~~T029~~ **SUPERSEDED by T085–T087** (2026-10-03) — `getAlerts` returns four groups now,
      not three (FR-048).
  Original: [US4] Implement `BOQService` in `src/projects/boq/boq.service.ts`:
      `createGroup`, `createItem`, `getTree` (groups + items with computed pendingQty/
      avgQtyPerDay/daysToComplete), `getAlerts` (today/delayed/toBeDelayed), `updateDoneQty`
      (called by DWR service on **approval**, not submission — research.md §13), `deleteItem`
      (→ 409 if DWRTask references it)
- [ ] ~~T030~~ **SUPERSEDED by T088** (2026-10-03) — the endpoint list grew with the import
      refusals and the alerts' fourth group.
  Original: [US4] Implement `BOQController` in `src/projects/boq/boq.controller.ts`: all BOQ
      endpoints from contracts — `Permission.PROJECTS`, `ProjectLockGuard` on writes

**Checkpoint**: BOQ management and import fully functional.

---

## Phase 7: User Story 5 — Daily Work Reports (Priority: P2)

**Goal**: DWR CRUD with server-side Actual Qty computation, BOQ doneQty increment on **approval**
(not submission — master PRD §7.5.3, research.md §13), approve workflow, file attachments.

**Independent Test**: Create DWR with measurement fields → verify server-computed actualQty,
submit → BOQ doneQty unchanged, approve → status = approved and BOQ doneQty increments.

### Implementation for User Story 5

> **Built by feature 022 on 2026-10-05, not here.** These six tasks sat unchecked from August
> while the tables, the `DWR` permission, the audit entity type and `BoqService.updateDoneQty`
> all existed — so **every BOQ line in the system reported 0% executed**, because `doneQty` moves
> only on approval and nothing could approve anything. See
> `specs/022-daily-work-reports-backend/`. Three of the six were specified in a form that could
> not be built, and 022 records what replaced each and why.

- [X] T031 [P] [US5] ✅ Done by 022 (T015, T015a, T016, T029) — `create-dwr.dto.ts`,
      `update-dwr.dto.ts`, `dwr-query.dto.ts`, `dwr-lifecycle.dto.ts` in
      `src/projects/dwr/dto/`. **The create DTO is two line shapes, not one with a nested
      `DWRTaskInput[]`**: a presence-paid line cannot carry the six factors at all (022 FR-030b)
- [X] T032 [P] [US5] ✅ Done by 022 (T008–T010) as `src/projects/dwr/dwr-quantity.ts`, with two
      departures. **Zero-value handling is a refusal, not `→ 0`**: a product of zero is a
      data-entry error, and a line asserting that measured work amounted to nothing is
      indistinguishable in every later report from work that was measured and came to nothing
      (022 FR-004). And the result is a `Prisma.Decimal`, never a `number` — six multiplications
      in binary floating point err in the third decimal place of a figure a client is invoiced
      from
- [X] T033 [P] [US5] ✅ Done by 022 (T011–T013) — `src/projects/dwr/dwr-quantity.spec.ts`, 19
      tests, including the one this task could not have asked for: a presence line with all six
      factors set to **7** must still yield its served quantity. The factors default to 1, so
      their product is 1 — identical to one day served — and an implementation that read them
      would be right for every row entered by hand and wrong the instant a factor moved
- [X] T034 [US5] ✅ Done by 022 (T017–T027, T030–T040), with three corrections.
      **`{siteCode}-{seq}` is impossible**: a report references a project and not a site, and
      `Site` has no code field at all — the number derives from `Project.code` (022 FR-002,
      research §2). **Approval does not call `updateDoneQty`**: that method opens its own
      transaction, so a report's increments would each commit separately, which is the opposite
      of all-or-nothing — 022 added `applyDoneQtyDeltas` for the caller `updateDoneQty` was
      written for. And **`reverse` is new**: 008 said approval moves the counter and never said
      what undoes it, leaving a wrong approval with no remedy but a hand-edit
- [X] T035 [US5] ✅ Done by 022 (T054–T056) — `src/projects/dwr/dwr.controller.ts`,
      `Permission.DWR` on every route, `ProjectLockGuard` on every write (423, not 403).
      Registered **before** `ProjectsController`, because `GET projects/dwr` is a literal path and
      `GET projects/:id` would otherwise swallow it
- [X] T036 [US5] ✅ Done by 022 (T061–T066a) as `test/dwr.e2e-spec.ts` — 25 tests, its own suite
      rather than inside `test/projects.e2e-spec.ts`. The assertion this task names is the one
      nothing could run for two months: submit → `doneQty` unchanged, approve → it increments,
      approve again → refused and it does not move twice

**Checkpoint**: DWR lifecycle and BOQ progress tracking fully functional — **reached 2026-10-05**.

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

- [X] T057 Reject a punch at an inactive site per US2/AC4 (missing) — `SiteStatus.inactive`
      is stored and editable but nothing reads it: `SitesService.getGeofence()` does not
      select `status`, and `src/hr/punch/punch.service.ts` has no site-status check, so a
      decommissioned site still accepts attendance. Add `status` to the `getGeofence()`
      projection (or a narrow `isSiteActive()` export) and refuse the punch in
      `punch.service.ts` with the same 409-style rejection the other same-day guards use.
      Cover it in `test/my-workspace.e2e-spec.ts` alongside the geofence cases. Note this
      is the one acceptance criterion of a P1 story that shipped unmet, and it has a real
      consequence: taking a site out of service does not stop attendance being recorded
      against it.
- [X] T058 Reconcile the project-detail "costing breakdown" per US3/AC3 (partial) —
      the acceptance scenario lists a costing breakdown among the aggregated tabs, but
      `contracts/projects-api.md`'s `GET /projects/:id` response shape does not, and
      `ProjectDetail` follows the contract with six tabs. Costing is the P&L (FR-008,
      US7). Decide which document is right and say so in one of them: either add costing
      to the contract as a US7 deliverable, or amend AC3 to stop naming it.
- [X] T059 Correct FR-012's reference to `SitesService.getHolidayCalendar()` (contradicts)
      — that method does not exist and cannot, since migration
      `20260901194500_drop_site_holidays_column` removed `Site.holidays` and the
      first-class `hr.Holiday` calendar superseded it. FR-012 and data-model.md's Site
      section both still describe it as a live export HR depends on. Documentation only;
      no code change.

---

## Amendment 2026-10-03 — BOQ entry and import (T061 – T096)

Sources: `spec.md` Amendment 2026-10-03 (FR-036 – FR-046) and its second pass (FR-047 – FR-056);
`plan.md` phases B1–B5 and its constitution re-check; `research.md` §15–§17;
`contracts/projects-api.md`; `quickstart.md` passes 10–12.

T026–T030 above are **superseded, not deleted** — each carries a note naming its replacement.

### Phase B1: The migration that lets a tender schedule exist

- [X] T061 [US4] ✅ Done 2026-10-03 Make six columns nullable in `prisma/schema.prisma` (FR-037):
      `BOQTaskItem.startDate`, `finishDate`, `duration`, `perDayQty` and
      `BOQTaskGroup.startDate`, `finishDate`. Update each field's doc comment to say that null means
      **unplanned** and that unplanned is a reported state, not a missing value.
- [X] T062 [US4] ✅ Done 2026-10-03 — `20261003180000_boq_programme_optional`, applied locally; `prisma migrate deploy` clean, client regenerated, `tsc --noEmit` clean Generate the migration in `prisma/migrations/`, opening with
      `SELECT set_config('app.is_super_admin','true',true)` per the RLS convention. No backfill —
      widening to nullable is safe and both tables are empty in every environment. No new policy:
      nothing is added, only relaxed.

**Checkpoint**: a BOQ line can exist without a programme.

### Phase B2: The parser boundary (constitution v1.5.0)

- [X] T063 [US4] ✅ Done — resolved to the CDN tarball, integrity hash in the lockfile, zero `registry.npmjs.org` resolutions for `xlsx`; installed version confirmed 0.20.3 Add `xlsx` to `package.json` pinned to
      `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`, and commit the lockfile with its
      integrity hash. **Not `npm install xlsx`** — the registry build is 0.18.5, carrying
      CVE-2023-30533 and CVE-2024-22363, and the constitution prohibits it.
- [X] T064 [US4] ✅ Done — `BoqWorkbookReader` returns `WorkbookSheet[]` of plain rows. **One refinement:** it returns sheets rather than a flat row list, because a tender workbook carries several (the e-tender template has one per BoQ type) and choosing between them is a schedule-identification decision, not a parsing one Implement `BoqWorkbookReader` in `src/projects/boq/boq-workbook.reader.ts`: takes a
      buffer, returns `{ rowNumber, cells: (string | number | null)[] }[]`. The **only** importer of
      `xlsx` anywhere. No caller receives a workbook, a worksheet or a cell object — that is what
      makes replacing the library one file's work.
- [X] T065 [US4] ✅ Done — routed on magic bytes (`PK\x03\x04` → exceljs, OLE2/CFB → SheetJS), not on the filename Route by content, not by filename: `.xlsx` to `exceljs`, legacy `.xls` to SheetJS.
      A renamed file is the common case, not the exception.
- [X] T066 [US4] ✅ Done — `BOQ_FILE_TOO_LARGE` (checked first, asserted by a test that would otherwise fail as unreadable), `BOQ_WORKBOOK_UNREADABLE`, `BOQ_WORKBOOK_EMPTY`. `BOQ_NO_SCHEDULE_BLOCK` belongs to T069 The four whole-file refusals, each named (FR-036, FR-056): `BOQ_FILE_TOO_LARGE`
      (over 10MB, before parsing), `BOQ_WORKBOOK_UNREADABLE`, `BOQ_WORKBOOK_EMPTY` (parsed, no
      sheets — the shape `exceljs` silently returns for the client's real file) and
      `BOQ_NO_SCHEDULE_BLOCK`.
- [X] T067 [P] [US4] ✅ Done — 7 tests. **The first draft was vacuous**: four assertions used `.catch(cb)`, which passes silently when the promise resolves — the exact failure shape this feature exists to prevent. Replaced with a helper that fails explicitly on resolution, and proved non-vacuous by breaking one deliberately and confirming it fails Unit test the reader alone in `boq-workbook.reader.spec.ts`: a real `.xls`, a
      real `.xlsx`, a text file renamed `.xls`, a workbook with no sheets, and an oversized buffer.
- [X] T068 [P] [US4] ✅ Done — walks `src/` and asserts no file but the reader imports `xlsx` Assert **no file other than the reader imports `xlsx`**, by reading the source
      tree in `boq-workbook.reader.spec.ts`. The constraint decays silently: a second import would
      work perfectly and nobody would notice until the library had to be replaced.

**Checkpoint**: bytes become rows, or a refusal that says which condition it hit.

### Phase B3: `validate` — every decision made before anything is written

- [X] T069 [US4] ✅ Done — header-text identification; on the real file it lands on sheet `BoQ1` row 11 with description=1, quantity=3, unit=4, rate=5, bidderRate=12, amount=52, span 0–54. The span rule disposes of the far block **and** of stray column-57 values on two heading rows without naming either `identifySchedule()` in `src/projects/boq/schedule-block.ts` (FR-054, FR-042): find the
      header row carrying both a description-like and a quantity-like header; the block spans that
      row's first to last **contiguous** matched column. The sample's second block at columns
      238–242 is excluded for being outside the span — a rule that still holds for the next tender,
      which will put its own second block somewhere else. No header row found ⇒
      `BOQ_NO_SCHEDULE_BLOCK` rather than a guess.
- [X] T070 [US4] ✅ Done — 311 candidates measured on the real file (231 items + 80 headings); the footer rows are kept separately rather than discarded, since FR-045 has nothing to reconcile against without them Count **candidate schedule rows** (FR-055) — rows inside the block with a non-empty
      description, *including* headings and rows that will later be rejected — immediately after
      identification and before validation, and apply the 1,000-row cap there
      (`BOQ_TOO_MANY_ROWS`). Judged on raw sheet rows instead, the client's own 312-line tender
      could be refused for being too large (research §17).
- [X] T071 [US4] ✅ Done — 80 heading rows fold into 66 groups on the real file, because consecutive headings are one nested section. Groups are renumbered **after** empty ones are dropped, so the numbering has no gaps corresponding to nothing a reader can see Hierarchy inference (FR-038): a row with a description and no quantity opens a
      group; rows below belong to it until the next such row. Deeper nesting folds the outer heading
      text into the group name. A quantity row before any heading goes to a group named for the sheet
      and raises a **warning** — the rows are good and only the structure is unstated, so it is not
      an error.
- [X] T072 [P] [US4] ✅ Done — strips case, punctuation **and whitespace**: periods alone left `R.Mtr.` as `rmtr` and `R. Mtr.` as `r mtr`, which was the first implementation and did not unify the family. Measured: 25 raw spellings → 21 visibly distinct → **12 units**. Surrounding whitespace is trimmed, the one deviation from "verbatim", because four spellings differed from another only by a trailing space and listing the same visible spelling twice reads as a defect in the report `normaliseUnit()` in `src/projects/boq/unit-normalise.ts` (FR-041): lowercase,
      strip periods, collapse whitespace, so `R. Mtr.`, `R.Mtr.` and `R mtr` agree. Store the source
      string verbatim on the line; normalise for matching only. **`Excess (+)` must resolve to no
      unit** — it appears in the units column on the quoted-rate row, and a unit named "excess" would
      be invented out of a footer.
- [X] T073 [US4] ✅ Done — read, found blank, dropped Read and discard the four pre-GST tax columns (FR-043) — Excise Duty, VAT,
      DGS&D/RITES inspection, Cenvat credit. Not errors, not data: the template predates GST.
- [X] T074 [US4] ✅ Done — `Prisma.Decimal`, `quantity × rate`. Measured: zero of the real file's 231 lines disagree with its own stated amount, so recomputing is safe as well as correct Recompute every amount as `quantity × rate` in `Prisma.Decimal` (FR-044). The file's
      own figures (`178.09326499999995`, `29961506.782150004`) are the thing to reconcile against,
      never an input.
- [X] T075 [US4] ✅ Done — located by its label in the **units** column of the footer row, with the value beside it in the rate column; `0.0246` on the real file, and `× 1.0246` reproduces its stated quoted total. Outside 0–1, or failing reconciliation, counts as not located Locate the quoted percentage (FR-039, FR-040, FR-056): a footer label matching `Excess` or
      `Quoted Rate`, **and** the quoted total it implies reconciling under T076's tolerance. Either
      failing, or a value outside 0–1, means **not located** — `quotedPercentage: null` and a
      first-class entry in the report. **Never 0**: zero is a valid percentage, so that failure is
      silent and under-bills every line by 2.46% — ₹7.37 lakh on this file.
- [X] T076 [US4] ✅ Done — tolerance `0.01 × lineCount`. **The tolerance earns its place on the real file**: derived 29,961,506.79 against stated 29,961,506.78, a one-paisa difference across 231 rounded lines, with ₹2.31 of tolerance. Exact equality would have failed a correct import of the client's own tender Reconcile both derived totals against the two the workbook states, reporting each
      difference (FR-045). Tolerance is **one paisa per line** (`0.01 × lineCount`; ₹3.12 on the
      sample), derived from two-decimal rounding rather than chosen — exact equality would fail a
      correct import, and every structural error this catches exceeds the tolerance by seven orders
      of magnitude.
- [X] T077 [US4] ✅ Done — writes nothing; asserted by reading the batch back and finding it `ready` `BOQImportService.validate(projectId, userId, buffer)` writing **nothing**,
      returning the contract's shape: `batchId`, group and line counts, units as-typed with their
      normalised form, both totals with differences and the tolerance, the percentage and whether it
      was located, errors, warnings, the alert preview, and `errorReportUrl` when errors exist.
- [X] T078 [US4] ✅ Done — four states, 30-minute TTL, 5/20 caps from centralized config. **Expiry is two-step**: marked `expired` at the TTL and dropped at twice it, because deleting at the TTL made "expired" and "never existed" indistinguishable — which was this file's first implementation and the same defect class as the rest of the feature Batch storage with the four states (FR-052, FR-053) in
      `src/projects/boq/import-batch.store.ts`: `ready → committing → confirmed`, plus `expired`.
      30-minute TTL, 5 live batches per company and 20 overall, a validate that would exceed the cap
      refused (`BOQ_TOO_MANY_BATCHES`) rather than evicting one somebody is reading. TTL, caps and
      the row threshold go in **centralized config** per Principle III, not inline.
- [X] T079 [US4] ✅ Done — `BOQ_NO_IMPORTABLE_ROWS`, and no batch issued Refuse to issue a batch for an empty result (FR-051): candidate rows found but none
      importable ⇒ `BOQ_NO_IMPORTABLE_ROWS`. A batch of nothing is a confirmable write of nothing,
      which is FR-036's prohibited shape reached by another route.
- [X] T080 [P] [US4] ✅ Done — 14 tests on the import service plus 8 on the batch store, against the synthetic fixture and the real file Unit tests for Phase B3 in `boq-import.service.spec.ts`: block identification
      against a far second block; a heading row opening a group; a quantity row before any heading
      raising a warning not an error; units normalising with `Excess (+)` resolving to none; the four
      tax columns dropped; amounts recomputed rather than read; a percentage outside 0–1 treated as
      not located; a located percentage whose total does not reconcile treated as not located; the
      row cap counted on candidates; and **no response carrying a batch with zero lines**.

**Checkpoint**: the client's file produces a report that reconciles, and the database is untouched.

### Phase B4: `confirm` — one transaction, once, by the right person

- [X] T081 [US4] ✅ Done — one `$transaction` under the caller's RLS context; groups then items then the percentage `confirm(batchId, userId, projectId)` in one `$transaction`: groups on first
      reference, then items, then `Project.quotedPercentage` **only if** the percentage was located.
- [X] T082 [US4] ✅ Done — `claim()` moves the batch to `committing` **before** the transaction opens and `release()` returns it to `ready` on failure. Asserted both ways: a second confirm during commit gets `BOQ_BATCH_IN_PROGRESS`, and a failed transaction leaves the batch retryable **Move the batch to `committing` before opening the transaction, and back to
      `ready` if it fails** (FR-052). Consuming it after the commit admits a double write; consuming
      it before loses the schedule when the transaction fails. A concurrent second confirm sees
      `committing` and gets `BOQ_BATCH_IN_PROGRESS`; a later one sees `confirmed` and gets
      `BOQ_BATCH_ALREADY_CONFIRMED`, which the interface shows as "already imported" rather than as
      a failure. One undifferentiated "not found" cannot be explained to whoever pressed the button.
- [X] T083 [US4] ✅ Done — ownership and project scope refused with `BOQ_BATCH_NOT_YOURS`; `BOQ_ALREADY_POPULATED` names the existing count, checked **inside** the transaction with a test asserting the call order, since two imports racing would otherwise both read an empty project Ownership and project scope (FR-050), and the populated-project refusal (FR-049):
      `BOQ_BATCH_NOT_YOURS` for a different user or project; `BOQ_ALREADY_POPULATED`, naming the
      existing line count, when the project already has BOQ lines. Appending is the same silent
      doubling by a different route — uploading twice rather than reading the wrong block — and
      replacing is impossible, since lines may already be referenced by a client bill line, a DWR
      task or an award line.
- [X] T084 [US4] ✅ Done — one entry, `AuditEntityType.BOQ_IMPORT` (new enum value + migration, separate from `BOQ_GROUP`/`BOQ_ITEM` because those describe rows). Asserted as `toHaveBeenCalledTimes(1)` **One** audit entry per import, naming the project, the batch, the group and line
      counts and whether the quoted percentage was set. Not 312 entries: one import is one act, and
      312 rows would bury the next thing in the log. (Replaces T026's DTO work, now with the
      programme fields optional.)
- [X] T085 [P] [US4] ✅ Done — 12 tests. **One design note found while writing them:** `BatchLookup` is a flat `{ batch, reason }` pair rather than a discriminated union, because this project compiles with `strictNullChecks: false` and a boolean discriminant does not narrow under it. Found by writing it the other way and reading the compiler error, and recorded on the type Unit tests in `boq-import-confirm.spec.ts`: confirm writes exactly the
      validated lines; a second confirm is refused and the line count is unchanged; a concurrent
      confirm hits `BOQ_BATCH_IN_PROGRESS`; a failed transaction returns the batch to `ready`; a
      batch with no located percentage leaves `quotedPercentage` untouched rather than writing 0;
      another user's confirm is refused; a populated project is refused.

**Checkpoint**: a BOQ exists, and 018's billing has something to measure against.

### Phase B5: Entry by hand, and the four alert groups

- [X] T086 [US4] ✅ Done — programme fields optional. **One deviation from research §4, deliberately**: the workbook arrives as **base64 in JSON**, not `multipart/form-data`. Every other upload in this product is base64 (company documents, equipment photos, purchase bills, payment attachments each say so at their own DTO) because feature 015 established the web client has no `FormData` anywhere; multipart here would mean introducing a second transport for one endpoint and the web half would have had to build it DTOs in `src/projects/boq/dto/` with the programme fields **optional**
      (FR-037): `create-boq-group.dto.ts`, `create-boq-item.dto.ts`, `import-boq-confirm.dto.ts`.
- [X] T087 [US4] ✅ Done — `deleteItem` checks **three** relations (`dwrTasks`, `clientBillLines`, `awardLines`) and names which one blocks; checking only the DWR, the only relation that existed when US4 was written, would let a billed line be deleted from under a submitted bill `BOQService` in `src/projects/boq/boq.service.ts`: `createGroup`, `createItem`,
      `getTree` (with `pendingQty`, `avgQtyPerDay`, `daysToComplete` computed, null where
      unplanned), `updateDoneQty` (on DWR **approval** only, research §13), `deleteItem` — `409` if
      referenced by a `DWRTask`, a `ClientBillLine` **or** a `WorkOrderBOQItem`; three relations,
      not one.
- [X] T088 [US4] ✅ Done — and **the first draft was defective in the amendment's own direction.** With four states and no `onTrack`, a line finished before its finish date fell into Today: completed work reported as due. FR-048 was corrected to five states, four of which are alert groups; `onTrack` is the absence of an alert and appears on the tree only `getAlerts` returning **four** mutually exclusive, jointly exhaustive groups
      (FR-047, FR-048), membership decided by the finish date alone: no finish date ⇒ `unplanned`;
      past with pending quantity ⇒ `delayed`; today ⇒ `today`; otherwise at risk when the rate
      needed to finish exceeds the rate achieved, where the needed rate is `perDayQty` when set and
      `pendingQty ÷ remaining days` otherwise. The old definition measured against `perDayQty`
      directly and would read every imported line as not-at-risk.
- [X] T089 [US4] ✅ Done — `Permission.PROJECTS` (not `PROJECT_FINANCIALS`: a schedule is project work, and a site engineer who may not see a bill may need the schedule), `ProjectLockGuard` on all five writes including both import steps, and `@Ip()` on confirm so the audit entry records a real address `BOQController` in `src/projects/boq/boq.controller.ts` — the entry endpoints, the
      two import steps and the alerts, each with `Permission.PROJECTS` and `ProjectLockGuard` on
      every write.
- [X] T090 [US4] ✅ Done — folded into `ProjectsModule` rather than a `BoqModule`, matching billing and pnl which have no modules of their own. `ImportBatchStore` is provided once, so it is the application-wide singleton the two-request flow needs. Injector verified by starting the app: `DI OK` Register `BoqModule` and wire it into `ProjectsModule`; confirm the injector
      resolves by starting the application.
- [X] T091 [P] [US4] ✅ Done — 13 tests, including the partially-planned line (finish date, no per-day quantity) landing in exactly one group, the finished-line case above, and `deleteItem` refused against each of the three relations separately Unit tests in `boq.service.spec.ts`: the four alert groups are exhaustive and
      disjoint across a fixture holding one line of each kind, **including a partially planned line**
      (finish date, no per-day quantity) which must land in exactly one group; `deleteItem` refuses
      against each of the three relations separately.

**Checkpoint**: a BOQ can be entered without a spreadsheet at all.

### Test fixtures, in two tiers because the real file is client data

- [X] T092 [P] [US4] ✅ Done — `test/fixtures/boq-synthetic.xls` plus the generator that builds it (`make-boq-synthetic.ts`, committed so the fixture can be changed on purpose rather than edited as binary). It reads as 10 lines under 4 groups; 12 would mean the span rule failed Commit a **synthetic** `.xls` at `test/fixtures/boq-synthetic.xls` reproducing
      every pathology in miniature: two levels with heading rows carrying no quantity, one unit
      spelled four ways, a second item-shaped block in far columns, the four blank tax columns,
      float-noisy stated totals, and a footer `Excess (+)`. Every assertion that must hold forever
      runs against this, so the suite is meaningful to someone who cannot hold the client's tender.
- [X] T093 [P] [US4] ✅ Done — asserts **231 ± 3 lines**, 12 normalised units with `Excess (+)` resolving to none, and both totals against the file's own figures within tolerance. Measured: 231 lines, 66 groups, ₹0.01 difference An **opt-in** test against `docs/BOQ_794578.xls` in `boq-real-file.spec.ts`
      that skips with a stated reason when the file is absent, asserting the three figures only it
      can: **312 ± 3 lines and not ~528** (an assertable range, because "about 312" is not a guard —
      a tolerance admitting 528 admits the failure); the 26 unit spellings resolving to 12 ± 1 units
      with `Excess (+)` resolving to none; and the derived totals against the file's own
      `2,99,61,506.78` and `3,06,98,559.85` within T076's tolerance.
- [X] T094 [US4] ✅ Done — `it.skip` with the reason in the test name, so an absent fixture reads as a skip and never as a pass A skipped test **reports as skipped and never as passed**, and the skip states why.
      Asserted as a property of the suite rather than noted beside it.

### Verification

- [X] T095 [US4] ✅ Done 2026-10-03 — `tsc --noEmit` clean; `eslint` 0 errors (8 pre-existing-style warnings, all `no-non-null-assertion` in test files); **1,593 tests across 140 suites, all passing**; prettier applied; injector verified by starting the application (`DI OK`). `fr-022` run green before each commit under its scanned paths after it fired once on the B2 files `npx tsc --noEmit`, `npx eslint src`, `npm test`, prettier per `.prettierrc.json`,
      and the injector check. Run `src/approvals/fr-022-unmigrated-modules.spec.ts` **before**
      committing anything under its scanned paths: it diffs two commits, so new files are invisible
      to it until the commit lands and it then fires one commit late.
- [X] T096 [US4] ✅ **Run 2026-10-03 against a real instance** — every pass in the table appended to `quickstart.md`. 231 lines not 462, both totals reconciling to ₹0.01 within ₹2.31, the percentage located, nothing written before confirm, a second confirm refused with the count unchanged, all 231 lines unplanned. **The run found a real defect**: pass 11.4's refusal fired only at confirm, so the populated-project check is now raised at validate too (FR-046) Walk `quickstart.md` passes 10–12 and record each result beside its task — pass 11's
      third step especially, that no upload anywhere produces a success carrying zero lines, which is
      the shape the already-approved library would have returned for the client's real file.

### Carried from the 2026-10-03 analysis pass

- [X] T097 **[US4] Built 2026-10-03, after the client asked for it.** US4 AC6's
      `POST /projects/:id/boq/estimate-import` and the `isEstimate: true` variant have **no task
      coverage at all** — not in T026–T030, and not in T061–T096. The analysis pass surfaced it
      because superseding T026–T030 removed the only phase it could have been assumed to live in.
      Deferred rather than built, on three grounds: `isEstimate` is read by **nothing** in `src/`
      (checked, zero occurrences); the client's file is a tender schedule and not an estimate, so
      nothing in the work that prompted this amendment needs it; and an estimate variant whose only
      consumer is a boolean nobody reads would be scaffolding, not a feature. **If the estimate
      import is wanted, it is its own decision** — most of FR-036 – FR-056 applies to it unchanged,
      so it is a small piece of work, but it is work nobody has asked for.

      **It was asked for later the same day, and the second and third grounds were answered rather
      than waived.** The variant is built, and `isEstimate` now decides three things — which is what
      stops it being the scaffolding this note warned about:

      * **An estimate line is not billable.** `billableBoq` excludes it from the schedule entirely
        and `compose` refuses one named directly, with `BOQ_LINE_IS_ESTIMATE` and the BOQ number.
        Without this, importing an estimate would put the company's own costing on the client's
        billable schedule at the company's own rates — doubled quantities at the wrong prices, on a
        document indistinguishable from a correct one.
      * **An estimate is absent from the alert groups**, at both the group and the line level. It
        carries no programme and nobody is delivering it; reported as unplanned it would bury the
        tender's own lines under a second copy of the same scope. It stays on the **tree**, because
        somebody entered it and must be able to read it.
      * **An estimate never sets `Project.quotedPercentage`.** That is the bidder's quote against
        the client and every client bill is priced with it; an internal costing's percentage written
        there would reprice the whole tender at a figure the client never saw.

      The pipeline is the tender's, unchanged — every refusal, the block identification, the unit
      normalisation and the reconciliation, because those are about reading a workbook honestly and
      that does not depend on whose figures it carries. `estimate-import.spec.ts` asserts the two
      reports are identical figure for figure, so a second parser cannot creep in.

      One behaviour had to change for the variant to be usable: the already-populated refusal is now
      **scoped to the variant and names it**. A project may legitimately hold a tender and an
      estimate — that is what a separate variant is *for* — and a single unscoped count made
      importing the second impossible while reporting a figure the operator could not reconcile with
      the screen in front of them.

      Fourteen assertions across `estimate-import.spec.ts`, `boq.service.spec.ts` and
      `test/client-bills.e2e-spec.ts`, each paired with the tender case so none of them passes by
      accident.
- [X] T098 [US4] ✅ Done — FR-042 cited on T069 and FR-040 on T075 Add the two missing citations found by the analysis pass: **FR-040** on T075 (the
      percentage is never imported as zero) and **FR-042** on T069 (the schedule block, and the far
      second block it excludes). Both are the money guards a reviewer will look for by ID, and both
      were covered in prose only — which is how a requirement survives a refactor in text and dies
      in code.

---

## Closed by feature 025 (2026-10-05)

`specs/025-projects-flow-completion/` closed the three convergence items above:

- **T057** — `SitesService.getGeofence()` now carries `isActive`, and `PunchService` refuses a punch
  at a site out of service. **Refused rather than recorded as an exception**: a failed fence and a
  failed face match are evidence about a punch that happened, and this is a punch that should not
  have been offered. Covered in `punch.service.spec.ts` with its non-vacuity half — a test that a
  live site still accepts one, without which a condition inverted by a typo would stop attendance
  everywhere and pass.
- **T058** — the contract was right and the acceptance scenario was not. US3/AC3 no longer names a
  costing breakdown: costing is the P&L (FR-008, US7), with its own endpoint, drill-down and
  export, and duplicating it into the project detail would put two figures for one cost on two
  screens.
- **T059** — FR-012 and the US2 note no longer cite `SitesService.getHolidayCalendar()`, which does
  not exist and cannot: `Site.holidays` was dropped by `20260901194500_drop_site_holidays_column`
  and the first-class `hr.Holiday` calendar superseded it.

**T026–T030 and T037–T051 above remain superseded or delivered elsewhere**, as their own notes say.
**TA001–TA020 are superseded by `specs/026-project-schedule-backend/`** (2026-10-05) — the schedule
and progress module: phases, activities, dependencies, baselines, weightage, periodic targets and
variance reporting. Specified, **not planned and not built**. 025 explicitly left it alone, because
that feature plans a *line* and this one plans a *programme*; 026 FR-003 is where the two have to be
reconciled.

Three decisions are open in that spec and are deliberately not guessed: how an activity is weighted,
whether a baseline freezes weights as well as dates, and where percent complete comes from for an
activity that names no BOQ line. Each is a question about how this organisation plans work rather
than about software, and each would otherwise produce a confident wrong number.
