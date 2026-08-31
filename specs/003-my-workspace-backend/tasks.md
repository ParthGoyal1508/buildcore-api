---

description: "Task list for feature implementation"
---

# Tasks: My Workspace Backend (Punch, Leave, Salary, Face Enrolment)

**Input**: Design documents from `/specs/003-my-workspace-backend/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md,
contracts/my-workspace-api.md, quickstart.md

**Tests**: Included. Biometric, attendance, and payroll-adjacent endpoints all qualify under this
repo's constitution's "new endpoints touching auth, payroll, or PII fields MUST have an e2e test"
requirement — same posture as features 001/002.

**Organization**: Tasks are grouped by user story (from spec.md) to enable independent
implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1–US7)
- Every task includes an exact file path

---

## Phase 1: Setup (Shared Infrastructure)

- [X] T001 Add `@vladmandic/face-api` and `pdfkit` as dependencies (constitution v1.1.0
      pre-approval) in `package.json`
- [X] T002 [P] Extend `src/common/configs/config.interface.ts` with `WorkspaceConfig` (face-match
      distance threshold, max offline-queue age hours, re-enrolment unlock duration days,
      clock-skew tolerance minutes) — research.md §2, §4, §8
- [X] T003 [P] Populate `WorkspaceConfig` defaults in `src/common/configs/config.ts`
- [X] T004 [P] Create `src/hr/hr.module.ts`, `src/projects/projects.module.ts` shells, and extend
      (or create) `src/payroll/payroll.module.ts`, registered in `src/app.module.ts`

**Checkpoint**: Config plumbing and module shells ready.

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T005 Add the `hr` Postgres schema block to `prisma/schema.prisma` (Prisma multi-schema,
      matching features 001/002's pattern) — research.md §1
- [X] T006 [P] Add the `projects` Postgres schema block with the `Site` model (companyId,
      latitude/longitude, geofenceRadiusMeters, weeklyOffDay, holidays) — data-model.md "Site"
- [X] T007 [P] Add the `Employee` model to the `hr` schema (userId, companyId, siteId, shiftId,
      employeeCode) — data-model.md "Employee"
- [X] T008 [P] Add the `FaceEnrolment` and `ReEnrolmentRequest` models to the `hr` schema —
      data-model.md
- [X] T009 [P] Add the `PunchRecord` model to the `hr` schema (type, capturedAt, receivedAt,
      isOfflineSync, photoRef, faceMatchResult, geofenceResult, exceptionResolution) —
      data-model.md "Punch Record"
- [X] T010 [P] Add `LeaveType`/`LeaveBalance`/`LeaveApplication` models to the `hr` schema —
      data-model.md
- [X] T011 [P] Add `PayrollRun` (status only) and the `SalarySlip` read-projection shape to the
      `payroll` schema — data-model.md
- [X] T012 Extend `shared.AuditLogEntry.entityType` in `prisma/schema.prisma` with `PUNCH`,
      `LEAVE_APPLICATION`, `FACE_ENROLMENT`, `RE_ENROLMENT_REQUEST` — data-model.md cross-reference
- [X] T013 Generate and apply the migration for T005–T012 via `npm run migrate:dev:create` then
      `npm run migrate:dev`
- [X] T014 Add Postgres RLS policies for every `companyId`-scoped table introduced above (`Site`,
      `Employee`, `PunchRecord` via `Employee`, `LeaveApplication` via `Employee`, `PayrollRun`),
      reusing the `app.current_company_id` session-variable pattern from features 001/002
- [X] T015 [P] Create `src/hr/employees/employees.service.ts`: `getByUserId(userId)`,
      `getById(employeeId)`, exported for other modules to resolve the caller's own Employee record
      — research.md §9
- [X] T016 [P] Create `src/projects/sites/sites.service.ts`: `getGeofence(siteId)`,
      `getHolidayCalendar(siteId)`, `getWeeklyOffDay(siteId)`, exported for `hr` to call —
      research.md §1
- [X] T017 [P] Create `src/hr/biometrics/biometrics.service.ts`: `computeDescriptor(photos)` and
      `compareDescriptors(a, b): { matched: boolean, distance: number }` using
      `@vladmandic/face-api`, reading the threshold from `WorkspaceConfig` — research.md §2
- [X] T018 [P] Create a geofence-distance utility (Haversine formula) in
      `src/hr/punch/geofence.util.ts` — research.md §3
- [X] T019 [P] Extend `src/auth/audit-log.service.ts`'s `record()` call sites list (no signature
      change needed beyond feature 002's generalization) to accept the four new `entityType` values
      from T012

**Checkpoint**: Schema, RLS, cross-module service exports, and the biometrics/geofence utilities
ready — user story implementation can now begin in parallel.

---

## Phase 3: User Story 1 - Enrol face biometrics (Priority: P1) 🎯 MVP

**Goal**: An employee can capture 3–5 photos, acknowledge consent, and enrol; consent withdrawal
deletes the template.

**Independent Test**: Enrol with 3 photos + consent, confirm status becomes Enrolled with a stored
descriptor; withdraw consent, confirm deletion and status reverts.

### Tests for User Story 1 ⚠️

- [X] T020 [P] [US1] E2e test: enrol (success, <3 photos → 400, unchecked consent → 400,
      already-enrolled → 409) in `test/my-workspace.e2e-spec.ts`
- [X] T021 [P] [US1] E2e test: consent withdrawal deletes photos/descriptor and reverts status in
      `test/my-workspace.e2e-spec.ts`
- [X] T022 [P] [US1] Unit test for `FaceEnrolmentService` (minimum-photo/consent gating,
      already-enrolled rejection) in `src/hr/biometrics/face-enrolment.service.spec.ts`

### Implementation for User Story 1

- [X] T023 [P] [US1] Create `src/hr/biometrics/dto/enrol.dto.ts` (photos, consentMethod,
      consentAcknowledged)
- [X] T024 [US1] Implement `src/hr/biometrics/face-enrolment.service.ts`: `enrol()` (gating,
      `BiometricsService.computeDescriptor()`, encrypted storage), `getStatus()`,
      `withdrawConsent()` (depends on T015, T017)
- [X] T025 [US1] Implement `src/hr/biometrics/face-enrolment.controller.ts`:
      `GET/POST /my/face-enrol`, `DELETE /my/face-enrol/consent` (depends on T024)
- [X] T026 [US1] Wire audit logging (entityType `FACE_ENROLMENT`) into enrol/withdraw paths of
      `face-enrolment.service.ts` — FR-027
- [X] T027 [US1] Register `FaceEnrolmentController`/`FaceEnrolmentService`/`BiometricsService` in
      `src/hr/hr.module.ts`

**Checkpoint**: User Story 1 fully functional and independently testable.

---

## Phase 4: User Story 2 - Punch in/out with face verification and geofence validation (Priority: P1)

**Goal**: An enrolled employee can punch in/out with photo+GPS; matches are recorded Present,
exceptions are recorded and routed for admin resolution.

**Independent Test**: Punch in/out with matching photo + in-geofence coordinates → Present;
out-of-geofence or non-matching photo → recorded as an exception, resolvable by an admin.

### Tests for User Story 2 ⚠️

- [X] T028 [P] [US2] E2e test: punch in/out success (worked hours, OT computed) in
      `test/my-workspace.e2e-spec.ts`
- [X] T029 [P] [US2] E2e test: no-enrolment rejection, double punch-in rejection, punch-out with no
      open punch-in rejection, and a caller cannot submit or read a punch for another employee (all
      endpoints resolve strictly from the caller's own token per FR-028) in
      `test/my-workspace.e2e-spec.ts`
- [X] T030 [P] [US2] E2e test: out-of-geofence and non-matching-photo punches recorded as
      exceptions; admin resolve (confirmed/rejected) in `test/my-workspace.e2e-spec.ts`
- [X] T031 [P] [US2] E2e test: punch rejected (423) within an already payroll-locked period in
      `test/my-workspace.e2e-spec.ts`
- [X] T032 [P] [US2] Unit test for the one-open-punch-in-at-a-time transactional guard (research.md
      §5) in `src/hr/punch/punch.service.spec.ts`
- [X] T033 [P] [US2] Unit test for OT-hours computation against `Employee.shiftId` duration in
      `src/hr/punch/punch.service.spec.ts`

### Implementation for User Story 2

- [X] T034 [P] [US2] Create `src/hr/punch/dto/punch.dto.ts` (type, photo, latitude, longitude,
      capturedAt)
- [X] T035 [US2] Implement `src/hr/punch/punch.service.ts`: `submitPunch()` (payroll-lock check via
      `SettingsModule`'s exported company lookup, open-punch-in transactional guard, geofence calc
      via `geofence.util.ts`/`SitesService`, face match via `BiometricsService`, OT computation via
      `Employee.shiftId` → `SettingsModule.getShift()`) (depends on T015–T018)
- [X] T036 [US2] Implement `src/hr/punch/punch.controller.ts`: `POST /my/punch` (depends on T035)
- [X] T037 [US2] Implement `src/hr/attendance-exceptions/attendance-exceptions.controller.ts` +
      a resolution method on `punch.service.ts`: `GET/POST /workspace-admin/attendance-exceptions*`,
      guarded with an admin permission check — FR-011a
- [X] T038 [US2] Wire audit logging (entityType `PUNCH`) into submit and resolve paths of
      `punch.service.ts` — FR-027
- [X] T039 [US2] Register `PunchController`, `AttendanceExceptionsController`, `PunchService` in
      `src/hr/hr.module.ts`

**Checkpoint**: User Stories 1 AND 2 both independently functional.

---

## Phase 5: User Story 3 - View attendance history (Priority: P2)

**Goal**: An employee can retrieve their own monthly attendance history with computed per-day
status.

**Independent Test**: Request a month with a mix of punches/leave/holidays and confirm each day's
status is correct.

### Tests for User Story 3 ⚠️

- [X] T040 [P] [US3] E2e test: month history reflects Present/Absent/On Leave/Weekly Off/Holiday
      correctly; empty months return blank rather than error; another employee's history is
      rejected in `test/my-workspace.e2e-spec.ts`
- [X] T041 [P] [US3] Unit test for the per-day status computation function (research.md §6) in
      `src/hr/punch/attendance-history.service.spec.ts`

### Implementation for User Story 3

- [X] T042 [US3] Implement `src/hr/punch/attendance-history.service.ts`: `getMonthHistory(employeeId,
      month, year)` computing per-day status from punches, approved leave (`LeaveModule`'s exported
      lookup), and `SitesService`'s holiday/weekly-off data (research.md §6) (depends on T015, T016)
- [X] T043 [US3] Add `GET /my/punch/history?month=&year=` to `punch.controller.ts` (depends on T042)

**Checkpoint**: User Stories 1–3 independently functional.

---

## Phase 6: User Story 4 - Apply for and manage leave (Priority: P2)

**Goal**: An employee can view balances, apply for leave (auto-computed days), cancel a pending
application, and have an admin approve/reject applications.

**Independent Test**: View balance, apply within it, confirm Pending; cancel it; separately, an
admin approves another application and the covered dates show On Leave in attendance history.

### Tests for User Story 4 ⚠️

- [X] T044 [P] [US4] E2e test: leave balance view; apply (day-count excludes weekends/holidays);
      over-balance rejection (non-LWP); LWP never balance-checked in `test/my-workspace.e2e-spec.ts`
- [X] T045 [P] [US4] E2e test: cancel a Pending application (success + 409 on non-Pending), and a
      caller cannot list, cancel, or view another employee's leave balance/applications (FR-022,
      FR-028) in `test/my-workspace.e2e-spec.ts`
- [X] T046 [P] [US4] E2e test: admin approve/reject (remarks required on reject), notification
      queued, approved dates show On Leave in attendance history in
      `test/my-workspace.e2e-spec.ts`
- [X] T047 [P] [US4] E2e test: leave create/edit rejected (423) within an already payroll-locked
      period in `test/my-workspace.e2e-spec.ts`
- [X] T048 [P] [US4] Unit test for the day-count calculation (excludes weekends + site holidays) in
      `src/hr/leave/leave.service.spec.ts`

### Implementation for User Story 4

- [X] T049 [P] [US4] Create `src/hr/leave/dto/leave-application.dto.ts` and
      `src/hr/leave/dto/leave-decision.dto.ts`
- [X] T050 [US4] Implement `src/hr/leave/leave.service.ts`: `getBalance()`, `apply()` (day-count via
      `SitesService.getHolidayCalendar()`, balance check), `cancel()`, `listMine()`, `decide()`
      (admin approve/reject, notification queue) — FR-018–FR-022a (depends on T015, T016)
- [X] T051 [US4] Implement `src/hr/leave/leave.controller.ts`: `GET /my/leave/balance`,
      `GET/POST /my/leave/applications`, `POST /my/leave/applications/:id/cancel` (depends on T050)
- [X] T052 [US4] Implement `src/hr/leave/leave-admin.controller.ts`:
      `GET /workspace-admin/leave-applications`,
      `POST /workspace-admin/leave-applications/:id/decide`, permission-guarded (depends on T050)
- [X] T053 [US4] Wire audit logging (entityType `LEAVE_APPLICATION`) into apply/cancel/decide paths
      of `leave.service.ts` — FR-027
- [X] T054 [US4] Register `LeaveController`, `LeaveAdminController`, `LeaveService` in
      `src/hr/hr.module.ts`

**Checkpoint**: User Stories 1–4 independently functional.

---

## Phase 7: User Story 5 - View and download salary slip (Priority: P2)

**Goal**: An employee can list Processed/Paid periods and view/download their own slip.

**Independent Test**: Available-periods excludes Draft; slip view and PDF download both return the
same figures for a Processed period.

### Tests for User Story 5 ⚠️

- [X] T055 [P] [US5] E2e test: available-periods excludes Draft; slip view returns full projection;
      PDF download returns `application/pdf` with matching figures; 404 for a Draft period; another
      employee's slip is rejected in `test/my-workspace.e2e-spec.ts`
- [X] T056 [P] [US5] Unit test for `SalaryPdfService`'s figure-to-PDF mapping (same source data,
      no divergence from the JSON response) in `src/payroll/salary/salary-pdf.service.spec.ts`

### Implementation for User Story 5

- [X] T057 [P] [US5] Implement `src/payroll/salary/salary.service.ts`: `getAvailablePeriods()`
      (filters `PayrollRun.status`), `getSlip(period)`
- [X] T058 [US5] Implement `src/payroll/salary/salary-pdf.service.ts`: `pdfkit`-based rendering
      from the same slip projection `salary.service.ts` returns — research.md §7
- [X] T059 [US5] Implement `src/payroll/salary/salary.controller.ts`:
      `GET /my/salary/available-periods`, `GET /my/salary/:period`, `GET /my/salary/:period/pdf`
      (depends on T057, T058)
- [X] T060 [US5] Register `SalaryController`/`SalaryService`/`SalaryPdfService` in
      `src/payroll/payroll.module.ts`

**Checkpoint**: User Stories 1–5 independently functional.

---

## Phase 8: User Story 6 - Offline punch queueing and sync (Priority: P3)

**Goal**: A punch whose declared capture time precedes the request's arrival time is accepted,
tagged offline-synced, and validated using its declared time.

**Independent Test**: Submit a punch with a past `capturedAt`; confirm it's accepted, tagged, and
validated (geofence/face/payroll-lock) against that declared date, not the request time.

### Tests for User Story 6 ⚠️

- [X] T061 [P] [US6] E2e test: offline-synced punch preserves declared `capturedAt`, tags
      `isOfflineSync: true`, stores `receivedAt` separately in `test/my-workspace.e2e-spec.ts`
- [X] T062 [P] [US6] E2e test: `capturedAt` older than the configured max offline-queue age is
      rejected (400) in `test/my-workspace.e2e-spec.ts`
- [X] T063 [P] [US6] Unit test for the offline-sync tagging + clock-skew-tolerance logic
      (research.md §4) in `src/hr/punch/punch.service.spec.ts`

### Implementation for User Story 6

- [X] T064 [US6] Extend `punch.service.ts`'s `submitPunch()` (T035) with the
      `isOfflineSync`/`maxOfflineQueueAgeHours` logic from research.md §4 (depends on T035)

**Checkpoint**: User Stories 1–6 independently functional.

---

## Phase 9: User Story 7 - Request and complete biometric re-enrolment (Priority: P3)

**Goal**: An enrolled employee can request re-enrolment; an admin approves/rejects; on approval, a
7-day one-time unlock permits exactly one fresh-capture completion.

**Independent Test**: Request → admin approve → complete within window → old template replaced,
unlock consumed; separately, a completion attempt with no/expired/consumed unlock is rejected.

### Tests for User Story 7 ⚠️

- [X] T065 [P] [US7] E2e test: request → approve (employee notified) → complete (old template
      replaced, unlock consumed) in `test/my-workspace.e2e-spec.ts`
- [X] T066 [P] [US7] E2e test: reject (remarks required, no unlock granted, employee notified);
      completion with no unlock (403); completion after unlock already consumed (403) in
      `test/my-workspace.e2e-spec.ts`
- [X] T067 [P] [US7] E2e test: completion after 7-day unlock expiry is rejected (403) in
      `test/my-workspace.e2e-spec.ts`
- [X] T068 [P] [US7] E2e test: consent withdrawal while a request is pending auto-closes it and
      reverts status in `test/my-workspace.e2e-spec.ts`
- [X] T069 [P] [US7] Unit test for the unlock-validity check (active/unexpired/unconsumed) in
      `src/hr/biometrics/face-enrolment.service.spec.ts`

### Implementation for User Story 7

- [X] T070 [P] [US7] Create `src/hr/biometrics/dto/re-enrolment-request.dto.ts` and
      `dto/re-enrolment-complete.dto.ts`
- [X] T071 [US7] Extend `face-enrolment.service.ts` (T024) with `requestReEnrolment()`,
      `decideReEnrolment()` (admin approve/reject, unlock issuance, queues an employee notification
      on both approval and rejection per FR-023), `completeReEnrolment()` (unlock-validity check,
      template replace, unlock consume) — FR-013–FR-016, FR-023
- [X] T072 [US7] Extend `face-enrolment.controller.ts` (T025) with
      `POST /my/face-enrol/re-enrolment-request`, `POST /my/face-enrol/re-enrolment-complete`, and
      an admin decide endpoint (permission-guarded) (depends on T071)
- [X] T073 [US7] Wire the consent-withdrawal auto-close-pending-request behavior (FR-017) into
      `withdrawConsent()` (T024)
- [X] T074 [US7] Wire audit logging (entityType `RE_ENROLMENT_REQUEST`) into request/decide/
      complete paths of `face-enrolment.service.ts` — FR-027

**Checkpoint**: All seven original user stories independently functional.

---

## Phase 10: User Story 8 - Submit reimbursement claims (Priority: P3)

**Goal**: An employee can create a reimbursement claim, edit/withdraw it while eligible, and view
their own claim history.

**Independent Test**: Submit a claim above a category's mandatory-receipt threshold without a
receipt (rejected), then with one (created, Submitted); confirm it appears in own-history.

### Tests for User Story 8 ⚠️

- [X] T078 [P] [US8] E2e test: create claim below/above receipt threshold (with/without receipt)
      in `test/my-workspace.e2e-spec.ts`
- [X] T079 [P] [US8] E2e test: edit/delete a Draft claim; withdraw a Submitted claim only while
      Pending in `test/my-workspace.e2e-spec.ts`
- [X] T080 [P] [US8] E2e test: one employee cannot read or act on another's claim in
      `test/my-workspace.e2e-spec.ts`

### Implementation for User Story 8

- [X] T081 [P] [US8] Create `src/hr/reimbursements/dto/create-claim.dto.ts` and
      `dto/update-claim.dto.ts`
- [X] T082 [US8] Implement `src/hr/reimbursements/reimbursement.service.ts` — `createClaim()`
      (reads category config via `SettingsService.getReimbursementCategories()`, enforces the
      receipt-threshold rule), `updateClaim()`, `withdrawClaim()`, `listOwnClaims()` — FR-029–
      FR-032 (depends on T081)
- [X] T083 [US8] Implement `src/hr/reimbursements/reimbursement.controller.ts` — `POST /my/
      reimbursements`, `PATCH /my/reimbursements/:id`, `POST /my/reimbursements/:id/withdraw`,
      `GET /my/reimbursements` — all scoped to the caller's own employee record (FR-033),
      permission-guarded (depends on T082)
- [X] T084 [US8] Wire audit logging (entityType `REIMBURSEMENT_CLAIM`) into
      `reimbursement.service.ts` — FR-027

**Checkpoint**: All eight user stories independently functional.

---

## Phase 11: Polish & Cross-Cutting Concerns

- [X] T085 [P] Run `npm run lint` and `npm run build` across all new/modified files
- [X] T086 [P] Add `@nestjs/swagger` decorators to every controller under `src/hr/`,
      `src/projects/`, `src/payroll/salary/`
- [ ] T087 Run the full `quickstart.md` validation scenarios end-to-end and record results
- [X] T087a [P] E2e test: perform one action producing each new `AuditLogEntry.entityType`
      (`PUNCH`, `LEAVE_APPLICATION`, `FACE_ENROLMENT`, `RE_ENROLMENT_REQUEST`,
      `REIMBURSEMENT_CLAIM`), then query `AuditLogEntry` directly and assert each row's
      `entityType`, `action`, `entityId`, acting account, `companyId`, and timestamp are correct —
      spec SC-009 — in `test/my-workspace.e2e-spec.ts`
- [X] T088 [P] Review every `companyId`-scoped table for RLS coverage and confirm the Super Admin
      bypass flag still behaves correctly — Constitution Principle IV
- [X] T089 [P] Confirm biometric photo/descriptor storage is encrypted at rest and every access is
      audit-logged — FR-026, research.md §8
- [X] T090 Update `.env.example` with any new `WorkspaceConfig` environment variables

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS all user stories
- **User Stories (Phase 3–10)**: All depend on Foundational
  - US1 (Enrolment) has no dependency on other stories and is the true prerequisite for US2's face
    verification to be meaningful (though US2's code can be built in parallel against a stubbed
    enrolled employee)
  - US2 (Punch) depends on US1 existing for realistic face-match testing but not for its own code
  - US3 (History) reads punch + leave data — build after US2 and US4's core services exist, though
    its own tasks are otherwise independent
  - US4 (Leave) is independent of US2/US3 beyond a Company/Site/Employee existing
  - US5 (Salary) is fully independent, needing only a seeded `PayrollRun`/`SalarySlip`
  - US6 (Offline sync) extends US2's `punch.service.ts` directly — must follow US2
  - US7 (Re-enrolment) extends US1's `face-enrolment.service.ts`/`controller.ts` directly — must
    follow US1
  - US8 (Reimbursement Claims) is independent of every other story beyond a Company/Employee
    existing and Settings' Reimbursement Categories master (feature 005) being available
- **Polish (Phase 11)**: Depends on all desired user stories being complete

### Parallel Opportunities

- All Setup tasks marked [P] can run in parallel
- Within Foundational, T006–T012 (schema models) can run in parallel; T015–T019 (service exports/
  utilities) can run in parallel once T013 (migration) completes
- Once Foundational completes: US1, US4, US5 can proceed fully in parallel; US2 can start in
  parallel too (using a test-seeded enrolled employee) but US6 must wait on US2; US3 benefits from
  US2/US4 landing first since it reads their data; US7 must wait on US1

---

## Parallel Example: User Story 1

```bash
# Launch all tests for User Story 1 together:
Task: "E2e test: enrol success/failure cases in test/my-workspace.e2e-spec.ts"
Task: "E2e test: consent withdrawal in test/my-workspace.e2e-spec.ts"
Task: "Unit test for FaceEnrolmentService gating in src/hr/biometrics/face-enrolment.service.spec.ts"

# Launch the DTO alongside the tests:
Task: "Create src/hr/biometrics/dto/enrol.dto.ts"
```

---

## Implementation Strategy

### MVP First (User Stories 1 + 2 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL — blocks all stories)
3. Complete Phase 3: User Story 1 (Enrolment)
4. Complete Phase 4: User Story 2 (Punch)
5. **STOP and VALIDATE**: Run quickstart.md Scenarios 1–2 independently
6. Deploy/demo if ready — self-service biometric attendance, the feature's core value, even before
   leave/salary/re-enrolment exist

### Incremental Delivery

1. Setup + Foundational → foundation ready (schema, RLS, cross-module exports, biometrics/geofence
   utilities)
2. US1 (Enrolment) → US2 (Punch) → test independently → MVP (core self-service attendance)
3. US3 (History) → US4 (Leave) → US5 (Salary) → each tested independently → full self-service
   portal
4. US6 (Offline sync) → US7 (Re-enrolment) → each tested independently → resilience + biometric
   lifecycle complete

---

## Phase 12: Convergence

Appended by a convergence pass over the codebase after Phases 1–11. Each item traces
to the spec/plan artifact it is missing against; none of them blocks a P1 or P2 user
story, which is why they are listed here rather than reopening an earlier phase.

- [X] T091 Apply the two migrations written but not yet run
      (`20260830140000_reimbursements_and_salary_slips`,
      `20260830140100_reimbursement_and_salary_rls_policies`) via `npm run migrate:dev`,
      then confirm `npm run migrate:status` is clean per plan: Prisma multi-schema (missing)
- [X] T092 Run `npm run test:e2e` against a live Postgres — `test/my-workspace.e2e-spec.ts`
      now covers US1–US8 and the audit trail but has never been executed
      per plan: Testing strategy (missing)
- [ ] T093 Build a notification transport and queue employee/HR notifications on leave
      approval and rejection, re-enrolment approval and rejection, re-enrolment request
      submission, and attendance-exception resolution. Every one of those call sites
      currently records the decision and stops — the only transport in the codebase is
      `MailService.sendAccountLockedEmail` per FR-023, FR-014, FR-011a, FR-022a (missing)
- [ ] T094 Add the punch-photo purge that `WorkspaceConfig.photoRetention.punchPhotoDays`
      exists for. The setting is configured and documented in `.env.example` but has no
      consumer anywhere in `src/`, so punch photos are currently retained indefinitely
      per FR-026, research.md §8 (missing)
- [ ] T095 Measure a punch-in round trip (photo + GPS submission through recorded
      response) against SC-001's 10-second budget with the real face-api backend, and
      record the result — the e2e suite substitutes a deterministic matcher, so nothing
      currently exercises real inference latency per SC-001 (missing)
- [ ] T096 Run the full `quickstart.md` validation scenarios end-to-end and record
      results (the T087 that Phase 11 could not complete without a running database)
      per plan: quickstart.md (missing)

---

## Phase 13: Convergence

Appended by a second convergence pass, run after Phases 1–12 with all migrations applied
and the full test suite green. The constitution checks were clean (no cross-schema
queries, no hardcoded magic values, RLS enabled and forced with a policy on all ten new
tables), and every endpoint in `contracts/my-workspace-api.md` is implemented. The items
below are the gaps that remain, and the first one blocks both P1 stories in real use.

- [X] T097 **CRITICAL** — Configure an explicit request body-size limit large enough for
      base64 photo payloads (e.g. `NestFactory.create(AppModule, { bodyParser: true })`
      plus `app.use(json({ limit: ... }))`, with the value in centralized config per
      Principle III, not inline). `src/main.ts` sets none today, so Express's 100 KB JSON
      default applies, and every realistic enrolment and punch fails with
      `413 request entity too large`. Verified live against the running API: a three-photo
      enrolment built from real photographs is 565 KB and returns 413. Punch is worse —
      `camera-capture.tsx` uploads at full sensor resolution, so a single frame commonly
      exceeds the limit several times over. Size the limit against the frontend's actual
      capture output (see the companion task in the web repo) rather than picking a round
      number, and reject oversized bodies with a message that names the real cause
      per contract `/my/face-enrol` + `/my/punch`, FR-001, FR-005 (missing)

- [X] T098 Add an e2e case that posts a realistically-sized photo payload — the current
      fixture in `test/my-workspace.e2e-spec.ts` is a 160-byte 1x1 JPEG, so all 88 tests
      pass against payloads roughly 3500x smaller than production traffic. That gap is the
      reason T097 went undetected through a full green suite. Use a photo of representative
      dimensions (the `@vladmandic/face-api` package ships sample images under `demo/`) and
      assert the enrolment and punch endpoints accept it
      per plan: Testing strategy (partial)

- [X] T099 Make `STORAGE_DRIVER=local` a fatal startup error when `NODE_ENV=production`
      rather than a logged warning in `src/common/storage/storage.module.ts`. The
      production host's filesystem is ephemeral, so the current behaviour is an application
      that starts cleanly, serves correctly, and silently destroys every stored biometric
      photo on the next deploy or idle spin-down — leaving the retention and deletion
      obligations unmeetable, with only a log line to say so. Failing to boot is the safer
      outcome for a misconfiguration whose symptom is otherwise invisible until the data is
      already gone per FR-026, research.md §8 — done; recorded as T107 in Phase 14

---

## Phase 14: Amendment 2026-09-01 — timezone, open-punch state, reimbursement wiring

Appended after Phases 1–13. Each task below is already implemented; they are recorded so
`tasks.md` still describes the code that exists.

- [X] T100 Add a configured application timezone (`APP_TIMEZONE`, default `Asia/Kolkata`) to
      `SettingsConfig` and reckon every calendar day against it
      per FR-018a

- [X] T101 Add `zonedDateOnly()` and `zonedDayBounds()` to `src/hr/leave/leave-days.ts` — the
      instant-to-calendar-day boundary `toDateOnly()` must not be used for. `toDateOnly` and
      `parseDateOnly` are deliberately unchanged: they operate on calendar strings and
      `@db.Date` values that genuinely are UTC-midnight, and are DST-free by construction.
      `zonedDayBounds` measures the zone's offset rather than assuming one, so a DST date
      returns a 23- or 25-hour day instead of dropping or double-counting an hour
      per FR-018a

- [X] T102 Apply the zone at every boundary where an instant becomes a day: punch grouping and
      the month range query in `attendance-history.service.ts` (its month edges were losing
      punches to the neighbouring months), the current-financial-year default in
      `leave.service.ts`, and both `isPayrollLocked()` call sites
      per FR-018a, FR-010, FR-019

- [X] T103 Extend `payroll-lock.spec.ts` with IST cases: a post-midnight punch attributed to the
      wrong period, and the lock closing a day early because 02:00 IST on the lock day is still
      the previous day in UTC. Existing cases pass `'UTC'` explicitly, preserving their original
      intent rather than re-deriving every expectation
      per FR-018a

- [X] T104 Add `GET /my/punch/open`, returning the caller's open punch-in or `null`, from the
      same `closedByPunchId IS NULL` condition the FR-008 rule is enforced against
      per FR-008b

- [X] T105 Add `GET /my/reimbursements/categories`, exposing the caller's company's active
      categories and their receipt thresholds so a claim form can be built at all
      per FR-029a

- [X] T106 Accept a base64 `receipt` on claim create/edit, store it via `StorageService`, and
      normalise it through `ImageProcessingService.compressReceipt()` first — which strips EXIF
      (GPS included) and makes the stored `image/jpeg` content type honest, where storing the
      raw bytes mislabelled every PNG and WebP the decoder accepts
      per FR-029b, FR-026

- [X] T107 Make `STORAGE_DRIVER=local` a fatal startup error under `NODE_ENV=production`, with an
      explicit `ALLOW_LOCAL_STORAGE` opt-out for deployments serving no real users
      per FR-026a — supersedes T099

---

## Phase 15: Amendment 2026-09-01 (b) — one punch-in and one punch-out per day (FR-008)

**Goal**: An employee can punch in once and out once per calendar day, and nothing else.

**Independent Test**: Punch in, punch out, then attempt a second punch-in and a second punch-out —
both refused with 409. On a fresh day, punch in succeeds again. With a stale open punch-in from an
earlier day present, today's punch-in still succeeds.

### Migration (blocking — every task below depends on it)

- [X] T108 Add the `PunchSource` enum (`employee` | `admin_correction` | `legacy`) and a `source`
      column on `PunchRecord` defaulting to `employee`, in `prisma/schema.prisma`
      per FR-008c, data-model.md

- [X] T109 Add a `punchDate` date column on `PunchRecord`, backfilled for existing rows from
      `capturedAt` at the default zone. Stored rather than computed: `AT TIME ZONE` with a named
      zone is STABLE, not IMMUTABLE, so Postgres will not index the expression
      per FR-008c, FR-018a, plan §2

- [X] T110 In the same migration, set every pre-existing row's `source` to `legacy`. The current
      data already contains multiple pairs on a day and the decision is to leave it; marking it
      `legacy` excludes it from the new index without deleting anything. Bounded by
      `createdAt <= NOW()` rather than "all rows", so replaying the statement can never
      reclassify punches made after the migration
      per FR-008c, clarification 2026-09-01

- [X] T111 Drop `PunchRecord_one_open_punch_in_per_employee`. It contradicts FR-008a — which
      requires two open punch-in rows to be able to coexist across days — and its rule is subsumed
      now that a day admits at most one punch-in
      per FR-008a, plan §3

- [X] T112 Create the partial unique index on `("employeeId", "type", "punchDate")
      WHERE "source" = 'employee'`
      per FR-008c

- [X] T113 Run the migration against the local database and confirm it applies cleanly with the
      existing multi-pair data present — if any `employee`-sourced duplicate remains, index
      creation fails and the deploy would stop. Verify with `npm run migrate:status`
      per plan §4

### Service and contract

- [X] T114 [US2] Stamp `punchDate` and `source: 'employee'` on every punch written by
      `submitPunch()` in `src/hr/punch/punch.service.ts`, using `zonedDateOnly()` against the
      configured zone
      per FR-008, FR-018a

- [X] T115 [US2] Replace the open-punch gate in `submitPunch()` with the day-scoped rule: reject a
      punch-in when that day already has one (closed or not), a punch-out when that day has no
      punch-in, and a punch-out when the day's punch is already closed. The check considers every
      punch on the day whatever its `source` — the rule is about the day's record, not who wrote it
      per FR-008

- [X] T116 [US2] Ensure a stale open punch-in from an earlier day does not block today's punch-in,
      and is not closable by today's punch-out
      per FR-008a

- [X] T117 [US2] Raise `ConflictException` (409) instead of `BadRequestException` (400) for every
      FR-008 refusal, including the pre-existing unmatched-punch-out case
      per FR-008, clarification 2026-09-01

- [X] T118 [US2] Reshape `getOpenPunchIn()` and `GET /my/punch/open` to today's state —
      `{ punchedInAt, punchedOutAt, isComplete }` — excluding any stale open punch-in from an
      earlier day, which is neither actionable nor closable
      per FR-008b, contracts/my-workspace-api.md

- [X] T119 [US2] Refuse a queued offline punch that drains onto a day already holding a punch of
      that type, with the same 409, so the recorded punch stands
      per FR-008, clarification 2026-09-01

### Tests

- [X] T120 [P] [US2] Unit-test the day rule in `src/hr/punch/punch.service.spec.ts`: second
      punch-in refused after the first is closed, punch-out with no punch-in refused, second
      punch-out refused, new day allowed, stale open punch-in from an earlier day non-blocking
      per FR-008, FR-008a

- [X] T121 [US2] Update `test/my-workspace.e2e-spec.ts` for the 400 → 409 change and add coverage
      for the one-pair-per-day refusals
      per FR-008

---

## Phase 16: Convergence

Appended by a convergence pass after Phase 15. These are gaps between the amended spec and the
code as it stands.

- [X] T122 Restructure the punch e2e scenarios that submit more than one punch of a type per
      employee per day in `test/my-workspace.e2e-spec.ts` — the out-of-geofence (line ~507),
      non-matching-face (~522) and offline-queued (~541) cases each assert 201 while reusing the
      same employee on the same day, which FR-008 now refuses with 409. Give each its own
      `capturedAt` day or its own employee rather than relaxing the assertions
      per FR-008 (contradicts)

- [X] T123 Fix the scenario at `test/my-workspace.e2e-spec.ts` ~line 478: "rejects a punch-out
      with no punch-in that day" runs after the pair is already complete, so it exercises
      "already punched out today" instead. It passes for the wrong reason — move it ahead of the
      punch-in, or rename it to what it actually tests
      per FR-008 (partial)

- [ ] T124 (NOT RUN — user deferred) Run `npm run test:e2e` against a live Postgres with the new migration applied, and fix
      whatever T122 and T123 do not already cover. The suite has not been executed since the
      one-pair-per-day rule landed
      per FR-008, FR-008b (missing)

- [ ] T125 Walk the Punch screen through its three states in a browser — no punch today, open
      shift, day complete — confirming the control appears, changes, and disappears, and that no
      disabled button is ever shown. Typecheck, lint and build pass, but no browser pass has run
      per FR-019c, FR-019d (missing)
