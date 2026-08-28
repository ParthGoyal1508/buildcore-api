# Quickstart: Validating the Settings Module Backend

## Prerequisites

- Local Postgres running with migrations applied (the `settings` schema's tables, plus feature
  001's `User.roleId`/`AuditLogEntry.entityType` changes — data-model.md).
- `npm run start:dev` running.
- The nine default roles seeded (Super Admin protected), and at least one bootstrap Super Admin
  account with a valid access token to call these endpoints.
- A second admin account with only `HO_USER`-level permissions, and a third account with neither
  `COMPANY_SETTINGS` nor `USER_MANAGEMENT`, for negative-permission checks.

## Scenario 1 — Company creation and scoping (User Story 1)

1. `POST /settings/companies` as Super Admin with a name, unique `shortCode` "DC", and required
   registration/statutory/payroll fields. **Expected**: 201; response includes default payroll
   rates (12% / 3.25% / 4.81% / 8.33%) if omitted from the request.
2. Repeat with `shortCode: "dc"` (case-variant collision). **Expected**: 409.
3. `PATCH` the company's `pfEmployerRate` to a new value. **Expected**: 200; a subsequent `GET`
   reflects the new rate immediately.
4. `PATCH` the company's `status` to `inactive`. **Expected**: 200; the company is excluded from a
   company-selection dropdown endpoint elsewhere but still returned by `GET
   /settings/companies/:id` directly.
5. `POST /settings/companies` as the non-admin third account. **Expected**: 403.

## Scenario 2 — Roles and permission enforcement (User Story 2)

1. `GET /settings/roles` as Super Admin. **Expected**: 200 with all nine default roles, each with
   `assignedUserCount` and Super Admin's `isProtected: true`.
2. `POST /settings/roles` with `{ name: "Custom Auditor", permissions: ["REPORTS", "DASHBOARD"] }`.
   **Expected**: 201.
3. `POST /settings/roles` with an invalid permission value (e.g. `"NOT_A_PERMISSION"`).
   **Expected**: 400.
4. `PATCH /settings/roles/:superAdminId` attempting to rename it or change its permissions.
   **Expected**: 403, regardless of caller.
5. Assign the new "Custom Auditor" role to a test user (via Scenario 3's user-edit endpoint), then
   authenticate as that user and call an endpoint requiring `EMPLOYEES` permission.
   **Expected**: 403 (role only grants `REPORTS`/`DASHBOARD`).
6. `DELETE /settings/roles/:customRoleId` while the test user still holds it. **Expected**: 200; a
   subsequent `GET /settings/users` shows that user with `role: null`, and their next authenticated
   request against any permission-restricted endpoint is rejected.

## Scenario 3 — User administration (User Story 3)

1. `GET /settings/users` as Super Admin. **Expected**: 200, list scoped to caller's company,
   showing role, status, and `lastLoginAt`.
2. `PATCH /settings/users/:id` changing `roleId` to a different existing role. **Expected**: 200;
   that user's next authenticated request reflects the new role's permissions.
3. `PATCH /settings/users/:id` toggling `status` to `inactive`. **Expected**: 200; that account can
   no longer authenticate.
4. `PATCH /settings/users/:lastSuperAdminId` attempting to deactivate or reassign the only
   remaining active Super Admin account. **Expected**: 409.
5. `DELETE /settings/users/:id` as the non-admin third account. **Expected**: 403.
6. Create a `pending` account via `010-account-creation-backend`'s `POST /account-creation/users`,
   then `PATCH /settings/users/:id` on it with `{ status: "active" }`. **Expected**: 400 — a
   pending account can only activate via 010's set-password flow, enforced inside the shared
   `UsersService.updateRoleOrStatus()` this feature imports from `AccountCreationModule`.
7. `PATCH /settings/users/:id` on an `active` account (created via 010, then activated) with
   `{ status: "deactivated" }`. **Expected**: 200; all of that account's refresh tokens are
   revoked immediately (verify a subsequent refresh with its pre-deactivation token fails); a
   follow-up `PATCH ... { status: "active" }` reactivates it directly, and login succeeds again
   with its existing password (no new invite needed).

## Scenario 4 — Employee Setup reference masters (User Stories 4–6)

1. Under company "DC", `POST /settings/departments` with `{ name: "Civil" }`. **Expected**: 201.
2. Under company "DI" (a second company), `POST /settings/departments` with `{ name: "Civil" }`
   again. **Expected**: 201 (same name allowed in a different company — per-company scoping).
3. Repeat step 1 under "DC" again (exact duplicate). **Expected**: 409.
4. `GET /settings/departments` authenticated against company "DI". **Expected**: does not include
   "DC"'s "Civil" department.
5. `POST /settings/document-types` with `{ code: "MED", name: "Medical Fitness", isMandatory:
   false, hasExpiry: true, needsNumber: false, sortOrder: 1 }`. **Expected**: 201; response's
   derived flag is `"Expiry"`.
6. `POST /settings/shifts` with a name, `inTime`, `outTime`, `graceMinutes`. **Expected**: 201.
7. Attempt `DELETE` on a Department/Shift that a (test-seeded) Employee record references.
   **Expected**: 409.

## Scenario 5 — Document type mandatory-gating and default seeding (User Story 5)

1. `POST /settings/companies` to create a fresh company. **Expected**: the new company's `GET
   /settings/document-types` immediately returns all 16 default types with correct default flags
   (e.g., Aadhaar → `MandatoryNumber`, Photo → `Mandatory`).
2. For a test employee missing the "Aadhaar" document, attempt whatever downstream
   attendance-marking check FR-021 gates (per the Employees/Attendance module's own contract).
   **Expected**: rejected until the mandatory document is recorded.

## Scenario 6 — Employee code generation (User Story 7)

1. Call `getNextEmployeeCode("DC")` (via an internal test harness, or the future Employees module's
   create-employee flow once it exists) for a company with no employees yet.
   **Expected**: `"DC-0001"`.
2. Fire 50 concurrent calls to `getNextEmployeeCode("DC")`.
   **Expected**: 50 distinct, sequential codes with no duplicates or gaps.
3. `PATCH` the company's `shortCode` to `"DCX"`, then call `getNextEmployeeCode` again.
   **Expected**: new code uses the `"DCX"` prefix; the sequence number continues from where it left
   off (not reset to 1).

## Scenario 7 — Audit logging (NFR: configuration change auditing)

1. Perform one create, one update, and one delete across Companies, Roles, and any one reference
   data resource.
2. Inspect the `AuditLogEntry` table directly (no read endpoint exists, per feature 001's
   write-only posture).
   **Expected**: one entry per operation, each with the correct `entityType`, `action`, `entityId`,
   acting admin, `companyId`, and timestamp.
