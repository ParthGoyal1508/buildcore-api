# Data Model: User Login Backend & Access Control

All entities below live in this repository's own database (unlike the `buildcore-web` feature,
which never models data directly — Constitution Principle V is this repo's own concern, not a
constraint on itself). Field names are conceptual; exact Prisma types are a task-level decision.

## User Account (extends the existing placeholder `User` model)

| Field | Type | Notes |
|---|---|---|
| `id` | string | Existing |
| `email` | string | Existing, unique — already case-sensitive at the DB level; lookups MUST normalize (lowercase + trim) at the service layer (FR-003) |
| `password` | string | Existing — already argon2-hashed via `PasswordService` |
| `role` | enum | Existing (`Role` enum: currently `ADMIN`/`USER`) — extended per the PRD's full role list as a separate concern (Account Creation feature); this feature only reads/compares it |
| `companyId` | string \| null | **NEW** — required for every role except Super Admin; `null` only for Super Admin (research.md §5) |
| `status` | enum: `active` \| `deactivated` | **NEW** |
| `mustChangePassword` | boolean | **NEW** |
| `consecutiveFailures` | integer | **NEW** — resets to 0 on success (FR-013) |
| `lockedUntil` | timestamp \| null | **NEW** — set when `consecutiveFailures` reaches 5 (FR-012) |

## Refresh Token (new — the "Session" from buildcore-web's data-model.md, made concrete)

| Field | Type | Notes |
|---|---|---|
| `id` | string | Internal identifier |
| `tokenHash` | string | Hash of the opaque token value actually sent to the client — the raw value is never stored (mirrors password hashing practice) |
| `familyId` | string | Shared by every token descended from one original login; reuse of any non-current member revokes the whole family (FR-008) |
| `accountId` | string | FK to User Account |
| `rememberMe` | boolean | Set once, from the original login's "remember me" choice, and copied onto every token rotated within the same family — determines each rotation's cookie `Max-Age` (FR-006) |
| `used` | boolean | Set true the moment this token is rotated (exchanged for a new one) |
| `revokedAt` | timestamp \| null | Set on logout (FR-011), reuse detection (FR-008), or account deactivation |
| `expiresAt` | timestamp | `now + 30 days` if issued under "remember me," otherwise a short session-length default (FR-006) |

State transitions:
- Login succeeds → new row, `familyId = <new random id>`, `rememberMe` set from the login request,
  `used = false`
- Refresh with a valid, unused, unexpired token → that row's `used → true`; a new row is inserted
  sharing the same `familyId` and copying its `rememberMe` value, with `expiresAt` computed from it
- Refresh with a token whose row has `used = true` (reuse) → every row sharing that `familyId` gets
  `revokedAt = now`; an audit event is recorded (FR-008, FR-017)
- Logout → every currently-active row in the presented token's `familyId` gets `revokedAt = now`
  (FR-011) — only that family, not the account's other sessions
- Account deactivated, or role changed in a way that revokes access → every row for that
  `accountId` gets `revokedAt = now` (FR-009's re-validation is what actually enforces this on the
  next request; eagerly revoking rows is a defense-in-depth cleanup, not the sole enforcement point)

## Audit Log Entry (new)

| Field | Type | Notes |
|---|---|---|
| `id` | string | |
| `eventType` | enum: `login_success` \| `login_failure` \| `account_locked` \| `logout` \| `refresh_reuse_detected` | |
| `accountId` | string \| null | Null only for `login_failure` against an unregistered email |
| `attemptedEmail` | string \| null | Populated only when `accountId` is null, so an unregistered-email failure is still traceable without ever inventing an account reference |
| `companyId` | string \| null | Copied from the account at the time of the event; null for both an unregistered-email failure and any Super-Admin-related event |
| `ipAddress` | string | |
| `createdAt` | timestamp | |

Never includes: a password (attempted or stored), a raw refresh/access token value, or any field
not listed above (FR-017's "no password material" requirement).

## Role/Permission Requirement (code-level metadata, not a table)

Represented as decorator metadata (e.g., `@Roles('SUPER_ADMIN', 'HO_USER')`) attached to a
controller method, read at request time by the guard described in research.md §6. Listed here for
completeness since spec.md's Key Entities calls it out, but it has no database row of its own —
its "state" is simply whatever roles a given endpoint's source code declares.

## Cross-reference to buildcore-web's data-model.md

| buildcore-web concept | This repo's equivalent |
|---|---|
| Session | Refresh Token (family) above — buildcore-web never sees the row, only the resulting cookie/token behavior |
| Login Attempt Record | Folded into User Account's `consecutiveFailures`/`lockedUntil` (research.md §4) rather than a separate table |
| Activity Log Entry | Audit Log Entry above — same concept, this repo's actual schema for it |
| User Account | Same entity, now with the fields this feature adds |
