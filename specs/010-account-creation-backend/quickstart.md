# Quickstart: Validating the Account Creation Backend

## Prerequisites

- Seeded company (002), seeded `settings.Role` rows including Super Admin (002's nine defaults),
  admin session token. `RESEND_API_KEY` set to a sandbox/test key (or `EmailService` mocked in
  test mode). Migrations applied: `User.status` +`pending`, `User.displayName`, new `InviteToken`
  table.

---

## Scenario 1 — Create a user and receive the invite (US1)

1. `POST /account-creation/users` with `{ email: "new.pm@acme.test", roleId: <Project Manager
   role>, companyId: <seeded company>, employeeId: <an unlinked Employee's id> }`. **Expected**:
   201, `{ id, email, status: "pending", emailDispatchFailed: false }`.
2. `GET /settings/users?status=pending` (002-settings-backend's list endpoint, backed by this
   feature's exported `UsersService.findAllForCompany()` — this feature has no list endpoint of
   its own). **Expected**: the new row, with `displayName` resolved from the linked Employee's
   name, `inviteExpiresAt` ~48h from now.
3. `POST /account-creation/users` again with the same `email`. **Expected**: 409, "already active"
   or "exists but deactivated" — never a silent duplicate.
4. `POST /account-creation/users` with the same `employeeId` as step 1, a different email.
   **Expected**: 409 (Employee already linked to a User).
5. `POST /account-creation/users` with `roleId: <Super Admin>` and a `companyId` provided.
   **Expected**: 400.

---

## Scenario 2 — Set password and activate (US2)

1. From Scenario 1's created user, extract the raw invite token (test-only: read
   `InviteToken.tokenHash`'s corresponding raw value from the test harness's captured email, not a
   real endpoint — no endpoint ever returns the raw token).
2. `GET /account-creation/invites/:token`. **Expected**: `{ valid: true, email: "new.pm@acme.test"
   }`.
3. `POST /account-creation/invites/:token/set-password` with `{ password: "weak" }`. **Expected**:
   400 (fails complexity rule).
4. `POST /account-creation/invites/:token/set-password` with `{ password: "Str0ngPass" }`.
   **Expected**: 201, `{ success: true }`.
5. `GET /account-creation/invites/:token` again. **Expected**: `{ valid: false, reason: "consumed"
   }`.
6. `POST /auth/login` (001's existing endpoint) with `{ email: "new.pm@acme.test", password:
   "Str0ngPass" }`. **Expected**: 200, valid access token — the account is fully usable.

---

## Scenario 3 — Resend an expired invite (US3)

1. Create a second user (Scenario 1 pattern). `POST
   /account-creation/users/:id/resend-invite`. **Expected**: 200,
   `{ emailDispatchFailed: false }`; a new `InviteToken` row exists.
2. Validate the *original* token from step 1's creation. **Expected**: `{ valid: false, reason:
   "consumed" }` — resend invalidates the prior token even though it hadn't expired yet.
3. Validate the *new* token from the resend. **Expected**: `{ valid: true, ... }`.
4. Complete set-password with the new token, then `POST
   /account-creation/users/:id/resend-invite` again on the now-`active` account. **Expected**: 409.

---

## Scenario 4 — Deactivate and reactivate (002-settings-backend, exercising this feature's exported `UsersService`)

This scenario lives conceptually here because it exercises the `UsersService` this feature
exports, but the endpoints themselves belong to `002-settings-backend` — see that feature's own
quickstart.md for its authoritative version of this walkthrough.

1. Take the now-`active` account from Scenario 3. `PATCH /settings/users/:id` with
   `{ status: "deactivated" }`. **Expected**: 200.
2. `POST /auth/login` with that account's credentials. **Expected**: rejected (account not
   active) — 001's existing login rejection logic, unchanged.
3. `PATCH /settings/users/:id` with `{ status: "active" }`. **Expected**: 200 — direct
   reactivation, no new invite needed.
4. `POST /auth/login` again with the same (already-set) password. **Expected**: 200, succeeds.
5. On a fresh `pending` user (Scenario 1, before set-password), `PATCH /settings/users/:id` with
   `{ status: "active" }`. **Expected**: 400 — a pending account can only activate via this
   feature's set-password flow (Scenario 2), never a direct status write — enforced inside the
   shared `UsersService.updateRoleOrStatus()` regardless of which feature's controller called it.
