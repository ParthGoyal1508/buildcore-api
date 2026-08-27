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

- [ ] T001 Add `@vladmandic/face-api` and `pdfkit` as dependencies (constitution v1.1.0
      pre-approval) in `package.json`
- [ ] T002 [P] Extend `src/common/configs/config.interface.ts` with `WorkspaceConfig` (face-match
      distance threshold, max offline-queue age hours, re-enrolment unlock duration days,
      clock-skew tolerance minutes) — research.md §2, §4, §8
- [ ] T003 [P] Populate `WorkspaceConfig` defaults in `src/common/configs/config.ts`
- [ ] T004 [P] Create `src/hr/hr.module.ts`, `src/projects/projects.module.ts` shells, and extend
      (or create) `src/payroll/payroll.module.ts`, registered in `src/app.module.ts`

**Checkpoint**: Config plumbing and module shells ready.

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [ ] T005 Add the `hr` Postgres schema block to `prisma/schema.prisma` (Prisma multi-schema,
      matching features 001/002's pattern) — research.md §1
- [ ] T006 [P] Add the `projects` Postgres schema block with the `Site` model (companyId,
      latitude/longitude, geofenceRadiusMeters, weeklyOffDay, holidays) — data-model.md "Site"
- [ ] T007 [P] Add the `Employee` model to the `hr` schema (userId, companyId, siteId, shiftId,
      employeeCode) — data-model.md "Employee"
- [ ] T008 [P] Add the `FaceEnrolment` and `ReEnrolmentRequest` models to the `hr` schema —
      data-model.md
- [ ] T009 [P] Add the `PunchRecord` model to the `hr` schema (type, capturedAt, receivedAt,
      isOfflineSync, photoRef, faceMatchResult, geofenceResult, exceptionResolution) —
      data-model.md "Punch Record"
- [ ] T010 [P] Add `LeaveType`/`LeaveBalance`/`LeaveApplication` models to the `hr` schema —
      data-model.md
- [ ] T011 [P] Add `PayrollRun` (status only) and the `SalarySlip` read-projection shape to the
      `payroll` schema — data-model.md
- [ ] T012 Extend `shared.AuditLogEntry.entityType` in `prisma/schema.prisma` with `PUNCH`,
      `LEAVE_APPLICATION`, `FACE_ENROLMENT`, `RE_ENROLMENT_REQUEST` — data-model.md cross-reference
- [ ] T013 Generate and apply the migration for T005–T012 via `npm run migrate:dev:create` then
      `npm run migrate:dev`
- [ ] T014 Add Postgres RLS policies for every `companyId`-scoped table introduced above (`Site`,
      `Employee`, `PunchRecord` via `Employee`, `LeaveApplication` via `Employee`, `PayrollRun`),
      reusing the `app.current_company_id` session-variable pattern from features 001/002
- [ ] T015 [P] Create `src/hr/employees/employees.service.ts`: `getByUserId(userId)`,
      `getById(employeeId)`, exported for other modules to resolve the caller's own Employee record
      — research.md §9
- [ ] T016 [P] Create `src/projects/sites/sites.service.ts`: `getGeofence(siteId)`,
      `getHolidayCalendar(siteId)`, `getWeeklyOffDay(siteId)`, exported for `hr` to call —
      research.md §1
- [ ] T017 [P] Create `src/hr/biometrics/biometrics.service.ts`: `computeDescriptor(photos)` and
      `compareDescriptors(a, b): { matched: boolean, distance: number }` using
      `@vladmandic/face-api`, reading the threshold from `WorkspaceConfig` — research.md §2
- [ ] T018 [P] Create a geofence-distance utility (Haversine formula) in
      `src/hr/punch/geofence.util.ts` — research.md §3
- [ ] T019 [P] Extend `src/auth/audit-log.service.ts`'s `record()` call sites list (no signature
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

- [ ] T020 [P] [US1] E2e test: enrol (success, <3 photos → 400, unchecked consent → 400,
      already-enrolled → 409) in `test/my-workspace.e2e-spec.ts`
- [ ] T021 [P] [US1] E2e test: consent withdrawal deletes photos/descriptor and reverts status in
      `test/my-workspace.e2e-spec.ts`
- [ ] T022 [P] [US1] Unit test for `FaceEnrolmentService` (minimum-photo/consent gating,
      already-enrolled rejection) in `src/hr/biometrics/face-enrolment.service.spec.ts`

### Implementation for User Story 1

- [ ] T023 [P] [US1] Create `src/hr/biometrics/dto/enrol.dto.ts` (photos, consentMethod,
      consentAcknowledged)
- [ ] T024 [US1] Implement `src/hr/biometrics/face-enrolment.service.ts`: `enrol()` (gating,
      `BiometricsService.computeDescriptor()`, encrypted storage), `getStatus()`,
      `withdrawConsent()` (depends on T015, T017)
- [ ] T025 [US1] Implement `src/hr/biometrics/face-enrolment.controller.ts`:
      `GET/POST /my/face-enrol`, `DELETE /my/face-enrol/consent` (depends on T024)
- [ ] T026 [US1] Wire audit logging (entityType `FACE_ENROLMENT`) into enrol/withdraw paths of
      `face-enrolment.service.ts` — FR-027
- [ ] T027 [US1] Register `FaceEnrolmentController`/`FaceEnrolmentService`/`BiometricsService` in
      `src/hr/hr.module.ts`

**Checkpoint**: User Story 1 fully functional and independently testable.

---

## Phase 4: User Story 2 - Punch in/out with face verification and geofence validation (Priority: P1)

**Goal**: An enrolled employee can punch in/out with photo+GPS; matches are recorded Present,
exceptions are recorded and routed for admin resolution.

**Independent Test**: Punch in/out with matching photo + in-geofence coordinates → Present;
out-of-geofence or non-matching photo → recorded as an exception, resolvable by an admin.

### Tests for User Story 2 ⚠️

- [ ] T028 [P] [US2] E2e test: punch in/out success (worked hours, OT computed) in
      `test/my-workspace.e2e-spec.ts`
- [ ] T029 [P] [US2] E2e test: no-enrolment rejection, double punch-in rejection, punch-out with no
      open punch-in rejection, and a caller cannot submit or read a punch for another employee (all
      endpoints resolve strictly from the caller's own token per FR-028) in
      `test/my-workspace.e2e-spec.ts`
- [ ] T030 [P] [US2] E2e test: out-of-geofence and non-matching-photo punches recorded as
      exceptions; admin resolve (confirmed/rejected) in `test/my-workspace.e2e-spec.ts`
- [ ] T031 [P] [US2] E2e test: punch rejected (423) within an already payroll-locked period in
      `test/my-workspace.e2e-spec.ts`
- [ ] T032 [P] [US2] Unit test for the one-open-punch-in-at-a-time transactional guard (research.md
      §5) in `src/hr/punch/punch.service.spec.ts`
- [ ] T033 [P] [US2] Unit test for OT-hours computation against `Employee.shiftId` duration in
      `src/hr/punch/punch.service.spec.ts`

### Implementation for User Story 2

- [ ] T034 [P] [US2] Create `src/hr/punch/dto/punch.dto.ts` (type, photo, latitude, longitude,
      capturedAt)
- [ ] T035 [US2] Implement `src/hr/punch/punch.service.ts`: `submitPunch()` (payroll-lock check via
      `SettingsModule`'s exported company lookup, open-punch-in transactional guard, geofence calc
      via `geofence.util.ts`/`SitesService`, face match via `BiometricsService`, OT computation via
      `Employee.shiftId` → `SettingsModule.getShift()`) (depends on T015–T018)
- [ ] T036 [US2] Implement `src/hr/punch/punch.controller.ts`: `POST /my/punch` (depends on T035)
- [ ] T037 [US2] Implement `src/hr/attendance-exceptions/attendance-exceptions.controller.ts` +
      a resolution method on `punch.service.ts`: `GET/POST /workspace-admin/attendance-exceptions*`,
      guarded with an admin permission check — FR-011a
- [ ] T038 [US2] Wire audit logging (entityType `PUNCH`) into submit and resolve paths of
      `punch.service.ts` — FR-027
- [ ] T039 [US2] Register `PunchController`, `AttendanceExceptionsController`, `PunchService` in
      `src/hr/hr.module.ts`

**Checkpoint**: User Stories 1 AND 2 both independently functional.

---

## Phase 5: User Story 3 - View attendance history (Priority: P2)

**Goal**: An employee can retrieve their own monthly attendance history with computed per-day
status.

**Independent Test**: Request a month with a mix of punches/leave/holidays and confirm each day's
status is correct.

### Tests for User Story 3 ⚠️

- [ ] T040 [P] [US3] E2e test: month history reflects Present/Absent/On Leave/Weekly Off/Holiday
      correctly; empty months return blank rather than error; another employee's history is
      rejected in `test/my-workspace.e2e-spec.ts`
- [ ] T041 [P] [US3] Unit test for the per-day status computation function (research.md §6) in
      `src/hr/punch/attendance-history.service.spec.ts`

### Implementation for User Story 3

- [ ] T042 [US3] Implement `src/hr/punch/attendance-history.service.ts`: `getMonthHistory(employeeId,
      month, year)` computing per-day status from punches, approved leave (`LeaveModule`'s exported
      lookup), and `SitesService`'s holiday/weekly-off data (research.md §6) (depends on T015, T016)
- [ ] T043 [US3] Add `GET /my/punch/history?month=&year=` to `punch.controller.ts` (depends on T042)

**Checkpoint**: User Stories 1–3 independently functional.

---

## Phase 6: User Story 4 - Apply for and manage leave (Priority: P2)

**Goal**: An employee can view balances, apply for leave (auto-computed days), cancel a pending
application, and have an admin approve/reject applications.

**Independent Test**: View balance, apply within it, confirm Pending; cancel it; separately, an
admin approves another application and the covered dates show On Leave in attendance history.

### Tests for User Story 4 ⚠️

- [ ] T044 [P] [US4] E2e test: leave balance view; apply (day-count excludes weekends/holidays);
      over-balance rejection (non-LWP); LWP never balance-checked in `test/my-workspace.e2e-spec.ts`
- [ ] T045 [P] [US4] E2e test: cancel a Pending application (success + 409 on non-Pending), and a
      caller cannot list, cancel, or view another employee's leave balance/applications (FR-022,
      FR-028) in `test/my-workspace.e2e-spec.ts`
- [ ] T046 [P] [US4] E2e test: admin approve/reject (remarks required on reject), notification
      queued, approved dates show On Leave in attendance history in
      `test/my-workspace.e2e-spec.ts`
- [ ] T047 [P] [US4] E2e test: leave create/edit rejected (423) within an already payroll-locked
      period in `test/my-workspace.e2e-spec.ts`
- [ ] T048 [P] [US4] Unit test for the day-count calculation (excludes weekends + site holidays) in
      `src/hr/leave/leave.service.spec.ts`

### Implementation for User Story 4

- [ ] T049 [P] [US4] Create `src/hr/leave/dto/leave-application.dto.ts` and
      `src/hr/leave/dto/leave-decision.dto.ts`
- [ ] T050 [US4] Implement `src/hr/leave/leave.service.ts`: `getBalance()`, `apply()` (day-count via
      `SitesService.getHolidayCalendar()`, balance check), `cancel()`, `listMine()`, `decide()`
      (admin approve/reject, notification queue) — FR-018–FR-022a (depends on T015, T016)
- [ ] T051 [US4] Implement `src/hr/leave/leave.controller.ts`: `GET /my/leave/balance`,
      `GET/POST /my/leave/applications`, `POST /my/leave/applications/:id/cancel` (depends on T050)
- [ ] T052 [US4] Implement `src/hr/leave/leave-admin.controller.ts`:
      `GET /workspace-admin/leave-applications`,
      `POST /workspace-admin/leave-applications/:id/decide`, permission-guarded (depends on T050)
- [ ] T053 [US4] Wire audit logging (entityType `LEAVE_APPLICATION`) into apply/cancel/decide paths
      of `leave.service.ts` — FR-027
- [ ] T054 [US4] Register `LeaveController`, `LeaveAdminController`, `LeaveService` in
      `src/hr/hr.module.ts`

**Checkpoint**: User Stories 1–4 independently functional.

---

## Phase 7: User Story 5 - View and download salary slip (Priority: P2)

**Goal**: An employee can list Processed/Paid periods and view/download their own slip.

**Independent Test**: Available-periods excludes Draft; slip view and PDF download both return the
same figures for a Processed period.

### Tests for User Story 5 ⚠️

- [ ] T055 [P] [US5] E2e test: available-periods excludes Draft; slip view returns full projection;
      PDF download returns `application/pdf` with matching figures; 404 for a Draft period; another
      employee's slip is rejected in `test/my-workspace.e2e-spec.ts`
- [ ] T056 [P] [US5] Unit test for `SalaryPdfService`'s figure-to-PDF mapping (same source data,
      no divergence from the JSON response) in `src/payroll/salary/salary-pdf.service.spec.ts`

### Implementation for User Story 5

- [ ] T057 [P] [US5] Implement `src/payroll/salary/salary.service.ts`: `getAvailablePeriods()`
      (filters `PayrollRun.status`), `getSlip(period)`
- [ ] T058 [US5] Implement `src/payroll/salary/salary-pdf.service.ts`: `pdfkit`-based rendering
      from the same slip projection `salary.service.ts` returns — research.md §7
- [ ] T059 [US5] Implement `src/payroll/salary/salary.controller.ts`:
      `GET /my/salary/available-periods`, `GET /my/salary/:period`, `GET /my/salary/:period/pdf`
      (depends on T057, T058)
- [ ] T060 [US5] Register `SalaryController`/`SalaryService`/`SalaryPdfService` in
      `src/payroll/payroll.module.ts`

**Checkpoint**: User Stories 1–5 independently functional.

---

## Phase 8: User Story 6 - Offline punch queueing and sync (Priority: P3)

**Goal**: A punch whose declared capture time precedes the request's arrival time is accepted,
tagged offline-synced, and validated using its declared time.

**Independent Test**: Submit a punch with a past `capturedAt`; confirm it's accepted, tagged, and
validated (geofence/face/payroll-lock) against that declared date, not the request time.

### Tests for User Story 6 ⚠️

- [ ] T061 [P] [US6] E2e test: offline-synced punch preserves declared `capturedAt`, tags
      `isOfflineSync: true`, stores `receivedAt` separately in `test/my-workspace.e2e-spec.ts`
- [ ] T062 [P] [US6] E2e test: `capturedAt` older than the configured max offline-queue age is
      rejected (400) in `test/my-workspace.e2e-spec.ts`
- [ ] T063 [P] [US6] Unit test for the offline-sync tagging + clock-skew-tolerance logic
      (research.md §4) in `src/hr/punch/punch.service.spec.ts`

### Implementation for User Story 6

- [ ] T064 [US6] Extend `punch.service.ts`'s `submitPunch()` (T035) with the
      `isOfflineSync`/`maxOfflineQueueAgeHours` logic from research.md §4 (depends on T035)

**Checkpoint**: User Stories 1–6 independently functional.

---

## Phase 9: User Story 7 - Request and complete biometric re-enrolment (Priority: P3)

**Goal**: An enrolled employee can request re-enrolment; an admin approves/rejects; on approval, a
7-day one-time unlock permits exactly one fresh-capture completion.

**Independent Test**: Request → admin approve → complete within window → old template replaced,
unlock consumed; separately, a completion attempt with no/expired/consumed unlock is rejected.

### Tests for User Story 7 ⚠️

- [ ] T065 [P] [US7] E2e test: request → approve (employee notified) → complete (old template
      replaced, unlock consumed) in `test/my-workspace.e2e-spec.ts`
- [ ] T066 [P] [US7] E2e test: reject (remarks required, no unlock granted, employee notified);
      completion with no unlock (403); completion after unlock already consumed (403) in
      `test/my-workspace.e2e-spec.ts`
- [ ] T067 [P] [US7] E2e test: completion after 7-day unlock expiry is rejected (403) in
      `test/my-workspace.e2e-spec.ts`
- [ ] T068 [P] [US7] E2e test: consent withdrawal while a request is pending auto-closes it and
      reverts status in `test/my-workspace.e2e-spec.ts`
- [ ] T069 [P] [US7] Unit test for the unlock-validity check (active/unexpired/unconsumed) in
      `src/hr/biometrics/face-enrolment.service.spec.ts`

### Implementation for User Story 7

- [ ] T070 [P] [US7] Create `src/hr/biometrics/dto/re-enrolment-request.dto.ts` and
      `dto/re-enrolment-complete.dto.ts`
- [ ] T071 [US7] Extend `face-enrolment.service.ts` (T024) with `requestReEnrolment()`,
      `decideReEnrolment()` (admin approve/reject, unlock issuance, queues an employee notification
      on both approval and rejection per FR-023), `completeReEnrolment()` (unlock-validity check,
      template replace, unlock consume) — FR-013–FR-016, FR-023
- [ ] T072 [US7] Extend `face-enrolment.controller.ts` (T025) with
      `POST /my/face-enrol/re-enrolment-request`, `POST /my/face-enrol/re-enrolment-complete`, and
      an admin decide endpoint (permission-guarded) (depends on T071)
- [ ] T073 [US7] Wire the consent-withdrawal auto-close-pending-request behavior (FR-017) into
      `withdrawConsent()` (T024)
- [ ] T074 [US7] Wire audit logging (entityType `RE_ENROLMENT_REQUEST`) into request/decide/
      complete paths of `face-enrolment.service.ts` — FR-027

**Checkpoint**: All seven user stories independently functional.

---

## Phase 10: Polish & Cross-Cutting Concerns

- [ ] T075 [P] Run `npm run lint` and `npm run build` across all new/modified files
- [ ] T076 [P] Add `@nestjs/swagger` decorators to every controller under `src/hr/`,
      `src/projects/`, `src/payroll/salary/`
- [ ] T077 Run the full `quickstart.md` validation scenarios end-to-end and record results
- [ ] T077a [P] E2e test: perform one action producing each new `AuditLogEntry.entityType`
      (`PUNCH`, `LEAVE_APPLICATION`, `FACE_ENROLMENT`, `RE_ENROLMENT_REQUEST`), then query
      `AuditLogEntry` directly and assert each row's `entityType`, `action`, `entityId`, acting
      account, `companyId`, and timestamp are correct — spec SC-009 — in
      `test/my-workspace.e2e-spec.ts`
- [ ] T078 [P] Review every `companyId`-scoped table for RLS coverage and confirm the Super Admin
      bypass flag still behaves correctly — Constitution Principle IV
- [ ] T079 [P] Confirm biometric photo/descriptor storage is encrypted at rest and every access is
      audit-logged — FR-026, research.md §8
- [ ] T080 Update `.env.example` with any new `WorkspaceConfig` environment variables

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS all user stories
- **User Stories (Phase 3–9)**: All depend on Foundational
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
- **Polish (Phase 10)**: Depends on all desired user stories being complete

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
