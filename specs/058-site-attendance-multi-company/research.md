# Research: 058 — refusals for Super Admin, site-tagged staff attendance, multi-company access

All findings were read from `develop` at 29e88de (api) and 8adfc40 (web) on 2026-11-06.

## R1. Gating the refusal logs on Super Admin

- **Decision**: put the existing `GroupAccessGuard` (`src/dashboard/group-access.guard.ts`) on the
  four refusal routes through `@UseGuards`:
  - `GET /hr/attendance/refusals`
  - `GET /hr/attendance/refusals/:id/photo`
  - `GET /labour/attendance/refusals`
  - `GET /labour/attendance/refusals/:id/photo`

  The routes keep their current permission and level decorators. In the web app, the attendance
  workspace's Refusals tab and the labour attendance refused-punch list show and fetch only when the
  user holds `CROSS_COMPANY_ACCESS`.
- **Rationale**: `GroupAccessGuard` is already the "Super Admin only, on top of the route's
  permission" guard (it is all-of, unlike `@RequirePermissions`). Constitution V asks for a guard,
  not an in-handler `if`. Keeping the existing decorators means a Super Admin still passes exactly as
  today.
- **Alternatives considered**:
  - A new `SuperAdminGuard`: it would duplicate `GroupAccessGuard`. Its 403 message names the group
    view, so it gets a neutral message parameter instead.
  - An in-handler check like `cash-visibility.controller.ts`: rejected by Constitution V.
- **Unchanged**: `GET /my/punch/refusals` and the 422 punch responses, for both staff and labour
  (FR-004).

## R2. Shape of a multi-site assignment

- **Decision**: add a child table `hr.EmployeeLocationAssignmentTarget`. Each row is one target and
  holds exactly one of `siteId` or `projectId` (a check constraint enforces this). The ids are bare,
  with no cross-schema foreign key, the same pattern as `Site.companyId` and `Employee.siteId`.

  Existing `EmployeeLocationAssignment.siteId` values move into target rows, and the column is
  dropped along with the `site_or_mobile` check. "Mobile, or at least one target" is enforced in the
  service, because a check constraint cannot look across rows.
- **Rationale**: an assignment can name several sites and several projects. A project target is
  resolved to its active sites at punch time, so sites added later are included (spec Assumptions).
  A child table keeps the history model unchanged: one row per effective-from change.
- **Alternatives considered**:
  - A `siteIds String[]` column: there would be no index and no way to tell a project target apart
    from a site target.
  - A one-site-per-row assignment with the same `effectiveFrom`: it breaks the "row in force" query,
    which takes the newest row.

## R3. Matching a punch to a site

- **Decision**: `SitesService` (in the projects module) gets
  `geofencesFor(ctx, { siteIds, projectIds })`. It returns the active sites covered by the
  assignment, de-duplicated and each with its fence. This keeps the Principle I rule: `hr` never
  reads `projects` tables directly.

  The punch service builds the candidate list as follows:
  - mobile → none
  - assignment targets → `geofencesFor`
  - no assignment → `[employee.siteId]`

  It runs `checkGeofence` against each candidate. The matched site is the in-range candidate with
  the smallest distance. If none is in range, the nearest candidate is used for the evidence
  (distance, site).

  If the candidate list is empty and the employee is not mobile (every covered site inactive, or a
  project with no active site), the existing "This site is no longer in service" 400 is returned.
  A list of every site in the company is not needed.
- **Rationale**: this is the same accuracy and unlocatable logic run several times. Nearest centre
  breaks ties when fences overlap (spec US2 scenario 4).
- **Performance**: an assignment covers only a few sites (two to six are expected), so this is
  negligible next to the face model.

## R4. Recording the site

- **Decision**:
  - `hr.PunchRecord.siteId String?`: the matched site. It is null for mobile punches, and for
    admin punches where no site was chosen.
  - `hr.PunchRefusal.siteId String?`: the nearest covered site.
  - Both are bare ids with an index `(siteId, punchDate)` on `PunchRecord`, for the register's site
    filter.

## R5. Backfilling existing punches (FR-015)

- **Decision**: a SQL migration sets `PunchRecord.siteId` only where the punch was accepted
  `in_range`, `source = 'employee'`, and the site it was checked against is certain. That site is
  the in-force assignment's `siteId` (when not mobile), else `Employee.siteId`.

  The backfill runs before the assignment `siteId` column is dropped, in the same migration. All
  other rows stay null. Migrations may cross schemas, because Principle I constrains application
  queries, not migrations.
- **Alternatives considered**: backfilling admin and imported punches from `Employee.siteId`.
  Rejected, because those punches were never located, so the site would be a guess.

## R6. HR manual punches and corrections (FR-012)

- **Decision**:
  - The `POST /hr/attendance` (mark) DTO and the correction DTO take an optional `siteId`.
  - It is validated against the employee's covered sites on that day. For mobile employees it is
    validated against any active site of the company.
  - When omitted and exactly one site is covered, that site is used. Otherwise it stays null.
  - Bulk attendance import leaves the site null, since the template has no site column. Adding one
    is out of scope.

## R7. Showing the site (FR-011, FR-016)

- **Decision**:
  - `daily()`'s `DailyAttendanceRow` gains `punchInSite` and `punchOutSite` (`{ id, name } | null`)
    and an optional `siteId` filter that matches a punch in or out at that site.
  - `employeeMonth` and the employee's own `GET /my/punch/history` gain the same fields.
  - Site names come from `SitesService.listForCompany`.
  - The web register table and its Excel download add the two columns and a site filter.
  - The monthly attendance sheet and payroll are not touched; they stay grouped by home site, as
    clarified on 2026-11-06.

## R8. Multi-company access without Super Admin powers

Findings:

- Every request reloads the user and its roles (`JwtStrategy.validate` →
  `loadUserWithPermissions`), so a role change applies on the caller's next request.
- Company selection (`CompanySelectionService.resolve/selectableFor/select`) is keyed to
  `CROSS_COMPANY_ACCESS`. The web switcher already shows whenever the backend lists more than one
  selectable company, so the web needs no switcher change.
- Scoping funnels through `rlsContextFor`, `companyScope`, `resolveCompanyId` and
  `effectiveCompanyId`. However, 109 places in 63 files read `caller.companyId` directly as "the
  caller's company".
- `shared.User` has RLS, and own-account services (change password, `/me`) read the caller's own
  row with `caller.companyId`.
- My Workspace resolves the caller's own employee with the caller's RLS context (11 `my/*`
  controllers). After a switch, this would not find an employee in the home company.

Decision:

- **Data**: `settings.Role.allCompanies Boolean @default(false)`.
- **Who can change it**: only callers holding `CROSS_COMPANY_ACCESS` may set or clear it
  (`roles.service`), or assign or remove a role carrying it (`users/users.service`,
  `account-creation/users/users.service`, and invites if they carry roles). Each change goes
  through the existing role and user audit entries.
- **Request user**: `AuthenticatedUser` gains `homeCompanyId: string | null` and
  `multiCompany: boolean`. `multiCompany` is true when any held role has `allCompanies` and the
  user does not hold `CROSS_COMPANY_ACCESS`. Super Admin is untouched (FR-023).
- **Working company swap**: in `JwtStrategy`, for a `multiCompany` user:
  - `homeCompanyId = companyId`
  - `companyId = (resolved selection) ?? homeCompanyId`
  - `selectedCompanyId` stays null

  Every existing reader of `caller.companyId` (all 109) and every `rlsContextFor` call then scope to
  the selected company, through the non-bypass branch. Such a user can never reach the
  `isSuperAdmin` bypass, because they don't hold the permission.
- **Company selection**: `selectableFor`, `select` and `resolve` treat `multiCompany` like
  cross-company for listing and storing the selection. Only active companies are listed. A stored
  selection naming an inactive or unknown company resolves to the home company.
- **Own records**: a new `@OwnRecords()` class decorator plus `OwnRecordsInterceptor` resets
  `companyId` to `homeCompanyId` for `multiCompany` users. It goes on the `my/*` controllers that
  read the caller's own employee:
  - punch, leave, reimbursements, holidays, employee, profile, payroll, salary, resignation,
    face-enrol
  - not `my/cash-policy` or `my/company-selection`, which must follow the working company

  Own-account services (`users/change-password.service`, `users/user-summary`, `users/users.service`
  own-row reads) use `homeCompanyId ?? companyId`. `/me` returns `companyId` (home) plus
  `workingCompanyId`.
- **Group powers stay keyed to `CROSS_COMPANY_ACCESS`**: the group dashboard, App Settings and
  cash visibility, company creation, cross-company user admin, reminders scope=all, DWR
  self-approval and refusals (R1). Because `multiCompany` users never hold the permission, FR-020
  holds with no change to those places.

  `OwnCompanyGuard` compares `:id` with `user.companyId`, which after the swap is the working
  company. A multi-company holder of `COMPANY_SETTINGS` can therefore edit only the company they are
  working in, never "other companies".

Alternatives considered:

- **Teaching `rlsContextFor` a `multiCompany` branch and leaving `companyId` as home**: rejected,
  because the 109 direct `caller.companyId` readers would keep using the home company. Writes would
  then fail RLS in the selected company, and lists would come back empty.
- **Granting `CROSS_COMPANY_ACCESS`**: rejected by the user. It brings every group power.
- **Per-person flag**: rejected in clarification (per role only).

Risks and mitigations:

- **A `my/*` route missed by `@OwnRecords()`**: it would read the working company. Mitigation: a
  unit test enumerates every `@Controller('my…')` and asserts the decorator except on an explicit
  allow-list (`my/cash-policy`, `my/company-selection`).
- **Something stores `caller.companyId` as "the user's company" on the User row**: covered by
  using `homeCompanyId` in own-account services. Tasks include a grep audit of `src/auth`,
  `src/users` and `src/account-creation`.

## R9. Web changes

- **Attendance workspace**: the Refusals tab filter changes from `hasWrite(user, 'ATTENDANCE')` to
  holding `CROSS_COMPANY_ACCESS`.
- **Labour attendance and muster pages**: the refusals query is enabled, and the list rendered,
  only for that permission.
- **`app/ui/hr/location-assignment.tsx` and `bulk-location-assignment.tsx`**: the single-site
  select becomes a multi-select of sites plus projects, with mobile kept. The UI warns when a
  chosen project has no active site.
- **`app/ui/hr/attendance-table.tsx`**: in and out site columns plus a site filter. The same columns
  go in the Excel download and the employee month view. The employee's own history shows the site.
- **Manual mark and correction forms**: an optional site select, limited to the employee's covered
  sites.
- **`app/ui/settings/role-modal.tsx`**: an "Works in all companies" checkbox, shown and editable
  only for Super Admin. The role list shows a badge.
- **Users screens**: roles carrying the flag cannot be selected by non-Super-Admin admins. The API
  also refuses it.
- **Company switcher**: no change, because it is driven by the backend list.
