# Implementation Plan: Refusals for Super Admin, site-tagged staff attendance, multi-company access

**Branch**: `058-site-attendance-multi-company` | **Date**: 2026-11-06 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/058-site-attendance-multi-company/spec.md`, in worktrees
`buildcore-api-058` and `buildcore-web-058`.

## Summary

The feature has three independent slices, delivered in this order:

1. **US1, refusals for Super Admin**: the existing Super Admin guard (`GroupAccessGuard`) goes on
   the four refusal routes (HR and labour, list and photo). The web hides the Refusals tab and the
   labour refused list unless the user holds `CROSS_COMPANY_ACCESS`. The employee's own refusal is
   unchanged.
2. **US2, site-tagged staff attendance**:
   - A location assignment covers several sites and/or projects, through a new target child table.
   - The punch is matched to the nearest in-range covered site, through a new
     `SitesService.geofencesFor`.
   - `PunchRecord` and `PunchRefusal` record `siteId`.
   - The daily register, the employee's month and the employee's own history show the in and out
     site, and the register can be filtered by site.
   - HR manual punches and corrections can name a site.
   - In-range employee punches are backfilled where the site is certain.
   - Payroll and the monthly sheet are untouched.
3. **US3, "all companies" roles**:
   - `Role.allCompanies`, settable only by Super Admin, who is also the only one who can assign it.
   - Holders get the company switcher.
   - `JwtStrategy` swaps `companyId` to the working company, keeping `homeCompanyId`, so every
     existing scope follows the selection without the Super Admin bypass.
   - `@OwnRecords()` keeps My Workspace on the home company.
   - Group powers stay keyed to `CROSS_COMPANY_ACCESS`.

Details are in [research.md](./research.md), [data-model.md](./data-model.md) and
[contracts/api-changes.md](./contracts/api-changes.md).

## Technical Context

**Language/Version**: TypeScript 5. API on NestJS 10.1 + Prisma 5.22 (PostgreSQL 18 on Neon). Web on Next.js 16.3 + React 19.2.

**Primary Dependencies**: existing only. No new packages.

**Storage**: PostgreSQL. One migration: a new `hr.EmployeeLocationAssignmentTarget` table, columns
on `hr.PunchRecord`, `hr.PunchRefusal` and `settings.Role`, a data move and backfill, and RLS
policy plus grants for the new table.

**Testing**:
- API: Jest unit tests and e2e (`npm test`, `npm run test:e2e`).
- Web: lint and typecheck (there's no unit runner). Screens are checked by hand, with screenshots
  of opened dialogs and filters.

**Target Platform**: API on Render (Docker, Linux). Web on Vercel. The phone punch screen is a PWA in mobile browsers.

**Project Type**: web service + web application (two repos).

**Performance Goals**: punch latency unchanged within noise. Multi-site matching adds a few
distance computations and replaces today's single site query with one query.

**Constraints**:
- Constitution I (hr never reads projects tables, and goes through `SitesService`).
- Constitution IV (RLS on the new table, tenant isolation for multi-company users).
- Constitution V (guards, not in-handler ifs).
- Payroll results must not change.

**Scale/Scope**:
- 2 companies, ~300 staff, ~30 sites per company.
- An assignment covers ≤ ~10 sites.
- 7 client roles.

## Constitution Check

| Principle | Status |
|---|---|
| I. Schema-per-module | ✅ Assignment targets store bare site and project ids. Resolution goes through a new `SitesService.geofencesFor` (projects module), like `getGeofence` today. The backfill is SQL in a migration, which isn't an application query. |
| II. Validated DTOs | ✅ New and changed DTOs (assignment, mark, correction, role, query `siteId`) use class-validator with whitelist. Swagger is updated. |
| III. No hardcoded values | ✅ New error and warning codes go in the owning module's constants. |
| IV. Tenant isolation & PII | ✅ The new table carries `companyId`, RLS and grants. Multi-company users always run in the non-bypass RLS branch, scoped to exactly one company (FR-019). Role-flag changes and assignments are audited. |
| V. AuthZ | ✅ Super Admin gates use a guard (`GroupAccessGuard`). `@OwnRecords()` is a decorator plus interceptor. The role and assignment ceilings extend the existing grant-ceiling checks. |
| VI. Safe migrations | ✅ One forward migration applied by `migrate deploy`. The backfill is idempotent (`WHERE "siteId" IS NULL`). The legacy assignment `siteId` body field is accepted for one release. |
| Tests | ✅ Every new guard, interceptor and service rule gets unit tests. Auth-touching endpoints (roles, users, company selection, refusals) get e2e tests. |

No violations, so Complexity Tracking is empty.

**Post-design re-check**: the design was re-checked against each row and still holds.

## Project Structure

### Documentation (this feature)

```text
specs/058-site-attendance-multi-company/
├── spec.md
├── plan.md              # this file
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/api-changes.md
├── checklists/requirements.md
└── tasks.md             # /speckit-tasks (next)
```

### Source Code

```text
buildcore-api-058/
├── prisma/schema.prisma, prisma/migrations/2026110…_058_site_attendance_multi_company/
├── src/dashboard/group-access.guard.ts                  # reused (neutral message option)
├── src/hr/attendance/attendance-admin.{controller,service}.ts, dto/   # refusal guard, site columns/filter, mark siteId
├── src/labour/attendance/labour-punch.controller.ts     # refusal guard
├── src/hr/location-assignments/                         # targets, validation, warnings
├── src/hr/punch/{punch.service,attendance-history.service,punch-refusals.service}.ts
├── src/projects/sites/sites.service.ts                  # geofencesFor()
├── src/auth/{authenticated-user,jwt.strategy}.ts        # homeCompanyId, multiCompany, swap
├── src/common/own-records/{own-records.decorator,own-records.interceptor}.ts  # new
├── src/settings/company-selection/company-selection.service.ts
├── src/settings/roles/{roles.service,dto/*}.ts, src/users/users.service.ts,
│   src/account-creation/users/users.service.ts, src/account-creation/invites/*
├── src/users/{change-password.service,user-summary}.ts
└── test/ (e2e)

buildcore-web-058/
├── app/ui/hr/{attendance-workspace,refusals-panel,attendance-table,location-assignment,bulk-location-assignment}.tsx
├── app/labour/attendance/page.tsx, app/dashboard/labour/muster-attendance/page.tsx
├── app/ui/my/* (own history site)
├── app/ui/settings/{role-modal,role-list,user-list}.tsx, app/ui/account-creation/create-user-form.tsx
└── app/lib/api/{hr-payroll,labour,users,roles}.ts, app/lib/constants.ts
```

**Structure Decision**: the existing two-repo layout. API work stays inside the owning modules (hr,
projects, settings, auth, users). Shared request plumbing (`@OwnRecords`) goes in `src/common`.

## Delivery order

1. **US1**: small; it can be reviewed on its own.
2. **US2**: migration (assignment targets first) → matcher → recording → views → web.
3. **US3**: auth plumbing → selection → own records → role and user ceilings → web.

There's a review point between each story. After merge, prod needs `migrate deploy` (automatic on
Render start). The client's roles are then set up as data.

## Complexity Tracking

None.
