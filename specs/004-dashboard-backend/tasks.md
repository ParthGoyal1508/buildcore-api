---

description: "Task list for feature implementation"
---

# Tasks: Dashboard & General Backend (Widgets, Notifications, Activity Log, Reports)

**Input**: Design documents from `/specs/004-dashboard-backend/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md,
contracts/dashboard-api.md, quickstart.md

**Tests**: Included. Attendance/leave/employee-search data qualifies under this repo's
constitution's "new endpoints touching auth, payroll, or PII fields MUST have an e2e test"
requirement — same posture as features 001–003.

**Organization**: Tasks are grouped by user story (from spec.md) to enable independent
implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1–US7)
- Every task includes an exact file path

---

## Phase 1: Setup (Shared Infrastructure)

- [ ] T001 Add `@nestjs/bullmq` and `exceljs` as dependencies (constitution v1.2.0 pre-approval,
      `pdfkit` already present from feature 003) in `package.json`
- [ ] T002 Add a Redis service to `docker-compose.yml` (or a new `docker-compose.redis.yml`) as
      BullMQ's backing store — research.md §6
- [ ] T003 [P] Extend `src/common/configs/config.interface.ts` with `DashboardConfig` (widget
      refresh interval default 30s, async-export row threshold) — research.md §5, §6
- [ ] T004 [P] Populate `DashboardConfig` defaults in `src/common/configs/config.ts`
- [ ] T005 Create `src/dashboard/dashboard.module.ts` shell, registering the BullMQ queue
      connection, in `src/app.module.ts`

**Checkpoint**: Dependencies, Redis, config, and module shell ready.

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [ ] T006 Add the `ExportJob` model to the existing `shared` schema in `prisma/schema.prisma`
      (data-model.md "Export Job") + migration via `migrate:dev:create`/`migrate:dev`
- [ ] T007 Add RLS policy for `ExportJob` (companyId-scoped, same session-variable pattern as
      prior features)
- [ ] T008 [P] Create `src/dashboard/widgets/widget.types.ts`: `WidgetProvider` interface,
      `WIDGET_PROVIDERS` multi-provider token — research.md §1
- [ ] T009 [P] Create `src/dashboard/notifications/notification.types.ts`:
      `NotificationProvider` interface, `NOTIFICATION_PROVIDERS` token — research.md §1
- [ ] T010 [P] Create `src/dashboard/reports/report.types.ts`: `ReportProvider` interface,
      `REPORT_PROVIDERS` token — research.md §1
- [ ] T011 Create `src/dashboard/dashboard.controller.ts`'s `DashboardService`: iterates all
      injected `WIDGET_PROVIDERS`, calls `isAvailable()`/`compute()` in parallel (`Promise.all`),
      assembles the `WidgetResult[]` envelope — spec FR-001, FR-002, research.md §1, §7 (depends on
      T008)
- [ ] T012 [P] Create `src/dashboard/activity-log/module-bucket-mapping.ts`: static
      `AuditLogEntry.entityType` → PRD module-filter-bucket map (data-model.md "Activity Log
      module-bucket mapping")

**Checkpoint**: Registry infrastructure and the generic widget-resolution engine ready — user
story implementation can now begin in parallel.

---

## Phase 3: User Story 1 - Extensible widget aggregation framework (Priority: P1) 🎯 MVP

**Goal**: A single endpoint returns a self-describing widget list; unbuilt-module widgets return
an explicit unavailable state; new widgets require no contract change.

**Independent Test**: Call the widget endpoint, confirm every entry follows the shared envelope,
and confirm at least one placeholder widget returns `unavailable` rather than a fabricated value.

### Tests for User Story 1 ⚠️

- [ ] T013 [P] [US1] E2e test: widget endpoint returns the shared envelope for every entry
      (id/displayType/title/section + value-or-unavailable) in `test/dashboard.e2e-spec.ts`
- [ ] T014 [P] [US1] E2e test: a permission-lacking caller is rejected before any computation
      (verified via no side effects) in `test/dashboard.e2e-spec.ts`
- [ ] T015 [P] [US1] Unit test: registering a new placeholder `WidgetProvider` doesn't change any
      existing provider's resolved output in `src/dashboard/widgets/widget.types.spec.ts`

### Implementation for User Story 1

- [ ] T016 [US1] Create `src/dashboard/widgets/unbuilt-module.placeholders.ts`: one
      `WidgetProvider` class per not-yet-computable widget (Active Projects, Total Machinery,
      Monthly Expenses, Contract Value, Materials Cost, Fuel Cost, Hire Bills, Alerts & Reminders),
      each `isAvailable(): false` with `unavailable: { reason: 'module_pending', module: <name> }`
      — spec FR-003, research.md §2 (depends on T008)
- [ ] T017 [US1] Implement `src/dashboard/dashboard.controller.ts`: `GET /dashboard/widgets`,
      guarded with `@RequirePermission(Permission.DASHBOARD)` (depends on T011, T016)
- [ ] T018 [US1] Register all Phase 3 providers in `src/dashboard/dashboard.module.ts`

**Checkpoint**: User Story 1 fully functional and independently testable.

---

## Phase 4: User Story 2 - Company Dashboard KPIs and tables (Priority: P1)

**Goal**: Real company-wide KPI and table widgets computed from already-specced Employee/
Attendance/Leave data.

**Independent Test**: Request widgets for a seeded company and confirm Total Employees/Present/
Absent/On Leave/Pending Approvals match the data, and the two table widgets return correct rows.

### Tests for User Story 2 ⚠️

- [ ] T019 [P] [US2] E2e test: KPI widgets match seeded employee/attendance/leave counts; Pending
      Approvals counts Pending leave applications only in `test/dashboard.e2e-spec.ts`
- [ ] T020 [P] [US2] E2e test: Today's Attendance (first 8) and Recent Leaves table widgets return
      correct rows in `test/dashboard.e2e-spec.ts`
- [ ] T021 [P] [US2] Unit test: Employees on Muster stat computation in
      `src/dashboard/widgets/muster-stat.provider.spec.ts`

### Implementation for User Story 2

- [ ] T022 [P] [US2] Create `src/dashboard/widgets/company-kpi.providers.ts`: Total Employees,
      Present Today, Absent, On Leave, Pending Approvals `WidgetProvider`s, each calling `hr`'s
      exported `EmployeesService`/`AttendanceHistoryService`/`LeaveService` methods — spec FR-005
      (depends on T008)
- [ ] T023 [P] [US2] Create `src/dashboard/widgets/attendance-table.provider.ts` and
      `recent-leaves-table.provider.ts` — spec FR-006 (depends on T008)
- [ ] T024 [P] [US2] Create `src/dashboard/widgets/muster-stat.provider.ts`: Employees on Muster
      (present/total) — spec Acceptance Scenario 5 (depends on T008)
- [ ] T025 [US2] Register Phase 4 providers in `src/dashboard/dashboard.module.ts` (depends on
      T018)

**Checkpoint**: User Stories 1 AND 2 both independently functional.

---

## Phase 5: User Story 3 - Query the Activity Log (Priority: P1)

**Goal**: A read/query endpoint over the existing shared audit log, filterable by module and time
range.

**Independent Test**: Perform a Settings edit and a My Workspace leave application, confirm both
appear newest-first and are correctly filterable.

### Tests for User Story 3 ⚠️

- [ ] T026 [P] [US3] E2e test: unfiltered feed returns entries newest-first with correct fields;
      module filter and time-range filter both narrow correctly and combine in
      `test/dashboard.e2e-spec.ts`
- [ ] T027 [P] [US3] E2e test: a module with zero real entries (e.g. machinery) returns empty, not
      an error; company scoping is enforced in `test/dashboard.e2e-spec.ts`
- [ ] T028 [P] [US3] Unit test: `module-bucket-mapping.ts`'s entityType → bucket mapping in
      `src/dashboard/activity-log/module-bucket-mapping.spec.ts`

### Implementation for User Story 3

- [ ] T029 [US3] Implement `src/dashboard/activity-log/activity-log.service.ts`: reads
      `shared.AuditLogEntry` directly (same-schema read, not cross-schema — research.md §4),
      applies module-bucket mapping (T012) and time-range filter, paginates, company-scopes
      (depends on T012)
- [ ] T030 [US3] Implement `src/dashboard/activity-log/activity-log.controller.ts`:
      `GET /activity-log?module=&timeRange=&page=`, guarded with
      `@RequirePermission(Permission.DASHBOARD)` — spec FR-007, FR-008 (depends on T029)
- [ ] T031 [US3] Register `ActivityLogController`/`ActivityLogService` in
      `src/dashboard/dashboard.module.ts`

**Checkpoint**: User Stories 1–3 independently functional.

---

## Phase 6: User Story 4 - Notifications Center (Priority: P2)

**Goal**: A notifications endpoint listing currently-active, system-generated notifications
computed fresh, plus a count endpoint; entries disappear automatically when resolved.

**Independent Test**: Create a pending leave application and re-enrolment request, confirm both
appear; approve the leave application, confirm it disappears without a dismiss action.

### Tests for User Story 4 ⚠️

- [ ] T032 [P] [US4] E2e test: Pending Leave Approvals, Biometric Re-enrolment Requests, and
      Payroll Pending all appear correctly when their conditions hold; unbuilt-module types are
      simply absent in `test/dashboard.e2e-spec.ts`
- [ ] T033 [P] [US4] E2e test: resolving a condition (approve leave) removes its notification on
      next fetch, with no dismiss endpoint called in `test/dashboard.e2e-spec.ts`
- [ ] T034 [P] [US4] E2e test: notification count matches list length; company scoping enforced in
      `test/dashboard.e2e-spec.ts`

### Implementation for User Story 4

- [ ] T035 [P] [US4] Create `src/dashboard/notifications/leave-pending.provider.ts`,
      `reenrolment-pending.provider.ts`, `payroll-pending.provider.ts` — spec FR-010 (depends on
      T009)
- [ ] T036 [US4] Implement `src/dashboard/notifications/notifications.service.ts`: iterates
      `NOTIFICATION_PROVIDERS` in parallel, assembles active rows — spec FR-009 (depends on T009,
      T035)
- [ ] T037 [US4] Implement `src/dashboard/notifications/notifications.controller.ts`:
      `GET /notifications`, `GET /notifications/count`, guarded with
      `@RequirePermission(Permission.DASHBOARD)` (depends on T036)
- [ ] T038 [US4] Register Phase 6 providers/controller in `src/dashboard/dashboard.module.ts`

**Checkpoint**: User Stories 1–4 independently functional.

---

## Phase 7: User Story 5 - Site Dashboard (Priority: P2)

**Goal**: Site selector plus site-scoped KPI/table widgets, refreshing per site selection.

**Independent Test**: Select a seeded site, confirm Workers Today and Today's Attendance reflect
only that site.

### Tests for User Story 5 ⚠️

- [ ] T039 [P] [US5] E2e test: site list scoped to caller's company; Workers Today and site
      attendance table correct for the selected site in `test/dashboard.e2e-spec.ts`
- [ ] T040 [P] [US5] E2e test: Machinery/Fuel/Material widgets return unavailable; a site from
      another company is rejected (403); a caller lacking `DASHBOARD` permission is rejected on
      both site-dashboard endpoints (spec FR-022) in `test/dashboard.e2e-spec.ts`

### Implementation for User Story 5

- [ ] T041 [P] [US5] Create `src/dashboard/widgets/site-widgets.providers.ts`: Workers Today,
      site-scoped Today's Attendance `WidgetProvider`s calling `hr`'s exported services filtered by
      `siteId` — spec FR-012 (depends on T008)
- [ ] T042 [US5] Extend `unbuilt-module.placeholders.ts` (T016) with Machinery Deployed, Fuel
      Consumed, Material Stock Value, and the four site-scoped table placeholders — spec FR-012
- [ ] T043 [US5] Implement `src/dashboard/site-dashboard.controller.ts`:
      `GET /site-dashboard/sites` (via `projects`' exported `SitesService`),
      `GET /site-dashboard/widgets?siteId=` (403 on cross-company site), both guarded with
      `@RequirePermission(Permission.DASHBOARD)` — spec FR-013, FR-022 (depends on T041)
- [ ] T044 [US5] Register Phase 7 providers/controller in `src/dashboard/dashboard.module.ts`

**Checkpoint**: User Stories 1–5 independently functional.

---

## Phase 8: User Story 6 - Group Dashboard and cross-company employee search (Priority: P2)

**Goal**: Per-company summary cards + Group Total, scoped to caller's accessible companies, plus
cross-company employee search.

**Independent Test**: As cross-company Super Admin, confirm one card per company + correct Group
Total; as single-company user, confirm only one card; search by a 2+ character term.

### Tests for User Story 6 ⚠️

- [ ] T045 [P] [US6] E2e test: cross-company Super Admin sees all accessible companies' cards +
      Group Total with correct Headcount; other figures unavailable in
      `test/dashboard.e2e-spec.ts`
- [ ] T046 [P] [US6] E2e test: single-company user sees only their own company's card in
      `test/dashboard.e2e-spec.ts`
- [ ] T047 [P] [US6] E2e test: employee search matches name/code/Aadhaar-last-4 across accessible
      companies; rejects a <2-char term (400) in `test/dashboard.e2e-spec.ts`
- [ ] T048 [P] [US6] E2e test: Statutory Calendar returns unavailable; a caller lacking
      `DASHBOARD` permission is rejected on all three `/group/*` endpoints (spec FR-022) in
      `test/dashboard.e2e-spec.ts`

### Implementation for User Story 6

- [ ] T049 [US6] Create `src/dashboard/widgets/group-company-card.provider.ts`: Headcount real
      (via `settings`' exported `CompaniesService` + `hr`'s `EmployeesService`), Payroll Cost/
      PF-ESIC Pending/Loans Outstanding/Docs Pending unavailable, plus Group Total aggregation —
      spec FR-014, FR-015 (depends on T008)
- [ ] T050 [US6] Implement `src/dashboard/group.controller.ts`: `GET /group/companies`,
      `GET /group/statutory-calendar` (unavailable), `GET /group/employees/search?q=` (min-2-char
      validation, cross-company scoped), all guarded with `@RequirePermission(Permission.
      DASHBOARD)` — spec FR-016, FR-017, FR-022 (depends on T049)
- [ ] T051 [US6] Register `GroupController`/`GroupCompanyCardProvider` in
      `src/dashboard/dashboard.module.ts`

**Checkpoint**: User Stories 1–6 independently functional.

---

## Phase 9: User Story 7 - Reports and export (Priority: P3)

**Goal**: Report-type registry, real Attendance/Employee reports, PDF/Excel export with async
handling for large exports.

**Independent Test**: List report types, run Attendance report, export to PDF and Excel; confirm a
large export goes async and completes via the job queue.

### Tests for User Story 7 ⚠️

- [ ] T052 [P] [US7] E2e test: report-type list flags Attendance/Employee available, rest
      unavailable, with filter metadata; a caller lacking `REPORTS` permission is rejected on
      `/reports/*` endpoints (spec FR-022) in `test/dashboard.e2e-spec.ts`
- [ ] T053 [P] [US7] E2e test: Attendance and Employee reports return correct tabular data for a
      date range; an unavailable type's run returns the unavailable body (200, not an error) in
      `test/dashboard.e2e-spec.ts`
- [ ] T054 [P] [US7] E2e test: small export returns the file synchronously (PDF and Excel, figures
      match on-screen data) in `test/dashboard.e2e-spec.ts`
- [ ] T055 [P] [US7] E2e test: export exceeding the async threshold returns 202 + `exportJobId`;
      polling `GET /reports/exports/:id` reaches `ready` with a `downloadUrl`; an "Export Ready"
      notification appears via `GET /notifications` in `test/dashboard.e2e-spec.ts`
- [ ] T056 [P] [US7] E2e test: a failed export job's status reflects `failed` with a reason, not
      silence or infinite pending, in `test/dashboard.e2e-spec.ts`
- [ ] T057 [P] [US7] Unit test for the PDF/Excel rendering functions (figures match the source
      report rows) in `src/dashboard/reports/export/export.processor.spec.ts`

### Implementation for User Story 7

- [ ] T058 [P] [US7] Create `src/dashboard/reports/attendance-report.provider.ts` and
      `employee-report.provider.ts`: real `ReportProvider`s calling `hr`'s exported services —
      spec FR-019 (depends on T010)
- [ ] T059 [P] [US7] Create `src/dashboard/reports/unbuilt-report.placeholders.ts`: Payroll,
      Machinery, Fuel, Project Cost, Expense, P&L, Equipment Utilization `ReportProvider`s, all
      `isAvailable(): false` — spec FR-019, research.md, Assumptions (Equipment Utilization folded
      in) (depends on T010)
- [ ] T060 [US7] Implement `src/dashboard/reports/reports.controller.ts`: `GET /reports/types`,
      `POST /reports/:type/run`, guarded with `@RequirePermission(Permission.REPORTS)` — spec
      FR-018, FR-022 (depends on T058, T059)
- [ ] T061 [US7] Implement `src/dashboard/reports/export/export-job.service.ts`: creates
      `ExportJob` rows, decides sync-vs-async by row-count threshold (`DashboardConfig`) — spec
      FR-020, FR-021 (depends on T006)
- [ ] T062 [US7] Implement `src/dashboard/reports/export/export.processor.ts`: BullMQ worker
      rendering PDF (`pdfkit`) or Excel (`exceljs`) from a report's rows, updates `ExportJob.status`
      — research.md §6 (depends on T061)
- [ ] T063 [US7] Add `POST /reports/:type/export` and `GET /reports/exports/:id` to
      `reports.controller.ts` (depends on T061, T062)
- [ ] T064 [US7] Create `src/dashboard/notifications/export-ready.provider.ts`: reads `ExportJob`
      rows with `status: 'ready', notifiedAt: null` — research.md §6 (depends on T009, T061)
- [ ] T065 [US7] Wire audit logging (entityType `REPORT_EXPORT`) into `export-job.service.ts` —
      contracts/dashboard-api.md "Audit logging"
- [ ] T066 [US7] Register Phase 9 providers/controller/processor in
      `src/dashboard/dashboard.module.ts`

**Checkpoint**: All seven user stories independently functional.

---

## Phase 10: Polish & Cross-Cutting Concerns

- [ ] T067 [P] Run `npm run lint` and `npm run build` across all new/modified files
- [ ] T068 [P] Add `@nestjs/swagger` decorators to every controller under `src/dashboard/`
- [ ] T069 Run the full `quickstart.md` validation scenarios end-to-end (including Redis/BullMQ)
      and record results
- [ ] T070 [P] Verify SC-001 (widget list resolves in <3s under seeded load) via a basic load
      check; confirm provider computation runs in parallel, not sequential
- [ ] T071 Update `.env.example` with `DashboardConfig` variables and the new Redis connection
      settings

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS all user stories (the registry engine and
  `ExportJob` table both live here since every story registers into them)
- **User Stories (Phase 3–9)**: All depend on Foundational
  - US1 (framework) is P1 and technically a prerequisite in spirit for all others, but its own
    tasks (placeholder providers + the endpoint) can be built and tested with zero real providers
    registered yet — US2 through US7 each *add* providers to the same framework
  - US2 (Company KPIs), US3 (Activity Log) are both P1 and independent of each other and of US1's
    placeholder set
  - US4 (Notifications), US5 (Site Dashboard), US6 (Group Dashboard) are mutually independent
  - US7 (Reports) depends on Foundational's `ExportJob` table (T006) but not on US2–US6
- **Polish (Phase 10)**: Depends on all desired user stories being complete

### Parallel Opportunities

- All Setup tasks marked [P] can run in parallel
- Within Foundational, T008–T010 (three parallel registry type definitions) can run in parallel;
  T006/T007 (ExportJob + RLS) can run in parallel with those
- Once Foundational completes, US1–US6 can all proceed in parallel (each only adds providers to
  the shared registries); US7 can start in parallel too, needing only T006 from Foundational

---

## Parallel Example: User Story 2

```bash
# Launch all tests for User Story 2 together:
Task: "E2e test: KPI widgets match seeded data in test/dashboard.e2e-spec.ts"
Task: "E2e test: table widgets return correct rows in test/dashboard.e2e-spec.ts"
Task: "Unit test: muster-stat provider in src/dashboard/widgets/muster-stat.provider.spec.ts"

# Launch independent provider files together:
Task: "Create src/dashboard/widgets/company-kpi.providers.ts"
Task: "Create src/dashboard/widgets/attendance-table.provider.ts and recent-leaves-table.provider.ts"
Task: "Create src/dashboard/widgets/muster-stat.provider.ts"
```

---

## Implementation Strategy

### MVP First (User Stories 1 + 2 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL — blocks all stories; registry engine + ExportJob
   table live here)
3. Complete Phase 3: User Story 1 (framework + placeholders)
4. Complete Phase 4: User Story 2 (real company KPIs)
5. **STOP and VALIDATE**: Run quickstart.md Scenarios 1–2 independently
6. Deploy/demo if ready — a working, extensible Dashboard with real data for what's computable
   today and honest placeholders for the rest

### Incremental Delivery

1. Setup + Foundational → registry engine + ExportJob table ready
2. US1 (framework) → US2 (Company KPIs) → US3 (Activity Log) → test independently → MVP
3. US4 (Notifications) → US5 (Site Dashboard) → US6 (Group Dashboard) → each tested independently
4. US7 (Reports + async export) → tested independently → feature complete
