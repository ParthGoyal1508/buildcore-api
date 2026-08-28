# Contract: `/auth/*` endpoints

This is this repo's own implementation of the contract `buildcore-web` already targets
(`buildcore-web/specs/001-user-login/contracts/auth-api.md`), reconciled with this repo's stricter
constitutional requirements (rotation + reuse detection, cookie-only refresh tokens, Super Admin
exception). Where the two differ, this document governs the actual backend behavior; the web
contract's *observable* behavior (what a client sees) remains compatible.

## `POST /auth/login`

**Request** (`LoginDto`, extended):
```ts
{ identifier: string; password: string; rememberMe: boolean }
```
`identifier` is either the account's email or its username — the service looks up by whichever
matches (FR-001). Validated via `class-validator`; unexpected fields rejected (global
`ValidationPipe` with `whitelist`/`forbidNonWhitelisted`, per Constitution Principle II).

**Response — 200 OK**:
```ts
{ accessToken: string; name: string; mustChangePassword: boolean }
```
- Sets the refresh token as a `Secure; HttpOnly; SameSite=Strict` cookie (never in the body).
  `Max-Age` = 30 days if `rememberMe`, otherwise a session cookie (no `Max-Age`).
- `accessToken`'s claims include `userId`, `role`, and `companyId` — except for a Super Admin
  account, whose token carries no `companyId` claim (or an explicit `allCompanies: true` marker)
  instead (FR-005, FR-020a).

**Response — 401 Unauthorized** (unregistered email/username, wrong password, or deactivated
account — indistinguishable, FR-002):
```ts
{ message: "Invalid email or password" }
```

**Response — 423 Locked** (account within its 15-minute lockout window, FR-014):
```ts
{ message: string } // states the account is locked and approximately when it unlocks
```
Returned even for a correct password.

**Response — 429 Too Many Requests** (source-address rate limit exceeded, FR-016):
```ts
{ message: "Too many attempts. Please try again later." }
```

**Response — 400 Bad Request**: standard DTO validation failure (missing/malformed fields).

## `POST /auth/refresh-token`

**Request**: no body — the refresh-token cookie is read automatically.

**Response — 200 OK**: `{ accessToken: string }`; the refresh cookie is re-issued (new token, same
family, old one marked used — FR-007).

**Response — 401 Unauthorized**: cookie missing, expired, or already revoked.

**Response — 403 Forbidden** *(reuse detected, FR-008)*: the presented token was already used by a
prior rotation. Every token in its family is revoked as a side effect of this response; an audit
entry (`refresh_reuse_detected`) is recorded. The client should treat this identically to a 401 for
UI purposes (return to `/login`) — the distinct status exists for observability, not for the
frontend to branch on differently.

## `POST /auth/logout`

**Request**: no body — acts on the current refresh cookie.

**Response — 200 OK**: the presented token's entire family is revoked (FR-011); the cookie is
cleared in the response. Other sessions/families for the same account are unaffected.

## Every authenticated request (existing `JwtAuthGuard` + new re-validation, FR-009)

On every request bearing an access token, the guard chain MUST re-check the account's current
`status` (and, if changed, `role`) against the database — not merely trust the token's claims —
and reject with 401 if the account no longer qualifies. This applies uniformly, including to a
Super Admin's cross-company-scoped token.

## `POST /auth/admin/reset-password` (FR-022, FR-022a)

**Request**:
```ts
{ targetAccountId: string; temporaryPassword: string }
```
Restricted to an admin role via the FR-010 role guard, scoped to the target account's own company
(Super Admin exempt from that scoping, per FR-020a). Validated via `class-validator` the same as
every other endpoint here (Principle II).

**Response — 200 OK**: `{ success: true }`. Side effects (FR-022, data-model.md "Admin Password
Reset"): target account's `password` is overwritten with the argon2 hash of `temporaryPassword`,
`mustChangePassword` is set `true`, every active refresh-token session for that account is revoked,
and an `admin_password_reset` audit entry is recorded.

**Response — 403 Forbidden**: caller lacks an admin role, or (non-Super-Admin caller) the target
account belongs to a different company.

**Response — 404 Not Found**: `targetAccountId` does not resolve to an existing account.

**Response — 400 Bad Request**: standard DTO validation failure.

## Role-restricted endpoints (FR-010, any future endpoint — not just auth's own)

An endpoint declaring required roles (e.g., `@Roles('SUPER_ADMIN')`) rejects an authenticated
request from an account without one of those roles with 403, before the endpoint's own handler
logic runs. An endpoint with no such declaration remains authenticated-only, matching today's
`UsersController` behavior unchanged.
