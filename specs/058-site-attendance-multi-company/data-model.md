# Data model: 058

One migration, `20261106xxxxxx_058_site_attendance_multi_company`, applied by
`prisma migrate deploy`. Every new table is tenant-scoped, carries `companyId`, and gets the
standard `tenant_isolation` RLS policy and the grants for `buildcore_app`, matching the existing
`hr` tables.

## hr.EmployeeLocationAssignmentTarget (new)

| Field | Type | Notes |
|---|---|---|
| id | String cuid | PK |
| companyId | String | RLS discriminator, copied from the assignment |
| assignmentId | String | FK → `EmployeeLocationAssignment.id`, on delete cascade |
| siteId | String? | Bare id of `projects.Site` |
| projectId | String? | Bare id of `projects.Project`; means every active site of the project at punch time |

- Check `(siteId IS NULL) <> (projectId IS NULL)`: exactly one is set.
- Unique `(assignmentId, siteId, projectId)`.
- Index `(companyId)` and `(assignmentId)`.

## hr.EmployeeLocationAssignment (changed)

- `siteId` is **dropped** after its values are copied into target rows.
- The `EmployeeLocationAssignment_site_or_mobile` check is **dropped**.
- New rule, enforced in the service: `isMobile` has no targets, and an assignment that isn't mobile
  has ≥ 1 target. Every target must belong to the employee's company. A project target with no
  active site is saved, but the response carries `warnings: ['PROJECT_HAS_NO_ACTIVE_SITE']`.
- The history model is unchanged: the row with the newest `effectiveFrom` on or before the punch
  day is in force.

## hr.PunchRecord (changed)

- `siteId String?`: the site the punch was matched to (R3). It is null for mobile punches, for old
  punches that can't be resolved, and for admin punches without a site.
- Index `(siteId, punchDate)`.
- Backfill: see research R5.

## hr.PunchRefusal (changed)

- `siteId String?`: the nearest covered site. `distanceMeters` already holds the distance.

## settings.Role (changed)

- `allCompanies Boolean @default(false)`.
- Only callers holding `CROSS_COMPANY_ACCESS` may set it, or assign or remove a role carrying it.
- The protected Super Admin role keeps `false`, because it already has `CROSS_COMPANY_ACCESS`.

## Request user (not persisted)

`AuthenticatedUser` gains:

- `homeCompanyId: string | null`: `User.companyId`.
- `multiCompany: boolean`: true when the user holds a role with `allCompanies` but doesn't hold
  `CROSS_COMPANY_ACCESS`.
- For `multiCompany` users, `companyId` becomes the **working** company: the stored selection if
  it's active, else the home company.
- For own-record routes (`@OwnRecords()`), `companyId` is reset to `homeCompanyId`.

## shared.UserCompanySelection (unchanged)

- It is now also written for `multiCompany` users.
- A selection naming an inactive company resolves to the home company.
