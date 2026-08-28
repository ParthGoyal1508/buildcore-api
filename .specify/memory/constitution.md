<!--
Sync Impact Report
- Version change: 1.2.0 → 1.3.0
- Modified principles: n/a
- Added sections:
  - Technology Stack & Standards: pre-approved `resend` (Resend's Node SDK) for any module needing
    transactional email delivery (invite/set-password links, OTP codes, lockout/notification
    emails) — introduced by the Account Creation feature, and retroactively documents the delivery
    mechanism the User Login feature's account-lockout email (FR-015) and master PRD §7.1's Forgot
    Password OTP already assumed without naming a library.
- Previous amendment (v1.2.0, for reference, unchanged): pre-approved `exceljs` for any module
  needing downloadable Excel (.xlsx) generation, per the user's explicit choice when asked — the
  Dashboard & General feature's Reports module was the first consumer.
- Earlier amendment (v1.1.0, for reference, unchanged): pre-approved (1) a specific in-process,
  npm-based biometric face-matching mechanism (`@vladmandic/face-api`-style library) for any module
  needing face verification; (2) `pdfkit` for any module needing downloadable PDF generation — both
  introduced by the My Workspace feature.
- Removed sections: none
- Original ratification's Added sections (for reference, unchanged):
  - Core Principles: I. Schema-Per-Module Boundaries (NON-NEGOTIABLE), II. Validated DTO
    Contracts (NON-NEGOTIABLE), III. Centralized Configuration & No Hardcoded Values
    (NON-NEGOTIABLE), IV. Multi-Tenant Isolation & PII Protection (NON-NEGOTIABLE),
    V. Authentication, Authorization & Secrets Hygiene, VI. Observability & Safe Migrations
  - Technology Stack & Standards
  - Development Workflow & Quality Gates
  - Governance
- Deferred / TODO items (carried over, unchanged):
  - TODO(SCHEMA_MIGRATION): `prisma/schema.prisma` currently has a single placeholder `User`
    model, not the schema-per-module split (hr/payroll/projects/plant/inventory/partners/
    settings/shared) described in Principle I. That split is recorded as the target architecture
    for all new module work per docs/HLD.md §5.1 in the ERP-Demo repo, not as something already
    true of the codebase today.
  - TODO(RBAC): Only authenticated-vs-not is implemented today; role/permission guards
    (Principle V) are not yet wired beyond the `Role` enum on `User`.
  - TODO(STRICT_TS): `tsconfig.json` currently sets `strictNullChecks: false` and
    `noImplicitAny: false`. Tightening these is a reasonable future improvement but is not
    mandated here as a NON-NEGOTIABLE, since doing so today would immediately conflict with the
    existing codebase; revisit via amendment if the team decides to invest in the migration.
-->

# BuildCore API Constitution

## Core Principles

### I. Schema-Per-Module Boundaries (NON-NEGOTIABLE)
One Postgres **database**, one **schema per business module** (`hr`, `payroll`, `projects`,
`plant`, `inventory`, `partners`, `settings`, `shared`), per docs/HLD.md §5.1 in the ERP-Demo repo.
A module's Prisma queries MUST only read or write tables inside its own schema — no raw join or
direct query into another module's schema. Anything one module needs from another MUST go through
that module's exported service method (an in-process function call), never a direct cross-schema
query. Side effects that fan out to modules that don't need a synchronous answer (e.g. "payroll
locked → send payslip email → push notification") MUST go through the in-process event bus
(`@nestjs/event-emitter`), not a chain of direct service calls.

**Rationale**: This is the documented seam for the Phase 2 extraction path (HLD §10) — when a
module needs its own service, its schema already *is* the boundary, so extraction becomes a
transport swap instead of a rewrite of who's allowed to touch what. It also prevents the kind of
double-submit correctness gap the HLD calls out for payroll runs.

### II. Validated DTO Contracts (NON-NEGOTIABLE)
Every controller endpoint MUST accept and return typed DTOs validated with `class-validator` and
`class-transformer` (the existing `src/*/dto/` pattern) — never a raw, untyped request body or an
inline object literal as a response shape. Global validation (`ValidationPipe` with
`whitelist`/`forbidNonWhitelisted`) MUST reject unexpected fields rather than silently dropping or
accepting them. New endpoints MUST be documented via `@nestjs/swagger` decorators so the
auto-generated Swagger UI (`/api`) stays accurate.

**Rationale**: DTOs are this codebase's boundary contract, matching HLD §6 (API Design) and §9.1
(input validation on all DTOs) — untyped bodies are exactly where injection and mass-assignment
bugs enter a NestJS app.

### III. Centralized Configuration & No Hardcoded Values (NON-NEGOTIABLE)
Environment-dependent values (DB URL, JWT secrets, token TTLs, external service URLs) MUST be
read through the existing `@nestjs/config` setup (`src/common/configs/config.ts` /
`config.interface.ts`), never as a raw, scattered `process.env.X` inside a service or controller.
Cross-cutting literals that are not environment-dependent (role names, error-message constants,
pagination defaults, cache TTLs) MUST live in a shared constants module per owning schema/module,
not be duplicated as magic strings/numbers across files. Secrets MUST NOT be committed — `.env` is
git-ignored and `.env.example` is kept in sync with every new required variable.

**Rationale**: A scattered `process.env` read is invisible to the type system and the first thing
that breaks silently between dev/staging/prod; centralizing config is also the prerequisite for the
HLD §9.3 goal of validating environment variables with Zod at boot.

### IV. Multi-Tenant Isolation & PII Protection (NON-NEGOTIABLE)
Every tenant-scoped table MUST carry a `company_id` discriminator, and Postgres Row-Level Security
policies MUST enforce that a query can never cross a tenant boundary, even if application code has
a bug (HLD §5). Regulated PII (Aadhaar, PAN, bank account numbers — DPDP Act 2023, HLD §9.2) MUST
be encrypted at rest, MUST be masked by default in any API response, and an unmasked "reveal" MUST
require an explicit role-gated action. Every unmasked read of a PII field, and every destructive
action (delete, payroll run, role change), MUST be written to the audit log table.

**Rationale**: This is regulated personal data, not an ordinary sensitive field — the masking and
audit requirements exist to satisfy DPDP Act obligations, not as a style preference, and RLS is the
last line of defense against an application-layer tenant-scoping bug.

### V. Authentication, Authorization & Secrets Hygiene
Passwords MUST be hashed with `argon2` (never stored plaintext or reversibly encrypted). JWT access
tokens MUST carry a short TTL (target: 15 minutes per HLD §9.1) with refresh-token rotation; refresh
tokens MUST be delivered as HTTP-only cookies, never exposed to client-side JavaScript or
`localStorage`. Every route that is not explicitly public MUST be behind the JWT auth guard, and
routes restricted to a subset of roles MUST use an explicit roles guard/decorator rather than an
in-handler `if` check. Rate limiting (`@nestjs/throttler`) MUST be applied to authentication
endpoints once wired (see Development Workflow gaps below).

**Rationale**: Auth is the highest-value target in a multi-tenant HR/payroll system; making the
guard/role check declarative (decorator-driven) rather than ad-hoc keeps it reviewable in one place
instead of scattered `if (user.role !== ...)` checks that are easy to miss.

### VI. Observability & Safe Migrations
Every request MUST be traceable via a correlation/request ID threaded through structured logs
(target: `nestjs-pino`, per HLD §9.3), so a single user-reported issue can be traced across module
boundaries. The service MUST expose liveness (`/health`) and readiness (`/readyz`, checking DB/Redis
connectivity) endpoints once `@nestjs/terminus` is wired. Schema migrations MUST be applied via
`prisma migrate deploy` as an explicit CI/CD release step — never run manually against a production
database. Each environment (dev/staging/production) MUST have its own database.

**Rationale**: These are the operational-readiness items the HLD explicitly calls out as
"required from Phase 1, not added later" — retrofitting tracing or health checks after the first
production incident is far more expensive than wiring them from the start.

## Technology Stack & Standards

- **Framework**: NestJS 10 on Node.js, TypeScript 5, Prisma 5 against PostgreSQL.
- **Auth**: `@nestjs/passport` + `passport-jwt` + `argon2`; JWT access + refresh token rotation.
- **Validation**: `class-validator` + `class-transformer` DTOs on every controller.
- **API docs**: `@nestjs/swagger`, served at `/api`.
- **Lint/format**: ESLint (`@typescript-eslint`) + Prettier per `.eslintrc.js` / `.prettierrc.json`
  — `npm run lint` MUST pass before merge.
- **Testing**: Jest for unit tests (`*.spec.ts` colocated with source) and `test/*.e2e-spec.ts` for
  e2e (requires a running Postgres). New services and guards MUST ship with unit tests; new
  endpoints touching auth, payroll, or PII fields MUST have an e2e test.
- Packages named in `README.md` as "not here yet" (RBAC guards, `@nestjs/event-emitter`,
  `@nestjs/bullmq`, `@nestjs/throttler`, `nestjs-pino`, `@nestjs/terminus`, `helmet`, Zod env
  validation) are pre-approved additions when the module that needs them lands. Introducing a
  *different* new architectural dependency (a second ORM, a second auth strategy, a second queue
  library) requires a constitution amendment first.
- **Biometric face matching**: An in-process, npm-based face-recognition library (e.g.
  `@vladmandic/face-api`, a maintained TensorFlow.js-based face-api fork — pure JS/WASM inference,
  no native-binding build step) computing and comparing face embeddings locally in the backend is
  pre-approved for any module that needs face verification (e.g. biometric attendance punching).
  This is an explicit, narrow exception to needing a fresh amendment per module — a second,
  materially different face-matching mechanism (a native-binding library, a hosted third-party
  face-recognition API) still requires its own amendment before introduction.
- **PDF generation**: `pdfkit` (pure-Node, no headless-browser dependency) is pre-approved for any
  module that needs to generate a downloadable PDF document (e.g. a salary slip). A second,
  materially different PDF-generation mechanism (a headless-browser HTML-to-PDF renderer, a hosted
  third-party document-generation API) still requires its own amendment before introduction.
- **Excel generation**: `exceljs` is pre-approved for any module that needs to generate a
  downloadable `.xlsx` document (e.g. a report export). A second, materially different
  spreadsheet-generation mechanism still requires its own amendment before introduction.
- **Transactional email**: `resend` (Resend's Node SDK) is pre-approved for any module that needs
  to send transactional email (invite/set-password links, OTP codes, account notifications) — per
  master PRD §7.1, the system's named provider. A second, materially different email-delivery
  mechanism (a different ESP, a self-hosted SMTP relay) still requires its own amendment before
  introduction.

## Development Workflow & Quality Gates

- Every change MUST pass `npm run lint` and `npm run build` (or `tsc` typecheck) before merge.
- Every change touching a Prisma schema MUST include the generated migration
  (`npm run migrate:dev:create` / `migrate:dev`) committed alongside it — never a hand-edited
  migration SQL file.
- Every change MUST be reviewed by at least one other person before merging; a reviewer MUST
  explicitly check for violations of Principles I, II, III, and IV (cross-schema queries, untyped
  request bodies, scattered `process.env`/magic values, missing tenant scoping or PII masking),
  since these are the non-negotiable articles most likely to be introduced accidentally while the
  codebase is still small.
- **Known gaps** (tracked in the Sync Impact Report above, not hidden): the schema-per-module split,
  RBAC guards beyond authenticated/not, and the §9.3 observability stack (pino/terminus/throttler)
  are not yet implemented. New module work MUST follow Principles I–VI from the start rather than
  extending the current single-schema/no-RBAC skeleton; retrofitting existing code to comply is
  tracked separately and is not blocking for unrelated changes.

## Governance

This constitution supersedes ad-hoc conventions for anything it explicitly covers. Amendments
require:
1. A documented rationale for the change (what problem it solves or what it corrects).
2. A version bump per semantic versioning: MAJOR for removing/redefining a principle, MINOR for
   adding a principle or materially expanding guidance, PATCH for wording/clarification fixes.
3. Updating the Sync Impact Report at the top of this file.

All pull requests MUST be checked against this constitution as part of review (see Development
Workflow & Quality Gates); a reviewer who approves a change that knowingly violates a
NON-NEGOTIABLE principle MUST record the justification in the PR description, and that
justification MUST itself prompt a constitution amendment if the exception is expected to recur.

**Version**: 1.3.0 | **Ratified**: 2026-08-26 | **Last Amended**: 2026-08-28
