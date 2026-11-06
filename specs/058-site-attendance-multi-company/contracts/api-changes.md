# API contract changes: 058

All of these changes are additive, except the assignment body, which changes shape. The web app is
updated in the same release.

## Refusals: Super Admin only (FR-001, FR-002)

| Route | Before | After |
|---|---|---|
| `GET /hr/attendance/refusals` | ATTENDANCE write | + Super Admin (`CROSS_COMPANY_ACCESS`), else 403 |
| `GET /hr/attendance/refusals/:id/photo` | ATTENDANCE write | + Super Admin, else 403 |
| `GET /labour/attendance/refusals` | DAILY_WORKER_REGISTRY + LABOUR_APPROVE | + Super Admin, else 403 |
| `GET /labour/attendance/refusals/:id/photo` | same | + Super Admin, else 403 |
| `GET /my/punch/refusals`, 422 punch responses | unchanged | unchanged |

- A refusal row in the HR log gains `site: { id, name } | null`.

## Location assignment (FR-006, FR-013)

`PUT /hr/employees/:employeeId/location-assignments`

```jsonc
// request
{
  "isMobile": false,               // optional, default false
  "siteIds": ["<siteId>", "..."],  // optional
  "projectIds": ["<projectId>"],   // optional
  "effectiveFrom": "2026-11-10",
  "reason": "Moves between Bundi sites"
}
// response 200
{
  "id": "…",
  "employeeId": "…",
  "isMobile": false,
  "effectiveFrom": "2026-11-10",
  "targets": [
    { "siteId": "…", "projectId": null, "name": "Bundi – 2000" },
    { "siteId": null, "projectId": "…", "name": "Bundi Ring Road (project)" }
  ],
  "warnings": []                   // or ["PROJECT_HAS_NO_ACTIVE_SITE"]
}
```

- **400 `ASSIGNMENT_EMPTY`**: not mobile and no targets.
- **400 `ASSIGNMENT_MOBILE_WITH_TARGETS`**: mobile and targets at the same time.
- **404**: a site or project that isn't in the employee's company.
- **The legacy `siteId` body field** is still accepted for one release as `siteIds: [siteId]`, so
  an older web build keeps working.

`GET /hr/employees/:employeeId/location-assignments`: each history row returns `targets` as above.

## Punch (FR-007 to FR-010)

`POST /my/punch` has an unchanged request. On success the response gains
`site: { id, name } | null`.

Refusals keep their codes. `outside_geofence` is now judged against the nearest covered site, and
the refusal detail carries that site's name.

## Attendance views (FR-011)

- **`GET /hr/attendance?date=…&punchSiteId=…`**: new optional `punchSiteId` filter, for employees
  with a punch in or out made **at** that site. The existing `siteId` keeps its meaning: employees
  posted at that home site, punched or not (decided during implementation so the register's
  site view doesn't change). Each row gains `punchInSite` and `punchOutSite`
  (`{ id, name } | null`).
- **`GET /hr/attendance/employee/:employeeId?month=…`**: each day gains `punchInSite` and
  `punchOutSite`.
- **`GET /my/punch/history?month=&year=`**: each day gains `punchInSite` and `punchOutSite`.

## Manual punches and corrections (FR-012)

- `POST /hr/attendance` (mark) and the attendance correction body gain an optional
  `siteId: string`.
- **400 `SITE_NOT_ASSIGNED`**: the site isn't covered for that employee on that day. For mobile
  employees, any active site of the company is accepted.

## Roles and users (FR-017, FR-017a)

- **`POST/PATCH /settings/roles`**: the body gains `allCompanies?: boolean`. Setting or changing it
  without `CROSS_COMPANY_ACCESS` returns **403 `ALL_COMPANIES_SUPER_ADMIN_ONLY`**.
- **`GET /settings/roles`**: each role gains `allCompanies`.
- **Assigning or removing a role with `allCompanies`** (user create, user role update, invite)
  without `CROSS_COMPANY_ACCESS` returns **403 `ALL_COMPANIES_SUPER_ADMIN_ONLY`**.

## Company selection and the caller (FR-018 to FR-022)

- **`GET /my/company-selection`**: for an all-companies user, lists every active company with
  `selected`. For other users who aren't Super Admin it is unchanged (only their own company).
- **`PUT /my/company-selection`**: the same body. It is now accepted for all-companies users, and
  403 `COMPANY_NOT_ACCESSIBLE` is returned otherwise, as today.
- **`GET /me`** (user summary): `companyId` stays the home company. New fields:
  - `workingCompanyId`: the company being worked in.
  - `multiCompany: boolean`
