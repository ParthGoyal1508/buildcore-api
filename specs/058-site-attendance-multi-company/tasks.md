# Tasks: Refusals for Super Admin, site-tagged staff attendance, multi-company access

**Input**: Design documents from `specs/058-site-attendance-multi-company/` (spec, plan, research,
data-model, contracts/api-changes.md, quickstart).

**Repos**:
- `API/` = `/Users/parthgoyal/Projects/buildcore-api-058`
- `WEB/` = `/Users/parthgoyal/Projects/buildcore-web-058`
- Both are on branch `058-site-attendance-multi-company`.

**Tests**: included. The constitution requires unit tests for new guards and services, and e2e tests
for auth-touching endpoints. The web has no unit runner, so web tasks end in a lint, typecheck and
visual check.

**Out of bounds**: never point the API at prod. Dev (Neon) is shared with the user, so run e2e tests
against the local scratch or e2e databases only.

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Setup

- [X] T001 Install dependencies in both worktrees (`npm ci` in API/ and WEB/). Copy `.env` (API) and `.env.local` (WEB) from the main checkouts if missing. Point API/.env `DATABASE_URL`/`MIGRATE_DATABASE_URL` at the local `buildcore_scratch` database for development and confirm `npm run lint && npm test` pass on the untouched branch, so there is a baseline for API/

---

## Phase 2: Foundational (blocking)

- [X] T002 Add the 058 schema changes to API/prisma/schema.prisma:
  - new model `EmployeeLocationAssignmentTarget` (`@@schema("hr")`; fields per data-model.md)
  - relation `targets` on `EmployeeLocationAssignment`; remove `siteId` from it
  - `siteId String?` + `@@index([siteId, punchDate])` on `PunchRecord`
  - `siteId String?` on `PunchRefusal`
  - `allCompanies Boolean @default(false)` on `Role`
- [X] T003 Create migration API/prisma/migrations/20261106120000_058_site_attendance_multi_company/migration.sql, in this order:
  1. Create the target table with the `(siteId IS NULL) <> (projectId IS NULL)` check, a unique `(assignmentId, siteId, projectId)` and the indexes; enable RLS with the `tenant_isolation` policy (copy the shape from the `EmployeeLocationAssignment` policy migration) and grant to `buildcore_app` as other hr tables do.
  2. Insert one target per existing assignment with a non-null `siteId`.
  3. Add `PunchRecord.siteId` + index and `PunchRefusal.siteId`.
  4. Backfill `PunchRecord.siteId` per research R5, only where `geofenceResult = 'in_range' AND source = 'employee' AND "siteId" IS NULL`, using the in-force assignment's old `siteId` (not mobile), else `hr.Employee.siteId`.
  5. Drop the `EmployeeLocationAssignment_site_or_mobile` check and the `siteId` column.
  6. Add `Role.allCompanies`.

  Then run `npx prisma migrate dev` against scratch and `npx prisma generate`.
- [X] T004 [P] Add 058 constants to API/src/hr/location-assignments/location-assignments.constants.ts (create): `ASSIGNMENT_EMPTY`, `ASSIGNMENT_MOBILE_WITH_TARGETS`, `PROJECT_HAS_NO_ACTIVE_SITE`, `SITE_NOT_ASSIGNED`. Add `ALL_COMPANIES_SUPER_ADMIN_ONLY` to API/src/settings/roles/roles.constants.ts (create if absent)

**Checkpoint**: the schema and client compile (`npm run build`), and existing tests still pass apart from those that reference `EmployeeLocationAssignment.siteId`. Those are fixed in US2.

---

## Phase 3: User Story 1 - Only Super Admin sees attendance refusals (P1) 🎯 MVP

**Goal**: staff and labour refusal logs and photos are visible only to Super Admin. Employees keep
their own refusal reason.

**Independent test**: an HR user with ATTENDANCE write, or a labour approver, gets 403 and sees no
tab or list. Super Admin sees both. `/my/punch/refusals` is unchanged.

- [X] T005 [US1] Let `GroupAccessGuard` take a neutral message: add an optional `SetMetadata` key (e.g. `@SuperAdminOnlyMessage('Only a Super Admin can see refused punches.')`) read via `Reflector`, falling back to today's group-view message, in API/src/dashboard/group-access.guard.ts. Unit test both messages in API/src/dashboard/group-access.guard.spec.ts
- [X] T006 [US1] Add `@UseGuards(GroupAccessGuard)` plus the message to `GET refusals` and `GET refusals/:id/photo` in API/src/hr/attendance/attendance-admin.controller.ts, and update their Swagger descriptions (audience = Super Admin; 403 otherwise)
- [X] T007 [US1] Do the same for `GET refusals` and `GET refusals/:id/photo` in API/src/labour/attendance/labour-punch.controller.ts. Leave the punch POST and its 422 refusals untouched
- [X] T008 [P] [US1] e2e API/test/refusal-visibility.e2e-spec.ts covering each refusal route:
  - Super Admin → 200
  - HR with ATTENDANCE write → 403
  - labour approver → 403
  - employee `GET /my/punch/refusals` → 200 with their own rows
- [X] T009 [P] [US1] In WEB/app/ui/hr/attendance-workspace.tsx, change the Refusals tab filter from `hasWrite(user, 'ATTENDANCE')` to holding `CROSS_COMPANY_ACCESS` (use the same permission helper as `app-settings`)
- [X] T010 [P] [US1] In WEB/app/labour/attendance/page.tsx and WEB/app/dashboard/labour/muster-attendance/page.tsx, enable the `getLabourRefusals` query and render the refused list or count only when the user holds `CROSS_COMPANY_ACCESS`. Keep the in-the-moment refusal message after a failed punch
- [X] T011 [US1] Run lint and typecheck in WEB/ and API/. Visual check: as HR there is no Refusals tab; as a labour approver there is no refused list; as Super Admin both appear. Save screenshots to the scratchpad

**Checkpoint**: US1 is shippable on its own.

---

## Phase 4: User Story 2 - Staff punch at any assigned site, tagged to that site (P1)

**Goal**: an assignment covers several sites and/or projects, a punch is matched to the nearest
in-range covered site, and the site is recorded and shown.

**Independent test**: see quickstart.md, US2 manual scenario. Single-site and mobile employees
behave as before.

### Tests first

- [X] T012 [P] [US2] Unit tests for the matcher in API/src/hr/punch/site-match.spec.ts:
  - in A
  - in B
  - in the overlap (nearest centre wins)
  - outside all (nearest recorded with distance)
  - unlocatable accuracy
  - mobile (no site)
  - no assignment (employee site)
  - every candidate inactive (the existing "no longer in service" 400)
- [X] T013 [P] [US2] Unit tests for assignment validation in API/src/hr/location-assignments/location-assignments.service.spec.ts:
  - empty → `ASSIGNMENT_EMPTY`
  - mobile with targets → `ASSIGNMENT_MOBILE_WITH_TARGETS`
  - other-company site or project → 404
  - project with no active site → saved with a warning
  - legacy `siteId` body → one site target

### Implementation (API)

- [X] T014 [US2] Add `geofencesFor(ctx, { siteIds, projectIds }): Promise<SiteGeofence[]>` in API/src/projects/sites/sites.service.ts. It returns **active** sites only, de-duplicated by id, each with `{ id, name, latitude, longitude, geofenceRadiusMeters }`. Projects resolve to all their active sites. Add a `namesFor(ctx, siteIds)` helper for display. Unit-test both in API/src/projects/sites/sites.service.spec.ts
- [X] T015 [US2] Rework API/src/hr/location-assignments/location-assignments.service.ts:
  - `inForceOn` returns `{ isMobile, targets: { siteId, projectId }[] }`
  - `assign` validates per data-model.md through a new `SitesService.assertTargetsInCompany(ctx, companyId, { siteIds, projectIds })` in API/src/projects/sites/sites.service.ts. It is the projects module's own read of `projects.Site`/`projects.Project`, which keeps Constitution I (hr never queries projects tables). It returns the projects with no active site for the warning. `assign` creates targets in the same transaction, writes an `AuditLogService` entry (employee, targets, effectiveFrom, assignedBy) per FR-014, and returns `warnings`
  - `historyFor` includes targets with names
- [X] T016 [US2] Update API/src/hr/location-assignments/dto/location-assignment.dto.ts: `siteIds?: string[]`, `projectIds?: string[]`, the deprecated `siteId?: string` mapped to `siteIds`, `isMobile?`, `effectiveFrom`, `reason?`. Update API/src/hr/location-assignments/location-assignments.controller.ts Swagger and response shape per contracts/api-changes.md
- [X] T017 [US2] Extract the candidate-and-nearest logic into API/src/hr/punch/site-match.ts (pure function over `checkGeofence` results, with the accuracy and unlocatable handling unchanged). Wire it into API/src/hr/punch/punch.service.ts, replacing the single `getGeofence(assignment?.siteId ?? employee.siteId)`:
  - candidates come from `geofencesFor` (assignment targets) or `[employee.siteId]`
  - `PunchRecord.siteId` = matched site (null when mobile)
  - `PunchRefusal.siteId` = nearest candidate
  - the punch response gains `site`

  Make T012 pass.
- [X] T018 [US2] Update API/src/hr/punch/punch-refusals.service.ts so HR refusal rows return `site: { id, name } | null`
- [X] T019 [US2] Daily register in API/src/hr/attendance/attendance-admin.service.ts `daily()`:
  - add `punchInSite` and `punchOutSite` to `DailyAttendanceRow`
  - add an optional `siteId` filter (rows with a punch in or out at that site)
  - add the query param to the controller DTO in API/src/hr/attendance/attendance-admin.controller.ts
  - names come from `SitesService.namesFor`
- [X] T020 [US2] Add `punchInSite` and `punchOutSite` to each day in `employeeMonth()` (API/src/hr/attendance/attendance-admin.service.ts) and in API/src/hr/punch/attendance-history.service.ts (own history)
- [X] T021 [US2] Add optional `siteId` to API/src/hr/attendance/dto/mark-attendance.dto.ts. In `mark()`, `submitCorrection()` and `upsertSide()` (API/src/hr/attendance/attendance-admin.service.ts):
  - validate the site against the employee's covered sites on that day, or any active company site when the employee is mobile, else 400 `SITE_NOT_ASSIGNED`
  - when the site is omitted and exactly one site is covered, use it
  - store it on the created `PunchRecord`
- [X] T022 [US2] Fix every remaining compile or test break from the dropped `EmployeeLocationAssignment.siteId`. Grep API/src and API/test for `siteId` on assignments (the bulk paths, the attendance-exception reconciler, fixtures) and adapt them to `targets`
- [X] T023 [P] [US2] Migration check (done 2026-11-06 as a one-off run on a pre-058 copy of the local DB, `buildcore_058_mig`, not a committed jest test. All 6 punch cases and the assignment→target move came out as designed; the copy was dropped after): an e2e or SQL fixture test in API/test/site-attendance.e2e-spec.ts asserting:
  - the backfill fills in-range employee punches with the assignment's site, or else the employee's site
  - mobile, admin and out-of-range punches stay null
  - old single-site assignments became one target
- [X] T024 [P] [US2] e2e in API/test/site-attendance.e2e-spec.ts:
  - assign project P (sites A and B), punch at A and then at B, and assert the sites on the register
  - the register `siteId` filter
  - a mark with a site outside the coverage → 400
  - monthly sheet and payroll output unchanged for the employee

### Implementation (WEB)

- [X] T025 [US2] In WEB/app/lib/api/hr-payroll.ts (or wherever assignments are typed), update the types and calls: assignment `targets`, `siteIds`/`projectIds`, `warnings`; `DailyAttendanceRow.punchInSite`/`punchOutSite`; the register `siteId` param; mark `siteId`
- [X] T026 [US2] WEB/app/ui/hr/location-assignment.tsx and WEB/app/ui/hr/bulk-location-assignment.tsx:
  - replace the single site select with a multi-select of sites and projects (projects labelled "all sites of …"), keeping the Mobile option exclusive
  - show history rows as a target list
  - surface the `PROJECT_HAS_NO_ACTIVE_SITE` warning
- [X] T027 [US2] WEB/app/ui/hr/attendance-table.tsx (note: the daily register has no Excel download. The only one on that screen is the monthly sheet, which stays home-site per the clarification, so no export column was added): add In site / Out site columns, a site filter (sites of the company), and the two columns in the Excel download. Add an optional site select, limited to the employee's covered sites, to the manual mark and correction form
- [X] T028 [P] [US2] Show the site per day in WEB/app/ui/my/attendance-history.tsx, and in the employee month view used by HR (find the component that renders `GET /hr/attendance/employee/:id`)
- [X] T029 [US2] Run lint and typecheck in both repos and `npm test` in API/. Visual check against the local API with seeded sites:
  - open the assignment dialog with two sites plus a project
  - the register with the site filter open
  - the mark form site select

  Save screenshots to the scratchpad

**Checkpoint**: US2 is shippable. Single-site employees are unchanged apart from the recorded site.

---

## Phase 5: User Story 3 - Work in both companies without Super Admin powers (P2)

**Goal**: a role flag lets holders switch between companies, scoped to one at a time, with only
their role's modules.

**Independent test**: see quickstart.md, US3 manual scenario.

### Tests first

- [X] T030 [P] [US3] Unit tests in API/src/auth/jwt.strategy.spec.ts:
  - a multiCompany user's `companyId` becomes the selection (and is the home company when there is none or it is inactive), with `homeCompanyId` kept and `selectedCompanyId` null
  - a Super Admin is unchanged
  - a single-company user is unchanged
- [X] T031 [P] [US3] Unit test API/src/common/own-records/own-records.coverage.spec.ts: enumerate every controller whose `@Controller` path starts with `my` (read the `path` metadata from the module classes, or glob `src/**/*.controller.ts`) and assert `@OwnRecords()` is on it, except the allow-list `my/cash-policy` and `my/company-selection`

### Implementation (API)

- [X] T032 [US3] In API/src/auth/authenticated-user.ts, add `homeCompanyId: string | null` and `multiCompany: boolean`. Compute `multiCompany` in `loadUserWithPermissions` (API/src/auth/auth.service.ts): any held role has `allCompanies` and the permissions lack `CROSS_COMPANY_ACCESS`. Include `allCompanies` in the role select
- [X] T033 [US3] In API/src/settings/company-selection/company-selection.service.ts, `selectableFor`, `select` and `resolve` treat `multiCompany` like cross-company for listing and storing: active companies only, and an inactive or unknown stored selection resolves to null
- [X] T034 [US3] In API/src/auth/jwt.strategy.ts, for `multiCompany` users set `homeCompanyId = companyId` and `companyId = (await resolve) ?? homeCompanyId`, and leave `selectedCompanyId = null`. Super Admin and other users keep today's path, with `homeCompanyId = companyId`. If the home company is inactive and there is no valid selection, use the first active company by name (spec edge case), and add that case to T030. Make T030 pass
- [X] T035 [US3] Create API/src/common/own-records/own-records.decorator.ts (class decorator setting metadata) and API/src/common/own-records/own-records.interceptor.ts. The interceptor is registered globally in API/src/app.module.ts and acts only when the metadata is present and `user.multiCompany`, setting `user.companyId = user.homeCompanyId`. Apply `@OwnRecords()` to:
  - src/hr/punch/punch.controller.ts
  - src/hr/leave/leave.controller.ts (the `my/leave` controller)
  - src/hr/reimbursements/reimbursement.controller.ts (`my/reimbursements`)
  - src/hr/holidays/my-holidays.controller.ts (both classes)
  - src/hr/employees/my-profile.controller.ts
  - src/hr/biometrics/face-enrolment.controller.ts (`my/face-enrol`)
  - src/payroll/my-payroll.controller.ts
  - src/payroll/salary/salary.controller.ts (`my/salary`)
  - src/recruitment/resignations/my-resignation.controller.ts

  Make T031 pass.
- [X] T036 [US3] Own-account services use the home company: replace `caller.companyId` with `caller.homeCompanyId ?? caller.companyId` in API/src/users/change-password.service.ts and API/src/users/users.service.ts (own-row reads). In API/src/users/user-summary.ts, return home `companyId` plus `workingCompanyId` and `multiCompany`. Audit `grep -n "companyId" src/auth src/users src/account-creation` for other own-row reads and record the result in the PR description
- [X] T037 [US3] Roles in API/src/settings/roles/roles.service.ts and its DTOs under API/src/settings/roles/dto/:
  - accept `allCompanies?: boolean` on create and update
  - setting or changing it without `CROSS_COMPANY_ACCESS` → 403 `ALL_COMPANIES_SUPER_ADMIN_ONLY`
  - include `allCompanies` in list and detail responses
  - audit the change through the existing role audit entry
- [X] T038 [US3] Assigning or removing a role with `allCompanies` without `CROSS_COMPANY_ACCESS` → 403 `ALL_COMPANIES_SUPER_ADMIN_ONLY`. Applies in API/src/users/users.service.ts (role updates) and API/src/account-creation/users/users.service.ts (+ dto/create-user.dto.ts). Put it next to the existing `assertMayGrant` calls. Confirm that the existing user-role change audit entry records the role. If it doesn't, add an audit entry (FR-017a)
- [X] T039 [P] [US3] e2e API/test/multi-company-access.e2e-spec.ts:
  - Super Admin flags a role and assigns it to a PRPL user
  - the user lists both companies, selects TE, and their list and create land in TE
  - group dashboard, App Settings / cash-visibility, `PATCH /settings/companies/<PRPL id>` while TE is selected, `reminders?scope=all` and the refusal routes → 403
  - DWR self-approval → refused
  - `GET /my/punch/open` and `GET /my/salary/...` resolve the PRPL employee while TE is selected
  - a non-Super-Admin user admin assigning the role → 403
  - unflagging → the next request works in PRPL only
- [X] T040 [P] [US3] Super Admin regression e2e: extend API/test/company-selection-rls.e2e-spec.ts to assert Super Admin selection and bypass behaviour is byte-for-byte unchanged

### Implementation (WEB)

- [X] T041 [US3] Add `allCompanies` to the role types and calls in WEB/app/lib/api/settings.ts, and `workingCompanyId`/`multiCompany` to the user summary type in WEB/app/lib/api/users.ts
- [X] T042 [US3] WEB/app/ui/settings/role-modal.tsx and WEB/app/ui/settings/role-list.tsx:
  - a "Works in all companies" checkbox, shown and editable only with `CROSS_COMPANY_ACCESS`, with a one-line hint that it does not give Super Admin powers
  - an "All companies" badge in the list
- [X] T043 [US3] WEB/app/ui/settings/user-list.tsx and WEB/app/ui/account-creation/create-user-form.tsx: disable roles carrying `allCompanies` for non-Super-Admin admins, with a tooltip, and handle the 403 message
- [X] T044 [US3] Verify the company switcher (WEB/app/ui/company-switcher.tsx) appears for a multi-company user and that switching refreshes data. Check WEB code that reads the user summary's `companyId` as "current company" (`grep -rn "companyId" app/lib app/ui | grep -i "user\|me"`) and switch those reads to `workingCompanyId` where they mean the working company
- [X] T045 [US3] Run lint and typecheck in both repos and `npm test` plus `npm run test:e2e` in API/. Visual check as a multi-company user:
  - the switcher is open
  - Inventory in TE
  - group dashboard and App Settings links absent
  - My Workspace punch is still on the home record
  - the role modal checkbox as Super Admin

  Save screenshots

**Checkpoint**: US3 is shippable. The client roles can be set up after release (data step, not code).

---

## Phase 5b: User Story 4 - Site supervisors only register labour and mark attendance (P1, added 2026-11-07)

- [X] T049 [US4] Add `LABOUR_ATTENDANCE` to the `Permission` enum in API/prisma/schema.prisma. Migration API/prisma/migrations/20261107100000_058_labour_attendance_permission (`ALTER TYPE ... ADD VALUE`, alone in its own file) and API/prisma/migrations/20261107100100_058_labour_supervisor_role (data: the role named "Labour Supervisor" swaps DAILY_WORKER_REGISTRY for LABOUR_ATTENDANCE in `Role.permissions` and `RolePermission`, same levels; no other role)
- [X] T050 [US4] Admit `LABOUR_ATTENDANCE` (any-of with DAILY_WORKER_REGISTRY) on: `labour/attendance` today and punch (API/src/labour/attendance/labour-punch.controller.ts), `labour/my-sites` (API/src/labour/supervisor-sites/supervisor-site.controller.ts), `labour/workers` list, contractor-options, detail, register, face-enrolment (API/src/labour/workers/labour-worker.controller.ts, with method-level DAILY_WORKER_REGISTRY on edit, transfer and deactivate), and `labour/muster-attendance/site-photos` POST (API/src/labour/attendance/muster-attendance.controller.ts)
- [X] T051 [US4] Supervisor allocation lists holders of either permission: API/src/labour/supervisor-sites/supervisor-site.service.ts (`listAssignments`, `setAssignments`)
- [X] T052 [P] [US4] e2e API/test/labour-supervisor-scope.e2e-spec.ts: a LABOUR_ATTENDANCE-only supervisor can list my-sites, register, list workers, see today, and upload a site photo; is refused (403) on payment sheets, advances, musters, muster attendance daily, site rates, wage rates, supervisor-sites, worker edit, transfer and deactivate; appears in the supervisor allocation list
- [X] T053 [US4] Web: permission label "Labour registration & attendance" and "Labour management" for DAILY_WORKER_REGISTRY (WEB/app/lib/constants.ts); the Labour nav module opens with either (NAV_MODULES); WEB/app/ui/labour/labour-nav.tsx shows only Attendance and Labour without DAILY_WORKER_REGISTRY; WEB/app/dashboard/labour/layout.tsx refuses the other sections; WEB/app/labour/layout.tsx and WEB/app/ui/permissions/device-permissions.tsx accept either; the worker list hides Edit, Transfer, Deactivate and NOC without DAILY_WORKER_REGISTRY (WEB/app/dashboard/labour/workers/page.tsx)
- [X] T054 [US4] Lint, typecheck, unit, e2e; visual check as a supervisor (tabs, worker list actions) and as an Operations Manager

## Phase 5c: User Story 5 - Module-specific roles (P3, added 2026-11-07)

- [X] T055 [US5] API/prisma/seed-module-roles.ts (+ `npm run roles:modules`): idempotent creation of "<Module> — View" / "<Module> — Edit" roles per levelled permission and one role per level-agnostic permission, shared by every company; refuses the production host unless `--yes-production` is given; prints what it created and what already existed
- [X] T056 [US5] Run it on the local DB and check in Settings → Roles (done 2026-11-07: 66 roles created, a second run created none). Dev and prod only on the user's go-ahead (not yet)

## Phase 6: Polish & cross-cutting

- [X] T046 [P] Update the Swagger and docs touched above, and add a short note to API/specs/058-site-attendance-multi-company/quickstart.md for any changed command
- [X] T047 Run the full quickstart.md manual scenarios end to end in both worktrees, and check with `git status` that only intended files changed in API/ and WEB/
- [X] T048 Write the PR descriptions (API and WEB, base `develop`): the summary per story, the migration and backfill note (prod needs `migrate deploy`, which runs automatically on Render start), the `caller.companyId` audit result from T036, and the client role-setup step after release. Don't merge or push without the user's go-ahead

---

## Dependencies & execution order

- **Setup (T001)** → **Foundational (T002–T004)** → stories.
- **US1 (T005–T011)** depends only on Phase 1. It doesn't need the migration and can ship first.
- **US2 (T012–T029)** depends on T002–T004.
  - Inside it: T014 → T015/T016 → T017 → T018–T021 → T022 → tests T023/T024.
  - Web tasks T025 → T026–T028 → T029.
- **US3 (T030–T045)** depends on T002–T004 (`Role.allCompanies`).
  - Inside it: T032 → T033 → T034 → T035/T036 → T037/T038 → e2e T039/T040.
  - Web tasks T041 → T042–T044 → T045.
  - US3 is independent of US2. It relies on US1 only in that the T039 refusal assertions expect US1's guard.
- **Polish (T046–T048)** comes after the chosen stories.

## Parallel opportunities

- **US1**: T008, T009 and T010 together (different repos and files) after T005–T007 are started.
- **US2**:
  - T012 and T013 (tests) together.
  - T023 and T024 together after T022.
  - T028 alongside T026/T027 after T025.
- **US3**:
  - T030 and T031 together.
  - T039 and T040 together.
  - Web T041 can start once the T037 response shape is fixed.
- **US2 and US3** can run in parallel after Phase 2, because their files don't overlap. The one
  exception is API/src/users/users.service.ts, which only US3 touches.

## Implementation strategy

1. **MVP = US1**: small and independently reviewable, and it delivers the client's privacy request.
2. Then **US2**: migration, matcher and views, with a review point after it.
3. Then **US3**: auth plumbing, then ceilings, then web, with a review point after it.
4. Commit per story on `058-site-attendance-multi-company` in each repo. Don't push or open PRs
   until the user asks.
