---

description: "Task list for feature implementation"
---

# Tasks: HR & Payroll Backend (Employees, Attendance, Leave, Payroll, Challans, Loans, Daily Workers)

**Input**: Design documents from `/specs/005-hr-payroll-backend/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md,
contracts/hr-payroll-api.md, quickstart.md

**Tests**: Included. This feature touches PII, payroll, and biometric data extensively — all three
categories this repo's constitution requires e2e coverage for.

**Organization**: Tasks are grouped by user story (from spec.md) to enable independent
implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1–US10)
- Every task includes an exact file path

---

## Phase 1: Setup (Shared Infrastructure)

- [ ] T001 [P] Add `otMultiplier` (decimal, default 2.00) to `settings.Company` in
      `prisma/schema.prisma` + migration — spec FR-014a
- [ ] T002 [P] Update `src/settings/companies/dto/create-company.dto.ts` and
      `update-company.dto.ts` with `otMultiplier`
- [ ] T003 [P] Extend `src/common/configs/config.interface.ts`/`config.ts` with
      `HrPayrollConfig` (document-expiry warning window default 30 days)

**Checkpoint**: Company payroll config and shared config ready.

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [ ] T004 Add the ~40 new Employee fields (Identity/Employment/Statutory/Pay & Bank/Contact/
      Letters/Onboarding) to `hr.Employee` in `prisma/schema.prisma` — data-model.md §Employee,
      research.md §2 (additive only — `userId`/`companyId`/`siteId`/`shiftId`/`employeeCode`
      untouched)
- [ ] T005 [P] Add `EmployeeDocument`, `EmployeeTransfer` models to `hr` schema —
      data-model.md
- [ ] T006 [P] Add `Holiday` (+ `HolidaySite` join) model to `hr` schema, superseding
      `Site.holidays` — data-model.md §Holiday, research.md §6
- [ ] T007 [P] Add `adminEdited`/`editedByUserId`/`editedAt`/`statusOverride`/`remarks` to the
      existing attendance representation, and the `AttendanceModification` model, in `hr` schema —
      data-model.md, research.md §7
- [ ] T008 [P] Add `DailyWorker`, `DailyWorkerAttendance` models to `hr` schema — data-model.md
      §Daily Worker
- [ ] T009 Generate and apply the migration for T004–T008 via `migrate:dev:create`/`migrate:dev`
      (grouped per Constitution Check VI)
- [ ] T010 [P] Add `PayrollLineItem` model to `payroll` schema (including nullable `projectId` —
      FR-046), extend `PayrollRun` with `generatedAt`/`generatedByUserId`/`processedAt`/`paidAt` —
      data-model.md
- [ ] T011 [P] Add `Loan`, `LoanScheduleEntry` models to `payroll` schema — data-model.md
- [ ] T012 Generate and apply the migration for T010–T011
- [ ] T013 Add RLS policies for every new `companyId`-scoped table from T004–T011
- [ ] T014 [P] Create `src/hr/employees/pii-masking.interceptor.ts`: truncates Aadhaar/PAN/
      bank-account/UAN to last 4 digits by default — research.md §3, Constitution Principle IV
- [ ] T015 [P] Migrate attendance-status computation (003) to read `Holiday`/`HolidaySite`
      instead of `Site.holidays`, and drop the now-unused column — research.md §6
- [ ] T016 Extend `shared.AuditLogEntry.entityType` with `EMPLOYEE`, `EMPLOYEE_DOCUMENT`,
      `EMPLOYEE_TRANSFER`, `ATTENDANCE`, `HOLIDAY`, `PAYROLL_RUN`, `LOAN`, `DAILY_WORKER`,
      `DAILY_WORKER_ATTENDANCE` — contracts/hr-payroll-api.md "Audit logging"

**Checkpoint**: Schema, RLS, PII masking, and the Holiday migration ready — user story
implementation can now begin in parallel.

---

## Phase 3: User Story 1 - Maintain full employee records (Priority: P1) 🎯 MVP

**Goal**: Full 8-tab employee CRUD, filterable list, detail view, masked PII with audited reveal.

**Independent Test**: Create an employee across all tabs, confirm List/Detail reflect it correctly
and PII is masked by default.

### Tests for User Story 1 ⚠️

- [ ] T017 [P] [US1] E2e test: create/edit across all eight tabs; list filters (search/department/
      site/status/company) in `test/hr-payroll.e2e-spec.ts`
- [ ] T018 [P] [US1] E2e test: PII masked by default; reveal-pii returns unmasked value and writes
      an audit entry in `test/hr-payroll.e2e-spec.ts`
- [ ] T019 [P] [US1] E2e test: Employee Detail composes Overview/Personal/Employment/Salary
      Structure/Attendance Calendar (via 003's `getMonthHistory`)/Leave Summary/Documents/Loan
      History in `test/hr-payroll.e2e-spec.ts`
- [ ] T020 [P] [US1] Unit test for statutory-tab conditional validation (PF/ESIC applicable → number
      fields required) in `src/hr/employees/employees.service.spec.ts`

### Implementation for User Story 1

- [ ] T021 [P] [US1] Create `src/hr/employees/dto/create-employee.dto.ts`/`update-employee.dto.ts`
      covering all eight tabs, with conditional validation (T020)
- [ ] T022 [US1] Extend `src/hr/employees/employees.service.ts` (003 scaffold): full CRUD, list
      with filters/pagination, detail composition (depends on T004, T021)
- [ ] T023 [US1] Implement `reveal-pii` action in `employees.service.ts`: audit-logs which field
      was revealed and by whom — research.md §3 (depends on T014)
- [ ] T024 [US1] Extend `src/hr/employees/employees.controller.ts`:
      `GET/POST/PATCH /hr/employees`, `GET /hr/employees/:id`,
      `POST /hr/employees/:id/reveal-pii`, guarded with `@RequirePermission(Permission.EMPLOYEES)`
      (depends on T022, T023)
- [ ] T025 [US1] Apply `PiiMaskingInterceptor` (T014) to `employees.controller.ts`
- [ ] T026 [US1] Wire audit logging (entityType `EMPLOYEE`) into create/update paths — FR-030
- [ ] T026a [US1] Implement exported `HrService.getUnlinkedEmployees(companyId, search?)` and
      `.linkEmployeeToUser(employeeId, userId)` (throws if `Employee.userId` already set) in
      `employees.service.ts`, exported from `HrModule` for `010-account-creation-backend` to
      inject — FR-047, research.md §17

**Checkpoint**: User Story 1 fully functional and independently testable.

---

## Phase 4: User Story 2 - Manage employee documents with mandatory/expiry gating (Priority: P1)

**Goal**: Document upload against Settings' Document Type master; mandatory-doc gate on
attendance marking; expiry flagging.

**Independent Test**: Upload fewer than mandatory docs, confirm punch rejection; complete the set,
confirm punch succeeds.

### Tests for User Story 2 ⚠️

- [ ] T027 [P] [US2] E2e test: document upload (with/without number/expiry per type); Documents
      progress bar reflects mandatory completion in `test/hr-payroll.e2e-spec.ts`
- [ ] T028 [P] [US2] E2e test: attendance marking (self-service 003 punch AND admin mark, US3)
      rejected while mandatory docs are missing, succeeds once complete in
      `test/hr-payroll.e2e-spec.ts`
- [ ] T029 [P] [US2] Unit test for the expiry-window flagging function (default 30 days) in
      `src/hr/employees/documents/employee-documents.service.spec.ts`

### Implementation for User Story 2

- [ ] T030 [P] [US2] Create `src/hr/employees/documents/dto/upload-document.dto.ts`
- [ ] T031 [US2] Implement `src/hr/employees/documents/employee-documents.service.ts`: upload
      (encrypted storage, `// TODO(VIRUS_SCAN)` per research.md §10), list with derived flags
      (reusing 002's flag derivation), expiry-window flagging (depends on T005, T003)
- [ ] T032 [US2] Implement `src/hr/employees/documents/employee-documents.controller.ts`:
      `POST/GET /hr/employees/:id/documents`, guarded with
      `@RequirePermission(Permission.EMPLOYEES)` (depends on T031)
- [ ] T033 [US2] Wire `hasMissingMandatoryDocs()` (002) against real `EmployeeDocument` rows into
      003's self-service punch path AND this feature's admin Mark Attendance path (US3) — spec
      FR-005 (depends on T031)
- [ ] T034 [US2] Wire audit logging (entityType `EMPLOYEE_DOCUMENT`) into upload path — FR-030

**Checkpoint**: User Stories 1 AND 2 both independently functional.

---

## Phase 5: User Story 3 - Administer attendance (Priority: P1)

**Goal**: Admin Daily Attendance view/edit, Exceptions, Modifications audit, Holidays.

**Independent Test**: Edit an attendance entry, confirm the Modifications audit shows the diff;
declare a holiday and confirm it reflects in status computation.

### Tests for User Story 3 ⚠️

- [ ] T035 [P] [US3] E2e test: daily attendance view (date+site scoped); Mark/Edit create+update in
      `test/hr-payroll.e2e-spec.ts`
- [ ] T036 [P] [US3] E2e test: edit rejected (423) within an already payroll-locked period in
      `test/hr-payroll.e2e-spec.ts`
- [ ] T037 [P] [US3] E2e test: Modifications audit captures actor/before/after/timestamp;
      Exceptions view lists out-of-geofence punches with distance in `test/hr-payroll.e2e-spec.ts`
- [ ] T038 [P] [US3] E2e test: holiday declared with all-sites vs. specific-sites applicability
      reflects correctly in per-site attendance status in `test/hr-payroll.e2e-spec.ts`

### Implementation for User Story 3

- [ ] T039 [P] [US3] Create `src/hr/attendance/dto/mark-attendance.dto.ts`,
      `dto/holiday.dto.ts`
- [ ] T040 [US3] Implement `src/hr/attendance/attendance-admin.service.ts`: daily view, mark/edit
      (payroll-lock check reused from 003, mandatory-doc check from US2's T033, writes
      `AttendanceModification` on every edit — research.md §7), exceptions view (depends on T007,
      T033)
- [ ] T041 [US3] Implement `src/hr/attendance/attendance-admin.controller.ts`:
      `GET/POST/PATCH /hr/attendance`, `GET /hr/attendance/exceptions`,
      `GET /hr/attendance/modifications`, guarded with
      `@RequirePermission(Permission.ATTENDANCE)` (depends on T040)
- [ ] T042 [US3] Implement `src/hr/attendance/holidays.controller.ts` +
      `holidays.service.ts`: `GET/POST /hr/holidays`, guarded with
      `@RequirePermission(Permission.ATTENDANCE)` (depends on T006)
- [ ] T043 [US3] Wire audit logging (entityType `ATTENDANCE`, `HOLIDAY`) into edit/holiday-create
      paths — FR-030

**Checkpoint**: User Stories 1–3 independently functional.

---

## Phase 6: User Story 4 - Administer leave (Priority: P1)

**Goal**: All-employee admin leave list and balance view, reusing 003's decide/balance logic
unchanged.

**Independent Test**: List all pending applications across employees; confirm balances match 003's
computation.

### Tests for User Story 4 ⚠️

- [ ] T044 [P] [US4] E2e test: admin list returns every employee's applications, filterable by
      status; balances view correct per employee/type in `test/hr-payroll.e2e-spec.ts`

### Implementation for User Story 4

- [ ] T045 [US4] Implement `src/hr/leave/leave-admin.controller.ts`:
      `GET /hr/leave/applications?status=`, `GET /hr/leave/balances?employeeId=` — thin layer over
      003's existing `LeaveService`, guarded with `@RequirePermission(Permission.ATTENDANCE)`
      (no new decision logic — spec FR-012/FR-013)

**Checkpoint**: User Stories 1–4 independently functional.

---

## Phase 7: User Story 5 - Generate payroll and produce salary slips (Priority: P1)

**Goal**: The payroll calculation engine, run lifecycle, real salary slip, bank sheet export.

**Independent Test**: Generate payroll for a seeded month, confirm figures match hand-calculation;
progress through Processed/Paid; confirm 003's `/my/salary` now returns real data.

### Tests for User Story 5 ⚠️

- [ ] T046 [P] [US5] E2e test: generate payroll — Payable/LOP days, OT wages (at company's
      `otMultiplier`), each earnings component, PF/ESIC deductions, PT, loan EMI, TDS default zero,
      Net Pay all match hand-calculated expectations for seeded data in
      `test/hr-payroll.e2e-spec.ts`
- [ ] T047 [P] [US5] E2e test: Processed run's figures immutable — a direct edit attempt rejected;
      Paid run visible via 003's `/my/salary/available-periods` in `test/hr-payroll.e2e-spec.ts`
- [ ] T048 [P] [US5] E2e test: salary slip (JSON + PDF) matches PRD sections and figures; bank sheet
      export produces correct `.xlsx` rows in `test/hr-payroll.e2e-spec.ts`
- [ ] T049 [P] [US5] E2e test: an inactive-as-of-period employee is excluded from generation in
      `test/hr-payroll.e2e-spec.ts`
- [ ] T050 [P] [US5] Unit test suite for `PayrollEngineService`: each earnings/deduction component
      computed in isolation (Payable Days, LOP, OT at configurable multiplier, PF/ESIC applicability
      branches, PT slabs, loan EMI summation across multiple active loans) in
      `src/payroll/engine/payroll-engine.service.spec.ts`

### Implementation for User Story 5

- [ ] T051 [US5] Implement `src/payroll/engine/payroll-engine.service.ts`: single-transaction
      `generate(companyId, period)` reading attendance (via 003's computation), salary structure
      (US1), active Loans (US7), Settings' rates + `otMultiplier`, and each employee's current
      site/project assignment to set `PayrollLineItem.projectId` (FR-046, research.md §16) —
      research.md §4 (depends on T010, T022, T040)
- [ ] T052 [US5] Implement `src/payroll/runs/payroll-runs.controller.ts`:
      `POST /hr/payroll/generate`, `GET /hr/payroll/runs`,
      `POST /hr/payroll/runs/:id/process`, `.../pay`, guarded with
      `@RequirePermission(Permission.PAYROLL)` (depends on T051)
- [ ] T053 [US5] Wire the immutability check (Processed/Paid run rejects further line-item writes,
      and — extending 003's existing lock rule — rejects attendance/leave edits for that period,
      already partially wired in T040) into `process` action — spec FR-015
- [ ] T054 [US5] Implement `src/payroll/runs/salary-slip.service.ts`: real slip (supersedes 003's
      placeholder), `pdfkit` rendering (reused from 003) — spec FR-016 (depends on T051)
- [ ] T055 [US5] Add `GET /hr/payroll/runs/:id/employees/:employeeId/slip[.pdf]` to
      `payroll-runs.controller.ts` (depends on T054); confirm 003's `/my/salary` endpoints now
      resolve real data for Processed/Paid periods with no contract change on that side
- [ ] T056 [US5] Implement bank-sheet export (`exceljs`, reused from 004) in
      `payroll-runs.controller.ts`: `GET /hr/payroll/runs/:id/bank-sheet` — spec FR-017
- [ ] T057 [US5] Wire audit logging (entityType `PAYROLL_RUN`) into generate/process/pay paths —
      FR-030
- [ ] T057a [US5] Implement `HrPayrollService.getLabourCostByProject(projectId, dateRange)` in
      `src/payroll/runs/payroll-runs.service.ts` (or a dedicated exported service), summing
      `netPay` across `PayrollLineItem`s matching `projectId` and a `payrollRun.period` within
      range — exported for `008-projects-backend`'s P&L to call — FR-046, research.md §16

**Checkpoint**: User Stories 1–5 independently functional — this is the feature's core MVP.

---

## Phase 8: User Story 6 - Generate statutory challans (Priority: P2)

**Goal**: PF/ESIC/PT challan tabs derived from a Processed/Paid run, with structured export.

**Independent Test**: Request challan tabs for a Processed month, confirm figures trace exactly to
that run's line items.

### Tests for User Story 6 ⚠️

- [ ] T058 [P] [US6] E2e test: PF/ESIC/PT challan figures match the source run's `PayrollLineItem`
      rows exactly, with correct summary totals in `test/hr-payroll.e2e-spec.ts`
- [ ] T059 [P] [US6] E2e test: a month with no processed run returns a clear "not processed" result,
      not fabricated data; PF/ESIC/PT exports produce structured files in
      `test/hr-payroll.e2e-spec.ts`

### Implementation for User Story 6

- [ ] T060 [US6] Implement `src/payroll/challans/challans.controller.ts` +
      `challans.service.ts`: `GET /hr/challans/pf|esic|pt`, derived read (no stored table),
      guarded with `@RequirePermission(Permission.CHALLANS)` — research.md §5 (depends on T010)
- [ ] T061 [US6] Implement `GET /hr/challans/{pf,esic,pt}/export` (`exceljs`/`pdfkit`) — spec
      FR-020 (depends on T060)

**Checkpoint**: User Stories 1–6 independently functional.

---

## Phase 9: User Story 7 - Track employee loans and EMI deductions (Priority: P2)

**Goal**: Loan CRUD with auto-generated schedule; active EMIs feed payroll deductions.

**Independent Test**: Create a loan, confirm the schedule; generate payroll for a covered month,
confirm the EMI deduction and schedule-entry status update.

### Tests for User Story 7 ⚠️

- [ ] T062 [P] [US7] E2e test: loan creation auto-generates a correct month-by-month schedule;
      Total Paid/Outstanding Balance computed from schedule entries, not stored fields, in
      `test/hr-payroll.e2e-spec.ts`
- [ ] T063 [P] [US7] E2e test: a loan's final EMI processed via payroll closes it; it stops
      appearing as a future deduction in `test/hr-payroll.e2e-spec.ts`

### Implementation for User Story 7

- [ ] T064 [P] [US7] Create `src/payroll/loans/dto/create-loan.dto.ts`
- [ ] T065 [US7] Implement `src/payroll/loans/loans.service.ts`: schedule auto-generation, Total
      Paid/Outstanding Balance computed from schedule (depends on T011)
- [ ] T066 [US7] Implement `src/payroll/loans/loans.controller.ts`:
      `GET/POST /hr/loans`, `GET /hr/loans/:id/schedule`, `POST /hr/loans/:id/close`, guarded with
      `@RequirePermission(Permission.LOANS)` (depends on T065)
- [ ] T067 [US7] Wire audit logging (entityType `LOAN`) into create/close paths — FR-030

**Checkpoint**: User Stories 1–7 independently functional.

---

## Phase 10: User Story 8 - Transfer an employee across companies (Priority: P2)

**Goal**: Cross-company employee transfer with code retention option and audit trail.

**Independent Test**: Transfer a test employee, confirm `companyId` updates and pre-transfer
records remain attributed to the original company.

### Tests for User Story 8 ⚠️

- [ ] T068 [P] [US8] E2e test: transfer with/without code retention; pre-transfer attendance/leave/
      payroll records remain attributed to the original company in
      `test/hr-payroll.e2e-spec.ts`

### Implementation for User Story 8

- [ ] T069 [US8] Implement transfer logic in `employees.service.ts` (US1): updates `companyId`,
      generates a new code via Settings' code-series service unless retained, creates an
      `EmployeeTransfer` row (depends on T005, T022)
- [ ] T070 [US8] Add `POST /hr/employees/:id/transfer` to `employees.controller.ts` (depends on
      T069)
- [ ] T071 [US8] Wire audit logging (entityType `EMPLOYEE_TRANSFER`) — FR-030

**Checkpoint**: User Stories 1–8 independently functional.

---

## Phase 11: User Story 9 - Register and mark attendance for daily workers (Priority: P3)

**Goal**: Lightweight Daily Worker enrolment (reusing biometrics) and site-scoped attendance
capture, structurally separate from Employee/Payroll.

**Independent Test**: Enrol a worker, mark attendance via face-match, confirm site headcount
reflects it and payroll excludes it entirely.

### Tests for User Story 9 ⚠️

- [ ] T072 [P] [US9] E2e test: enrolment (3–5 photos, consent attestation, no login/statutory
      fields) using the same `BiometricsService` computation as Employee enrolment in
      `test/hr-payroll.e2e-spec.ts`
- [ ] T073 [P] [US9] E2e test: face-match and manual-fallback attendance marking (photo/GPS/
      timestamp/supervisor captured when available; exception logged for manual) in
      `test/hr-payroll.e2e-spec.ts`
- [ ] T074 [P] [US9] E2e test: cross-site enrolment/marking rejected (403) for a supervisor not
      assigned to the worker's site in `test/hr-payroll.e2e-spec.ts`
- [ ] T075 [P] [US9] E2e test: bulk-marking multiple workers in one session; individual
      after-the-fact absence correction in `test/hr-payroll.e2e-spec.ts`
- [ ] T076 [P] [US9] E2e test: deactivated worker excluded from the capture roster but historical
      attendance remains queryable in `test/hr-payroll.e2e-spec.ts`
- [ ] T077 [P] [US9] E2e test: zero Daily Workers ever appear in a `PayrollLineItem`, across a full
      payroll generation run in `test/hr-payroll.e2e-spec.ts`
- [ ] T078 [P] [US9] E2e test: conversion to Employee carries forward photos/descriptor without
      re-capture; original DailyWorker marked `converted`, not deleted, in
      `test/hr-payroll.e2e-spec.ts`

### Implementation for User Story 9

- [ ] T079 [P] [US9] Create `src/hr/daily-workers/dto/enrol-daily-worker.dto.ts`,
      `dto/mark-daily-worker-attendance.dto.ts`
- [ ] T080 [US9] Implement `src/hr/daily-workers/daily-workers.service.ts`: enrolment (calls 003's
      `BiometricsService.computeDescriptor()`), site-scoping check, deactivation — research.md §8
      (depends on T008)
- [ ] T081 [US9] Implement `src/hr/daily-workers/daily-workers.controller.ts`:
      `GET/POST/PATCH /hr/daily-workers`, `.../deactivate`, guarded with
      `@RequirePermission(Permission.DAILY_WORKER_REGISTRY)` (depends on T080)
- [ ] T082 [US9] Implement `src/hr/daily-workers/daily-worker-attendance.controller.ts` +
      service: face-match (via `BiometricsService.compareDescriptors()`) and manual marking, bulk
      session support, site-scoping, guarded with
      `@RequirePermission(Permission.DAILY_WORKER_REGISTRY)` (depends on T080)
- [ ] T083 [US9] Implement `GET /hr/daily-workers/wage-summary` (per-site/period payout summary,
      explicitly outside `/hr/payroll/*`) — spec FR-028 (depends on T082)
- [ ] T084 [US9] Implement `src/hr/daily-workers/daily-worker-conversion.service.ts`: creates
      Employee + FaceEnrolment from the DailyWorker's existing photos/descriptor, marks the
      DailyWorker `converted` — research.md §9 (depends on T022, T080)
- [ ] T085 [US9] Add `POST /hr/daily-workers/:id/convert` to `daily-workers.controller.ts`
      (depends on T084)
- [ ] T086 [US9] Wire daily worker attendance into the site-headcount aggregation Dashboard (004)
      reads, tagged distinctly from Employee attendance — spec FR-026
- [ ] T087 [US9] Wire audit logging (entityType `DAILY_WORKER`, `DAILY_WORKER_ATTENDANCE`) into
      enrol/mark/deactivate/convert paths — FR-030

**Checkpoint**: User Stories 1–9 independently functional.

---

## Phase 12: User Story 10 - Administer biometric re-enrolment requests (Priority: P3)

**Goal**: Admin queue view over 003's existing re-enrolment-request data.

**Independent Test**: List pending requests with employee/site/reason context; approve via 003's
unchanged endpoint.

### Tests for User Story 10 ⚠️

- [ ] T088 [P] [US10] E2e test: queue lists employee/site/reason/requested-on/status, filterable,
      using 003's data unchanged in `test/hr-payroll.e2e-spec.ts`

### Implementation for User Story 10

- [ ] T089 [US10] Implement `src/hr/re-enrolment-requests/re-enrolment-requests-admin.controller.ts`:
      `GET /hr/re-enrolment-requests?status=`, guarded with
      `@RequirePermission(Permission.EMPLOYEES)` — thin list over 003's existing service, no new
      decision logic (spec FR-029)

**Checkpoint**: All ten original user stories independently functional.

---

## Phase 14: User Story 11 - Employee Offboarding and Full & Final Settlement (Priority: P3)

**Goal**: Initiate an employee exit, compute and process F&F settlement, deactivate their account.

**Independent Test**: Initiate exit, compute F&F (leave encashment + loan recovery appear),
process as an F&F payroll run, confirm status → Inactive and login revoked.

### Tests for User Story 11 ⚠️

- [ ] T097 [P] [US11] E2e test: exit → F&F computation (pending salary, EL encashment, loan
      recovery, net payable) → process → employee Inactive, login revoked in
      `test/hr-payroll.e2e-spec.ts`
- [ ] T098 [P] [US11] E2e test: attendance/leave/payroll actions rejected for an Inactive employee;
      historical records remain readable in `test/hr-payroll.e2e-spec.ts`
- [ ] T099 [P] [US11] Unit test for the F&F computation function (pro-rated pending salary, EL
      encashment at `basic / 26`/day, active loan recovery) in
      `src/payroll/offboarding/fnf.service.spec.ts`

### Implementation for User Story 11

- [ ] T100 [P] [US11] Create `src/hr/offboarding/dto/exit.dto.ts`
- [ ] T101 [US11] Implement `src/hr/offboarding/exit.service.ts` — `initiateExit()` creates an
      `ExitRecord` (FR-031); implement `src/payroll/offboarding/fnf.service.ts` —
      `computeFnf()` (FR-032), `processFnf()` (creates an F&F-flagged `PayrollRun`, reuses the
      standard payroll lock lifecycle, FR-033) (depends on T100, existing PayrollEngine from US5)
- [ ] T102 [US11] Implement `src/hr/employees/employees.controller.ts` additions: `POST
      /hr/employees/:id/exit`, `GET /hr/employees/:id/fnf`, `POST
      /hr/employees/:id/fnf/process` — guarded with `@RequirePermission(Permission.EMPLOYEES)`
      (depends on T101)
- [ ] T103 [US11] Wire the on-processed employee-deactivation hook (`status → Inactive`,
      `User.active = false`, Redis refresh-token revocation, FR-034) and the Inactive-employee
      action-rejection guard (FR-035) into `employees.service.ts`

**Checkpoint**: All eleven user stories independently functional.

---

## Phase 15: User Story 12 - Reimbursement Claims (Admin) (Priority: P3)

**Goal**: Admin review layer (approve/reject/pay/register) over feature 003's employee-created
Reimbursement Claims.

**Independent Test**: Seed a Submitted claim (003), approve it, mark it paid directly, confirm a
second claim can be rejected with mandatory remarks.

### Tests for User Story 12 ⚠️

- [ ] T104 [P] [US12] E2e test: list submitted claims → approve (optional remarks) → mark paid
      (direct: mode/date/reference recorded) in `test/hr-payroll.e2e-spec.ts`
- [ ] T105 [P] [US12] E2e test: reject requires remarks; employee notified; rejected claim never
      appears in a payroll run or the register's payable totals in
      `test/hr-payroll.e2e-spec.ts`
- [ ] T106 [P] [US12] E2e test: `paymentMode: 'payroll'` includes the claim as an earnings line in
      the employee's next payroll run, mirroring Loan EMI (FR-022) in
      `test/hr-payroll.e2e-spec.ts`

### Implementation for User Story 12

- [ ] T107 [P] [US12] Create `src/payroll/reimbursements-admin/dto/decide-claim.dto.ts` and
      `dto/pay-claim.dto.ts`
- [ ] T108 [US12] Implement `src/payroll/reimbursements-admin/reimbursements-admin.service.ts` —
      `listClaims()`, `approveClaim()`, `rejectClaim()` (FR-037), `payClaim()` (direct or
      payroll-earnings-line, FR-038), `getRegister()` (FR-039) — operating on feature 003's
      `ReimbursementClaim` table (`hr` schema), never a duplicate table (research.md §10 there)
- [ ] T109 [US12] Implement `src/payroll/reimbursements-admin/reimbursements-admin.controller.ts`
      — `GET /hr/reimbursements`, `PATCH /hr/reimbursements/:id/approve`, `.../reject`,
      `.../pay`, `GET /hr/reimbursements/register` — guarded with
      `@RequirePermission(Permission.EMPLOYEES)` (depends on T108)
- [ ] T110 [US12] Wire the payroll-earnings-line inclusion path into the payroll engine (US5) so an
      Approved, `paymentMode: 'payroll'` claim's amount appears in the employee's next run
      (depends on T108, existing PayrollEngine)
- [ ] T110a [US12] Implement `ReimbursementCategoriesService` + `ReimbursementCategoriesController`
      in `src/settings/reimbursement-categories/` — same CRUD shape as 002's Department/
      Designation/Document Type/Shift masters, guarded with `@RequirePermission(Permission.
      EMPLOYEES)` (FR-045, research.md §15 — found missing on a second alignment-audit pass;
      depends on T003)

**Checkpoint**: All twelve user stories independently functional.

---

## Phase 16: User Story 13 - Bulk Attendance Import (Priority: P3)

**Goal**: CSV template download, row-level validation report, then commit-only-validated-rows
attendance import.

**Independent Test**: Upload a CSV mixing valid/invalid rows, confirm the validation report and
zero records created, then commit only the valid rows.

### Tests for User Story 13 ⚠️

- [ ] T111 [P] [US13] E2e test: validate returns row-level errors (unknown employee code,
      malformed date, duplicate row) with nothing committed in `test/hr-payroll.e2e-spec.ts`
- [ ] T112 [P] [US13] E2e test: commit creates only previously-validated rows as standard
      Attendance Records, each tagged import-sourced in the audit log, in
      `test/hr-payroll.e2e-spec.ts`
- [ ] T113 [P] [US13] E2e test: a row dated within an already payroll-locked period is rejected in
      the validation report (FR-009/FR-044) in `test/hr-payroll.e2e-spec.ts`

### Implementation for User Story 13

- [ ] T114 [P] [US13] Create `src/hr/attendance/dto/import-row.dto.ts`
- [ ] T115 [US13] Implement `src/hr/attendance/attendance-import.service.ts` — `getTemplate()`
      (FR-041), `validate()` (row-level parsing/lookup errors, no writes, FR-042), `commit()`
      (creates Attendance Records via the existing Mark/Edit path — US3's `attendance-admin.
      service.ts` — reusing its Total-Hours/status computation and payroll-lock rejection,
      FR-043/FR-044) (depends on US3's `attendance-admin.service.ts`)
- [ ] T116 [US13] Implement `src/hr/attendance/attendance-import.controller.ts` — `GET
      /hr/attendance/import/template`, `POST /hr/attendance/import/validate`, `POST
      /hr/attendance/import/commit` — guarded with `@RequirePermission(Permission.ATTENDANCE)`
      (depends on T115)
- [ ] T117 [US13] Wire the import-sourced audit-log tag into committed rows (FR-043)

**Checkpoint**: All thirteen user stories independently functional.

---

## Phase 17: Polish & Cross-Cutting Concerns

- [ ] T118 [P] Run `npm run lint` and `npm run build` across all new/modified files
- [ ] T119 [P] Add `@nestjs/swagger` decorators to every controller under `src/hr/`, `src/payroll/`
- [ ] T120 Run the full `quickstart.md` validation scenarios end-to-end and record results
- [ ] T121 [P] Review every new `companyId`-scoped table for RLS coverage and confirm the Super
      Admin bypass flag behaves correctly — Constitution Principle IV
- [ ] T122 [P] Confirm every PII field (Aadhaar/PAN/bank-account/UAN) is encrypted at rest, masked
      by default, and every reveal is audit-logged — spec FR-003, SC-006
- [ ] T123 Confirm the `TODO(VIRUS_SCAN)` gap (T031) is also recorded in this repo's constitution's
      Deferred/TODO list — research.md §10
- [ ] T124 Update `.env.example` with any new config variables

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS all user stories (this is the largest
  Foundational phase of any feature so far, given the sheer number of new/extended tables)
- **User Stories (Phase 3–16)**: All depend on Foundational
  - US1 (Employees) is the true root dependency — US2 (Documents), US3 (Attendance admin), US8
    (Transfer) all extend or reference the Employee record US1 builds
  - US2 depends on US1's Employee existing; its mandatory-doc gate is consumed by US3's Mark
    Attendance action
  - US4 (Leave admin) only needs Foundational + 003's existing Leave data — independent of US1–US3
  - US5 (Payroll engine) depends on US1 (salary structure fields), US3 (attendance computation),
    and US7 (active loans) — build last among the P1/P2 stories, or stub loan input until US7 lands
  - US6 (Challans) depends entirely on US5's processed run data
  - US7 (Loans) is independent of US1–US6 beyond Foundational, but US5 depends on it
  - US8 (Transfer) depends on US1
  - US9 (Daily Workers) is fully independent of US1–US8 (a structurally separate system,
    research.md §8) beyond Foundational and 003's `BiometricsService`
  - US10 (Re-enrolment queue) is independent of everything except 003's existing data
  - US11 (Offboarding/F&F) depends on US1 (Employee), US5 (payroll engine reuse), and US7 (loan
    recovery figures)
  - US12 (Reimbursements Admin) depends on feature 003's `ReimbursementClaim` table existing (that
    feature's own US8) and, for the payroll-earnings-line path, US5's payroll engine
  - US13 (Attendance Import) depends on US3's `attendance-admin.service.ts` (reused for the actual
    record-creation/lock-check logic) — independent of US1, US2, US4–US12 otherwise
- **Polish (Phase 17)**: Depends on all desired user stories being complete

### Parallel Opportunities

- All Setup tasks marked [P] can run in parallel
- Within Foundational, T005–T008 (new hr-schema models) can run in parallel; T010–T011 (payroll
  models) can run in parallel with those; T013–T016 depend on the migrations (T009, T012) landing
  first
- Once Foundational completes: US1, US4, US7, US9, US10 can all start in parallel (each has no
  dependency on another user story). US2 and US8 should follow shortly after US1's Employee CRUD
  lands. US3 follows US1/US2. US5 is the natural last P1 story (depends on US1+US3+US7). US6
  follows US5.

---

## Parallel Example: User Story 1

```bash
# Launch all tests for User Story 1 together:
Task: "E2e test: create/edit across all eight tabs; list filters in test/hr-payroll.e2e-spec.ts"
Task: "E2e test: PII masking + reveal-pii audit in test/hr-payroll.e2e-spec.ts"
Task: "E2e test: Employee Detail composition in test/hr-payroll.e2e-spec.ts"
Task: "Unit test for statutory-tab conditional validation in employees.service.spec.ts"

# Launch the DTO alongside the tests:
Task: "Create src/hr/employees/dto/create-employee.dto.ts and update-employee.dto.ts"
```

---

## Implementation Strategy

### MVP First (User Stories 1, 2, 3, 4, 5, 7 — the full core loop)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL — the largest schema change of any feature so far)
3. Complete US1 (Employees) → US2 (Documents) → US3 (Attendance admin) → US4 (Leave admin) → US7
   (Loans) → US5 (Payroll engine, which depends on the first three)
4. **STOP and VALIDATE**: Run quickstart.md Scenarios 1–6 independently
5. Deploy/demo if ready — the complete employee-to-payslip loop, the PRD's central value

### Incremental Delivery

1. Setup + Foundational → the largest schema/migration set in this repo so far, ready
2. US1 → US2 → US3 → US4 → US7 → US5 → test each independently → core MVP (employee lifecycle
   through payslip)
3. US6 (Challans) → US8 (Transfer) → each tested independently → full P1/P2 scope
4. US9 (Daily Workers) → US10 (Re-enrolment queue) → each tested independently → feature complete
