---

description: "Task list for feature implementation"
---

# Tasks: Account Creation Backend (Invite Flow)

**Input**: Design documents from `/specs/010-account-creation-backend/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md,
contracts/account-creation-api.md, quickstart.md

**Tests**: Included for auth/password-adjacent paths (token validation, set-password, status
transitions) — required by the constitution for endpoints touching account creation/activation.

**Organization**: Tasks are grouped by user story (from spec.md) to enable independent
implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1–US3)
- Every task includes an exact file path

---

## Phase 1: Setup (Shared Infrastructure)

- [ ] T001 [P] Add `resend` to `package.json`; add `RESEND_API_KEY` to `.env.example` and the
      `@nestjs/config` schema — constitution v1.3.0, research.md §5
- [ ] T002 [P] Scaffold `src/account-creation/` directory and `AccountCreationModule` in
      `src/account-creation/account-creation.module.ts` with the sub-module structure from plan.md
- [ ] T003 [P] Create `src/shared/email/email.service.ts`: `EmailService` wrapping `resend`,
      `sendInviteEmail(email, token, isResend)` using a single defined-constant template — exported
      from a shared module — research.md §5
- [ ] T004 [P] Create `src/account-creation/constants/account-creation.constants.ts` with
      `INVITE_TOKEN_TTL_HOURS = 48` and the password-complexity regex (reused from 001's own
      constant if it's already centralized there — otherwise define once here and have 001
      reference it) — Constitution Principle III

**Checkpoint**: Module scaffold and email service ready.

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [ ] T005 Extend `shared.User` in `prisma/schema.prisma`: `status` enum +`pending` value, add
      `displayName String?`, relax `password` to nullable — data-model.md
- [ ] T006 Add `InviteToken` model to `shared` schema in `prisma/schema.prisma` — data-model.md
- [ ] T007 Generate and apply the migration (`migrate:dev:create`/`migrate:dev`) — Constitution
      Principle VI
- [ ] T008 [P] Extend `shared.AuditLogEntry.entityType` enum with `USER_ACCOUNT` —
      contracts/account-creation-api.md "Audit logging"
- [ ] T009 [P] Implement `HrService.getUnlinkedEmployees(companyId, search?)` and
      `.linkEmployeeToUser(employeeId, userId)` in `005-hr-payroll-backend`'s
      `src/hr/employees/employees.service.ts` (cross-feature task — see that feature's T026a) and
      export from `HrModule`

**Checkpoint**: Schema, audit enum, and the 005 cross-feature dependency ready. User story phases
can now proceed.

---

## Phase 3: User Story 1 — Admin Creates a User (Priority: P1) 🎯 MVP

**Goal**: Admin submits the create-user form; a `pending` account is created and an invite email
is dispatched via Resend.

**Independent Test**: Submit create-user with a seeded role/company, confirm a `pending` row with
no password exists, confirm invite dispatch (mocked Resend in test).

### Implementation for User Story 1

- [ ] T010 [P] [US1] Create `src/account-creation/users/dto/create-user.dto.ts`: `email`, `roleId`,
      `companyId?`, `employeeId?`, `displayName?` with conditional `class-validator` rules
      (companyId required unless role resolves to Super Admin; employeeId XOR displayName)
- [ ] T011 [P] [US1] Implement `TokenService.generate()` in
      `src/account-creation/invites/token.service.ts`: `crypto.randomBytes(32).toString('hex')` +
      SHA-256 hash, returns `{ raw, hash }` — research.md §2
- [ ] T012 [US1] Implement `UsersService.create()` in
      `src/account-creation/users/users.service.ts`: single transaction — validate role/company
      combination, check email uniqueness across all statuses (409 with distinct messages per
      spec US1 AC6), optionally call `HrService.linkEmployeeToUser()` (409 if already linked),
      insert `User` (`status: 'pending'`), generate+store `InviteToken` (T011), call
      `EmailService.sendInviteEmail()` (awaited, failure → `emailDispatchFailed: true`, no
      rollback) (depends on T005, T006, T009, T011)
- [ ] T013 [US1] Implement `UsersService.findAllForCompany()`, `.updateRoleOrStatus()` (rejects a
      direct `status: 'active'` write against a `pending` account with `400` — the guard lives
      here, not in any controller, so it applies identically no matter which feature's controller
      calls it), `.deleteAccount()` (also removes any associated `InviteToken` row),
      `.countByRoleId()`, `.clearRoleAssignment()`, `.countActiveSuperAdmins()` — exported from
      `AccountCreationModule` for `002-settings-backend` to import and call from its own
      `users-admin` controller (research.md §8; not exposed via any controller in this feature)
      (depends on T012)
- [ ] T014 [US1] Implement `UsersController` in
      `src/account-creation/users/users.controller.ts`: `POST /account-creation/users`,
      `GET /account-creation/employees/unlinked` (proxies `HrService.getUnlinkedEmployees()`) —
      `@RequirePermission(Permission.USER_MANAGEMENT)`. No `GET`/`PATCH`/`DELETE` here — that
      surface is `002-settings-backend`'s `/settings/users` (depends on T012, T013)
- [ ] T015 [P] [US1] Unit test `UsersService`: `create()` email-uniqueness-across-statuses (active
      vs. deactivated distinct messages), employeeId-already-linked → 409, Super-Admin +
      companyId → 400, non-Super-Admin without companyId → 400; `updateRoleOrStatus()` rejects a
      direct `pending → active` write with `400` (full transition-guard matrix: all 6 status-pair
      combinations, 3 valid + 3 rejected) —
      `src/account-creation/users/users.service.spec.ts`
- [ ] T016 [US1] E2e test: `POST /account-creation/users` → 201, `pending` status, no password
      queryable, mocked `EmailService.sendInviteEmail` called with the right args —
      `test/account-creation.e2e-spec.ts` (create the file)

**Checkpoint**: Admin can create a user; invite email dispatch verified.

---

## Phase 4: User Story 2 — Invitee Sets Password (Priority: P1)

**Goal**: Invitee validates their token, sets a password, account activates and can log in via
001's existing endpoint.

**Independent Test**: Generate an invite token, call validate then set-password, confirm
subsequent `POST /auth/login` succeeds.

### Implementation for User Story 2

- [ ] T017 [P] [US2] Create `src/account-creation/invites/dto/set-password.dto.ts`: `password`
      with the complexity regex (T004)
- [ ] T018 [P] [US2] Implement `InvitesService.validate(rawToken)` in
      `src/account-creation/invites/invites.service.ts`: hash lookup, returns
      `{ valid, email? }` or `{ valid: false, reason }` — research.md §2
- [ ] T019 [US2] Implement `InvitesService.setPassword(rawToken, password)`: single transaction —
      re-validate token, hash password via 001's `PasswordService`, set `User.status = 'active'`,
      mark `InviteToken.consumedAt`; throws `410` for expired/consumed (depends on T018)
- [ ] T020 [US2] Implement `InvitesController` in
      `src/account-creation/invites/invites.controller.ts` (no `JwtAuthGuard`, rate-limited via
      `@nestjs/throttler`): `GET /account-creation/invites/:token`,
      `POST /account-creation/invites/:token/set-password` (depends on T018, T019)
- [ ] T021 [P] [US2] Unit test `InvitesService`: valid token, expired token, consumed token,
      password-complexity rejection — `src/account-creation/invites/invites.service.spec.ts`
- [ ] T022 [US2] E2e test: full loop — create user (T016's helper) → extract raw token
      (test-only DB read, since the raw value is never returned by any real endpoint) → validate →
      set-password → `POST /auth/login` with the new password succeeds; a second set-password call
      against the same token → 410 — `test/account-creation.e2e-spec.ts`

**Checkpoint**: Full invite → active-account → login loop works end-to-end.

---

## Phase 5: User Story 3 — Resend Invite (Priority: P2)

**Goal**: Admin can resend a pending invite. (Deactivate/reactivate of already-existing accounts is
`002-settings-backend`'s own scope, calling into this feature's `UsersService.updateRoleOrStatus()`
— already implemented in T013; not rebuilt here.)

**Independent Test**: Resend a pending user's invite and confirm the old token is invalidated while
the new one works.

### Implementation for User Story 3

- [ ] T023 [P] [US3] Implement `UsersService.resendInvite(userId)`: `409` if not `pending`,
      otherwise generate+store a new `InviteToken` (T011) and call
      `EmailService.sendInviteEmail(..., isResend: true)` (depends on T012)
- [ ] T025 [US3] Add `POST /account-creation/users/:id/resend-invite` to
      `users.controller.ts` — `Permission.USER_MANAGEMENT` (depends on T023)
- [ ] T026 [US3] Wire audit logging (entityType `USER_ACCOUNT`) into create (T012) and resend
      (T023) paths — spec FR-014
- [ ] T027 [P] [US3] Unit test `UsersService.resendInvite()`: `409` on non-pending account, new
      token replaces old on a pending one — `src/account-creation/users/users.service.spec.ts`
- [ ] T028 [US3] E2e test: resend → old token now `{ valid: false, reason: 'consumed' }`, new
      token works; resend on an already-`active` account → `409` — `test/account-creation.e2e-spec.ts`

**Checkpoint**: Resend-invite functional and e2e tested. The `UsersService` methods
`002-settings-backend` needs for deactivate/reactivate/delete were already implemented in T013 —
verify that feature's own e2e suite covers the deactivate→login-fails→reactivate→login-succeeds
loop, since it isn't duplicated here.

---

## Dependencies

```
Phase 1 (Setup) → Phase 2 (Schema + 005 amendment) → US1 (Create) → US2 (Activate) → US3 (Lifecycle)
```

US2 depends on US1 (needs a `pending` user + token to exist). US3 depends on US1 (resend needs a
`pending` user). `002-settings-backend`'s own deactivate/reactivate work depends on US1's T013
(`UsersService.updateRoleOrStatus()`), which ships as part of US1, not US3.

## Parallel execution opportunities

- T001, T002, T003, T004 (Setup) are all independent
- T010, T011 are independent (DTO, token service)
- T017, T018 are independent (DTO, validate logic)
- T015, T021, T027 (unit tests) are independent of each other once their respective services exist

## Implementation Strategy

**MVP (Phase 1–4, US1–US2)**: Setup, schema, and the full create→activate→login loop, plus the
exported `UsersService` methods `002-settings-backend` needs. This alone closes the gap 001/002
both deferred — an admin can onboard a user end-to-end, and 002's existing account-administration
endpoints (list/edit/deactivate/reactivate/delete) become fully functional against real data.

**Increment 2 (Phase 5, US3)**: Resend invite — ongoing invite-lifecycle management.
