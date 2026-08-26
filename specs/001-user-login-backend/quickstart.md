# Quickstart: Validating the Login Backend

## Prerequisites

- Local Postgres running with migrations applied (including this feature's new fields/tables —
  `companyId`/`status`/`mustChangePassword`/lockout fields on `User`, the refresh-token table, the
  audit log table).
- `npm run start:dev` (or equivalent) with `JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET` set in `.env`.
- Seeded test data: at least one active account with a known password and a `companyId`, one
  deactivated account, one Super Admin account (no `companyId`), and the ability to reset a given
  account's `consecutiveFailures`/`lockedUntil` between test runs.
- A tool that preserves cookies across requests (e.g., `curl -c/-b`, Postman, or an httpie session)
  — the refresh token is only ever readable as a cookie, never in a JSON response.

## Scenario 1 — Successful login + company scoping (User Story 1)

1. `POST /auth/login` with a seeded active account's correct email/password and `rememberMe: false`.
   **Expected**: 200 with `accessToken`, `name`, `mustChangePassword`; a `Set-Cookie` for the
   refresh token with no `Max-Age` (session cookie), `Secure`, `HttpOnly`.
2. Decode the returned `accessToken` (e.g., paste into jwt.io locally, or log the payload in a
   test).
   **Expected**: contains `userId`, `role`, and that account's `companyId`.
3. Repeat with the seeded Super Admin account.
   **Expected**: same shape, but no `companyId` claim (or an explicit "all companies" marker)
   instead.

## Scenario 2 — Enumeration-safe rejection (User Story 2)

1. `POST /auth/login` with an unregistered email + any password.
2. `POST /auth/login` with a registered active account's email + wrong password.
3. `POST /auth/login` with a deactivated account's correct email/password.
   **Expected for all three**: identical 401 body `{ "message": "Invalid email or password" }` —
   diff the raw response bytes across all three to confirm no difference.
4. `POST /auth/login` with a missing `password` field.
   **Expected**: 400, not 401 — rejected before any credential check.

## Scenario 3 — Refresh rotation, reuse detection, and remember-me expiry (User Story 3)

1. Log in with `rememberMe: true`; capture the refresh cookie (call it `R0`).
2. `POST /auth/refresh-token` using `R0`.
   **Expected**: 200, a new access token, and a new refresh cookie (`R1`) — `R0` is now "used."
3. `POST /auth/refresh-token` using `R0` again (replay the already-rotated token).
   **Expected**: 403 (reuse detected); a subsequent attempt with `R1` (which was valid a moment
   ago) **also now fails**, because reuse revokes the whole family.
4. Log in again fresh, confirm a normal refresh chain works repeatedly without triggering reuse
   detection (each new token used exactly once).
5. (If feasible to fast-forward in a test environment) confirm a refresh attempt fails once 30
   days have elapsed from the original `rememberMe: true` login.
6. While signed in, directly flip the account's `status` to deactivated in the database, then make
   any authenticated request with the still-unexpired access token.
   **Expected**: rejected (401) — re-validated against current DB state, not the token's claims.

## Scenario 4 — Logout scoped to one session (User Story 4)

1. Log in twice for the same account (two separate login calls, two separate cookie jars — two
   sessions).
2. `POST /auth/logout` using the first session's cookie.
   **Expected**: 200; a subsequent `/auth/refresh-token` with that same cookie now fails.
3. Confirm the second session's cookie still refreshes successfully — logout only revoked the
   first session's family.

## Scenario 5 — Brute-force lockout (User Story 5)

1. `POST /auth/login` with a wrong password for one seeded account, 5 times consecutively.
2. **Expected after the 5th**: the account is locked; a lockout email is sent (check the test
   email sink/log).
3. A 6th attempt with the *correct* password while still locked.
   **Expected**: 423, not 200 or 401.
4. Wait for (or fast-forward) the 15-minute window, then log in with the correct password.
   **Expected**: 200; `consecutiveFailures` back to 0.
5. Drive a high volume of requests from one client in a short window.
   **Expected**: eventually 429, independent of which account(s) were targeted.

## Scenario 6 — Role-restricted endpoint (User Story 6)

1. Add (or use an existing test-only) endpoint decorated with a role requirement, e.g.
   `@Roles('SUPER_ADMIN')`.
2. Call it with a non-Super-Admin account's valid access token.
   **Expected**: 403, before the endpoint's own logic runs (verify via a log/side-effect that never
   fires).
3. Call it with the Super Admin account's token.
   **Expected**: succeeds normally.
4. Call an endpoint with no `@Roles(...)` decorator using any authenticated account.
   **Expected**: succeeds — no role check applied, matching today's behavior.

## Cross-cutting checks

- After Scenarios 2, 3 (step 3), 4, and 5, inspect the audit log table directly and confirm one row
  per event with the correct `eventType`, actor/`attemptedEmail`, `companyId`, timestamp, and IP —
  and confirm no row anywhere contains a password or raw token value.
- Confirm `/api` (Swagger) reflects the new/changed DTOs for `/auth/login`,
  `/auth/refresh-token`, and `/auth/logout`.
- Confirm no request in this quickstart succeeds over plain HTTP in a non-local environment.
