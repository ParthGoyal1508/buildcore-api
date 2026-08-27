# Tasks: Machinery Backend (Asset Register, Logbook, Fuel, Maintenance, Hire Bills, Equipment Categories, Equipment Doc Types, Hire Rates)

**Input**: Design documents from `/specs/006-machinery-backend/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/machinery-api.md,
quickstart.md — all present.

**Tests**: Included per this repo's constitution (Development Workflow & Quality Gates —
new services/guards MUST ship with unit tests; endpoints touching financial calculations MUST
have e2e coverage). No test-first ordering was explicitly requested; unit/e2e tasks are placed in
Polish per this feature's Testing plan (plan.md), covering the module's highest-stakes computed
values.

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Setup

- [ ] T001 [P] Create `machinery` module scaffolding (`src/machinery/machinery.module.ts`) and
  register it in `src/app.module.ts`.
- [ ] T002 [P] Create `partners/vendors` module scaffolding (`src/partners/partners.module.ts`,
  `src/partners/vendors/`) and register it in `src/app.module.ts` — the first claim on the
  `partners` schema (research.md §2).

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [ ] T003 Add the `plant` schema's ten tables (Equipment, EquipmentDocument, EquipmentCategory,
  EquipmentDocType, LogbookEntry, FuelEntry, ServiceSchedule, MaintenanceJob, HireBill, HireRate)
  to `prisma/schema.prisma` per data-model.md, and generate the migration.
- [ ] T004 [P] Add the minimal `partners.Vendor` table to `prisma/schema.prisma` per
  data-model.md, and generate the migration (research.md §2).
- [ ] T005 [P] Extend `settings.Permission` enum with `ASSET_REGISTER`, `LOGBOOK`, `FUEL`,
  `MAINTENANCE`, `HIRE_BILLS`, `MACHINERY_SETTINGS` and generate the migration (research.md §6).
- [ ] T006 [P] Seed the 10 PRD-named `EquipmentCategory` defaults (including
  `fuelVarianceThresholdPercent: 15`, `hireBillVarianceThresholdPercent: 5`) in `prisma/seed.ts`
  (research.md §8, §9).
- [ ] T007 [P] Seed the 10 PRD-named `EquipmentDocType` defaults in `prisma/seed.ts`
  (research.md §8).
- [ ] T008 [P] Implement minimal `VendorsService` + `VendorsController` CRUD in
  `src/partners/vendors/` — guarded with `MACHINERY_SETTINGS` as an interim gate (documented with
  a code comment noting a future Partners feature owns real Partners-scoped permissions;
  research.md §2).
- [ ] T009 [P] Register a new BullMQ queue for Machinery's two scheduled jobs, extending 004's
  existing `@nestjs/bullmq` wiring, in `src/machinery/machinery.module.ts` (research.md §4).

**Checkpoint**: Foundation ready — user story implementation can now begin.

---

## Phase 3: User Story 1 - Asset Register (Priority: P1) 🎯 MVP

**Goal**: Register and maintain equipment records with compliance-document tracking.

**Independent Test**: Create an equipment record, upload a document with an expiry date, and
confirm the auto-derived document status and Flags count.

- [ ] T010 [P] [US1] Create Equipment DTOs (create/update/list-filter) in
  `src/machinery/equipment/dto/`.
- [ ] T011 [US1] Implement `EquipmentService` (CRUD, filtered list, `flagsCount`), rejecting a
  deactivated `categoryId` on create (FR-030) while preserving the reference on existing records,
  in `src/machinery/equipment/equipment.service.ts` (depends on T003, T010).
- [ ] T012 [US1] Implement Site-reference validation via a `ProjectsService`-shaped call inside
  `EquipmentService` (research.md §3, FR-002).
- [ ] T013 [US1] Implement `EquipmentController`, guarded with `ASSET_REGISTER`, in
  `src/machinery/equipment/equipment.controller.ts` (depends on T011).
- [ ] T014 [P] [US1] Create EquipmentDocument DTOs in `src/machinery/equipment/documents/dto/`.
- [ ] T015 [US1] Implement `EquipmentDocumentsService` — enforces `hasExpiryDate`/
  `needsDocumentNumber` per the referenced `EquipmentDocType`, rejects a deactivated `docTypeId`
  on upload (FR-030) while preserving the reference on existing records, derives Valid/Expiring/
  Expired status — in `src/machinery/equipment/documents/equipment-documents.service.ts` (depends
  on T003, T014).
- [ ] T016 [US1] Implement `EquipmentDocumentsController`, guarded with `ASSET_REGISTER`, in
  `src/machinery/equipment/documents/equipment-documents.controller.ts` (depends on T015).
- [ ] T017 [US1] Implement `UtilizationService` (formula per research.md §10) in
  `src/machinery/equipment/utilization.service.ts` (depends on T011).
- [ ] T018 [US1] Implement `DocumentExpiryScanJob` (BullMQ repeatable, daily) — recomputes every
  `EquipmentDocument.status`, refreshes cached `utilizationPercent`, and raises Dashboard/
  Notification entries for newly Expiring/Expired documents — in
  `src/machinery/jobs/document-expiry-scan.job.ts` (depends on T009, T015, T017).
- [ ] T019 [US1] Wire `AuditLogService` calls for every Equipment and EquipmentDocument create/
  update action (FR-033).

**Checkpoint**: User Story 1 is fully functional and independently testable.

---

## Phase 4: User Story 2 - Logbook (Priority: P1)

**Goal**: Daily logbook entries that keep the machine's Current Reading accurate.

**Independent Test**: Create a logbook entry and confirm the machine's Current Reading updates,
and that the next entry pre-populates Opening Reading from it.

- [ ] T020 [P] [US2] Create LogbookEntry DTOs in `src/machinery/logbook/dto/`.
- [ ] T021 [US2] Implement Operator validation via an `EmployeesService`-shaped call
  (research.md §3, FR-011).
- [ ] T022 [US2] Implement `LogbookService` — Opening Reading suggestion, Closing ≥ Opening
  validation with the `isMeterResetOverride` escape hatch (FR-012), Equipment.currentReading
  update on save — in `src/machinery/logbook/logbook.service.ts` (depends on T011, T020, T021).
- [ ] T023 [US2] Implement `LogbookController`, guarded with `LOGBOOK`, in
  `src/machinery/logbook/logbook.controller.ts` (depends on T022).
- [ ] T024 [US2] Wire `AuditLogService` calls for LogbookEntry create/update/delete (FR-033).

**Checkpoint**: User Stories 1 AND 2 both work independently.

---

## Phase 5: User Story 3 - Fuel (Priority: P2)

**Goal**: Record fuel entries and auto-detect consumption variance.

**Independent Test**: Record a fuel entry whose resulting consumption rate exceeds the category
benchmark by more than the threshold, and confirm a variance alert is raised.

- [ ] T025 [P] [US3] Create FuelEntry DTOs in `src/machinery/fuel/dto/`.
- [ ] T026 [US3] Implement `FuelService` — Amount computation, Vendor `type: 'fuel'` validation
  via `VendorsService`, filtered-list totals — in `src/machinery/fuel/fuel.service.ts` (depends
  on T008, T011).
- [ ] T027 [US3] Implement `FuelController`, guarded with `FUEL`, in
  `src/machinery/fuel/fuel.controller.ts` (depends on T026).
- [ ] T028 [US3] Implement `FuelVarianceJob` (BullMQ repeatable) — compares each machine's recent
  fuel-vs-logbook-hours consumption rate to its effective benchmark (override or category
  default), raising an alert when it exceeds the category's `fuelVarianceThresholdPercent` — in
  `src/machinery/fuel/fuel-variance.job.ts` (depends on T009, T022, T026).
- [ ] T029 [US3] Wire `AuditLogService` calls for FuelEntry create/update/delete (FR-033).

**Checkpoint**: User Stories 1, 2, and 3 all work independently.

---

## Phase 6: User Story 4 - Maintenance (Priority: P2)

**Goal**: Preventive service schedules and maintenance jobs that keep machine Status accurate.

**Independent Test**: Open a maintenance job linked to a schedule, confirm Status becomes Under
Maintenance, close it, and confirm Status reverts and the schedule resets.

- [ ] T030 [P] [US4] Create ServiceSchedule + MaintenanceJob DTOs in
  `src/machinery/maintenance/dto/`.
- [ ] T031 [US4] Implement `ServiceSchedulesService` (Remaining-units calculation, <10% flag) and
  `ServiceSchedulesController`, guarded with `MAINTENANCE`, in
  `src/machinery/maintenance/service-schedules.service.ts` /
  `service-schedules.controller.ts` (depends on T011, T030).
- [ ] T032 [US4] Implement `MaintenanceJobsService` — open sets Equipment Status to
  `under_maintenance` via `EquipmentService`, close resets it to `active` and updates the linked
  schedule's Last Done reading/date + Remaining reset — in
  `src/machinery/maintenance/maintenance-jobs.service.ts` (depends on T011, T031).
- [ ] T033 [US4] Implement `MaintenanceJobsController`, guarded with `MAINTENANCE`, in
  `src/machinery/maintenance/maintenance-jobs.controller.ts` (depends on T032).
- [ ] T034 [US4] Wire maintenance-due notification generation (open jobs and <10%-remaining
  schedules) into the Dashboard/Notification provider registry (FR-022, depends on T031, T032).
- [ ] T035 [US4] Wire `AuditLogService` calls for ServiceSchedule/MaintenanceJob create/update/
  status-transition (FR-033).

**Checkpoint**: User Stories 1–4 all work independently.

---

## Phase 7: User Story 5 - Hire Bills (Priority: P2)

**Goal**: Verify hire bills against logbook data before authorizing payment.

**Note**: This phase also builds Hire Rates (spec User Story 6's third acceptance scenario),
ahead of the rest of User Story 6, because Hire Bills cannot default a rate or resolve an
effective-dated lookup without it existing first — the same kind of real cross-story dependency
feature 005 handled by building Loans ahead of Payroll. The Hire Rates admin CRUD built here
satisfies both this story's FR-024 dependency and spec User Story 6's acceptance scenario 3.

**Independent Test**: Create a hire bill whose Billed Hours differ from summed Logbook Hours for
the period, Verify it, and confirm Variance/TDS/Net Payable and the Status workflow are correct.

- [ ] T036 [P] [US5] Create HireBill DTOs in `src/machinery/hire-bills/dto/` and HireRate DTOs in
  `src/machinery/rates/dto/`.
- [ ] T037 [US5] Implement `HireRatesService` (effective-dated resolution; on create, closes the
  prior "current" rate's `effectiveTo` to preserve non-overlapping history) and
  `HireRatesController`, guarded with `MACHINERY_SETTINGS`, in
  `src/machinery/rates/hire-rates.service.ts` / `hire-rates.controller.ts` (depends on T003,
  T036; FR-029).
- [ ] T038 [US5] Implement `HireBillsService` — rejects creation unless Equipment.ownership is
  `hired`, defaults Rate from `HireRatesService` and rejects creation if no rate is effective for
  the bill's period start date (spec Edge Cases), Verify sums LogbookEntry hours for the period
  and compares against the category's `hireBillVarianceThresholdPercent`, Mark Paid rejects
  (409) unless Status is currently `verified` and otherwise computes TDS/Net Payable from the
  Vendor record — in `src/machinery/hire-bills/hire-bills.service.ts` (depends on T008, T011,
  T022, T037; FR-023–FR-026).
- [ ] T039 [US5] Implement `HireBillsController`, guarded with `HIRE_BILLS`, in
  `src/machinery/hire-bills/hire-bills.controller.ts` (depends on T038).
- [ ] T040 [US5] Wire `AuditLogService` calls for HireBill status transitions and HireRate
  creation (FR-033).

**Checkpoint**: User Stories 1–5 all work independently.

---

## Phase 8: User Story 6 - Equipment Categories & Doc Types masters (Priority: P3)

**Goal**: Admin CRUD for the seeded Equipment Categories and Equipment Doc Types reference data
(Hire Rates already built in Phase 7 — see the note there).

**Independent Test**: Edit a seeded category's fuel benchmark and confirm a subsequent Fuel entry
(US3) uses the updated value; edit a doc type's remind-days and confirm subsequent document-status
derivation (US1) reflects it.

- [ ] T041 [P] [US6] Create EquipmentCategory DTOs in `src/machinery/categories/dto/` and
  EquipmentDocType DTOs in `src/machinery/doc-types/dto/`.
- [ ] T042 [US6] Implement `EquipmentCategoriesService` + `EquipmentCategoriesController`, guarded
  with `MACHINERY_SETTINGS`, in `src/machinery/categories/` (depends on T003, T041; FR-027,
  FR-030).
- [ ] T043 [US6] Implement `EquipmentDocTypesService` + `EquipmentDocTypesController`, guarded
  with `MACHINERY_SETTINGS`, in `src/machinery/doc-types/` (depends on T003, T041; FR-028,
  FR-030).
- [ ] T044 [US6] Wire `AuditLogService` calls for EquipmentCategory/EquipmentDocType create/update
  (FR-033).

**Checkpoint**: All six user stories are independently functional.

---

## Phase 9: Polish & Cross-Cutting Concerns

- [ ] T045 [P] Implement Dashboard widget-provider registrations (Machinery Cost, Fuel Cost, Hire
  Bills) into 004's `WIDGET_PROVIDERS` token in
  `src/machinery/dashboard-providers/machinery-widget.providers.ts` (research.md §7, FR-034).
- [ ] T046 [P] Implement Dashboard notification-provider registrations (Document Expiry, Fuel
  Variance, Maintenance Due) into 004's `NOTIFICATION_PROVIDERS` token in
  `src/machinery/dashboard-providers/machinery-notification.providers.ts` (research.md §7,
  FR-034).
- [ ] T047 [P] Unit tests for `UtilizationService`'s formula in
  `src/machinery/equipment/utilization.service.spec.ts`.
- [ ] T048 [P] Unit tests for `HireBillsService`'s variance/TDS/Net Payable computation in
  `src/machinery/hire-bills/hire-bills.service.spec.ts`.
- [ ] T049 [P] Unit tests for `HireRatesService`'s effective-dated resolution and non-overlapping-
  history invariant in `src/machinery/rates/hire-rates.service.spec.ts`.
- [ ] T050 [P] Unit tests for `MaintenanceJobsService`'s open/close status transitions in
  `src/machinery/maintenance/maintenance-jobs.service.spec.ts`.
- [ ] T051 e2e test suite in `test/machinery.e2e-spec.ts` covering every endpoint in
  contracts/machinery-api.md and all six permission guards independently.
- [ ] T052 Run quickstart.md validation end-to-end.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately.
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS all user stories.
- **User Stories (Phase 3–8)**: All depend on Foundational. US1 and US2 (P1) have no dependency on
  each other. US3 and US4 (P2) depend on US1 (Equipment) and, for US3's variance job, US2
  (Logbook). US5 (P2) depends on US1, US2, and Foundational's Vendor (T008); it also builds Hire
  Rates ahead of the rest of US6 (see the note in Phase 7). US6's remaining scope (Categories/Doc
  Types admin CRUD) depends only on Foundational's seed data (T006/T007) — it is independently
  testable without US1–US5, since those stories only need the *seeded* reference data, not its
  admin CRUD screens.
- **Polish (Phase 9)**: Depends on all six user stories being complete.

### Within Each User Story

- DTOs before services; services before controllers; cross-schema reference validation
  (Site/Employee/Vendor) wired into the service that needs it before that service is considered
  done; audit logging wired last, once the entity's mutation paths are stable.

### Parallel Opportunities

- All Setup tasks (T001–T002) in parallel.
- Within Foundational: T004–T009 in parallel once T003 lands (T003 itself is the single serialization
  point since every schema addition lands in the same `prisma/schema.prisma` file).
- Within each user story, the `[P]`-marked DTO task can run alongside other stories' DTO tasks.
- US1 and US2 can be built in parallel by different developers once Foundational completes.
- US6's Categories/Doc Types scope (T041–T044) can be built in parallel with US3/US4/US5 once
  Foundational completes, since it has no dependency on them.

---

## Parallel Example: User Story 1

```bash
Task: "Create Equipment DTOs in src/machinery/equipment/dto/"
Task: "Create EquipmentDocument DTOs in src/machinery/equipment/documents/dto/"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational
3. Complete Phase 3: User Story 1 (Asset Register)
4. **STOP and VALIDATE**: Test Asset Register independently via quickstart.md Scenario 1
5. Deploy/demo if ready

### Incremental Delivery

1. Setup + Foundational → Foundation ready
2. US1 (Asset Register) → test independently → MVP
3. US2 (Logbook) → test independently
4. US3 (Fuel) and US4 (Maintenance) → test independently (can proceed in parallel)
5. US5 (Hire Bills, including Hire Rates) → test independently
6. US6 remainder (Categories/Doc Types admin CRUD) → test independently
7. Polish (Dashboard/Notification provider registrations, tests) → full quickstart.md validation

## Notes

- `[P]` tasks touch different files with no unmet dependency.
- `[Story]` labels map every implementation task to its owning user story for traceability.
- Every controller task states its guarding `Permission` value explicitly (learned practice from
  this project's prior features' analyze passes).
- Commit after each task or logical group; stop at any checkpoint to validate a story
  independently.
