# Implementation Plan: User Login Backend & Access Control

**Branch**: `001-user-login-backend` | **Date**: 2026-08-27 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/001-user-login-backend/spec.md`

## Summary

Extend `buildcore-api`'s existing `src/auth/` skeleton (which already has argon2 hashing, a JWT
strategy, and basic login/refresh endpoints) into the full login backend `buildcore-web` is coded
against — cookie-only refresh tokens with rotation and reuse detection, enumeration-safe rejection,
account lockout with email notification, multi-tenant company scoping (with a single, explicit
Super Admin cross-company exception), a declarative RBAC guard system, source-address rate
limiting, and an audit log — reconciling this repo's own constitution (which imposes stricter
requirements than the web-side spec needed to state) with the contract the frontend already
expects. See [research.md](research.md) for the gap between what exists today and what this
feature adds.

## Technical Context

**Language/Version**: TypeScript 5.1, Node.js, NestJS 10, Prisma 5 against PostgreSQL — all
already the project's stack (`package.json`); no new language/runtime introduced.

**Primary Dependencies**: Existing — `@nestjs/jwt`, `@nestjs/passport` + `passport-jwt`, `argon2`,
`class-validator`/`class-transformer`, `@nestjs/swagger`, `@nestjs/config`, `nestjs-prisma`. New —
`@nestjs/throttler` (rate limiting, FR-016; already pre-approved in the constitution's tech-stack
list) and Express cookie handling (`cookie-parser` or NestJS's built-in response cookie API) for
the refresh-token cookie (FR-006).

**Storage**: PostgreSQL via Prisma — extends the existing placeholder `User` model and adds a
refresh-token table and an audit-log table (data-model.md). No new datastore technology.

**Testing**: Jest (unit, colocated `*.spec.ts`) and `test/*.e2e-spec.ts` (e2e, requires a running
Postgres) — both already wired in this repo. Unlike the `buildcore-web` side of this feature (which
has no test framework yet), the constitution's Development Workflow section explicitly requires
"new endpoints touching auth ... MUST have an e2e test," so this plan's tasks include real test
tasks, not a manual-verification fallback.

**Target Platform**: Linux server (Node.js), same deployment target as the rest of `buildcore-api`.

**Project Type**: Web service (backend API) — single NestJS project; no new service/project split.

**Performance Goals**: A login request completes in under 1 second under normal load (spec SC-001).

**Constraints**: Every controller method uses a validated DTO (Principle II); no cross-schema
queries (Principle I); no raw `process.env`/scattered magic values for the new settings this
feature adds (Principle III); every tenant-scoped table carries `companyId` and is RLS-protected,
with exactly one explicit, narrow exception for Super Admin (Principle IV); argon2 hashing,
short-TTL access tokens, HttpOnly cookie refresh tokens, and declarative role guards (Principle V);
migrations applied only via `prisma migrate dev`/`deploy`, never hand-edited SQL (Principle VI).

**Scale/Scope**: Three endpoints (`/auth/login`, `/auth/refresh-token`, `/auth/logout`), a new
`RolesGuard`/`@Roles()` pair usable by any future endpoint, account-lockout tracking, a new audit
log table, and the `companyId`/RLS extension to the account model — no other modules are touched.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Check | Status |
|---|---|---|
| I. Schema-Per-Module Boundaries (NON-NEGOTIABLE) | Auth/User doesn't belong to any of the seven named business modules — it belongs in the `shared` schema per the module list. Today everything (including `User`) lives in the default `public`/single schema. This feature migrates the account table and its own new tables into a `shared` Postgres schema (via Prisma's multi-schema support) rather than leaving them in the undifferentiated default, so it satisfies Principle I going forward instead of extending the un-split skeleton. | PASS (post-remediation) |
| II. Validated DTO Contracts (NON-NEGOTIABLE) | Existing `LoginDto`/`TokenDto` already follow this pattern. New/changed DTOs (login request with `rememberMe`, login response, refresh/logout responses) all follow the same `class-validator` + `@nestjs/swagger` pattern; global `ValidationPipe` (already configured in `main.ts`) continues to reject unexpected fields. | PASS |
| III. Centralized Configuration & No Hardcoded Values (NON-NEGOTIABLE) | New settings (lockout threshold/duration, refresh-cookie lifetimes, throttler limits) go into `SecurityConfig`/`config.ts`. The two existing raw-string `configService.get('JWT_ACCESS_SECRET')`/`get('JWT_REFRESH_SECRET')` calls (`jwt.strategy.ts`, `auth.module.ts`) are folded into the same typed config path while this feature is already touching those files (research.md §9). | PASS (post-remediation) |
| IV. Multi-Tenant Isolation & PII Protection (NON-NEGOTIABLE) | Every new/extended table carries `companyId` and gets an RLS policy (research.md §5); the one Super Admin exception is an explicit, narrowly-scoped RLS bypass flag, not a silent gap. Account lockout and deactivation-triggered session revocation are written to the new audit log, satisfying the "every destructive action" audit requirement. Email/name aren't in this constitution's regulated-PII list (Aadhaar/PAN/bank details), so no masking requirement applies to this feature's own fields. | PASS |
| V. Authentication, Authorization & Secrets Hygiene | Argon2 already in place. This feature adds: refresh rotation + reuse detection, HttpOnly-cookie-only refresh delivery, short-TTL access tokens (already 15m in `config.ts`), a declarative `RolesGuard`/`@Roles()` pair (research.md §6), and `@nestjs/throttler` on auth endpoints (research.md §7) — this feature is what closes out this principle's remaining "once wired" gaps. | PASS |
| VI. Observability & Safe Migrations | All new schema changes ship as generated Prisma migrations (`migrate:dev:create`), never hand-edited SQL. Request-ID tracing (`nestjs-pino`) and health endpoints (`@nestjs/terminus`) remain a separate, repo-wide observability initiative not specific to login — consistent with the constitution's own note that this gap is "not blocking for unrelated changes." | PASS (tracing/health explicitly out of this feature's scope) |

No violations require a Complexity Tracking entry — the "post-remediation" rows are pre-existing
gaps this feature closes as part of its own work, not new violations it introduces.

**Post-design re-check (after Phase 1)**: data-model.md and contracts/auth-api.md keep every new
table tenant-scoped with the single documented Super Admin exception, every endpoint's request/
response as a typed DTO, and no new configuration read outside the centralized path. Still PASS.

## Project Structure

### Documentation (this feature)

```text
specs/001-user-login-backend/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md         # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   └── auth-api.md      # Phase 1 output
└── tasks.md             # Phase 2 output (/speckit-tasks — not created by /speckit-plan)
```

### Source Code (repository root)

```text
buildcore-api/
├── prisma/
│   ├── schema.prisma                       # MODIFIED — User gets companyId/status/mustChangePassword/lockout fields,
│   │                                       #            moved into a new `shared` schema; new RefreshToken + AuditLogEntry models
│   └── migrations/                        # NEW migration(s) generated via `migrate:dev:create` (never hand-edited)
├── src/
│   ├── main.ts                            # MODIFIED — cookie parsing enabled
│   ├── common/
│   │   ├── configs/
│   │   │   ├── config.ts                  # MODIFIED — lockout/cookie/throttler settings added
│   │   │   └── config.interface.ts        # MODIFIED — SecurityConfig extended
│   │   ├── decorators/
│   │   │   ├── user.decorator.ts          # EXISTING, unchanged
│   │   │   └── roles.decorator.ts         # NEW — `@Roles(...role: Role[])`
│   │   └── guards/
│   │       └── roles.guard.ts             # NEW — reads `@Roles`, compares against request's role claim
│   └── auth/
│       ├── auth.module.ts                 # MODIFIED — registers ThrottlerModule, RolesGuard provider
│       ├── auth.controller.ts             # MODIFIED — login/refresh/logout: cookie handling, 423/429 responses
│       ├── auth.service.ts                # MODIFIED — enumeration-safe errors, lockout, rotation+reuse, audit writes
│       ├── password.service.ts            # EXISTING, unchanged (already argon2)
│       ├── jwt.strategy.ts                # MODIFIED — reads secret via typed config; re-validates account status
│       ├── jwt-auth.guard.ts              # EXISTING, unchanged
│       ├── refresh-token.service.ts       # NEW — token family issuance/rotation/reuse-detection logic
│       ├── audit-log.service.ts           # NEW — write-only audit log helper
│       └── dto/
│           ├── login.dto.ts               # MODIFIED — add `rememberMe`
│           ├── token.dto.ts               # MODIFIED — response shape (no refreshToken field; cookie-only)
│           └── ... (locked-response / generic-error DTOs as needed)
└── test/
    └── auth.e2e-spec.ts                    # NEW/MODIFIED — covers login/refresh/logout/lockout/RBAC per constitution's e2e requirement
```

**Structure Decision**: Single NestJS project (`buildcore-api`), extending the existing `src/auth/`
and `src/common/` directories in place — no new service/project. The one structural addition is a
`shared` Postgres schema (via Prisma multi-schema) to bring the account/session/audit tables into
compliance with Principle I, which today's single-schema skeleton doesn't yet have.

## Complexity Tracking

*No entries — no constitution violations requiring justification (see Constitution Check above).*
