---

description: "Task list for feature implementation"
---

# Tasks: Settings Module Backend (Companies, Users, Roles & Reference Data)

**Input**: Design documents from `/specs/002-settings-backend/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/settings-api.md,
quickstart.md

**Tests**: Included. This feature's Roles/permission enforcement and user administration are
access-control-adjacent, matching the constitution's "new endpoints touching auth ... MUST have an
e2e test" requirement (same posture as feature 001) — test tasks are mandatory here, not optional.

**Organization**: Tasks are grouped by user story (from spec.md) to enable independent
implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1–US7)
- Every task includes an exact file path

---

## Phase 1: Setup (Shared Infrastructure)

- [X] T001 [P] Extend `src/common/configs/config.interface.ts` with a `SettingsConfig` type
      (default PF/ESIC/Gratuity/Bonus rates) — research.md §11
- [X] T002 [P] Populate the new `SettingsConfig` values in `src/common/configs/config.ts` (12,
      3.25, 4.81, 8.33 defaults; env-overridable) — research.md §11, FR-002
- [X] T003 Create `src/settings/settings.module.ts` (empty shell, registered in `src/app.module.ts`)
      — target module all this feature's controllers/services/providers attach to

**Checkpoint**: Config plumbing and module shell ready.

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T004 Add a `settings` Postgres schema block to `prisma/schema.prisma` (Prisma multi-schema,
      matching feature 001's `shared` schema pattern) — research.md §1
- [X] T005 Add the `Permission` enum to the `settings` schema in `prisma/schema.prisma` with all 22
      values (`DASHBOARD`, `EMPLOYEES`, `ATTENDANCE`, `PROJECTS`, `DWR`, `PROJECT_FINANCIALS`,
      `MACHINERY`, `INVENTORY`, `PARTNERS`, `REPORTS`, `PAYROLL`, `CHALLANS`, `LOANS`, `LOGBOOK`,
      `FUEL`, `DAILY_WORKER_REGISTRY`, `MY_WORKSPACE`, `SETTINGS`, `USER_MANAGEMENT`,
      `COMPANY_SETTINGS`, `DATA_EXPORT`, `DATA_DELETE`) — data-model.md "Permission enum"
- [X] T006 Add the `Role` model to the `settings` schema in `prisma/schema.prisma` (`id`, `name`
      unique, `permissions Permission[]`, `isProtected`, timestamps) — data-model.md "Role"
- [X] T007 Change `shared.User.role` (enum) to `roleId String` with a relation to `settings.Role.id`
      in `prisma/schema.prisma`, removing the placeholder `Role` enum — data-model.md "User
      Account", research.md §2
- [X] T008 Generalize `shared.AuditLogEntry` in `prisma/schema.prisma`: rename `eventType` to
      `entityType` (extended with `COMPANY`, `ROLE`, `DEPARTMENT`, `DESIGNATION`, `DOCUMENT_TYPE`,
      `SHIFT` alongside the existing login values), add `action` enum, `entityId` nullable string,
      `changes` nullable Json — data-model.md "Audit Log Entry", research.md §9
- [X] T009 Generate and apply the migration for T004–T008 via `npm run migrate:dev:create` then
      `npm run migrate:dev` (single combined migration; never hand-edited SQL)
- [X] T010 [P] Add the `Company` model to the `settings` schema in `prisma/schema.prisma` (all
      fields per data-model.md "Company", `shortCode` unique) + migration
- [X] T011 [P] Add `Department`, `Designation` models to the `settings` schema in
      `prisma/schema.prisma` (`companyId`, `name` unique per `(companyId, name)`) + migration —
      data-model.md, research.md §8
- [X] T012 [P] Add the `DocumentType` model to the `settings` schema in `prisma/schema.prisma`
      (`companyId`, `code` unique per `(companyId, code)`, `isMandatory`, `hasExpiry`,
      `needsNumber`, `sortOrder`, `isActive`) + migration — data-model.md "Document Type"
- [X] T013 [P] Add the `Shift` model to the `settings` schema in `prisma/schema.prisma`
      (`companyId`, `name` unique per `(companyId, name)`, `inTime`, `outTime`, `graceMinutes`) +
      migration — data-model.md "Shift"
- [X] T014 [P] Add the `EmployeeCodeSequence` model to the `settings` schema in
      `prisma/schema.prisma` (`companyId` PK, `lastNumber` default 0) + migration — data-model.md
      "Employee Code Sequence"
- [X] T015 Write and apply the migration for T010–T014 via `npm run migrate:dev:create` then
      `npm run migrate:dev`
- [X] T016 Add Postgres RLS policies (SQL migration) for every `companyId`-scoped `settings` table
      (`Department`, `Designation`, `DocumentType`, `Shift`, `EmployeeCodeSequence`), reusing
      feature 001's `app.current_company_id` / `app.is_super_admin` session-variable pattern —
      research.md §8
- [X] T017 Create `src/common/decorators/require-permission.decorator.ts`:
      `@RequirePermission(...permissions: Permission[])` metadata decorator — data-model.md "Role/
      Permission Requirement" pattern, research.md §4
- [X] T018 Extend `src/auth/roles.guard.ts` (feature 001) — or create
      `src/common/guards/permission.guard.ts` if that file doesn't exist yet — to read
      `@RequirePermission()` metadata via `Reflector`, resolve the authenticated request's role via
      `SettingsModule`'s exported `RolesService.getRoleById()`, and check the required permission
      is present in `role.permissions`, rejecting with 403 otherwise — research.md §3, §4
- [X] T019 Create `prisma/seed.ts` additions (or a new `prisma/seeds/settings.seed.ts` imported by
      it): seed the nine default roles from the PRD's table with their documented permission sets,
      `isProtected: true` only for Super Admin — data-model.md "Role", spec FR-006
- [X] T020 Create `src/settings/employee-code/employee-code.service.ts`: exported
      `getNextEmployeeCode(companyId: string): Promise<string>` using an atomic
      `UPDATE ... RETURNING` against `EmployeeCodeSequence`, formatting
      `{Company.shortCode}-{lastNumber, zero-padded to 4}` — research.md §6, FR-023 (implemented in
      Foundational since it has no independent story-level UI beyond the read view in US7)
- [X] T021 [P] Extend `src/auth/audit-log.service.ts` (feature 001)'s `record()` method signature to
      the generalized `entityType`/`action`/`entityId`/`changes` shape (T008) while remaining
      backward-compatible with feature 001's own login-event call sites — research.md §9
- [X] T021a Add a `lastLoginAt` nullable timestamp column to `shared.User` in
      `prisma/schema.prisma` (owned by feature 001's login flow; skip this task if feature 001's own
      migration already added it) + migration — data-model.md "User Account", spec FR-017

**Checkpoint**: Foundation ready — schema, guard, seed data, and audit log all in place; user story
implementation can now begin in parallel.

---

## Phase 3: User Story 1 - Configure a company and its statutory/payroll settings (Priority: P1) 🎯 MVP

**Goal**: A Super Admin can create and edit companies with full registration/statutory/payroll
settings, driving multi-company scoping everywhere else.

**Independent Test**: Create a company with a unique short code and full field set, confirm it's
listed and selectable, edit its payroll rates, confirm the new values persist.

### Tests for User Story 1 ⚠️

- [X] T022 [P] [US1] E2e test: create company (success + duplicate-short-code 409 + malformed
      GSTIN/PAN 400) in `test/settings.e2e-spec.ts`
- [X] T023 [P] [US1] E2e test: edit company payroll rates and confirm persistence; deactivate a
      company and confirm it's excluded from `listActiveForOtherModules()` output while still
      present in the full admin `GET /settings/companies` list — spec FR-005 — in
      `test/settings.e2e-spec.ts`
- [X] T024 [P] [US1] Unit test for `CompaniesService` (short-code collision check, default-rate
      fallback, GSTIN/PAN validation) in `src/settings/companies/companies.service.spec.ts`

### Implementation for User Story 1

- [X] T025 [P] [US1] Create `src/settings/companies/dto/create-company.dto.ts` (all Company fields,
      `@Matches()` GSTIN/PAN validators per research.md §10)
- [X] T026 [P] [US1] Create `src/settings/companies/dto/update-company.dto.ts` (partial fields)
- [X] T027 [US1] Implement `src/settings/companies/companies.service.ts`: create (short-code
      collision check, default payroll rates from `SettingsConfig` when omitted, seed default
      Document Types via `ReferenceDataService`/`DocumentTypesService` from Phase 6, create
      `EmployeeCodeSequence` row at 0), list (all statuses, for the Settings UI's own Company List),
      `listActiveForOtherModules()` (status `active` only, exported for other modules' dropdowns —
      spec FR-005), get, update (depends on T010, T001/T002)
- [X] T028 [US1] Implement `src/settings/companies/companies.controller.ts`:
      `GET/POST/PATCH /settings/companies`, guarded with
      `@RequirePermission(Permission.COMPANY_SETTINGS)` (depends on T017, T018, T027)
- [X] T029 [US1] Wire audit logging (`AuditLogService.record()`, entityType `COMPANY`) into create/
      update paths of `companies.service.ts` — FR-025
- [X] T030 [US1] Register `CompaniesController`/`CompaniesService` in
      `src/settings/settings.module.ts`

**Checkpoint**: User Story 1 fully functional and independently testable.

---

## Phase 4: User Story 2 - Manage roles and their permissions (Priority: P1)

**Goal**: A Super Admin can view/create/edit/delete roles (except the protected Super Admin role)
with permissions drawn from the fixed enum, and see per-role assigned-user counts.

**Independent Test**: List the nine default roles, create a custom role with a permission subset,
assign it to a test user, confirm accessible modules match exactly.

### Tests for User Story 2 ⚠️

- [X] T031 [P] [US2] E2e test: list default roles with `assignedUserCount` and Super Admin's
      `isProtected: true` in `test/settings.e2e-spec.ts`
- [X] T032 [P] [US2] E2e test: create custom role, reject invalid permission value (400), edit/
      delete a non-protected role, reject rename/edit/delete of Super Admin (403) in
      `test/settings.e2e-spec.ts`
- [X] T033 [P] [US2] E2e test: delete a role with assigned users, confirm those users' `roleId`
      clears and their next permission-gated request is rejected in `test/settings.e2e-spec.ts`
- [X] T034 [P] [US2] Unit test for `RolesService` (protected-role guard, assigned-user-count
      computation, cascading roleId clear on delete) in `src/settings/roles/roles.service.spec.ts`

### Implementation for User Story 2

- [X] T035 [P] [US2] Create `src/settings/roles/dto/create-role.dto.ts` (`name`, `permissions:
      Permission[]` validated against the enum)
- [X] T036 [P] [US2] Create `src/settings/roles/dto/update-role.dto.ts` (partial fields)
- [X] T037 [US2] Implement `src/settings/roles/roles.service.ts`: list (with
      `assignedUserCount` via `010-account-creation-backend`'s exported
      `UsersService.countByRoleId()` — corrected from an original "AuthModule" assumption,
      research.md §3), create, update (reject if `isProtected`), delete (reject if `isProtected`;
      otherwise clear `roleId` on all referencing users via `UsersService.clearRoleAssignment()`) —
      research.md §3, §5, FR-008, FR-009, FR-010
- [X] T038 [US2] Implement `src/settings/roles/roles.controller.ts`:
      `GET/POST/PATCH/DELETE /settings/roles`, guarded with
      `@RequirePermission(Permission.USER_MANAGEMENT)` (depends on T037)
- [X] T039 [US2] Wire audit logging (entityType `ROLE`) into create/update/delete paths of
      `roles.service.ts` — FR-025
- [X] T040 [US2] Register `RolesController`/`RolesService` in `src/settings/settings.module.ts`
- [X] T041 [US2] Cross-feature task: add `UsersService.countByRoleId()` and
      `.clearRoleAssignment()` to `010-account-creation-backend`'s `src/account-creation/users/
      users.service.ts`, exported from `AccountCreationModule` for `SettingsModule` to import and
      call — research.md §3 (this task actually lives in 010's own tasks.md; listed here as a
      dependency marker since 002 was specced first and originally assumed a different owner)

**Checkpoint**: User Stories 1 AND 2 both independently functional.

---

## Phase 5: User Story 3 - Administer existing user accounts (Priority: P2)

**Goal**: A Super Admin or HO User can list, edit (role/status), and delete existing user accounts;
the last active Super Admin account is protected.

**Independent Test**: List users, change one's role/status, confirm immediate enforcement; delete
another; confirm the last Super Admin account can't be deactivated/deleted/reassigned.

### Tests for User Story 3 ⚠️

- [X] T042 [P] [US3] E2e test: list users scoped to caller's company; edit role/status and confirm
      enforcement on next request in `test/settings.e2e-spec.ts`
- [X] T043 [P] [US3] E2e test: delete a user; reject delete/deactivate/reassign of the last active
      Super Admin (409); reject all operations from a non-Super-Admin/non-HO-User caller (403) in
      `test/settings.e2e-spec.ts`
- [X] T044 [P] [US3] Unit test for `UsersAdminService` (last-Super-Admin-standing guard) in
      `src/settings/users-admin/users-admin.service.spec.ts`

### Implementation for User Story 3

- [X] T045 [P] [US3] Create `src/settings/users-admin/dto/update-user.dto.ts` (partial `{ roleId?,
      status? }`)
- [X] T046 [US3] Implement `src/settings/users-admin/users-admin.service.ts`: list (via
      `UsersService.findAllForCompany()` — now includes `pending` accounts, with `inviteExpiresAt`/
      `employeeId`/`displayName` alongside the original name/email/role/status/lastLoginAt fields,
      per `010-account-creation-backend`'s extension of `UserSummary`), update
      (last-Super-Admin-standing check per research.md §5, calls
      `UsersService.updateRoleOrStatus()` — which itself rejects a direct `pending → active`
      transition with `400`, since that only happens via 010's set-password flow), delete (same
      guard, calls `UsersService.deleteAccount()` — also removes any associated `InviteToken` row
      if the deleted account was `pending`) — FR-013, FR-014, FR-015, FR-016
- [X] T047 [US3] Implement `src/settings/users-admin/users-admin.controller.ts`:
      `GET/PATCH/DELETE /settings/users`, guarded with
      `@RequirePermission(Permission.USER_MANAGEMENT)` plus a role check restricting to Super Admin
      or HO User — FR-014 (depends on T046). Account *creation* is intentionally absent from this
      controller — `POST /account-creation/users` (010) is the only creation path.
- [X] T048 [US3] Wire audit logging (entityType `USER_ACCOUNT` — matches
      `010-account-creation-backend`'s entityType so both features' writes to the same account
      appear under one type in the Activity Log) into update/delete paths of
      `users-admin.service.ts` — FR-025
- [X] T049 [US3] Register `UsersAdminController`/`UsersAdminService` in
      `src/settings/settings.module.ts`; import `AccountCreationModule` to access its exported
      `UsersService`
- [X] T050 [US3] Cross-feature task: add `UsersService.findAllForCompany()`,
      `.updateRoleOrStatus()`, `.deleteAccount()`, and `.countActiveSuperAdmins()` to
      `010-account-creation-backend`'s `users.service.ts`, exported from `AccountCreationModule`
      for `SettingsModule` — research.md §3, §5 (this task actually lives in 010's own tasks.md;
      listed here as a dependency marker)

**Checkpoint**: User Stories 1–3 independently functional.

---

## Phase 6: User Story 4 - Maintain Departments and Designations masters (Priority: P2)

**Goal**: Per-company CRUD for Departments and Designations feeding Employee form dropdowns.

**Independent Test**: Add a department/designation under one company, confirm company-scoped
visibility, edit and delete each.

### Tests for User Story 4 ⚠️

- [X] T051 [P] [US4] E2e test: create/list/edit Department and Designation, confirm per-company
      isolation (same name allowed under a different company, 409 on exact duplicate) in
      `test/settings.e2e-spec.ts`
- [X] T052 [P] [US4] E2e test: reject deletion while referenced by an Employee record (409) in
      `test/settings.e2e-spec.ts` (uses a stubbed/mocked Employees-module reference check)
- [X] T053 [P] [US4] Unit test for `ReferenceDataService`'s Department/Designation CRUD paths in
      `src/settings/reference-data/reference-data.service.spec.ts`

### Implementation for User Story 4

- [X] T054 [P] [US4] Create `src/settings/reference-data/dto/department.dto.ts` and
      `src/settings/reference-data/dto/designation.dto.ts` (`name`, create + update variants)
- [X] T055 [US4] Implement the Department/Designation CRUD methods in
      `src/settings/reference-data/reference-data.service.ts` (parameterized per resource;
      composite-unique collision → 409; delete guarded by a reference-check hook that currently
      no-ops until the Employees module exists, per plan.md's cross-module note) — data-model.md,
      research.md §8, FR-018
- [X] T056 [P] [US4] Implement `src/settings/reference-data/departments.controller.ts`:
      `GET/POST/PATCH/DELETE /settings/departments`, guarded with
      `@RequirePermission(Permission.EMPLOYEES)` (depends on T055)
- [X] T057 [P] [US4] Implement `src/settings/reference-data/designations.controller.ts`:
      `GET/POST/PATCH/DELETE /settings/designations`, same guard (depends on T055)
- [X] T058 [US4] Wire audit logging (entityType `DEPARTMENT`/`DESIGNATION`) into
      `reference-data.service.ts`'s Department/Designation paths — FR-025
- [X] T059 [US4] Register `DepartmentsController`/`DesignationsController`/`ReferenceDataService` in
      `src/settings/settings.module.ts`

**Checkpoint**: User Stories 1–4 independently functional.

---

## Phase 7: User Story 5 - Maintain Document Types with mandatory/expiry/number flags (Priority: P3)

**Goal**: Per-company Document Types with derived flags, seeded defaults per new company, and
attendance-gating for missing mandatory documents.

**Independent Test**: Create a document type with Mandatory+Number, confirm derived flag
"MandatoryNumber"; confirm an employee missing a mandatory type can't have attendance marked.

### Tests for User Story 5 ⚠️

- [X] T060 [P] [US5] E2e test: create Document Type, verify every toggle-combination → derived-flag
      mapping (all 6 cases) in `test/settings.e2e-spec.ts`
- [X] T061 [P] [US5] E2e test: new company is seeded with all 16 default document types and correct
      default flags in `test/settings.e2e-spec.ts`
- [X] T062 [P] [US5] Unit test for the derived-flag computation function in
      `src/settings/reference-data/document-types.service.spec.ts`

### Implementation for User Story 5

- [X] T063 [P] [US5] Create `src/settings/reference-data/dto/document-type.dto.ts` (`code`, `name`,
      `isMandatory`, `hasExpiry`, `needsNumber`, `sortOrder`, `isActive`, create + update variants)
- [X] T064 [US5] Implement `src/settings/reference-data/document-types.service.ts`: CRUD (composite
      `(companyId, code)` uniqueness), derived-flag computation on read (research.md §7), a
      `seedDefaultsForCompany(companyId)` method exporting the 16-default-type seed used by
      `CompaniesService.create()` (T027) — FR-019, FR-020
- [X] T064a [US5] Implement `hasMissingMandatoryDocs(companyId, employeeDocumentTypeIds: string[])`
      in `src/settings/reference-data/document-types.service.ts`, exported from
      `SettingsModule` for the future Employees/Attendance module to call before marking attendance
      — data-model.md "Document Type", spec FR-021, SC-006
- [X] T064b [P] [US5] Unit test for `hasMissingMandatoryDocs()`: an employee with all mandatory
      docs on file returns no missing entries; one missing a mandatory doc returns exactly that
      type in `src/settings/reference-data/document-types.service.spec.ts`
- [X] T065 [US5] Implement `src/settings/reference-data/document-types.controller.ts`:
      `GET/POST/PATCH /settings/document-types` (no `DELETE` — `isActive` toggle instead), guarded
      with `@RequirePermission(Permission.EMPLOYEES)` (depends on T064)
- [X] T066 [US5] Wire audit logging (entityType `DOCUMENT_TYPE`) into `document-types.service.ts` —
      FR-025
- [X] T067 [US5] Register `DocumentTypesController`/`DocumentTypesService` in
      `src/settings/settings.module.ts`; wire `CompaniesService.create()` (T027) to call
      `seedDefaultsForCompany()` (T064)

**Checkpoint**: User Stories 1–5 independently functional.

---

## Phase 8: User Story 6 - Maintain Shifts (Priority: P3)

**Goal**: Per-company Shift definitions feeding Employee form dropdowns and overtime calculation.

**Independent Test**: Create a shift under one company, confirm it appears in that company's
dropdown data, confirm deletion is blocked while referenced.

### Tests for User Story 6 ⚠️

- [X] T068 [P] [US6] E2e test: create/list/edit Shift, per-company isolation, delete-while-referenced
      409 in `test/settings.e2e-spec.ts`
- [X] T069 [P] [US6] Unit test for `ReferenceDataService`'s Shift CRUD path in
      `src/settings/reference-data/reference-data.service.spec.ts`

### Implementation for User Story 6

- [X] T070 [P] [US6] Create `src/settings/reference-data/dto/shift.dto.ts` (`name`, `inTime`,
      `outTime`, `graceMinutes`, create + update variants)
- [X] T071 [US6] Implement the Shift CRUD methods in
      `src/settings/reference-data/reference-data.service.ts` (composite `(companyId, name)`
      uniqueness, same reference-check-hook pattern as T055) — FR-022
- [X] T072 [US6] Implement `src/settings/reference-data/shifts.controller.ts`:
      `GET/POST/PATCH/DELETE /settings/shifts`, guarded with
      `@RequirePermission(Permission.EMPLOYEES)` (depends on T071)
- [X] T073 [US6] Wire audit logging (entityType `SHIFT`) into `reference-data.service.ts`'s Shift
      path — FR-025
- [X] T074 [US6] Register `ShiftsController` in `src/settings/settings.module.ts`

**Checkpoint**: User Stories 1–6 independently functional.

---

## Phase 9: User Story 7 - Auto-generate employee codes from a company's code series (Priority: P3)

**Goal**: Concurrency-safe, per-company sequential employee code generation, with an admin-visible
read-only view of current sequence state.

**Independent Test**: Request the next code twice sequentially (increments by 1); fire concurrent
requests (no duplicates/gaps); change a company's short code mid-sequence (prefix updates, sequence
continues).

### Tests for User Story 7 ⚠️

- [X] T075 [P] [US7] Unit test for `EmployeeCodeService.getNextEmployeeCode()`: first code is
      `DC-0001`, sequential increments, short-code-change behavior in
      `src/settings/employee-code/employee-code.service.spec.ts`
- [X] T076 [P] [US7] Concurrency test: 1,000 simulated concurrent calls to
      `getNextEmployeeCode()` for one company produce 1,000 unique, gapless codes (spec SC-007) in
      `src/settings/employee-code/employee-code.service.spec.ts`
- [X] T077 [P] [US7] E2e test: `GET /settings/companies/:id/code-series` returns current state
      without incrementing it in `test/settings.e2e-spec.ts`

### Implementation for User Story 7

- [X] T078 [US7] Add `GET /settings/companies/:id/code-series` to
      `src/settings/companies/companies.controller.ts` (read-only `lastNumber`/next-preview state,
      via a new `EmployeeCodeService.getCurrentState()` read method that does not increment) —
      spec User Story 7 acceptance scenarios (depends on T020, T028)

**Checkpoint**: All seven user stories independently functional.

---

## Phase 10: Polish & Cross-Cutting Concerns

- [X] T079 [P] Run `npm run lint` and `npm run build` across all new/modified files and fix any
      violations
- [X] T080 [P] Add `@nestjs/swagger` decorators (`@ApiTags`, `@ApiOperation`, `@ApiResponse`) to
      every controller under `src/settings/` — Constitution Principle II
- [X] T081 Run the full `quickstart.md` validation scenarios end-to-end against a local environment
      and record results
- [X] T081a [P] E2e test: perform one create/update/delete each across Company, Role, and one
      reference-data resource, then query `AuditLogEntry` directly and assert each row's
      `entityType`, `action`, `entityId`, acting account, `companyId`, and timestamp are correct —
      spec SC-009 — in `test/settings.e2e-spec.ts`
- [X] T082 [P] Review every new/modified `settings`/`shared` table for RLS coverage and confirm the
      Super Admin bypass flag behaves identically to feature 001's pattern — Constitution Principle
      IV, spec SC-003
- [X] T083 Update `.env.example` with any new `SettingsConfig` environment variables introduced in
      T001/T002

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion — BLOCKS all user stories
- **User Stories (Phase 3–9)**: All depend on Foundational phase completion
  - US1 (Companies) and US2 (Roles) are both P1 and mutually independent (US1 only needs the
    `Role`/`Permission` schema+seed+guard from Foundational, not US2's own CRUD endpoints)
  - US3 (Users admin) needs Foundational's seeded roles to exist but not US2's CRUD endpoints
  - US4/US6 (Departments/Designations/Shifts) are independent of each other and of US1–US3 beyond
    a Company existing (US1)
  - US5 (Document Types) is called by US1's `CompaniesService.create()` for default seeding
    (T027 ↔ T064/T067) — implement US5's service before wiring that call, or stub it initially
  - US7 (Employee code) is implemented in Foundational (T020, no independent story-level UI) with
    only its read-only endpoint (T078) deferred to its own phase
- **Polish (Phase 10)**: Depends on all desired user stories being complete

### Parallel Opportunities

- All Setup tasks marked [P] can run in parallel
- Within Foundational, T010–T014 (new schema models) can run in parallel; T004–T008 (shared-schema
  changes) are sequential with each other (same file) but can run in parallel with T010–T014
- Once Foundational completes, US1, US4, US6 can proceed in parallel; US2/US3 can proceed in
  parallel with US1 once T004–T009's seed (T019) is in place; US5 should land before or alongside
  US1's default-seeding wire-up (T067)
- All test tasks within a story marked [P] can run in parallel with each other before that story's
  implementation tasks begin

---

## Parallel Example: User Story 1

```bash
# Launch all tests for User Story 1 together:
Task: "E2e test: create company (success + 409 + 400) in test/settings.e2e-spec.ts"
Task: "E2e test: edit payroll rates + deactivate exclusion in test/settings.e2e-spec.ts"
Task: "Unit test for CompaniesService in src/settings/companies/companies.service.spec.ts"

# Launch both DTOs for User Story 1 together:
Task: "Create src/settings/companies/dto/create-company.dto.ts"
Task: "Create src/settings/companies/dto/update-company.dto.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL — blocks all stories; note T020's employee-code service
   and T019's role seed live here even though their own endpoints/CRUD are later phases)
3. Complete Phase 3: User Story 1 (Companies)
4. **STOP and VALIDATE**: Run quickstart.md Scenario 1 independently
5. Deploy/demo if ready — a working multi-company backbone, even before Roles/Users/reference-data
   endpoints exist

### Incremental Delivery

1. Setup + Foundational → foundation ready (schema, seed, guard, audit log, employee-code service)
2. US1 (Companies) → test independently → MVP
3. US2 (Roles) + US3 (Users admin) → test independently → full RBAC administration
4. US4 (Departments/Designations) → US5 (Document Types) → US6 (Shifts) → each tested independently
   → complete Employee Setup
5. US7 (Employee code read endpoint) → test independently → feature complete


---

## Implementation notes (2026-08-29)

All 87 tasks are complete. Nine of them did not play out exactly as written; each divergence below
was confirmed with the user before it was acted on, rather than decided unilaterally.

### Already satisfied by feature 001 before this feature began

`T004`, `T005`, `T006`, `T007` and the first half of `T009` were written on the assumption that
nothing settings-related existed yet (research.md §1). By the time 002 was implemented, feature 001
had already created the `settings` schema, the `Permission` enum, the `Role` model and their
migration (commit `952ab02`) — its own access control could not work without a real permission
model. These tasks were verified as satisfied rather than re-executed.

Two of them are satisfied *differently* from what the task text specifies:

- **T005** specifies 22 permission values; the enum has **23**. Feature 001 added
  `CROSS_COMPANY_ACCESS` to replace its former hardcoded `role === SUPER_ADMIN` check. It is kept,
  and is deliberately **not** assignable through role CRUD (`ASSIGNABLE_PERMISSIONS` in
  `create-role.dto.ts`) — only the seeded, protected Super Admin role carries it.
- **T007** specifies a scalar `User.roleId` FK, i.e. one role per account. The shipped model is
  many-to-many via `settings.UserRole`, per a 2026-08-28 clarification that an account can hold
  several roles at once, its effective permissions being the union across them. Implementing T007
  literally would have deleted working multi-role support, so the many-to-many model won and
  everything downstream (the guard, seeding, US2/US3 endpoints) was built against it. The backfill
  T007 would have needed already exists inside 001's own migration.

### Cross-feature tasks re-homed

`T041` and `T050` assign six `UsersService` methods to `010-account-creation-backend`, which is not
built (there is no `src/account-creation/`). They were added instead to the `UsersModule` feature
001 already ships (`src/users/users.service.ts`), which owns `shared.User` — so Principle I is
satisfied and `SettingsModule` still reaches user data only through an exported service. When 010
lands it can take ownership of these methods without changing a caller.

Consequences elsewhere: `UserSummary` returns `roles: {id,name}[]` rather than the contract's
singular `role`, and omits `inviteExpiresAt`/`employeeId` — those, and the `pending` status whose
rejection `T046` describes, are all 010 concepts that do not exist yet.

### Under-specified data filled in explicitly

- **T019** seeds nine roles, but the PRD documents permission sets for only six. Site Admin, HO
  User and Site User were derived from their master-PRD descriptions and approved before seeding;
  the reasoning is recorded in `prisma/seeds/settings.seed.ts`.
- **T064** seeds **17** default document types, not the 16 data-model.md's prose mentions — the
  PRD's enumerated table lists 17, keeping the 10th and 12th marksheets separate.

### Verified but not exercisable

- **T064a** (`hasMissingMandatoryDocs`) is implemented, exported and unit-tested, but has no caller
  until the Employees/Attendance module exists.
- **T055`/`T071`'s deletion guard** calls a reference-check hook that returns `false` until that
  same module lands; e2e covers the guard's wiring with the hook stubbed.
- **T009**'s audit-log half needed a hand-authored migration
  (`20260829120000_audit_log_generalization`): the two new NOT NULL columns could not be added to a
  table already holding 38 login rows, so it adds them nullable, backfills from `eventType`, then
  constrains — the same shape 001's own migration used for its `UserRole` backfill.
- **T082** found the policies correct but **inert locally**: the app connects as a Postgres
  superuser, which bypasses RLS unconditionally. Verified working under a non-superuser role. See
  `quickstart-results.md` §8.

---

## Phase 11: Convergence

Appended by `/speckit-converge` on 2026-08-29, after the Phase 1–10 implementation pass. Each item
traces to the requirement it closes. The two blocked items surfaced by that run (FR-021's
attendance gating and FR-018/FR-022's employee reference check) are deliberately **not** listed —
neither is buildable until the Employees module exists, and both are already recorded under
"Verified but not exercisable" above.

- [X] T084 **CRITICAL** Filter every reference-data and document-type read/write by the caller's
      resolved company instead of relying on RLS alone, in
      `src/settings/reference-data/reference-data.service.ts` (`findAll`, `update`, `remove`) and
      `src/settings/reference-data/document-types.service.ts` (`findAll`, `update`) — mirror the
      explicit `where: ctx.isSuperAdmin ? {} : { companyId }` guard
      `UsersService.findAllForCompany()` already applies, and reject a by-id operation whose row
      belongs to another company. Today these paths pass no `companyId` at all, so a
      company-scoped caller reads and edits every company's rows wherever RLS is not enforced —
      per Constitution IV, FR-027, SC-003 (missing)
- [X] T085 Set `shared.User.lastLoginAt` on every successful authentication in
      `src/auth/auth.service.ts`'s `login()` success path (alongside the existing
      `consecutiveFailures: 0` reset), so the column added by T021a is actually populated and
      `UserSummary.lastLoginAt` stops being permanently null — per FR-017, FR-013 (missing)
- [X] T086 Provision and document a non-superuser, non-`BYPASSRLS` Postgres role for the
      application connection, and update `.env.example` plus the deployment checklist to require
      it. The app currently connects as `prisma` (`rolsuper = true`), and Postgres superusers
      bypass row-level security unconditionally — so every RLS policy in features 001 and 002 is
      correct but inert as deployed (verified working under a non-superuser role; see
      `quickstart-results.md` §8) — per Constitution IV, SC-003 (missing)
- [X] T087 Add an e2e case in `test/settings.e2e-spec.ts` covering read isolation for a caller
      **without** `CROSS_COMPANY_ACCESS`: seed reference data under two companies, authenticate as
      an account scoped to one, and assert the other company's rows are absent from
      `GET /settings/departments` and `GET /settings/document-types`. Both existing e2e callers
      hold cross-company access, so the isolation path is never exercised today — per SC-003,
      US4/AC3 (partial)

### Convergence pass outcome (2026-08-29)

All four appended tasks are complete. Two things are worth carrying forward:

- **T084 was a live isolation hole, not a hypothetical one.** The reference-data and document-type
  read/write paths passed no `companyId` predicate at all, leaning entirely on RLS — which was
  itself inert (T086). Either defence alone would have been enough; neither was actually in force.
  `src/settings/company-scope.ts` now supplies the application-layer half, and T087's e2e case
  covers it with a genuinely company-scoped caller.
- **T086 surfaced a feature-001 login defect.** Running the suite as the new non-superuser role
  turned up `auth.service.ts`'s post-login bookkeeping write executing under the *caller's own*
  company scope. For any account with no `companyId` and no `CROSS_COMPANY_ACCESS`, the policy
  matched no row and login failed with a 500 — invisible under a superuser connection. That write
  now runs in the system context `rls-context.ts` already documents for credential-verified
  login-path lookups. The e2e suite passes under both the superuser and the application role.

### Follow-up (2026-08-29): T086 hardened

Documenting the non-superuser role requirement left it possible to ignore, so the check is now
enforced in code: `src/common/prisma/rls-preflight.ts` runs at startup and, under
`NODE_ENV=production`, refuses to boot when the connected role is a superuser or holds
`BYPASSRLS` — the two conditions under which every RLS policy in this repo is silently inert.
Outside production it warns and continues; an inconclusive check warns rather than blocking a
deploy. Verified both ways against the real database: production + superuser refuses to start,
production + `buildcore_app` logs "Row-level security is enforced" and proceeds.

---

## Amendment 2026-09-01 — Company Documents Repository

Covers spec FR-028 to FR-038 and plan Phases A1–A3. Task IDs prefixed `TA` to avoid collision.

- [ ] TA001 Add `CompanyDocumentType` and `CompanyDocument` models to `prisma/schema.prisma`;
      migration + RLS on both
- [ ] TA002 [P] Extend `shared.AuditLogEntry.entityType` with `COMPANY_DOCUMENT` (spec FR-037)
- [ ] TA003 Seed the default statutory company document types on company creation — reuse the
      FR-020 seeding hook, not a second mechanism (spec FR-029)
- [ ] TA004 [US8] `CompanyDocumentTypesService` + controller in
      `src/settings/company-documents/`: Super-Admin CRUD, `requiresExpiry` without `alertDays`
      → 400, delete guard → 409, list returning `documentCount`
- [ ] TA005 [US9] `CompanyDocumentsService`: upload enforcing each type's required fields → 400
      (spec FR-030); `expiryDate` < `issueDate` → 400
- [ ] TA006 [US9] Versioning — a new upload of a type becomes the next version and demotes the
      prior, **scoped per `documentNumber` when one is present** so multiple concurrent
      registrations of one type coexist (spec FR-031)
- [ ] TA007 [US9] Store files as encrypted object-storage references; refuse production start on
      local-filesystem blobs (spec FR-032)
- [ ] TA008 [US9] Compute status on read as valid / expiring_soon / expired so an `alertDays`
      change takes effect immediately with no backfill (spec FR-033)
- [ ] TA009 [US9] Register the `company_document_expiry` reminder rule with feature 004's
      centralized engine (spec FR-034; ratified 2026-09-01) — **no evaluation or de-duplication
      logic here**
- [ ] TA010 [US9] `CompanyDocumentsController`: `COMPANY_SETTINGS` guard, company scoping except
      for `CROSS_COMPANY_ACCESS` holders (spec FR-036), download streaming with the access
      audit-logged
- [ ] TA011 [US9] Soft-delete promoting the prior version to current (spec FR-038); assert expiry
      blocks no business operation (spec FR-035)
- [ ] TA012 [P] Unit test: versioning per document number; status across alert-window changes
- [ ] TA013 [P] E2e test: renewal creates v2 current with v1 still downloadable; cross-company read
      → 403

**Blocked by**: TA009 depends on 004's reminders engine (TA-004 series below).
