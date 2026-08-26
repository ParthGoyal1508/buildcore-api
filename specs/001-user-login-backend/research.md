# Research: User Login Backend & Access Control

## 1. Starting point: what already exists vs. what this feature must add

**Decision**: Treat `src/auth/` as a genuine starting skeleton to extend, not a placeholder to
throw away. Argon2 hashing (`PasswordService`), a `JwtStrategy`/`JwtAuthGuard` pair, and basic
`LoginDto`/`TokenDto`/`SignupDto` already exist and already follow the constitution's DTO/argon2
requirements. What's missing, concretely:
- `User` model (`prisma/schema.prisma`) has no `companyId`, `status`, `mustChangePassword`, or
  lockout fields — it's the single placeholder the constitution's Sync Impact Report already flags.
- `auth.service.ts`'s `login()` throws distinct `NotFoundException`/`BadRequestException` (email
  vs. password) — violates this feature's FR-002 enumeration resistance outright.
- Refresh tokens are just re-signed JWTs verified against `JWT_REFRESH_SECRET` with no persistence,
  no rotation, and no reuse detection — `refreshToken()` in `auth.service.ts` re-issues freely.
- Tokens are returned in the response body (`TokenDto`), not set as cookies — no cookie handling
  exists anywhere in `main.ts`/`auth.controller.ts`.
- No lockout/attempt tracking, no rate limiting (`@nestjs/throttler` isn't installed yet, matching
  the README's "not here yet" list), no audit log table, and no RBAC guard beyond
  authenticated-vs-not (`JwtAuthGuard`).

**Rationale**: Constitution's own Development Workflow section says new module work "MUST follow
Principles I–VI from the start rather than extending the current single-schema/no-RBAC skeleton" —
this feature is exactly that first real module work for auth, so it owns closing these gaps rather
than assuming a separate migration effort does it first.

**Alternatives considered**: Wait for a separate "harden auth" cleanup feature before building
login properly — rejected: the buildcore-web frontend is already coded against a contract (cookie
refresh tokens, lockout, generic errors) that the current skeleton cannot satisfy at all; shipping
login without these fixes wouldn't be a smaller feature, it would be a non-functional one.

## 2. Refresh-token rotation + reuse detection design

**Decision**: Model refresh tokens as rows in a new table, not as bare JWTs verified only by
signature. Each row stores: a random opaque token identifier (hashed at rest, like a password —
never store or compare the raw token value), the account it belongs to, its `familyId` (shared by
every token descended from one original login), whether it has been used (rotated out), and its
expiry. On `/auth/refresh-token`: look up the presented token's hash; if not found or expired,
reject; if found but already marked "used," treat this as reuse — revoke every row sharing that
`familyId` and record an audit event (spec FR-008); otherwise mark it used, issue a new token row
in the same family, and return it.

**Rationale**: Reuse detection is structurally impossible with stateless JWT-only refresh tokens
(there's nothing to mark "used") — it requires a persisted, checkable record. This is the standard
"refresh token family" pattern from the OAuth 2.0 Security BCP the user confirmed they want
(clarification: "Yes, detect reuse").

**Alternatives considered**: Keep refresh tokens as pure signed JWTs and rely only on a short
lifetime to bound exposure — rejected: the user explicitly asked for reuse detection, which a
stateless token cannot provide; a shorter lifetime alone doesn't satisfy FR-008/SC-005.

## 3. Cookie-based refresh token delivery

**Decision**: Set the refresh token as a `Secure; HttpOnly; SameSite=Strict` cookie from
`auth.controller.ts` (via the raw Express `Response` object, since NestJS controllers can inject
it), with `Max-Age` set to 30 days when `rememberMe` is true and omitted (session cookie) when
false. Read it back the same way on `/auth/refresh-token` and `/auth/logout` — no request body
carries it.

**Rationale**: Matches both the constitution (Principle V: "refresh tokens MUST be delivered as
HTTP-only cookies") and the already-built `buildcore-web` contract (`contracts/auth-api.md`,
reused here) — this is one of the few points where both sides already agree, so no reconciliation
is needed, only implementation.

**Alternatives considered**: Continue returning the refresh token in the JSON body (today's
behavior) — rejected outright by the constitution; not a real option.

## 4. Account lockout representation

**Decision**: Add lockout fields (`consecutiveFailures`, `lockedUntil`) directly on the account's
own row rather than a separate join table, since it's a 1:1 relationship with no independent
lifecycle of its own beyond the account.

**Rationale**: Simpler schema, one less join for every login attempt (which is the hottest path in
this feature); nothing in the spec requires historical login-attempt records to be queryable
independently of the current lockout state (that's the Audit Log's job, a separate table, for
history).

**Alternatives considered**: A separate `LoginAttempt` table keyed by account — rejected as
unnecessary complexity for data with no independent lifecycle; would only be justified if
per-attempt history needed its own retention/query pattern, which isn't required here.

## 5. Multi-tenancy: company scoping and the Super Admin exception

**Decision**: Add a nullable `companyId` column to the account table (nullable specifically to
represent the Super Admin exception — every other role's row MUST have it populated, enforced at
the application/DTO layer since Prisma/Postgres can't conditionally require a column by row).
Postgres Row-Level Security policies on every tenant-scoped table compare against a session-level
`app.current_company_id` setting; for a Super Admin request, the application layer sets a distinct
session flag that the RLS policy explicitly checks (`app.is_super_admin = true` bypasses the
`company_id` equality check) rather than ever forging a matching `company_id`.

**Rationale**: A nullable column keeps "no company" representable at all without a sentinel magic
value; a policy-level bypass flag (rather than, say, giving Super Admin a fake matching
`company_id` per request) keeps the exception explicit and auditable at the database layer itself,
matching the clarification's requirement that this stay "narrowly-scoped."

**Alternatives considered**: Give Super Admin a row per company (one account per company they
administer) — rejected: contradicts the clarification's decision that Super Admin authenticates
once with one set of credentials and gets a cross-company-scoped token, not N separate accounts.

## 6. RBAC guard mechanism (FR-010, User Story 6)

**Decision**: A `@Roles(...)` decorator (metadata via `Reflector`) paired with a `RolesGuard`
(implements `CanActivate`, reads the required roles via `Reflector`, compares against the
authenticated request's role claim) — the standard NestJS guard/decorator pattern, applied
alongside the existing `JwtAuthGuard` rather than replacing it. An endpoint with no `@Roles(...)`
decorator is authenticated-only, matching today's behavior exactly (backward compatible with
`UsersController`'s existing `@UseGuards(JwtAuthGuard)` usage).

**Rationale**: This is exactly the "declarative role/permission guard" the constitution calls for
in Principle V and the clarification confirmed should be built now; NestJS's own guard/decorator
composition is the idiomatic mechanism for this, requiring no new library.

**Alternatives considered**: An in-handler `if (user.role !== ...)` check per endpoint — this is
literally what the constitution calls out as the anti-pattern to avoid ("rather than an in-handler
`if` check").

## 7. Rate limiting

**Decision**: Introduce `@nestjs/throttler`, scoped specifically to the `/auth/*` controller (via
`@Throttle(...)` or a dedicated `ThrottlerGuard` on `AuthController`), rather than a global
application-wide limiter, in this pass.

**Rationale**: The constitution lists `@nestjs/throttler` as a pre-approved addition "when the
module that needs them lands" — this is that module. Scoping it to auth first (rather than
globally) matches this feature's actual requirement (FR-016) without taking on a broader
rate-limiting policy decision for unrelated endpoints, which is out of scope here.

**Alternatives considered**: Hand-roll rate limiting with a Postgres/in-memory counter — rejected:
reinvents what the pre-approved, constitution-sanctioned package already does.

## 8. Audit log storage

**Decision**: A new, append-only `AuditLogEntry` table (or, if a schema-per-module "shared" schema
audit table is later established for the whole app, this feature's writes target that same table)
capturing event type, account/attempted-email, timestamp, IP, and company — written to, never read
back, by this feature (per clarification: "write-only in this feature").

**Rationale**: No audit log table exists anywhere in the codebase today (confirmed by inspection —
`prisma/schema.prisma` has only the placeholder `User` model), so this feature is establishing it,
not extending something pre-existing.

**Alternatives considered**: Reuse Prisma's `nestjs-prisma` logging middleware (already wired for
query logging in `app.module.ts`) as a stand-in for the audit log — rejected: that middleware logs
at the query/SQL level for debugging, not as a queryable, event-typed security record with the
specific fields (actor, event type, company) this feature's audit requirements need.

## 9. Configuration centralization

**Decision**: Extend `SecurityConfig` (`config.interface.ts`) with the new settings this feature
needs (lockout threshold/duration, refresh-token "remember me" vs. default lifetime, throttler
limits) and read `JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET` through that same typed config path
rather than the current `configService.get('JWT_ACCESS_SECRET')` raw-string-key calls scattered
across `jwt.strategy.ts` and `auth.module.ts`.

**Rationale**: Those raw-key `.get()` calls are a pre-existing, narrow gap relative to Principle
III's "never as a raw, scattered `process.env.X`" — while `ConfigService.get()` isn't literally
`process.env`, using an unstructured string key instead of the typed `Config` interface has the
same drift risk the principle is guarding against, and this feature already has to touch this exact
file for the new settings anyway.

**Alternatives considered**: Leave the existing raw-key calls alone and only add new settings the
same way — rejected: would let a known-narrow gap grow wider right as this feature is already
editing the same three lines, for no savings.

## 10. Schema-per-module placement for auth's tables

**Decision**: Move the account table and this feature's new tables (refresh tokens, audit log)
into a dedicated `shared` Postgres schema (via Prisma's multi-schema support), rather than leaving
them in the current undifferentiated default schema.

**Rationale**: Auth/User doesn't belong to any of the seven named business modules
(hr/payroll/projects/plant/inventory/partners/settings) — `shared` is exactly the catch-all
Principle I names for cross-module concerns like this. The constitution's own Development Workflow
section says new module work "MUST follow Principles I–VI from the start rather than extending the
current single-schema/no-RBAC skeleton" — this feature is real new work on the account model, so it
is the right point to make the split, rather than adding more tables to the un-split skeleton and
leaving the eventual migration even larger.

**Alternatives considered**: Leave everything in the default schema and treat the full
schema-per-module split as a separate future migration — rejected: the constitution's own wording
draws the line at "new module work," and this feature is squarely that for the account model, not
"unrelated changes" the constitution's deferral language is protecting.

