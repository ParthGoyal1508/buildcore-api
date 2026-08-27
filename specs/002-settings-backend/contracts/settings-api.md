# Contract: `/settings/*` endpoints

All endpoints require an authenticated request (existing `JwtAuthGuard`, feature 001) plus a
declared permission check via `@RequirePermission(Permission.X)` (research.md §4, extending feature
001's `RolesGuard`). Every request/response is a validated DTO (Constitution Principle II); every
list endpoint is scoped to the caller's `companyId` via RLS (except a cross-company Super Admin,
feature 001).

## Companies — `/settings/companies` (permission: `COMPANY_SETTINGS`, Super Admin only per FR-001)

### `GET /settings/companies`
**Response — 200**: `Company[]` — all statuses (list columns per spec: name, shortCode, address,
gstin, pan, pfEstablishmentCode, esicCode, status). This is the Settings UI's own admin list, not
the cross-module dropdown source.

### `listActiveForOtherModules()` — internal contract only (no public endpoint)
Exported from `SettingsModule` for any other module's company-selection dropdown; returns only
`status: active` companies (FR-005). Not reachable via HTTP in this feature.

### `POST /settings/companies`
**Request** (`CreateCompanyDto`): all Company fields except `id`/timestamps; payroll rate fields
optional (default to config-sourced values, research.md §11, if omitted).

**Response — 201**: the created `Company`. Seeds the default Document Types (FR-020) and an
`EmployeeCodeSequence` row (`lastNumber = 0`) for it as a side effect.

**Response — 409 Conflict**: `shortCode` collides (case-insensitive/trimmed) with an existing
company (FR-004).

**Response — 400 Bad Request**: malformed `gstin`/`pan` (research.md §10) or other DTO validation
failure.

### `PATCH /settings/companies/:id`
**Request** (`UpdateCompanyDto`): partial Company fields.

**Response — 200**: the updated `Company`.

**Response — 409 Conflict**: `shortCode` change collides with another company.

### `DELETE /settings/companies/:id`
Not exposed — companies are deactivated (`status: inactive`), never hard-deleted, since historical
data must remain intact (FR-005). Use `PATCH` with `status: "inactive"`.

## Roles — `/settings/roles` (permission: `USER_MANAGEMENT`)

### `GET /settings/roles`
**Response — 200**: `Role[]`, each including `assignedUserCount` (FR-009), computed via the exported
`UsersService` count call (research.md §3), not a direct cross-schema join.

### `POST /settings/roles`
**Request** (`CreateRoleDto`): `{ name: string; permissions: Permission[] }` — `permissions` values
outside the `Permission` enum are rejected by DTO validation (FR-007).

**Response — 201**: the created `Role` (`isProtected: false`).

### `PATCH /settings/roles/:id`
**Request** (`UpdateRoleDto`): partial `{ name?, permissions? }`.

**Response — 200**: the updated `Role`.

**Response — 403 Forbidden**: target role `isProtected === true` (FR-008) — the Super Admin role.

### `DELETE /settings/roles/:id`
**Response — 200**: deletion succeeds; every `User` row referencing this `roleId` has it cleared
(`roleId: null`) as part of the same operation (FR-010) — those users lose all module access until
reassigned.

**Response — 403 Forbidden**: target role `isProtected === true`.

## Users (administration) — `/settings/users` (permission: `USER_MANAGEMENT`, Super Admin or HO User
per FR-014)

Creation is intentionally absent from this contract — new accounts are created exclusively through
the separate Account Creation feature (spec Assumptions).

### `GET /settings/users`
**Response — 200**: `UserSummary[]` — `{ id, name, email, role: { id, name }, status, lastLoginAt:
string | null }`, scoped to the caller's company (or all companies for a cross-company Super
Admin).

### `PATCH /settings/users/:id`
**Request** (`UpdateUserDto`): partial `{ roleId?, status? }`.

**Response — 200**: the updated `UserSummary`.

**Response — 409 Conflict**: the request would leave zero active Super Admin accounts (FR-016) —
either deactivating the last one or reassigning its role away.

**Response — 403 Forbidden**: caller lacks `USER_MANAGEMENT` permission or isn't Super Admin/HO
User.

### `DELETE /settings/users/:id`
**Response — 200**: the account is deleted; it can no longer authenticate (FR-015).

**Response — 409 Conflict**: deleting the last active Super Admin account (FR-016).

## Employee Setup reference data — `/settings/departments`, `/settings/designations`,
`/settings/document-types`, `/settings/shifts` (permission: `EMPLOYEES`, per-company scoped)

Each of the four resources exposes the same CRUD shape:

### `GET /settings/{resource}`
**Response — 200**: list scoped to the caller's `companyId` via RLS.

### `POST /settings/{resource}`
**Response — 201**: the created row.

**Response — 409 Conflict**: uniqueness violation — `(companyId, name)` for Department/Designation/
Shift, `(companyId, code)` for Document Type (research.md §8).

### `PATCH /settings/{resource}/:id`
**Response — 200**: the updated row. For Document Types, the response includes the derived display
flag (`MandatoryNumber`/`Mandatory`/`ExpiryNumber`/`Expiry`/`Number`/`Optional`), computed on read
(research.md §7) — never a request field.

### `DELETE /settings/{resource}/:id`
**Response — 200**: deleted.

**Response — 409 Conflict**: still referenced by an Employee record (FR-018 for Department/
Designation, FR-022 for Shift) — checked via the future Employees module's exported service, not a
direct cross-schema query. Document Types are deactivated (`isActive: false`) rather than deleted,
matching FR-019's "Active flag" behavior; `DELETE` is not exposed for that resource.

## Employee code generation — internal contract only (no public endpoint)

`getNextEmployeeCode(companyId: string): Promise<string>` — exported from `SettingsModule` for the
future Employees module to call on employee creation (research.md §6, FR-023). Returns
`{Company.shortCode}-{sequence, zero-padded to 4 digits}`, e.g. `DC-0001`. Not reachable via HTTP in
this feature; a read-only `GET /settings/companies/:id/code-series` endpoint exposes the current
`lastNumber` state for admin visibility (User Story 7) without incrementing it.

## Audit logging (cross-cutting, not a separate endpoint)

Every `POST`/`PATCH`/`DELETE` above writes one `AuditLogEntry` (via the shared `AuditLogService`,
research.md §9) capturing `entityType`, `action`, `entityId`, the acting account, `companyId`, and
timestamp (FR-025) — this feature never exposes a way to read it back, matching feature 001's
write-only posture for the same table.
