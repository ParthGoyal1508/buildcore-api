# Implementation Plan: Session Persistence (Backend)

**Branch**: `015-session-persistence-backend` | **Date**: 2026-09-11 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/015-session-persistence-backend/spec.md`

## Summary

Sessions last one day unless the user ticked a box, replay protection reads a slow instance as
credential theft, and the renewal cookie carries attributes chosen for cross-site delivery. This
plan gives every session a 90-day sliding window, re-calibrates replay tolerance and makes it
configurable, and moves the cookie's `sameSite` and `path` into configuration so the same code
serves both the current cross-site deployment and the proxied same-site one the web application is
moving to.

No new dependency, no new endpoint, one destructive-but-safe migration, and one scheduled job.
The rotation logic is already a sliding window — `rotate()` re-derives expiry on every call — so
the change there is to its *length* and its dependence on `rememberMe`, not to its shape.

## Technical Context

**Language/Version**: TypeScript 5.x on Node 22, NestJS 10

**Primary Dependencies**: Prisma 5.22 (PostgreSQL, multi-schema), `@nestjs/schedule` (already
installed), `@nestjs/config`, `class-validator`. Nothing new.

**Storage**: PostgreSQL. `shared."RefreshToken"` is the only table this feature writes.

**Testing**: Jest — unit (`src/**/*.spec.ts`) and e2e (`test/*.e2e-spec.ts`). Both exist and are
expected to cover the acceptance scenarios; this is not a manual-verification feature.

**Target Platform**: Linux container (Render), fronted by a Next.js application on Vercel.

**Project Type**: REST API (web service).

**Performance Goals**: Unchanged. Renewal is already one indexed lookup plus two writes inside one
transaction; nothing here adds a query to the hot path.

**Constraints**: No live session may be invalidated by the deployment (FR-004). The API must be
deployable **before** the web change without breaking the current cross-site deployment — every
new setting therefore defaults to today's behaviour.

**Scale/Scope**: 89 sign-ins and 215 token rows on the current deployment. The 90-day window
raises row counts roughly ninety-fold, which is why FR-013 exists.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | Assessment |
|---|---|
| **I. Schema-per-module, no cross-schema queries** | `RefreshToken` lives in `shared`. The only relation crossing to `settings."User"` is `account`, which already exists and is not touched. No new cross-schema query. **Pass.** |
| **II. Validation at the boundary** | `LoginDto.rememberMe` becomes `@IsOptional()` rather than being deleted, so an older client is still validated rather than rejected. New settings are read through `ConfigService`, not `process.env`, at their point of use. **Pass.** |
| **III. Audited writes** | FR-007 adds an audit record when reuse detection destroys a family — strictly more auditing than today, where a destroyed session leaves no trace beyond the rows themselves. **Pass.** |
| **IV. Company scoping / RLS** | `rotate()` runs under `{ isSuperAdmin: true }` because a refresh token is located by an unforgeable hash and has no company context until it is resolved. That is pre-existing, deliberate and documented in the service; this feature does not widen it. The new cleanup job runs the same way, for the same reason. **Pass.** |
| **Config over code** | FR-012 requires the window and the tolerance to be adjustable without a release. Both become environment-backed config with defaults, matching `SecurityConfig`'s existing shape. **Pass.** |

No violations. Nothing for Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/015-session-persistence-backend/
├── spec.md
├── plan.md              # This file
├── research.md          # Phase 0 — the five design decisions
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
├── contracts/
│   └── auth-session.md  # Phase 1
└── checklists/
    └── requirements.md
```

### Source Code (repository root)

```text
prisma/
├── schema.prisma                                   # CHANGED — drop RefreshToken.rememberMe
└── migrations/
    └── 2026…_drop_refresh_token_remember_me/       # NEW

src/
├── common/configs/
│   ├── config.ts                                   # CHANGED — session window, reuse tolerance,
│   │                                               #   cookie path/sameSite, cleanup retention
│   └── config.interface.ts                         # CHANGED — SecurityConfig shape
└── auth/
    ├── refresh-token.service.ts                    # CHANGED — single window, configurable
    │                                               #   tolerance, audit on revoke, outcome codes
    ├── auth.service.ts                             # CHANGED — propagate the refusal reason
    ├── auth.controller.ts                          # CHANGED — cookie path/sameSite from config,
    │                                               #   always set maxAge, error codes
    ├── dto/login.dto.ts                            # CHANGED — rememberMe optional + ignored
    └── refresh-token-cleanup.cron.ts               # NEW — FR-013

test/
└── auth-session.e2e-spec.ts                        # NEW — US1/US2 acceptance scenarios
```

## Approach

### 1. One window, applied to everyone (FR-001, FR-002, FR-003, FR-004)

`SecurityConfig.refreshToken` collapses from `{ rememberMeDays, defaultDays }` to a single
`sessionDays` (default 90, env-overridable). `expiryFor()` loses its parameter. `rotate()` already
re-derives expiry on every rotation, so the sliding behaviour FR-002 asks for is what the code
does today — the change is the number and its unconditionality.

`RefreshToken.rememberMe` is dropped (research §1). Live rows keep their `expiresAt`, so no
session is invalidated; each adopts 90 days at its next rotation, which is exactly FR-004.

`LoginDto.rememberMe` becomes optional and unread. It is **not** removed: `forbidNonWhitelisted`
is global, so deleting it would 400 every request from the currently-deployed web build the moment
this ships.

### 2. Replay tolerance (FR-005, FR-006, FR-007)

`REUSE_GRACE_WINDOW_MS` moves from a module constant to `security.refreshToken.reuseGraceSeconds`,
default **60**. Research §2 records why a wall-clock window is kept and why the generational
alternative was rejected — it fails above two-way concurrency, turning a common case into the
exact failure being fixed.

When the window *is* exceeded, the family is still destroyed (FR-006) and an audit entry is now
written (FR-007) recording the account, the family, and how far outside the window the
presentation fell. Without that, a destroyed session leaves nothing to distinguish a genuine theft
signal from another false positive.

### 3. Distinguishable refusals (FR-008)

`rotate()` already returns a discriminated `RotateResult`; `invalid` and `reuse` are distinct
there and are flattened to one 401 above. That distinction is carried up and emitted as a body
`code` — `SESSION_EXPIRED` or `SESSION_REVOKED` — using the mechanism `ApiError.code` and
`PASSWORD_CHANGE_REQUIRED` already established. Status stays 401 (research §3).

### 4. Cookie attributes (FR-009, FR-010, FR-011)

`path` and `sameSite` become configuration, defaulting to today's values so this is safe to deploy
before the web change. `maxAge` is now **always** set, from `sessionDays` — omitting it is what
made the cookie die with the browser, and with no `rememberMe` there is no longer a case where
that is wanted.

The API owns the cookie path rather than having the proxy rewrite `Set-Cookie` (research §4).
`logout()` already re-states the attributes when clearing; it reads them from the same config so
the two cannot drift, which is what FR-011 protects.

### 5. Cleanup (FR-013)

A nightly `@Cron` deletes rows whose `expiresAt` or `revokedAt` passed more than
`cleanupRetentionDays` (default 7) ago, following `src/partners/cron/compliance-check.cron.ts`. The
retention delay keeps a short forensic tail so FR-007's audit entries still have the rows they
describe.

## Risks

| Risk | Handling |
|---|---|
| API ships before web; cookie still third-party | Every new setting defaults to current behaviour. Nothing changes until the deployment is reconfigured. |
| Dropping a `NOT NULL` column | Irreversible, but the column is unread after this change and expiry lives elsewhere. Verified against FR-004: live rows keep `expiresAt`. |
| 60 s tolerance is wrong for this deployment | It is configuration, which is the point of FR-012. SC-002 measures it against production. |
| 90-day rows accumulate | FR-013's job, shipped in the same feature rather than deferred. |

## Verification

`npx tsc --noEmit`, `npx jest` (unit + the new e2e spec), `npx eslint --fix` scoped to touched
files. The 9 pre-existing punch failures in `test/my-workspace.e2e-spec.ts` are unrelated and
remain. Beyond the suite, [quickstart.md](./quickstart.md) exercises the scenarios that only show
up against a running instance and a real browser cookie jar.
