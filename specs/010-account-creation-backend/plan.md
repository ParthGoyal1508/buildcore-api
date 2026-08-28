# Implementation Plan: Account Creation Backend (Invite Flow)

**Branch**: `010-account-creation-backend` | **Date**: 2026-08-28 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/010-account-creation-backend/spec.md`

## Summary

Implement master PRD §7.1's Invite Flow, closing a gap `001-user-login-backend` and
`002-settings-backend` both explicitly deferred to "a separate Account Creation feature" that was
never specced. An admin creates a `pending` `shared.User` row (no password) optionally linked to an
`hr.Employee`; the system emails a single-use, 48-hour invite token via Resend; the invitee sets
their own password to activate the account (`pending → active`); an admin can resend an
unconsumed invite. Requires small amendments to `005-hr-payroll-backend`
(`getUnlinkedEmployees()`/`linkEmployeeToUser()` exports, FR-047) and a constitution amendment
(v1.3.0) pre-approving `resend` for transactional email.

**Reconciliation found while drafting** (research.md §8): this feature's account-list and
deactivate/reactivate endpoints would have duplicated `002-settings-backend`'s already-specced
`GET/PATCH/DELETE /settings/users` (its own User Story 3). This feature does not build those
endpoints — it exports a `UsersService` that both this feature's own `POST /account-creation/users`
and 002's existing controller call into, correcting 002's original (never-fulfilled) assumption
that this service would come from `AuthModule` (001). See [research.md](research.md) for all eight
decisions.

## Technical Context

**Language/Version**: TypeScript 5.1, Node.js, NestJS 10, Prisma 5 against PostgreSQL — unchanged.

**Primary Dependencies**: Existing — `class-validator`/`class-transformer`, `@nestjs/swagger`,
`@nestjs/config`, `nestjs-prisma`, 001's `PasswordService` (argon2) and refresh-token revocation,
`@nestjs/throttler` (pre-approved, first real consumer alongside 001's OTP endpoints). **New**:
`resend` (Node SDK) — constitution v1.3.0, research.md §5.

**Storage**: PostgreSQL via Prisma — `shared` schema: `User` gains `status: 'pending'` value +
`displayName` column (both additive/nullable); new `InviteToken` table.

**Testing**: Jest unit tests for: token generation/hashing, the pending→active transition guard in
`UsersService.updateRoleOrStatus()` (direct write to `active` must be rejected regardless of
caller), email-uniqueness-across-all-statuses check. E2e coverage in
`test/account-creation.e2e-spec.ts` — required since this touches account creation and
password-adjacent flows (Constitution's PII/auth testing gate).

**Target Platform**: Linux server (Node.js), same as rest of `buildcore-api`.

**Project Type**: Web service (backend API) — single NestJS project; new `account-creation` NestJS
module alongside `hr`, `payroll`, `settings`, `shared`.

**Performance Goals**: Invite email dispatch does not block the create-user response beyond a
reasonable Resend API round-trip; a slow/failed send surfaces via `emailDispatchFailed` rather than
timing out the whole request (research.md §5 — fire-and-report, not fire-and-forget: the call is
awaited but never rolls back the DB write on failure).

**Constraints**: `account-creation` module never queries `hr` schema directly — only via
`HrService.getUnlinkedEmployees()`/`.linkEmployeeToUser()` (Principle I, research.md §1); invite
tokens stored only as hashes, raw value never persisted/logged (research.md §2); the two
invite-facing endpoints are the only unauthenticated routes in this feature and MUST be rate-limited
(research.md §7); `User.status` transitions enforced inside the shared `UsersService`, not
duplicated per-caller — `pending → active` only via set-password, never a direct write, enforced
identically whether called from this feature or from `002-settings-backend`'s controller
(research.md §8); no `GET`/`PATCH`/`DELETE` account-administration endpoints under
`/account-creation/*` — that surface stays at 002's `/settings/users` (research.md §8).

**Scale/Scope**: 1 new table (`InviteToken`) + 1 extended (`User`), 4 endpoints under
`/account-creation/*` (create, resend-invite, invite-validate, set-password) plus one small helper
(unlinked-employee picker), 1 exported `UsersService` (6 of its methods consumed by
`002-settings-backend`), 1 new exported `EmailService` in `shared`, 2 new exported `HrService`
methods (005 amendment), 0 new Permission enum values (reuses `USER_MANAGEMENT`).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Check | Status |
|---|---|---|
| I. Schema-Per-Module Boundaries (NON-NEGOTIABLE) | `User`/`InviteToken` in `shared` schema (correct — `User` already lives there per 001). `Employee` link resolved via `HrService.getUnlinkedEmployees()`/`.linkEmployeeToUser()`, never a direct query — research.md §1. `UsersService` exported from this feature for `002-settings-backend` to import, rather than 002 querying `shared.User` itself — research.md §8. | PASS |
| II. Validated DTO Contracts (NON-NEGOTIABLE) | Every endpoint in contracts/account-creation-api.md uses a typed DTO; password complexity validated via `class-validator` regex, matching 001's existing password rule. | PASS |
| III. Centralized Configuration & No Hardcoded Values (NON-NEGOTIABLE) | `RESEND_API_KEY` via `@nestjs/config`; invite-token TTL (48h) and password-complexity regex as named constants, not inline literals; email template a defined constant, not inline string concatenation scattered across the service. | PASS |
| IV. Multi-Tenant Isolation & PII Protection (NON-NEGOTIABLE) | `User.companyId` scoping unchanged from 001; no new regulated-PII field introduced (email/role/company are not Aadhaar/PAN/bank-account class data). Every write this feature makes is audit-logged (FR-014); deactivate/reactivate/role-edit writes are audit-logged by 002's own controller using the same `USER_ACCOUNT` entityType. | PASS |
| V. Authentication, Authorization & Secrets Hygiene | Every admin endpoint behind `JwtAuthGuard` + `@RequirePermission(Permission.USER_MANAGEMENT)` (reused, research.md §6). The two invite-facing endpoints are deliberately public (no session exists yet) and rate-limited (research.md §7) — an explicit, narrow, documented exception, not an oversight. Passwords hashed via 001's existing `PasswordService` (argon2) — no new hashing logic. | PASS |
| VI. Observability & Safe Migrations | `User` status enum extension and `displayName` column are additive/nullable — no data loss risk to existing rows. `InviteToken` is a wholly new table. Migrations via `migrate:dev:create`/`migrate:dev`. | PASS |

**Post-design re-check**: data-model.md keeps `InviteToken` scoped to `shared`, every write
audit-logged, the `pending → active` transition guarded once inside the shared `UsersService`
(not duplicated per-caller), and no endpoint surface duplicated against 002's `/settings/users`.
Still PASS.

## Project Structure

### Documentation (this feature)

```text
specs/010-account-creation-backend/
├── plan.md                    # This file
├── research.md                # Phase 0 output
├── data-model.md              # Phase 1 output
├── quickstart.md              # Phase 1 output
└── contracts/
    └── account-creation-api.md # Phase 1 output
```

### Source Code

```text
src/
├── account-creation/
│   ├── account-creation.module.ts    # exports UsersService for SettingsModule to import
│   ├── users/
│   │   ├── users.controller.ts       # POST /account-creation/users, resend-invite, employee picker
│   │   ├── users.service.ts          # UsersService — create() + the 6 methods 002 imports
│   │   └── dto/
│   │       └── create-user.dto.ts
│   └── invites/
│       ├── invites.controller.ts    # public — no JwtAuthGuard
│       ├── invites.service.ts
│       └── dto/
│           └── set-password.dto.ts
├── shared/
│   └── email/
│       └── email.service.ts         # NEW — resend wrapper, exported
├── hr/
│   └── employees/
│       └── employees.service.ts     # MODIFIED (005) — +getUnlinkedEmployees/+linkEmployeeToUser
└── settings/
    └── users-admin/                 # MODIFIED (002) — imports AccountCreationModule's UsersService
        └── (no new files here — see 002's own plan.md; noted for cross-reference only)

prisma/
└── schema.prisma                    # MODIFIED: User.status +pending, +displayName; new InviteToken

test/
└── account-creation.e2e-spec.ts     # new
```

## Implementation Phases

### Phase 1: Schema & Shared Infrastructure

- [ ] Extend `shared.User.status` enum with `pending`; add `displayName String?`, relax `password`
  to nullable — additive migration
- [ ] Add `InviteToken` model to `shared` schema
- [ ] Generate and apply migration
- [ ] Create `src/shared/email/email.service.ts` wrapping `resend`, exported from a shared module
- [ ] Create `src/account-creation/account-creation.module.ts` scaffold

**Checkpoint**: Schema and email service ready. All user story phases can proceed.

### Phase 2: User Story 1 — Admin creates a user, invite email sent (P1) 🎯 MVP

- [ ] `CreateUserDto` with conditional validation (companyId required unless Super Admin role;
  employeeId XOR displayName)
- [ ] `UsersService.create()`: transaction — insert `User` (status `pending`, no password),
  optionally call `HrService.linkEmployeeToUser()`, generate+store `InviteToken`, call
  `EmailService.sendInviteEmail()` (await, catch → `emailDispatchFailed: true`, does not roll back)
- [ ] `UsersService.findAllForCompany()`, `.updateRoleOrStatus()` (with the pending→active guard),
  `.deleteAccount()`, `.countByRoleId()`, `.clearRoleAssignment()`, `.countActiveSuperAdmins()` —
  exported for `002-settings-backend` to import (research.md §8); not exposed via any controller
  in this feature
- [ ] `UsersController`: `POST /account-creation/users`,
  `GET /account-creation/employees/unlinked` — `Permission.USER_MANAGEMENT`
- [ ] Unit tests: email-uniqueness-across-statuses, employeeId-already-linked guard,
  Super-Admin-companyId-rejection, pending→active-direct-write rejection (exercised via
  `UsersService.updateRoleOrStatus()` directly, not through a controller this feature owns)
- [ ] E2e test: create → pending row exists, no password, invite email dispatched (mocked)

**Checkpoint**: Admin can create a user and an invite goes out.

### Phase 3: User Story 2 — Invitee sets password, account activates (P1)

- [ ] `InvitesController` (public, rate-limited): `GET /account-creation/invites/:token`,
  `POST /account-creation/invites/:token/set-password`
- [ ] `InvitesService`: hash-lookup token, validate expiry/consumed state, on set-password —
  transaction: hash password via 001's `PasswordService`, set `User.status = 'active'`, mark token
  consumed
- [ ] Unit tests: expired token, consumed token, password-complexity rejection, successful
  activation
- [ ] E2e test: full loop — create user → extract token (test-only helper) → validate → set
  password → 001's `POST /auth/login` succeeds with new password

**Checkpoint**: Full invite → active-account loop works end-to-end.

### Phase 4: User Story 3 — Resend invite (P2)

- [ ] `POST /account-creation/users/:id/resend-invite`: new `InviteToken` row, new email, `409`
  guard for non-pending accounts
- [ ] Wire audit logging (entityType `USER_ACCOUNT`) into create and resend-invite paths
- [ ] Unit tests: resend-only-when-pending guard
- [ ] E2e test: resend → old token now `{ valid: false, reason: 'consumed' }`, new token works
- [ ] Cross-feature checkpoint: once `002-settings-backend`'s `users-admin` module is wired against
  this feature's exported `UsersService`, verify (in 002's own e2e suite, not duplicated here)
  that deactivate revokes refresh tokens and reactivate restores login — this feature's own tests
  only cover the service methods it exports, not 002's controller behavior

**Checkpoint**: Resend-invite functional; the exported `UsersService` is ready for 002 to consume
for the rest of the account lifecycle.

## TODO: Cross-feature dependencies

- This feature depends on `005-hr-payroll-backend`'s `HrService.getUnlinkedEmployees()`/
  `.linkEmployeeToUser()` (FR-047, 005's research.md §17) — added to 005's own spec/data-model/
  tasks as part of this feature being specced, not left as a stub, since the employee-link is core
  to User Story 1, not an optional cross-module nicety.
- `002-settings-backend` depends on this feature's exported `UsersService` for its own User Story 2
  (`countByRoleId`/`clearRoleAssignment`) and User Story 3 (`findAllForCompany`/
  `updateRoleOrStatus`/`deleteAccount`/`countActiveSuperAdmins`) — 002's own tasks.md (T041, T050)
  has been updated to point here rather than at its original "AuthModule" assumption
  (research.md §8).
