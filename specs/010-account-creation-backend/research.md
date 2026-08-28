# Research: Account Creation Backend (Invite Flow)

## 1. Why this feature exists now, and why `Employee.userId` is written here

**Decision**: This feature is the first and only writer of `hr.Employee.userId` (003's field,
never populated by any shipped feature until now). When an admin creates a User account with an
`employeeId`, this feature sets `Employee.userId = newUser.id` in the same transaction as the User
row insert.

**Rationale**: 001 and 002 both explicitly deferred account *creation* to "a separate Account
Creation feature" — a forward reference that was never resolved because that feature was never
specced. This was discovered during a master-PRD alignment audit sweep: 001's data-model.md and
002's spec.md/research.md/plan.md all name the gap explicitly, and 003's `Employee.userId` FK has
existed since that feature shipped with no code path that ever sets it. Building this feature
closes both gaps in one pass rather than as two independent fixes, since they're the same root
cause (no invite flow exists).

**Alternatives considered**: Having 005 (HR employee onboarding) create the User account directly
as part of Employee creation — rejected: conflates two different admin actions (adding an employee
record vs. granting system access) that the master PRD explicitly separates (§7.3.1 Employee
Management has no password/invite fields at all; §7.1 Invite Flow is its own section). Not every
Employee needs a login (Daily Workers, per 005, structurally never do).

## 2. Invite token: opaque random value, hash stored, mirrors refresh-token pattern

**Decision**: `crypto.randomBytes(32).toString('hex')` generates the raw token; only its SHA-256
hash is stored in `InviteToken.tokenHash`. The raw value is embedded in the emailed link and never
persisted or logged anywhere. Token lookup on validate/set-password hashes the incoming value and
matches by hash — identical to how 001's `RefreshToken.tokenHash` already works.

**Rationale**: Reusing an already-audited pattern (001's refresh token hashing) rather than
inventing a new one; a leaked database dump alone can never be used to forge a valid invite link.

**Alternatives considered**: JWT-based invite tokens (self-contained, no DB lookup needed) —
rejected: a JWT can't be invalidated before its expiry without a revocation list, which is exactly
the DB row this design already needs for the resend-invalidates-prior-token requirement (spec
US3 AC1) — so a JWT would need the same storage anyway, with none of the benefit.

## 3. `User.status` gains a `pending` value; no separate "invited" table needed

**Decision**: 001's existing `status: 'active' | 'deactivated'` enum on `shared.User` gains a
third value, `pending`. The User row is created immediately at invite time (not deferred until
set-password) so that `002-settings-backend`'s existing `GET /settings/users` (backed by this
feature's exported `UsersService.findAllForCompany()`, §8 below) can show pending invites in the
same list as active/deactivated accounts, and so email uniqueness (FR-010) is enforced against a
real row from the moment of creation, not a separate staging table that would need its own
uniqueness check reconciled against the User table.

**Rationale**: A single source of truth for "does this email already have an account" avoids the
class of bug where a separate pending-invites table and the User table can disagree. This also
means 001's login endpoint needs zero changes — it already rejects non-`active` accounts by
whatever mechanism it currently uses for `deactivated`; `pending` behaves identically for login
purposes without 001 needing to special-case a third status value (verified against 001's spec:
its rejection logic is "account is not active," not an enum-value allowlist).

**Alternatives considered**: A separate `PendingInvite` staging table with no `User` row until
set-password succeeds — rejected per the reasoning above (uniqueness/listing complexity for no
real benefit); it also can't represent "resend an invite for a user with a linked Employee record
already partially configured," since nothing exists yet to attach that Employee link to.

## 4. `displayName` vs. deriving name from linked Employee

**Decision**: `shared.User` gains a nullable `displayName` column, populated only when no
`employeeId` is given at creation. Every account-list/detail read resolves a display name as
`Employee.firstName + ' ' + Employee.lastName` when linked, falling back to `User.displayName`
otherwise.

**Rationale**: `shared.User` has never had its own name field (verified: 001's data-model.md lists
no `name`/`firstName` field), because every account created so far implicitly assumed the
Employee record was the name's source of truth. But not every account needs one (Super Admin, or a
system/vendor-facing account with no HR record) — the PRD's Invite Flow form only shows "name" as
one of several fields, without stating it's always employee-derived, so a fallback field is the
minimal correct model rather than forcing every account through Employee.

**Alternatives considered**: Requiring every User to have a linked Employee (make `employeeId`
mandatory) — rejected: the master PRD's own role list includes Super Admin ("full access across
all companies"), which has no company-scoped Employee record to link to by definition (it isn't
scoped to any one company's HR data at all).

## 5. Email delivery: `resend` package, centralized `EmailService`

**Decision**: A `src/shared/email/email.service.ts` wraps the `resend` npm package (pre-approved
in constitution v1.3.0) with one method for this feature's needs, `sendInviteEmail(email, token,
isResend: boolean)`, using a single hardcoded template string (defined as a constant, not inline
in the service body, per Constitution Principle III). API key read via `@nestjs/config`
(`RESEND_API_KEY`), never a raw `process.env` read.

**Rationale**: Centralizing in `shared` (not `src/account-creation/`) because 001's existing
account-lockout notification email (FR-015 there) needs the exact same delivery mechanism and
currently has no named implementation — this feature's `EmailService` becomes the natural place
for 001 to eventually wire its own notification, without this feature needing to modify 001's
scope to do so (that wiring itself is out of this feature's scope, tracked as a note in
Assumptions, not built here).

**Alternatives considered**: A `nodemailer` + generic-SMTP wrapper instead of Resend's own SDK —
rejected: master PRD §7.1 names Resend specifically ("emails a... link via Resend"), and Resend's
SDK is a thinner dependency than configuring a full SMTP transport for a single email type.

## 6. Permission: reuse `USER_MANAGEMENT`, no new enum value

**Decision**: Every admin-facing endpoint in this feature is gated by 002's existing
`Permission.USER_MANAGEMENT` value — already present in `settings.Permission`'s pre-built enum,
never used by any shipped feature until now (002 built the enum anticipating this feature by name,
same as it did for `MACHINERY`/`LOGBOOK`/`FUEL` ahead of 006).

**Rationale**: Matches this session's established reconciliation pattern (Machinery, Partners,
Inventory, Projects) — check the pre-built enum before inventing anything; `USER_MANAGEMENT` is an
exact semantic match with no ambiguity, unlike Projects' genuinely-new `DWR`/`PROJECT_FINANCIALS`
split.

**Alternatives considered**: A narrower split (e.g. separate permissions for "create user" vs.
"deactivate user") — rejected: no other feature's permission model splits by CRUD verb within one
entity type at this granularity; `USER_MANAGEMENT` is already the established single value for
this entire concern.

## 7. Invite/set-password endpoints are unauthenticated by necessity

**Decision**: `GET /account-creation/invites/:token` and `POST
/account-creation/invites/:token/set-password` are the only two endpoints in this feature *not*
behind `JwtAuthGuard` — the invitee has no session at all when following the emailed link. Both
are rate-limited (`@nestjs/throttler`, already pre-approved in the constitution's Technology Stack
section for when a module needs it) to prevent token brute-forcing, since the token itself (not a
password) is the only secret gating account activation.

**Rationale**: This mirrors 001's own Forgot-Password OTP endpoints, which are necessarily
unauthenticated for the same reason (no session yet) and are already rate-limited per the master
PRD's "rate-limited to prevent brute force" language for that flow.

**Alternatives considered**: Requiring the invitee to already have some form of session (e.g. a
magic-link auto-login before set-password) — rejected: adds complexity with no PRD requirement;
the token itself already IS the credential for this one-time action.

## 8. `UsersService` ownership: this feature, not `AuthModule` (001) — a collision caught while drafting

**Decision**: This feature exports a `UsersService` (from `AccountCreationModule`) providing
`create()` plus five account-CRUD methods `002-settings-backend`'s User Story 3 (list/edit-status-
or-role/delete existing accounts) and User Story 2 (Roles — `countByRoleId()`,
`clearRoleAssignment()`) already depend on: `findAllForCompany()`, `updateRoleOrStatus()`,
`deleteAccount()`, `countByRoleId()`, `clearRoleAssignment()`, `countActiveSuperAdmins()`. This
feature does **not** build its own `GET/PATCH/DELETE` account-list/edit/delete endpoints under
`/account-creation/*` — those already exist at `002`'s `/settings/users`, and building a second
set would duplicate the exact same `shared.User` CRUD behind two URLs with two independently-
maintained implementations.

**Rationale**: While drafting this feature's spec, a direct re-read of `002-settings-backend`'s
own spec/contracts/tasks (the same "verify before building" discipline used throughout this
session's master-PRD alignment audit) surfaced that 002 already fully specced `GET/PATCH/DELETE
/settings/users` for exactly the list/edit-status/edit-role/delete surface this feature's original
draft was about to rebuild under a different URL. 002's own contract explicitly says "Creation is
intentionally absent from this contract — new accounts are created exclusively through the
separate Account Creation feature" — i.e., 002 always intended a clean split by *concern*
(creation vs. administration of existing accounts), not by feature owning two competing copies of
the same list. A second discovery in the same pass: 002's spec assumed the shared `UsersService`
it calls into would be exported by `AuthModule` (feature 001) — but 001 never built any such
service (verified: no `UsersService` reference anywhere in 001's own spec/tasks/data-model). Since
this feature needs the same `shared.User` CRUD-adjacent operations internally anyway (its own
`create()` is the same shape of concern as 002's `updateRoleOrStatus()`/`deleteAccount()`), the
correct fix is for this feature to be the actual owner of `UsersService`, with 002 importing
`AccountCreationModule` — same interface 002 always expected, corrected owner.

**Alternatives considered**: Building this feature's own parallel `GET /account-creation/users`
list and `PATCH .../:id` status endpoints, leaving 002's `/settings/users` untouched — rejected:
would leave two ways to list/deactivate the same accounts, immediately diverging the moment either
one changes (exactly the kind of duplication this session's audit has been finding and fixing
across Partners/Inventory/Projects for permission enums and masters placement — this is the same
failure mode applied to an endpoint surface instead of a data table). Leaving `UsersService` in a
new standalone module neither feature owns — rejected: adds a module with no controller of its own
and no clear maintenance owner, when this feature already needs to be a NestJS module with exactly
this responsibility.
