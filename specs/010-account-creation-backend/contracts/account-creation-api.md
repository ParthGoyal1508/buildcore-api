# Contract: `/account-creation/*` endpoints

Two endpoints (invite validation, set-password) are intentionally public — the invitee has no
session. Every other endpoint requires `JwtAuthGuard` plus
`@RequirePermission(Permission.USER_MANAGEMENT)` (reused from 002's existing enum, research.md §6).

**No `GET`/`PATCH`/`DELETE` account-list or edit-account endpoints live under `/account-creation/*`**
— those already exist at `002-settings-backend`'s `/settings/users` (its own User Story 3), backed
by this feature's exported `UsersService` (research.md §8, data-model.md). Building a second set
here would duplicate that surface under a different URL.

---

## Users — `/account-creation/users` (permission: `USER_MANAGEMENT`)

- `POST /account-creation/users` — `{ email, roleId, companyId?, employeeId?, displayName? }` →
  `201` with `{ id, email, status: 'pending', emailDispatchFailed: boolean }`. `400` if
  `companyId` missing for a non-Super-Admin role, or provided for the Super Admin role, or neither
  `employeeId` nor `displayName` given. `409` if email already active, email already
  deactivated-but-exists (distinct message), or `employeeId` already linked to another User.
- `POST /account-creation/users/:id/resend-invite` — no body. `200` with
  `{ emailDispatchFailed: boolean }` if the account is `pending`; `409` if `active` or
  `deactivated`. Invalidates the previous invite token (inserts a new `InviteToken` row).

## Employee picker — `GET /account-creation/employees/unlinked?companyId=&search=`
(permission: `USER_MANAGEMENT`)

- Proxies `HrService.getUnlinkedEmployees()` (005). Response: `{ id, firstName, lastName }[]`.

---

## Invites — `/account-creation/invites` (public — no auth guard)

- `GET /account-creation/invites/:token` — `200` with `{ valid: true, email }` or
  `{ valid: false, reason: 'expired' | 'consumed' | 'not_found' }`. Rate-limited.
- `POST /account-creation/invites/:token/set-password` — `{ password }` → `201` with
  `{ success: true }` on a valid token and a password meeting the complexity rule (min 8 chars, 1
  uppercase, 1 number). `400` on validation failure (bad password or malformed body). `410 Gone` on
  an expired or already-consumed token. Rate-limited.

---

## Audit logging

Every write this feature makes (user create, resend-invite, successful set-password) writes an
`AuditLogEntry` with `entityType: 'USER_ACCOUNT'`, `entityId`, `actorUserId` (system-attributed for
the unauthenticated set-password action, since the invitee has no `User.id` distinct from the
account being activated — the entry uses the account's own id as actor), `action`, `before`/
`after`, `timestamp`. Extends `shared.AuditLogEntry.entityType` with `USER_ACCOUNT`.
Status/role changes on already-existing accounts (deactivate/reactivate/role edit) are audit-logged
by `002-settings-backend`'s own controller, using the same `USER_ACCOUNT` entityType so both
features' writes to one account appear together in the Activity Log.
