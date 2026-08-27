# Data Model: Settings Module Backend (Companies, Users, Roles & Reference Data)

All new entities below live in this repository's own database, in the `settings` Postgres schema
(Constitution Principle I) unless noted otherwise. Field names are conceptual; exact Prisma types
are a task-level decision. See research.md for the cross-schema and audit-log decisions referenced
here.

## Company (`settings` schema — new)

The tenant root; not itself `companyId`-scoped.

| Field | Type | Notes |
|---|---|---|
| `id` | string | |
| `name` | string | |
| `shortCode` | string | Unique across all companies (case-insensitive, trimmed) — FR-004; drives employee code generation |
| `logoUrl` | string \| null | Reference to an uploaded file; storage mechanism out of scope (spec Assumptions) |
| `status` | enum: `active` \| `inactive` | Inactive excluded from cross-module selection dropdowns but data preserved (FR-005) |
| `gstin` | string \| null | Validated against GSTIN format (research.md §10) |
| `pan` | string \| null | Validated against PAN format (research.md §10) |
| `cin` | string \| null | |
| `tan` | string \| null | |
| `address` | string \| null | |
| `city` | string \| null | |
| `state` | string \| null | |
| `pinCode` | string \| null | |
| `pfEstablishmentCode` | string \| null | |
| `esicCode` | string \| null | |
| `professionalTaxRegNumber` | string \| null | |
| `bocwRegNumber` | string \| null | |
| `payCycle` | enum: `monthly` | Fixed value per PRD; modeled as an enum of one for forward compatibility |
| `payrollLockDay` | integer | Day-of-month after which attendance edits lock |
| `pfEmployerRate` | decimal | Default 12.00 (FR-002) |
| `esicEmployerRate` | decimal | Default 3.25 (FR-002) |
| `gratuityRate` | decimal | Default 4.81 (FR-002) |
| `bonusRate` | decimal | Default 8.33 (FR-002) |
| `createdAt` / `updatedAt` | timestamp | |

## Role (`settings` schema — new; supersedes `shared.User.role` enum, research.md §2)

| Field | Type | Notes |
|---|---|---|
| `id` | string | |
| `name` | string | Unique across roles |
| `permissions` | `Permission[]` | Native Postgres array of the fixed `Permission` enum (research.md §4) |
| `isProtected` | boolean | `true` only for the seeded Super Admin row; blocks rename/permission-change/delete (FR-008) |
| `createdAt` / `updatedAt` | timestamp | |

Seeded on first setup with the nine default roles from the PRD's table, `isProtected = true` only
for Super Admin.

**`Permission` enum** (`settings` schema): `DASHBOARD`, `EMPLOYEES`, `ATTENDANCE`, `PROJECTS`,
`MACHINERY`, `INVENTORY`, `PARTNERS`, `REPORTS`, `PAYROLL`, `CHALLANS`, `LOANS`, `LOGBOOK`, `FUEL`,
`DAILY_WORKER_REGISTRY`, `MY_WORKSPACE`, `SETTINGS`, `USER_MANAGEMENT`, `COMPANY_SETTINGS`,
`DATA_EXPORT`, `DATA_DELETE`.

## User Account (`shared` schema — modifies feature 001's model)

| Field | Type | Notes |
|---|---|---|
| `roleId` | string | **CHANGED** — replaces the placeholder `role Role` enum; FK to `settings.Role.id` (research.md §2/§3). Every account has exactly one role. |
| `lastLoginAt` | timestamp \| null | **NEW** (owned by feature 001) — set on every successful authentication (spec FR-017). Feature 001's `AuthService.login()` writes it; this feature only reads it via the exported `UsersService` (research.md §3) for the Users list (FR-013). If feature 001 lands first without this field, add it there instead of here — either way it belongs to `shared.User`, not to `settings`. |
| *(all other fields)* | — | Unchanged from feature 001's data-model.md (`companyId`, `status`, `mustChangePassword`, lockout fields, etc.) |

This feature does not add new columns to `User` beyond the enum→FK change; it reads/lists/edits/
deletes existing rows via `AuthModule`'s exported `UsersService` (research.md §3), never a direct
`shared.User` query from `settings`.

## Department (`settings` schema — new)

| Field | Type | Notes |
|---|---|---|
| `id` | string | |
| `companyId` | string | FK to Company; RLS-protected (research.md §8) |
| `name` | string | Unique per `(companyId, name)` |
| `createdAt` / `updatedAt` | timestamp | |

Deletion rejected while any Employee record references it (FR-018) — enforced via a call to the
future Employees module's exported check, not a direct cross-schema query.

## Designation (`settings` schema — new)

Same shape and deletion-guard behavior as Department.

## Document Type (`settings` schema — new)

| Field | Type | Notes |
|---|---|---|
| `id` | string | |
| `companyId` | string | RLS-protected |
| `code` | string | Unique per `(companyId, code)` |
| `name` | string | |
| `isMandatory` | boolean | Gates attendance marking (FR-021) |
| `hasExpiry` | boolean | |
| `needsNumber` | boolean | |
| `sortOrder` | integer | |
| `isActive` | boolean | Inactive types excluded from new-upload selection but historical records unaffected |
| `createdAt` / `updatedAt` | timestamp | |

Derived display flag (`MandatoryNumber`/`Mandatory`/`ExpiryNumber`/`Expiry`/`Number`/`Optional`) is
computed on read from `isMandatory`/`hasExpiry`/`needsNumber` (research.md §7), not stored.

Seeded per newly created company with the 16 default document types from the PRD (Aadhaar, PAN,
Bank Proof, Photo, Driving Licence, Marksheets, Degree, Experience Letter, Medical Fitness, Police
Verification, Offer Letter, Appointment Letter, Joining Letter, PF Form 11, PF Form 2, ESIC Family
Declaration) with their documented default flags (FR-020).

Exports `hasMissingMandatoryDocs(companyId, employeeDocumentTypeIds: string[]): Promise<{ missing:
DocumentType[] }>` for the future Employees/Attendance module to call (FR-021) — given the set of
document type IDs an employee currently has on file, returns which of that company's
`isMandatory: true` document types are absent. This feature owns the check itself; it does not own
attendance-marking or Employee document storage, which belong to those future modules.

## Shift (`settings` schema — new)

| Field | Type | Notes |
|---|---|---|
| `id` | string | |
| `companyId` | string | RLS-protected |
| `name` | string | Unique per `(companyId, name)` |
| `inTime` | time | |
| `outTime` | time | |
| `graceMinutes` | integer | |
| `createdAt` / `updatedAt` | timestamp | |

Deletion rejected while any Employee record references it (FR-022), same cross-module check
pattern as Department/Designation.

## Employee Code Sequence (`settings` schema — new)

| Field | Type | Notes |
|---|---|---|
| `companyId` | string | Primary key — one row per company |
| `lastNumber` | integer | Incremented atomically via `UPDATE ... RETURNING` (research.md §6); default 0 |

Not directly exposed by any endpoint beyond a read-only "current state" view (User Story 7); the
next-code value is obtained exclusively through the exported `getNextEmployeeCode(companyId)`
service method, which formats `{Company.shortCode}-{lastNumber, zero-padded to 4 digits}`.

## Audit Log Entry (`shared` schema — modifies feature 001's model, research.md §9)

| Field | Type | Notes |
|---|---|---|
| `entityType` | enum | **CHANGED from `eventType`** — now covers both feature 001's login-related values (`LOGIN_SUCCESS`, `LOGIN_FAILURE`, `ACCOUNT_LOCKED`, `LOGOUT`, `REFRESH_REUSE_DETECTED`) and this feature's entity values (`COMPANY`, `ROLE`, `DEPARTMENT`, `DESIGNATION`, `DOCUMENT_TYPE`, `SHIFT`) |
| `action` | enum: `CREATE` \| `UPDATE` \| `DELETE` \| `LOGIN_SUCCESS` \| `LOGIN_FAILURE` \| `ACCOUNT_LOCKED` \| `LOGOUT` \| `REFRESH_REUSE_DETECTED` | **NEW** — separates "what happened" from "to what" |
| `entityId` | string \| null | **NEW** — the Company/Role/Department/... row affected; null for login-related events (which key off `accountId`/`attemptedEmail` as before) |
| `changes` | JSON \| null | **NEW** — optional before/after snapshot for update actions |
| *(all other fields)* | — | Unchanged from feature 001 (`accountId`, `attemptedEmail`, `companyId`, `ipAddress`, `createdAt`) |

Written exclusively via the shared `AuditLogService.record()` in-process call (research.md §9); this
feature is write-only against it, matching feature 001's own "write-only in this feature" posture —
reading/querying the audit log remains a separate, later Activity Log feature for both.

## Cross-reference to feature 001 (001-user-login-backend)

| Concept | Relationship |
|---|---|
| `shared.User.role` (enum) | **Replaced** by `roleId` FK into this feature's `settings.Role` (research.md §2) |
| `shared.AuditLogEntry.eventType` | **Generalized** into `entityType`/`action` (research.md §9), backward-compatible with every value feature 001 needs |
| `RolesGuard`/`@Roles()` (feature 001, research.md §6) | **Extended**, not replaced — this feature's endpoints add permission-based checks (`@RequirePermission(Permission.X)`) reading the new `Role.permissions` array via the same guard mechanism, alongside feature 001's role-name checks |
| Super Admin cross-company token exception (feature 001) | Unchanged; this feature's `companyId`-scoped tables honor the same RLS bypass flag (research.md §8) |
