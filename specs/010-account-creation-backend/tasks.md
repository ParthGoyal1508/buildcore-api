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

- [X] T001 [P] Add `resend` to `package.json`; add `RESEND_API_KEY` to `.env.example` and the
      `@nestjs/config` schema — constitution v1.3.0, research.md §5
- [X] T002 [P] Scaffold `src/account-creation/` directory and `AccountCreationModule` in
      `src/account-creation/account-creation.module.ts` with the sub-module structure from plan.md
- [X] T003 [P] Create `src/shared/email/email.service.ts`: `EmailService` wrapping `resend`,
      `sendInviteEmail(email, token, isResend)` using a single defined-constant template — exported
      from a shared module — research.md §5
- [X] T004 [P] Create `src/account-creation/constants/account-creation.constants.ts` with
      `INVITE_TOKEN_TTL_HOURS = 48` and the password-complexity regex (reused from 001's own
      constant if it's already centralized there — otherwise define once here and have 001
      reference it) — Constitution Principle III

**Checkpoint**: Module scaffold and email service ready.

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T005 Extend `shared.User` in `prisma/schema.prisma`: `status` enum +`pending` value, add
      `displayName String?`, relax `password` to nullable — data-model.md
- [X] T006 Add `InviteToken` model to `shared` schema in `prisma/schema.prisma` — data-model.md
- [X] T007 Generate and apply the migration (`migrate:dev:create`/`migrate:dev`) — Constitution
      Principle VI
- [X] T008 [P] Extend `shared.AuditLogEntry.entityType` enum with `USER_ACCOUNT` —
      contracts/account-creation-api.md "Audit logging"
- [X] T009 [P] Implement `HrService.getUnlinkedEmployees(companyId, search?)` and
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

- [X] T010 [P] [US1] Create `src/account-creation/users/dto/create-user.dto.ts`: `email`, `roleId`,
      `companyId?`, `employeeId?`, `displayName?` with conditional `class-validator` rules
      (companyId required unless role resolves to Super Admin; employeeId XOR displayName)
- [X] T011 [P] [US1] Implement `TokenService.generate()` in
      `src/account-creation/invites/token.service.ts`: `crypto.randomBytes(32).toString('hex')` +
      SHA-256 hash, returns `{ raw, hash }` — research.md §2
- [X] T012 [US1] Implement `UsersService.create()` in
      `src/account-creation/users/users.service.ts`: single transaction — validate role/company
      combination, check email uniqueness across all statuses (409 with distinct messages per
      spec US1 AC6), optionally call `HrService.linkEmployeeToUser()` (409 if already linked),
      insert `User` (`status: 'pending'`), generate+store `InviteToken` (T011), call
      `EmailService.sendInviteEmail()` (awaited, failure → `emailDispatchFailed: true`, no
      rollback) (depends on T005, T006, T009, T011)
- [X] T013 [US1] Implement `UsersService.findAllForCompany()`, `.updateRoleOrStatus()` (rejects a
      direct `status: 'active'` write against a `pending` account with `400` — the guard lives
      here, not in any controller, so it applies identically no matter which feature's controller
      calls it), `.deleteAccount()` (also removes any associated `InviteToken` row),
      `.countByRoleId()`, `.clearRoleAssignment()`, `.countActiveSuperAdmins()` — exported from
      `AccountCreationModule` for `002-settings-backend` to import and call from its own
      `users-admin` controller (research.md §8; not exposed via any controller in this feature)
      (depends on T012)
- [X] T014 [US1] Implement `UsersController` in
      `src/account-creation/users/users.controller.ts`: `POST /account-creation/users`,
      `GET /account-creation/employees/unlinked` (proxies `HrService.getUnlinkedEmployees()`) —
      `@RequirePermission(Permission.USER_MANAGEMENT)`. No `GET`/`PATCH`/`DELETE` here — that
      surface is `002-settings-backend`'s `/settings/users` (depends on T012, T013)
- [X] T015 [P] [US1] Unit test `UsersService`: `create()` email-uniqueness-across-statuses (active
      vs. deactivated distinct messages), employeeId-already-linked → 409, Super-Admin +
      companyId → 400, non-Super-Admin without companyId → 400; `updateRoleOrStatus()` rejects a
      direct `pending → active` write with `400` (full transition-guard matrix: all 6 status-pair
      combinations, 3 valid + 3 rejected) —
      `src/account-creation/users/users.service.spec.ts`
- [X] T016 [US1] E2e test: `POST /account-creation/users` → 201, `pending` status, no password
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

- [X] T017 [P] [US2] Create `src/account-creation/invites/dto/set-password.dto.ts`: `password`
      with the complexity regex (T004)
- [X] T018 [P] [US2] Implement `InvitesService.validate(rawToken)` in
      `src/account-creation/invites/invites.service.ts`: hash lookup, returns
      `{ valid, email? }` or `{ valid: false, reason }` — research.md §2
- [X] T019 [US2] Implement `InvitesService.setPassword(rawToken, password)`: single transaction —
      re-validate token, hash password via 001's `PasswordService`, set `User.status = 'active'`,
      mark `InviteToken.consumedAt`; throws `410` for expired/consumed (depends on T018)
- [X] T020 [US2] Implement `InvitesController` in
      `src/account-creation/invites/invites.controller.ts` (no `JwtAuthGuard`, rate-limited via
      `@nestjs/throttler`): `GET /account-creation/invites/:token`,
      `POST /account-creation/invites/:token/set-password` (depends on T018, T019)
- [X] T021 [P] [US2] Unit test `InvitesService`: valid token, expired token, consumed token,
      password-complexity rejection — `src/account-creation/invites/invites.service.spec.ts`
- [X] T022 [US2] E2e test: full loop — create user (T016's helper) → extract raw token
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

- [X] T023 [P] [US3] Implement `UsersService.resendInvite(userId)`: `409` if not `pending`,
      otherwise generate+store a new `InviteToken` (T011) and call
      `EmailService.sendInviteEmail(..., isResend: true)` (depends on T012)
- [X] T025 [US3] Add `POST /account-creation/users/:id/resend-invite` to
      `users.controller.ts` — `Permission.USER_MANAGEMENT` (depends on T023)
- [X] T026 [US3] Wire audit logging (entityType `USER_ACCOUNT`) into create (T012) and resend
      (T023) paths — spec FR-014
- [X] T027 [P] [US3] Unit test `UsersService.resendInvite()`: `409` on non-pending account, new
      token replaces old on a pending one — `src/account-creation/users/users.service.spec.ts`
- [X] T028 [US3] E2e test: resend → old token now `{ valid: false, reason: 'consumed' }`, new
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

---

## Phase 6: Convergence

Appended by a convergence pass after all 27 tasks were implemented and green (234 unit,
150 e2e, lint clean). The constitution checks passed and every endpoint in
`contracts/account-creation-api.md` exists. The items below are what the assessment
found, and the first one is a regression this feature introduced into feature 001.

- [X] T029 **CRITICAL** — Null-guard the stored password before verifying it in
      `src/auth/auth.service.ts` (~line 123), and again at `src/users/users.service.ts`
      (~line 55). This feature relaxed `shared.User.password` to nullable so a `pending`
      row can exist, but login still passes it straight to `argon2.verify`, which throws
      `TypeError: pchstr must be a non-empty string` on null — verified directly. The
      status check that would have rejected the account sits *after* that call, so it is
      never reached. Two consequences: `POST /auth/login` returns 500 rather than 401 for
      any invited-but-not-yet-activated email, and the difference between that 500 and a
      401 for an unknown address is an account-enumeration oracle that defeats the
      deliberately generic `GENERIC_INVALID_CREDENTIALS` message 001 chose. Treat a null
      password as "not a valid credential" and let the existing generic path handle it;
      add an e2e case asserting a pending account's login attempt returns 401, not 500
      per FR-001, 001 FR-011 (contradicts)

- [X] T030 Point `002-settings-backend`'s account administration at the guarded service.
      `src/settings/users-admin/users-admin.service.ts` imports `UsersService` from
      `../../users/users.service` — feature 001's implementation — whose
      `updateRoleOrStatus()` has no pending-account check. FR-008 requires the
      `status: 'active'` rejection to hold "regardless of which feature's controller
      invokes it" and explicitly names 002's `PATCH /settings/users/:id` as the
      admin-facing entry point for it, so the rule is currently unenforced on the only
      path that can reach it. An admin can today activate a pending account directly,
      producing an `active` row with a null password — which then triggers T029
      per FR-008 (missing)

- [X] T031 Consolidate the two `UsersService` implementations. `findAllForCompany`,
      `updateRoleOrStatus`, `deleteAccount`, `countByRoleId`, `clearRoleAssignment` and
      `countActiveSuperAdmins` now exist in both `src/users/users.service.ts` and
      `src/account-creation/users/users.service.ts`. research.md §8 called for these to
      live in one place — it assumed 001 had never built them, which is why T013 wrote a
      second copy rather than extending the first. Two implementations of the same six
      operations is exactly how T030's gap arose, and it will keep arising: any future
      rule added to one will silently not apply to callers of the other. Pick one owner
      (this feature, per §8), migrate 002's callers, and delete the duplicates
      per research.md §8 (unrequested)

- [X] T032 Write an audit entry when an invite is redeemed. FR-014 names three events —
      user creation, invite resend, and **successful set-password (activation)** — and
      `src/account-creation/invites/invites.service.ts` writes none for the third.
      Creation and resend are covered. Activation is the one that turns an account into a
      usable credential, so its absence is the most consequential of the three to be
      missing from the Activity Log. Use entityType `USER_ACCOUNT` with the activating
      account as `accountId`, and do not record the raw token
      per FR-014 (missing)

---

## Phase 8: Amendment 2026-09-01 — direct account creation with an admin-set password

**Goal**: An admin can create an account with a password instead of an invite, and that password
must be replaced before the account can do anything.

**Independent Test**: Create an account with a password; confirm no invite token exists and no email
was dispatched; sign in with it; confirm every endpoint but the four exemptions is refused with
`403 PASSWORD_CHANGE_REQUIRED`; change the password; confirm the refusal stops without re-login.

### Foundational — schema (blocks everything below)

- [X] T033 Add a `CredentialOrigin` enum (`invite` | `admin_direct` | `admin_reset`) and a
      `credentialOrigin` column on `shared.User` in `prisma/schema.prisma`, backfilled to `invite`
      for existing rows — which is what every account created before this amendment is
      per FR-017a-i, data-model.md

- [X] T034 Set `credentialOrigin` on the paths that already create or reset credentials: `invite`
      in `src/account-creation/users/users.service.ts`, `admin_reset` in
      `src/auth/auth.service.ts`'s admin-reset path. Without this the column is accurate only for
      new direct creations
      per FR-017a-i

### User Story 4 — direct creation (P2)

- [X] T035 [US4] Add an optional `password` to `CreateUserDto` in
      `src/account-creation/users/dto/create-user.dto.ts`, validated against the same complexity
      rule as the invitee's own (min 8, 1 uppercase, 1 number)
      per FR-015, FR-016

- [X] T036 [US4] Branch `UsersService.create()` in
      `src/account-creation/users/users.service.ts`: with a password, create `status: 'active'`,
      argon2-hashed via 001's `PasswordService`, `mustChangePassword: true`,
      `credentialOrigin: 'admin_direct'`, and skip token generation and email entirely; without
      one, leave today's invite flow untouched
      per FR-015, FR-018

- [X] T037 [US4] Validate the password before any row is written, so a rejected attempt leaves no
      account, no employee link and no token behind
      per FR-016

- [X] T038 [US4] Record the creation in the audit log distinguishably from an invited one, and
      ensure the password appears nowhere in it — not the value, not a hash, not a length
      per FR-014

### Forced password change (the enforcement FR-017a–d depends on)

- [X] T039 Clear `mustChangePassword` in the same update as the new hash in
      `UsersService.changePassword()` (`src/users/users.service.ts`). Left set, the user is
      redirected on every login with no way out
      per FR-017b

- [X] T040 Add a global guard refusing requests from an account with
      `credentialOrigin: 'admin_direct'` and `mustChangePassword` still set, returning `403` with a
      `PASSWORD_CHANGE_REQUIRED` code in the body. It MUST read the account state re-read per
      request by `jwt.strategy.ts`, never the JWT claim, or the refusal would outlive the change
      until re-login
      per FR-017a

- [X] T041 Add the opt-out decorator following `src/common/decorators/permissions.decorator.ts`'s
      `SetMetadata` + `Reflector` pattern, and apply it to exactly four routes:
      `POST /users/change-password`, `GET /users/me`, `POST /auth/refresh-token`,
      `POST /auth/logout`. Exempting must be deliberate; a rule that fails open on forgetfulness is
      not a rule
      per FR-017a

- [X] T042 Ensure an absent or unrecognised `credentialOrigin` is never refused — only an explicit
      `admin_direct` triggers the guard, so missing metadata cannot lock a real user out
      per FR-017a-i

### Tests

- [X] T043 [P] [US4] Unit-test `UsersService.create()` both ways in
      `src/account-creation/users/users.service.spec.ts`: with a password (active, hashed, flagged,
      no token, no email) and without (unchanged invite flow)
      per FR-015

- [X] T044 [P] Unit-test the guard in `src/auth/`: refuses `admin_direct` + flag set; allows the
      same account once the flag clears; allows `invite` and `admin_reset` accounts throughout;
      allows an account with no origin recorded
      per FR-017a, FR-017a-i, FR-017a-ii

- [ ] T045 (PARTIAL) Test each of the four exemptions explicitly rather than assuming them from the
      decorator's presence — this guard sits in the request path of every authenticated endpoint,
      and a mistake in its list locks every user out of everything
      — `GET /users/me` and `PATCH /users/me/password` verified live against a running
      server; `refresh-token` and `logout` are covered only by the generic exempt-path
      unit test, not per-route
      per FR-017a, plan risk note

- [ ] T046 (NOT RUN — needs the e2e suite) E2e: create an account with a password, sign in, confirm a non-exempt endpoint is
      refused with the code, change the password, confirm the same endpoint then succeeds **on the
      same session** — no re-login
      per FR-017a, FR-017b

### Not in scope, recorded

- [ ] T047 (DEFERRED — FR-017d) Revoke sessions issued before a forced password change. Left undone
      while there are no production users; must be revisited before there are, since the forced
      change currently removes the admin's knowledge of the password but not access they already
      hold. 001's refresh-token family revocation is the mechanism
      per FR-017d

- [ ] T048 (DEFERRED — FR-017a-ii) Apply the same enforcement to admin-reset accounts. Excluded
      deliberately so deploying this cannot lock out anyone mid-reset
      per FR-017a-ii

- [X] T049 Reject a password change whose new value matches the current one, comparing against the
      stored hash rather than the submitted `oldPassword` so it holds for every path that reaches
      `changePassword()`. Found in manual testing after Phase 8: without it the forced change was
      defeatable in one step
      per FR-017b-i
