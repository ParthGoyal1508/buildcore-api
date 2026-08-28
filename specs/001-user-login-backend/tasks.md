---

description: "Task list for feature implementation"
---

# Tasks: User Login Backend & Access Control

**Input**: Design documents from `/specs/001-user-login-backend/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/auth-api.md, quickstart.md

**Tests**: Included. Unlike the counterpart `buildcore-web` feature (which has no test framework
yet), this repo's constitution explicitly requires "new endpoints touching auth ... MUST have an
e2e test," so test tasks are mandatory here, not optional.

**Organization**: Tasks are grouped by user story (from spec.md) to enable independent
implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1–US6)
- Every task includes an exact file path

---

## Phase 1: Setup (Shared Infrastructure)

- [X] T001 Add `@nestjs/throttler` as a dependency and register a base `ThrottlerModule` (global
      defaults) in `src/app.module.ts`, per the constitution's pre-approved addition for this
      module (spec FR-016)
- [X] T002 [P] Add cookie parsing/response-cookie support in `src/main.ts` (e.g. `cookie-parser`,
      or NestJS's built-in `Response.cookie()`) — prerequisite for every refresh-token-cookie task
      below
- [X] T003 [P] Extend `src/common/configs/config.interface.ts`'s `SecurityConfig` with: lockout
      threshold/duration, refresh-cookie lifetimes (remember-me vs. default), and throttler
      limits
- [X] T004 Update `src/common/configs/config.ts` with the new `SecurityConfig` values (env-sourced
      where appropriate) and fold the existing raw `configService.get('JWT_ACCESS_SECRET')` /
      `get('JWT_REFRESH_SECRET')` calls into the same typed config path (research.md §9)

**Checkpoint**: Config and cookie plumbing ready.

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T005 Introduce a `shared` Postgres schema in `prisma/schema.prisma` (Prisma multi-schema
      support) and move the `User` model into it (research.md §10) + migration via
      `migrate:dev:create`
- [X] T006 Extend `User` in `prisma/schema.prisma`: add `companyId` (nullable — null only for
      Super Admin), `status` enum (`active`/`deactivated`), `mustChangePassword` boolean,
      `consecutiveFailures` int, `lockedUntil` timestamp, `username` string (unique) + migration
      (data-model.md "User Account")
- [X] T007 [P] Add a `RefreshToken` model in `prisma/schema.prisma`: `tokenHash`, `familyId`,
      `accountId`, `used`, `revokedAt`, `expiresAt` + migration (data-model.md "Refresh Token")
- [X] T008 [P] Add an `AuditLogEntry` model in `prisma/schema.prisma`: `eventType`, `accountId`,
      `attemptedEmail`, `companyId`, `ipAddress`, `createdAt` + migration (data-model.md "Audit Log
      Entry")
- [X] T009 [P] ~~Create `src/common/decorators/roles.decorator.ts`~~ — superseded during
      implementation by `src/common/decorators/permissions.decorator.ts`'s `@RequirePermissions(...)`
      (data-model.md's 2026-08-28 Role/Permission/UserRole revision: a user holds multiple roles,
      each a set of permissions, rather than one hardcoded role name)
- [X] T010 [P] ~~Create `src/common/guards/roles.guard.ts`~~ — superseded by
      `src/common/guards/permissions.guard.ts`'s `PermissionsGuard`, same reason as T009
- [X] T011 [P] Create `src/auth/refresh-token.service.ts`: issues a new token family on login,
      rotates on use, and detects/handles reuse (revokes the whole family) against the
      `RefreshToken` table — including a short grace window (e.g. a few seconds after a token is
      marked used) that tolerates a benign concurrent-refresh race without treating it as reuse
      (research.md §2, spec.md Edge Cases)
- [X] T012 [P] Create `src/auth/audit-log.service.ts`: a write-only helper for creating
      `AuditLogEntry` rows (research.md §8)
- [X] T013 Update `src/auth/jwt.strategy.ts`: read the JWT secret via the typed config (T004) and
      re-validate the account's current `status` (not just trust the token) on every request
      (FR-009) — this guards every route using `JwtAuthGuard`, so it belongs in Foundational
- [X] T014 Add Postgres Row-Level Security policies (raw-SQL migration) on the `shared` schema's
      tenant-scoped tables, enforcing `companyId` isolation, plus the explicit Super Admin bypass
      condition (research.md §5, FR-020a) — include a comment in the migration/policy SQL noting
      this bypass is intentionally scoped to the Super Admin role only and must not be widened to
      any other role without a constitution amendment (FR-020a's non-extendable requirement)

**Checkpoint**: Foundation ready — user story implementation can now begin.

---

## Phase 3: User Story 1 - Authenticate with valid credentials (Priority: P1) 🎯 MVP

**Goal**: A login request with correct credentials for an active account returns a usable, company-
scoped session.

**Independent Test**: `POST /auth/login` with a seeded active account's correct credentials;
confirm the response and cookie per quickstart.md Scenario 1.

### Tests for User Story 1 ⚠️

- [ ] T015 [P] [US1] e2e test in `test/auth.e2e-spec.ts`: valid login returns `accessToken`,
      `name`, `mustChangePassword`, and a `Set-Cookie` refresh token; decode the access token and
      confirm it carries `companyId` for a normal account and no `companyId` for a Super Admin
      account (quickstart.md Scenario 1)

### Implementation for User Story 1

- [X] T016 [US1] Update `src/auth/dto/login.dto.ts` to add a `rememberMe: boolean` field and
      rename/replace `email` with `identifier: string` (FR-001 — accepts either email or username)
- [X] T017 [US1] Update `src/auth/dto/token.dto.ts` (or introduce a `LoginResponseDto`) to match
      contracts/auth-api.md's 200 shape: `accessToken`, `name`, `mustChangePassword` — no
      `refreshToken` field in the body
- [X] T018 [US1] Update `src/auth/auth.service.ts` `login()` to: look up the account by
      `identifier` matching either `email` or `username` (FR-001), accept an active, non-locked
      account, build the JWT payload with `role` and `companyId` (or the all-companies marker for
      Super Admin, FR-005), issue a new refresh-token family via `refresh-token.service.ts`, and
      write an audit `login_success` entry
- [X] T019 [US1] Update `src/auth/auth.controller.ts`'s `POST /auth/login` to accept the new DTO,
      set the refresh-token cookie (`Max-Age` per `rememberMe`), and return the new response DTO
- [X] T020 [P] [US1] Register `RefreshTokenService` and `AuditLogService` as providers in
      `src/auth/auth.module.ts`

**Checkpoint**: User Story 1 is fully functional and independently e2e-tested.

---

## Phase 4: User Story 2 - Safely reject invalid credentials (Priority: P1)

**Goal**: Wrong password, unregistered email, deactivated account, and missing fields are all
rejected identically (except the 400 case).

**Independent Test**: quickstart.md Scenario 2.

### Tests for User Story 2 ⚠️

- [ ] T021 [P] [US2] e2e test in `test/auth.e2e-spec.ts`: unregistered email, wrong password, and a
      deactivated account's correct credentials all return byte-identical 401 bodies; a missing
      field returns 400

### Implementation for User Story 2

- [X] T022 [US2] Rewrite the rejection paths in `src/auth/auth.service.ts` `login()` so an
      unregistered identifier (email or username), a wrong password, and a deactivated account ALL
      throw the same `UnauthorizedException('Invalid email or password')` (FR-002) — replacing the
      current `NotFoundException`/`BadRequestException` split
- [X] T023 [P] [US2] Normalize the identifier lookup (lowercase + trim) before comparison against
      both `email` and `username` in `auth.service.ts` (FR-003)
- [X] T024 [P] [US2] Write audit `login_failure` entries for every rejection path (using
      `attemptedEmail` when no account matched), via `audit-log.service.ts`

**Checkpoint**: User Stories 1 AND 2 both work independently.

---

## Phase 5: User Story 3 - Session persistence, rotation, and revalidation (Priority: P2)

**Goal**: Refresh tokens rotate on use, reuse revokes the whole session family, "remember me"
governs the 30-day vs. default lifetime, and status/role changes take effect immediately.

**Independent Test**: quickstart.md Scenario 3.

### Tests for User Story 3 ⚠️

- [ ] T025 [P] [US3] e2e test in `test/auth.e2e-spec.ts`: a refresh rotates the token; replaying the
      old (already-rotated) token returns 403 and invalidates the entire family (including the
      token that had just been validly issued)
- [ ] T026 [P] [US3] unit test in `src/auth/refresh-token.service.spec.ts`: rotation and
      reuse-detection logic in isolation (family issuance, marking used, family-wide revocation),
      including a case just inside the grace window (tolerated, no revocation) and one well
      outside it (treated as genuine reuse)

### Implementation for User Story 3

- [X] T027 [US3] Implement `POST /auth/refresh-token` in `auth.controller.ts`/`auth.service.ts`
      using `refresh-token.service.ts`: validate the cookie token, rotate it, detect reuse (403 +
      revoke family + audit `refresh_reuse_detected` entry), issue a new access token + cookie
- [X] T028 [US3] Extend the per-request re-validation from T013 to also reject when the account's
      current `role` no longer matches what a still-unexpired access token assumed (FR-009,
      completing the Foundational groundwork for this story)
- [X] T029 [P] [US3] Persist whether a token family originated from a `rememberMe: true` login so
      the refresh cookie's `Max-Age` is set correctly (30 days vs. session cookie) on every
      subsequent rotation, not just the original login (FR-006)

**Checkpoint**: User Stories 1, 2, AND 3 all work independently.

---

## Phase 6: User Story 4 - Log out (Priority: P2)

**Goal**: Logout revokes only the targeted session's family.

**Independent Test**: quickstart.md Scenario 4.

### Tests for User Story 4 ⚠️

- [ ] T030 [P] [US4] e2e test in `test/auth.e2e-spec.ts`: logging out one of two concurrent
      sessions revokes only that session's family; the other session's refresh still succeeds

### Implementation for User Story 4

- [X] T031 [US4] Implement `POST /auth/logout` in `auth.controller.ts`/`auth.service.ts`: revoke
      the presented token's family via `refresh-token.service.ts`, clear the cookie, write an
      audit `logout` entry (FR-011)

**Checkpoint**: User Stories 1–4 all work independently.

---

## Phase 7: User Story 5 - Brute-force lockout after repeated failures (Priority: P2)

**Goal**: 5 consecutive failures lock the account for 15 minutes with an email notice; source-IP
rate limiting applies independently.

**Independent Test**: quickstart.md Scenario 5.

### Tests for User Story 5 ⚠️

- [ ] T032 [P] [US5] e2e test in `test/auth.e2e-spec.ts`: 5 consecutive failures lock the account;
      the 6th (even correct) attempt returns 423; the account recovers after the window elapses
      and `consecutiveFailures` resets; a burst of requests eventually returns 429

### Implementation for User Story 5

- [X] T033 [US5] Implement consecutive-failure counting and the 15-minute lock in
      `auth.service.ts` (FR-012, FR-013)
- [X] T034 [P] [US5] Return 423 with the lockout message (before any credential check) when
      `lockedUntil` is in the future (FR-014)
- [X] T035 [P] [US5] Send a lockout-notification email to the account's registered address when a
      lock is triggered (FR-015) — introduce a minimal mail-sending abstraction if none exists yet
- [X] T036 [P] [US5] Write audit `account_locked` entries via `audit-log.service.ts` (FR-017)
- [X] T037 [US5] Apply `@nestjs/throttler` to `AuthController` (global or per-route `@Throttle`)
      for source-address rate limiting (FR-016)

**Checkpoint**: User Stories 1–5 all work independently.

---

## Phase 8: User Story 6 - Declarative access control for protected endpoints (Priority: P2)

**Goal**: Any endpoint can require specific permissions via `@RequirePermissions(...)`, enforced
before its handler runs. (Revised from the original `@Roles(...)` design — see T009/T010 and
data-model.md's 2026-08-28 Role/Permission/UserRole section.)

**Independent Test**: quickstart.md Scenario 6.

### Tests for User Story 6 ⚠️

- [ ] T038 [P] [US6] unit test in `src/common/guards/permissions.guard.spec.ts`: rejects a
      caller lacking the required permission, allows a caller holding it (via any one of their
      roles), and allows any authenticated request through when no `@RequirePermissions(...)` is
      declared
- [ ] T039 [P] [US6] e2e test in `test/auth.e2e-spec.ts` (or a dedicated test-only route): a
      permission-restricted sample route rejects a caller lacking it with 403 before its handler
      logic runs, and admits a caller holding it

### Implementation for User Story 6

- [X] T040 [US6] Register `PermissionsGuard` (T010) alongside `JwtAuthGuard` — applied per-route via
      `@UseGuards(JwtAuthGuard, PermissionsGuard)` (e.g. `admin/reset-password`), not globally, so
      any future endpoint can adopt `@RequirePermissions(...)` the same way without further wiring
- [X] T041 [P] Document the `@RequirePermissions`/`PermissionsGuard` usage pattern — done as a
      doc comment directly on `src/common/guards/permissions.guard.ts` rather than a separate
      README note

**Checkpoint**: All six user stories are independently functional and tested.

---

## Phase 8b: Admin Password Reset (FR-022, FR-022a — added 2026-08-28)

**Goal**: An admin can set a temporary password for another account in their own company (or any
company, for Super Admin), forcing that account to change it on next login.

**Independent Test**: `POST /auth/admin/reset-password` as an admin against a same-company target
account succeeds and the target's next login with the temp password returns
`mustChangePassword: true`; the same call against a different-company target (non-Super-Admin
caller) returns 403.

### Tests for Phase 8b ⚠️

- [ ] T047 [P] e2e test in `test/auth.e2e-spec.ts`: admin resets a same-company account's password
      → 200, target account's `mustChangePassword` becomes true, target's prior refresh sessions no
      longer work; cross-company attempt by a non-Super-Admin → 403; unknown `targetAccountId` → 404

### Implementation for Phase 8b

- [X] T048 [P] Create `src/auth/dto/admin-reset-password.dto.ts`: `targetAccountId: string`,
      `temporaryPassword: string`, validated via `class-validator`
- [X] T049 Add `adminResetPassword()` to `src/auth/auth.service.ts`: hash `temporaryPassword` via
      the existing `PasswordService`, overwrite the target account's `password`, set
      `mustChangePassword = true`, revoke every active `RefreshToken` row for that `accountId`
      (data-model.md "Admin Password Reset"), and write an `admin_password_reset` audit entry via
      `audit-log.service.ts`
- [X] T050 Add `POST /auth/admin/reset-password` to `src/auth/auth.controller.ts`, guarded by
      `@Roles(...)` (FR-022a — admin roles) plus a same-company check against the target account
      (Super Admin exempt), per contracts/auth-api.md
- [X] T051 [P] Update `@nestjs/swagger` annotations for the new DTO/endpoint

**Checkpoint**: Phase 8b is independently e2e-tested; no other phase depends on it.

---

## Phase 9: Polish & Cross-Cutting Concerns

- [X] T042 [P] Run all six `quickstart.md` scenarios manually as an additional smoke check
      alongside the automated tests above
- [X] T043 [P] `npm run lint` and `npm run build` pass with no errors
- [X] T044 Spot-check that no audit log row, log line, or response body anywhere contains a
      password or a raw (unhashed) refresh-token value (spec FR-017's "no password material"
      requirement, extended to token values by data-model.md)
- [X] T045 [P] Update `.env.example` with any new required environment variables (lockout config,
      throttler config) per Constitution Principle III
- [X] T046 Update `@nestjs/swagger` annotations for every modified/added DTO and confirm `/api`
      reflects them accurately (Constitution Principle II)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS all user stories
- **User Stories (Phase 3–8)**: All depend on Foundational; proceed in priority order
  (US1 → US2 → US3 → US4 → US5 → US6) or in parallel across developers where file-independent
- **Admin Password Reset (Phase 8b)**: Depends on Foundational (T006's `username`/`mustChangePassword`
  fields, T011's `RefreshTokenService`, T012's `AuditLogService`) and on `PasswordService` already
  existing — independent of every other user story, can be built any time after Foundational
- **Polish (Phase 9)**: Depends on all desired user stories (including 8b) being complete

### User Story Dependencies

- **US1 (P1)**: No dependencies on other stories — the MVP path
- **US2 (P1)**: Shares `auth.service.ts`'s `login()` with US1 — sequence right after US1
- **US3 (P2)**: Builds on US1's token-family issuance — sequence after US1
- **US4 (P2)**: Only needs Foundational's `refresh-token.service.ts` — independent of US2/US3/US5
- **US5 (P2)**: Shares `login()` with US1/US2 and the account's lockout fields — sequence after US2
- **US6 (P2)**: Fully independent of US1–US5 (uses only Foundational's guard/decorator) — can be
  built and tested in parallel with any of them

### Parallel Opportunities

- T002/T003 (Setup) can run in parallel
- T007–T012 (Foundational) marked [P] can run in parallel where they touch different files
- Once Foundational is done, US6 has zero dependency on US1–US5 and can be staffed fully in
  parallel; US1/US2/US3/US5 all touch `auth.service.ts`'s `login()` and should not be
  parallelized against each other

---

## Parallel Example: User Story 1

```bash
Task: "e2e test for valid login in test/auth.e2e-spec.ts"
Task: "Register RefreshTokenService and AuditLogService as providers in src/auth/auth.module.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational
3. Complete Phase 3: User Story 1
4. **STOP and VALIDATE**: run quickstart.md Scenario 1 + the T015 e2e test
5. Note: without US2, invalid credentials aren't yet handled safely — this MVP slice is for
   internal/demo use only, matching the same caveat noted on the buildcore-web side

### Incremental Delivery

1. Setup + Foundational → foundation ready
2. US1 → validate → demo (MVP)
3. US2 → validate → safe to expose beyond a trusted demo
4. US3 → validate
5. US4 → validate
6. US5 → validate
7. US6 → validate (can slot in anytime after Foundational, independent of the others)
8. Full spec scope complete

---

## Notes

- [P] tasks touch different files with no unmet dependency
- [Story] labels map every task to spec.md's user stories for traceability
- Test tasks are mandatory here (constitution requirement), unlike the buildcore-web counterpart
- Commit after each task or logical group
- Stop at any checkpoint to validate a story independently before moving on
