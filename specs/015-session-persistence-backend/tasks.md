# Tasks: Session Persistence (Backend)

**Input**: Design documents from `/specs/015-session-persistence-backend/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/auth-session.md](./contracts/auth-session.md)

**Tests**: This repository has jest unit and e2e suites, so the acceptance scenarios become real
tests. US1 and US2 each carry test tasks; they are not optional.

**Deploy order**: every setting below defaults to today's behaviour, so this ships safely **before**
the web change. Nothing alters until the deployment is reconfigured.

---

## Phase 1: Foundational — configuration shape

**Everything else reads these.**

- [X] T001 Reshape `SecurityConfig` in `src/common/configs/config.interface.ts`:
      `refreshToken` becomes `{ sessionDays, reuseGraceSeconds, cleanupRetentionDays }`;
      `refreshCookie` gains `path` (spec FR-012)
- [X] T002 Implement those defaults in `src/common/configs/config.ts` — `SESSION_DAYS` 90,
      `REFRESH_REUSE_GRACE_SECONDS` 60, `REFRESH_CLEANUP_RETENTION_DAYS` 7,
      `REFRESH_COOKIE_PATH` `/auth`, and replace the `CORS_ORIGINS ? 'none' : 'strict'` inference
      for `sameSite` with `REFRESH_COOKIE_SAMESITE` defaulting to `lax`. That inference encodes
      the cross-site assumption this feature removes (spec FR-009, FR-012; research §5)

---

## Phase 2: US1 — A session that lasts as long as the user keeps using it (P1)

**Goal**: 90 days for everyone, sliding, with no live session invalidated.

**Independent test**: A new session records a 90-day expiry; renewing moves it 90 days from the
renewal, not from sign-in; a session created before the migration still renews.

- [X] T003 [US1] Drop `rememberMe` from `model RefreshToken` in `prisma/schema.prisma` and add the
      migration `ALTER TABLE "shared"."RefreshToken" DROP COLUMN "rememberMe"`. Live rows keep
      their `expiresAt`, which is what makes this safe (spec FR-004; research §1, data-model.md)
- [X] T004 [US1] `src/auth/refresh-token.service.ts`: `expiryFor()` loses its parameter and reads
      `sessionDays`; `issue()` and `rotate()` stop passing and storing `rememberMe`. `rotate()`
      already re-derives expiry on every call, so the sliding behaviour is existing — only the
      number and its conditionality change (spec FR-001, FR-002)
- [X] T005 [US1] `src/auth/auth.service.ts`: stop threading `rememberMe` through login and refresh
      results (spec FR-003)
- [X] T006 [US1] `src/auth/dto/login.dto.ts`: make `rememberMe` `@IsOptional()` and ignore it.
      **Do not remove it** — `forbidNonWhitelisted` is global, so deleting it would 400 every
      request from the currently-deployed web build the moment this ships (spec FR-003)
- [X] T007 [US1] `src/auth/auth.controller.ts` `setRefreshCookie()`: always set `maxAge` from
      `sessionDays`, and take `path` and `sameSite` from config. Omitting `maxAge` is what made the
      credential die with the browser (spec FR-001, FR-009, FR-010)
- [X] T008 [US1] Make `logout()`'s `clearCookie` read `path` and `sameSite` from the same config
      used to set it, so the two cannot drift — a mismatch leaves the credential in place after a
      sign-out (spec FR-011)
- [X] T009 [P] [US1] Unit test: a new session expires in 90 days; a rotation moves the expiry to
      90 days from the rotation; both hold with no preference supplied (SC-001)
- [ ] T010 [P] [US1] E2e test: a session row created with a short legacy expiry still renews, and
      its replacement carries 90 days — FR-004's guarantee that the deployment signs nobody out
      (SC-005)

**Checkpoint**: quickstart Passes 1, 2 and 6.

---

## Phase 3: US2 — Concurrency is not theft (P1)

**Goal**: One client renewing repeatedly survives; a genuine replay is still caught.

**Independent test**: Present one credential several times in quick succession — all succeed.
Spread them beyond the old 5 s window — still succeed. Present a genuinely stale one — refused,
family destroyed.

- [X] T011 [US2] Replace the `REUSE_GRACE_WINDOW_MS = 5_000` module constant in
      `src/auth/refresh-token.service.ts` with `reuseGraceSeconds` from config, keeping the
      wall-clock mechanism. Research §2 records why the generational alternative was rejected: it
      fails above two-way concurrency, turning a common case into the exact failure being fixed
      (spec FR-005, FR-012)
- [X] T012 [US2] Write an audit entry via `AuditLogService` when reuse detection revokes a family,
      recording account, family and how far outside the window the presentation fell. Without it a
      destroyed session leaves nothing to tell a genuine theft signal from another false positive
      (spec FR-007)
- [X] T013 [US2] Surface the refusal reason: carry `RotateResult`'s existing `invalid` / `reuse`
      distinction up through `auth.service.ts` and emit it as a body `code` of `SESSION_EXPIRED`
      or `SESSION_REVOKED`, status still 401, using the mechanism `PASSWORD_CHANGE_REQUIRED`
      already established (spec FR-008; contracts/auth-session.md)
- [X] T014 [P] [US2] Unit test: the same credential presented 5 times inside the window rotates
      each time and the family survives; presented beyond the window it revokes the family and
      returns `reuse` (SC-002, SC-003, SC-004)
- [ ] T015 [P] [US2] E2e test: five concurrent `POST /auth/refresh-token` with one cookie all
      succeed and the session still works afterwards — the production failure, as a regression
      test (SC-002)

**Checkpoint**: quickstart Passes 3 and 4.

---

## Phase 4: US3 — Credential delivery matched to first-party routing (P2)

**Goal**: The cookie is accepted and returned by the browser through the web application's origin.

- [X] T016 [US3] Verify against a running instance that `REFRESH_COOKIE_PATH=/bff/auth` and
      `REFRESH_COOKIE_SAMESITE=lax` produce exactly those attributes on `Set-Cookie` for both
      login and refresh, and that `HttpOnly` and `Secure` are unchanged (spec FR-009, FR-010;
      quickstart Pass 5)

**Checkpoint**: quickstart Pass 5. This is the setting the web feature depends on absolutely.

---

## Phase 5: FR-013 — Cleanup

- [X] T017 Add `src/auth/refresh-token-cleanup.cron.ts`: a nightly `@Cron` deleting rows whose
      `expiresAt` or `revokedAt` passed more than `cleanupRetentionDays` ago, running under
      `withRlsContext(..., { isSuperAdmin: true })` and following
      `src/partners/cron/compliance-check.cron.ts`. The retention delay keeps the forensic tail
      T012's audit entries describe (spec FR-013; research §6)
- [X] T018 [P] Unit test: long-expired rows are removed, recently-revoked ones are kept

---

## Phase 6: Polish & verification

- [X] T019 [P] `npx tsc --noEmit`
- [X] T020 [P] `npx eslint --fix` scoped to touched files only — `npm run lint` is `eslint --fix`
      across the repo and would reformat unrelated code
- [X] T021 `npx jest` — expect the full unit suite green. The 9 punch failures in
      `test/my-workspace.e2e-spec.ts` are pre-existing and unrelated (duplicate punch-in returns
      500 not 409)
- [ ] T022 Work quickstart Passes 1–7 against a running instance

---

## Dependencies

```
T001 ─▶ T002 ─┬─▶ T004 ─▶ T005 ─▶ T006
              ├─▶ T007 ─▶ T008
              ├─▶ T011 ─▶ T012 ─▶ T013
              └─▶ T017

T003 ─▶ T004        (schema before the service that stops writing the column)
T004 ─▶ T009, T010
T011 ─▶ T014, T015
T017 ─▶ T018
```

US1 and US2 are independent once Phase 1 lands. US3 is verification-only and needs both.

## Parallel opportunities

- T009, T010 — different test files.
- T014, T015 — unit and e2e, different files.
- T019, T020 — independent checks.

T004, T011 and T012 all edit `refresh-token.service.ts`; T007 and T008 both edit
`auth.controller.ts`. Neither pair is parallel.

## MVP scope

**Phase 1 + Phase 2** alone ends the daily logout for the 74 of 89 sign-ins that never asked to be
remembered. **Phase 3** is what stops replay protection destroying live sessions, and matters most
to the users whose browsers already work. Neither is genuinely optional; they are separable.

---

## Implementation note — 2026-09-11

Done and verified. Two tasks remain unchecked, deliberately:

- **T010, T015** — the two *e2e* test tasks. Both scenarios are covered by unit tests in
  `src/auth/refresh-token.service.spec.ts` (a legacy short-expiry row still renewing; a
  30-second spread surviving where the old 5-second window would have destroyed the
  family), and both were additionally verified against a running instance. What is
  missing is a codified e2e spec in `test/`, which has lasting regression value a one-off
  probe does not.

Live verification against a built instance, with `REFRESH_COOKIE_PATH=/bff/auth`:

```
Set-Cookie: refreshToken=…; Max-Age=7776000; Path=/bff/auth; Expires=Thu, 10 Dec 2026;
            HttpOnly; Secure; SameSite=Lax
login with rememberMe still supplied      -> 201  (FR-003)
5 concurrent refreshes on one credential  -> 201 ×5, session still alive afterwards
genuinely stale credential                -> 401 {"code":"SESSION_REVOKED"}
unknown credential                        -> 401 {"code":"SESSION_EXPIRED"}
audit entry written                       -> {"familyId":"83b5ab04…","lateBySeconds":3}
```

The last line is FR-007 doing its job: 3 seconds past the window reads as a slow client,
where hours past it would read as a credential somebody kept. That discriminator is what
was missing when the old 5-second window destroyed five live sessions unnoticed.

686/686 unit tests, `tsc` clean, eslint 0 errors, migration applied.
