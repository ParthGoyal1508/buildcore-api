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

- `POST /account-creation/users` — `{ email, roleId, companyId?, employeeId?, displayName?,
  password? }` → `201` with `{ id, email, status, emailDispatchFailed: boolean }`. `400` if
  `companyId` missing for a non-Super-Admin role, or provided for the Super Admin role, or neither
  `employeeId` nor `displayName` given. `409` if email already active, email already
  deactivated-but-exists (distinct message), or `employeeId` already linked to another User.

  **`password` (FR-015)** switches the creation mode:

  | `password` | Result |
  |---|---|
  | absent | Today's flow: `status: 'pending'`, invite token generated, invite emailed, `credentialOrigin: 'invite'` |
  | present | `status: 'active'`, password argon2-hashed, `mustChangePassword: true`, `credentialOrigin: 'admin_direct'`. **No token generated, no email sent** — `emailDispatchFailed` is always `false` |

  A supplied password is held to the same complexity rule as the invitee's own (min 8 chars, 1
  uppercase, 1 number) and rejected with `400` **before any account row is created** (FR-016), so a
  failed attempt leaves nothing behind. The password is never echoed in the response and never
  written to the audit log in any form.
- `POST /account-creation/users/:id/resend-invite` — no body. `200` with
  `{ emailDispatchFailed: boolean }` if the account is `pending`; `409` if `active` or
  `deactivated`. Invalidates the previous invite token (inserts a new `InviteToken` row).

## Cross-cutting: pending password change (FR-017a)

An account created with `credentialOrigin: 'admin_direct'` that has not yet changed its password is
refused on **every** authenticated endpoint in the system except four, with:

```
403 { "code": "PASSWORD_CHANGE_REQUIRED", "message": "..." }
```

Clients branch on `code`, never on the message. The four that stay reachable are the ones needed to
complete the change or leave: `POST /users/change-password`, `GET /users/me`, `POST
/auth/refresh-token`, and `POST /auth/logout`.

The check reads the account's current state (re-read per request by the JWT strategy), not the JWT
claim — so the refusal stops the instant the password is changed, with no re-login needed.

Accounts flagged by an admin *reset* are **not** subject to this (FR-017a-ii) — a recorded
limitation, not an omission.

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
