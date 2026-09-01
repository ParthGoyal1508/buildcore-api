# Feature Specification: Account Creation Backend (Invite Flow)

**Feature Branch**: `010-account-creation-backend`

**Created**: 2026-08-28

**Status**: Draft

**Input**: Added during a master-PRD alignment audit sweep across `buildcore-api`. Both
`001-user-login-backend` and `002-settings-backend` explicitly deferred account *creation* to "a
separate Account Creation feature" (001's data-model.md, 002's spec.md/research.md/plan.md) —
that feature was never actually specced, leaving no way for an admin to onboard a new user despite
both prerequisite features (login/session handling in 001, the `Role`/`Permission` model in 002)
already being built to expect it. This feature implements master PRD §7.1's "User Provisioning
(Invite Flow)": an admin creates a user record (no password field), the system emails a
single-use, time-limited "set your password" link, the invitee sets their own password to
activate the account, and an admin can resend an expired/unused invite.

## Clarifications

### Session 2026-09-01

- Q: Which requests stay allowed while an account is waiting for its forced password change? → A:
  Exactly four — change-password, the caller's own profile read, token refresh, and logout.
  Everything else is refused. That is the smallest set that lets the user finish the change and
  leave: reads are not exempted, because browsing payroll, attendance and biometric status on a
  password the admin chose is most of what this rule exists to prevent.
- Q: Does the new refusal also apply to accounts already carrying the flag from an admin password
  reset? → A: No — only accounts created through the direct path. Existing reset accounts keep
  behaving as they do now, so deploying this cannot lock anyone mid-reset out of the app.
  Consequence, accepted: `mustChangePassword` can no longer decide on its own, since the same flag
  now means "enforced" on one account and "advisory" on another — the account must also record how
  its credential was set. And the equivalent hole on the admin-reset path stays open until that
  path is given the same treatment.
- Q: What does the API return when it refuses a request pending the forced password change? → A:
  `403` carrying a machine-readable code (`PASSWORD_CHANGE_REQUIRED`) in the body. The client
  branches on the code, never on message text; `428 Precondition Required` fits the semantics more
  exactly but the client has no handling for it, and `409` already means "conflicts with recorded
  state" in this system.
- Q: What does the refusal do when an account's credential origin is absent or unrecognised? → A:
  It does not refuse. Only an explicit `admin_direct` triggers it, so an unknown value fails open
  *for this rule* — the account still needs a valid session and its permissions, so the blast
  radius is one rule rather than authentication. An account whose provenance cannot be established
  is far more likely a legacy row than a directly-created one, and refusing it would lock a real
  user out over missing metadata.
- Q: When a directly-created account changes its password, do sessions issued before the change
  keep working? → A: Yes, for now — existing sessions are left alone, on the grounds that there are
  no production users today, so no admin is holding a live token for someone else's account. This
  is a deferral, not a judgement that revocation is unnecessary: see FR-017d.
- Q: Should an admin-set password have to be changed at first login? → A: Yes. The account is
  created `active` with `mustChangePassword: true`, so the user must replace it before doing
  anything else. An admin who knows a working credential can sign in as that person, and these
  accounts reach payroll and biometric data — the flag already exists for the admin-reset path and
  carries the same reasoning here.
- Q: Separate endpoint, or one endpoint with an optional password? → A: One. `POST
  /account-creation/users` takes an optional `password`; present means direct creation, absent
  means today's invite flow, unchanged. A second endpoint would duplicate creation logic — the
  employee linking, the role and company resolution, the uniqueness check — to vary one field.
- Q: Should anything be emailed when an account is created this way? → A: Nothing. The admin
  passes the credentials on out of band. Sending them would write a live password into an inbox
  and the mail provider's logs, which is the exposure `ALLOW_CONSOLE_EMAIL`'s warning exists to
  prevent; a password-free notification was considered and judged not worth a new template for a
  path whose whole point is that no email is involved.

### Session 2026-08-28 (self-resolved during the alignment audit — see research.md for rationale)

- Q: Does this feature create a bare User account, or does it require linking to an existing
  `hr.Employee` record? → A: Linking is optional but the common path. The User form takes email +
  `roleId` (from 002's `settings.Role`) + `companyId` (required unless the selected role is Super
  Admin, matching 001's cross-company exception, FR-020a there) + an optional `employeeId`
  (searchable dropdown of `hr.Employee` rows with no `userId` yet, via `HrService
  .getUnlinkedEmployees()`). If `employeeId` is provided, `Employee.userId` is set to the new
  User's id (research.md §1) — this is how 003's `Employee.userId` FK gets populated in practice,
  since no other feature ever writes it.
- Q: Where does the "Name" shown to an admin creating a user come from, since `shared.User` has no
  `name` field? → A: From the linked Employee's `firstName`/`lastName` when one is selected; the
  User form has no separate Name field of its own. When no Employee is linked (e.g. a Super Admin
  or a vendor-facing account with no HR record), the create form requires a `displayName` free-text
  field instead, stored on `User` as a new nullable column used only when `employeeId` is absent.
- Q: What happens to an invite token that expires unused? → A: The account row already exists
  (`status: pending`) but has no password set and cannot log in. An admin sees it in the User list
  with an "Invite Expired" badge and a "Resend Invite" action, which generates a new token
  (invalidating the old one) and re-sends the email — matching master PRD §7.1 step 4 exactly.
- Q: Can an admin create a user with an email that matches an already-`deactivated` account? → A:
  No — email uniqueness is global per 001's existing `shared.User.email` unique constraint,
  regardless of status; the correct action for a returning user is reactivating the existing row
  (FR-010), not creating a new one. `409 Conflict` with a message distinguishing "already active"
  from "exists but deactivated — reactivate instead."
- Q: What email delivery mechanism sends the invite/resend emails? → A: `resend` (Resend's Node
  SDK), per master PRD §7.1 ("emails a... link via Resend") — newly pre-approved in the
  constitution (v1.3.0) for any module needing transactional email, and retroactively documents
  what 001's account-lockout notification email (FR-015 there) already assumed without naming a
  library.
- Q: Does this feature duplicate `002-settings-backend`'s existing `GET/PATCH/DELETE
  /settings/users` (User Story 3 there — list, edit role/status, delete)? → A: No — that collision
  was caught while drafting this feature. `002` already owns listing, role/status editing (for
  already-existing accounts), and deletion; it explicitly deferred only account *creation* to "a
  separate Account Creation feature," which is this one. This feature owns creation and the invite
  lifecycle (validate/set-password/resend) only. Both features share one exported `UsersService`
  (owned here, imported by `002`'s `SettingsModule`) so the `pending`-status guard and refresh-token
  revocation logic exist in exactly one place — see research.md §8 for the full reconciliation,
  including the discovery that `002` had assumed this service would live in `AuthModule` (001),
  which never built it.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Admin creates a user and the invite email goes out (Priority: P1)

An admin fills a short form (email, role, company, optional linked employee or display name) and
submits it; the system creates a `pending` User account with no password, generates a single-use
invite token, and emails a "Set your password" link.

**Why this priority**: This is the entire unblocking value of the feature — without it, no new
admin, project manager, or any other role can ever get an account, regardless of how complete
001/002/005 are.

**Independent Test**: Can be fully tested by submitting the create-user form with a seeded role
and company, confirming a `pending` User row exists with no usable password, and confirming an
invite email was dispatched (via a test/sandbox Resend key or a mocked email service) containing a
tokenized link.

**Acceptance Scenarios**:

1. **Given** a valid admin session, **When** `POST /account-creation/users` is called with
   `{ email, roleId, companyId?, employeeId?, displayName? }`, **Then** a `User` row is created
   with `status: 'pending'`, no password, and the invite token (hashed) stored with a 48-hour
   expiry; the response never includes the raw token.
2. **Given** the created user, **When** the invite is dispatched, **Then** an email is sent to
   `email` via Resend containing a link embedding the raw (unhashed) token as a query/path
   parameter, which is never logged or persisted anywhere in plaintext.
3. **Given** a role other than Super Admin, **When** `companyId` is omitted, **Then** a `400`
   validation error is returned — `companyId` is required for every role except Super Admin
   (matching 001 FR-020a).
4. **Given** the Super Admin role, **When** `companyId` is provided anyway, **Then** it is
   rejected with `400` — Super Admin accounts never carry a single company scope (001 FR-005).
5. **Given** an `employeeId` for an `hr.Employee` that already has a `userId` set, **When** the
   create call is made, **Then** `409 Conflict` is returned — an Employee can be linked to at most
   one User account.
6. **Given** an email already used by an active account, **When** creation is attempted, **Then**
   `409 Conflict` ("account already exists and is active"); **given** an email used by a
   `deactivated` account, **Then** `409 Conflict` with a distinct message directing the admin to
   reactivate instead (US3).

---

### User Story 2 - Invitee sets their password and the account activates (Priority: P1)

The invitee follows the emailed link, the frontend calls a token-validation endpoint to confirm
it's live, the invitee sets a password meeting the PRD's complexity rule, and the account becomes
usable for login.

**Why this priority**: Without this half of the flow, User Story 1 only ever produces accounts
nobody can log into — the two stories together are the minimum shippable unit.

**Independent Test**: Can be fully tested by taking a freshly-generated invite token, calling the
set-password endpoint with a valid password, and confirming a subsequent login (001's existing
`POST /auth/login`) succeeds with the new password and the account's `status` is now `active`.

**Acceptance Scenarios**:

1. **Given** a valid, unexpired, unused invite token, **When** `GET
   /account-creation/invites/:token` is called, **Then** it returns `{ valid: true, email }`
   (email shown for the invitee to confirm, no other account data).
2. **Given** an expired or already-consumed token, **When** the same validation call is made,
   **Then** `{ valid: false, reason: 'expired' | 'consumed' }` is returned — never a generic 404
   that would let a client distinguish "wrong token" from "right token, wrong state" through
   response-shape probing beyond this explicit reason field.
3. **Given** a valid token, **When** `POST /account-creation/invites/:token/set-password` is
   called with a password meeting the complexity rule (min 8 chars, 1 uppercase, 1 number),
   **Then** the password is argon2-hashed and stored (reusing 001's existing `PasswordService`),
   `User.status` moves to `active`, the invite token is marked consumed, and a `201` confirms
   success.
4. **Given** a password that fails the complexity rule, **When** submitted, **Then** a `400` with
   a field-level validation error is returned and nothing is changed.
5. **Given** a token already consumed by a prior successful set-password call, **When** submitted
   again, **Then** `410 Gone` is returned — invite tokens are strictly single-use.
6. **Given** an account activated via this flow, **When** it subsequently logs in via 001's
   `POST /auth/login`, **Then** it succeeds exactly as any other active account would — this
   feature does not duplicate or bypass 001's login logic.

---

### User Story 4 - Admin creates an account with a password directly (Priority: P2)

An admin creates an account and sets its first password themselves, handing the credentials to the
person directly, without an invite email.

**Why this priority**: The invite flow (User Stories 1 and 2) is the norm and depends on
deliverable email. This path covers the cases it cannot serve — a site worker with no working
email address, a test or demo account, or an invite that has to be bypassed because mail delivery
is failing — none of which block the P1 flow.

**Independent Test**: Can be fully tested by creating an account with a password, confirming no
invite token is generated and no email is dispatched, signing in with those credentials, and
confirming the session demands a password change before anything else.

**Acceptance Scenarios**:

1. **Given** an admin supplying `email`, `roleId`, the usual company/employee fields **and** a
   `password`, **When** the account is created, **Then** it is `active` immediately with the
   password stored argon2-hashed, `mustChangePassword` set, and **no** invite token generated and
   **no** email dispatched.
2. **Given** the same request without a `password`, **When** the account is created, **Then** the
   existing invite flow runs unchanged — `pending` status, token generated, invite emailed.
3. **Given** a supplied password that fails the complexity rule, **When** creation is attempted,
   **Then** it is rejected before any account exists, by the same rule the invitee's own
   set-password call is held to.
4. **Given** an account created this way, **When** the user signs in with the admin-set password,
   **Then** they are required to set a new password before the session is useful — the admin's
   value never remains in force.
5. **Given** an account created this way, **When** an admin attempts to resend an invite for it,
   **Then** it is rejected: the account is `active` and there is no invite to resend (FR-007).

---

### User Story 3 - Admin resends an expired or unconsumed invite (Priority: P2)

An admin resends an invite for an account that hasn't yet activated (expired token, or the
invitee simply hasn't clicked it yet).

**Why this priority**: Ongoing invite management — necessary for a usable admin experience once
invites start expiring in practice, but the system is minimally viable (US1+US2) before this
exists.

**Note on scope**: This feature does **not** build account listing, role/status editing, or
deletion for *existing* accounts — `002-settings-backend`'s User Story 3 already owns
`GET/PATCH/DELETE /settings/users` for exactly that (list, edit role/active/inactive status,
delete), and explicitly deferred only account *creation* to this feature. This feature exports the
shared `UsersService` that both features' controllers call into (research.md §8), so the two
features share one implementation with no duplicated logic — this feature owns the parts 002 never
built (create, invite lifecycle); 002 keeps owning list/edit/delete of accounts that already
exist, now `pending`-aware.

**Independent Test**: Can be fully tested by creating a user, letting/forcing its invite to expire
(or directly manipulating `expiresAt` in a test), resending it, and confirming a new token/email
replaces the old one.

**Acceptance Scenarios**:

1. **Given** a `pending` account with an expired or already-consumed-without-activation invite
   (i.e., still `pending`, not `active`), **When** `POST
   /account-creation/users/:id/resend-invite` is called, **Then** a new token is generated
   (the old one is invalidated even if unexpired), a new email is sent, and the response confirms
   dispatch.
2. **Given** an `active` account, **When** `POST /account-creation/users/:id/resend-invite` is
   called, **Then** `409 Conflict` is returned — resend only applies to accounts that have never
   completed activation.
3. **Given** a `pending` account, **When** an admin instead uses `002-settings-backend`'s
   `PATCH /settings/users/:id` to set `status: 'active'` directly, **Then** `400` is returned —
   enforced by the shared `UsersService.updateRoleOrStatus()` (research.md §8) regardless of which
   feature's controller called it; a pending account can only become active via this feature's
   set-password flow (US2).
4. **Given** an `active` account deactivated via `002-settings-backend`'s
   `PATCH /settings/users/:id`, **When** the deactivation is processed, **Then** all of that
   account's refresh tokens are revoked immediately (001's existing revocation path, invoked by
   the shared `UsersService`) — this feature does not duplicate that logic, it lives once in the
   shared service both features call.

---

### Edge Cases

- What happens if the invite email fails to send (Resend API error)? → The User row and token are
  still created (not rolled back); the response includes `emailDispatchFailed: true` so the admin
  UI can immediately offer a manual resend rather than leaving the admin unaware the invite never
  went out.
- What if an admin creates a user, then the invite expires, then the admin creates *another* user
  with the same email before resending? → Blocked by the email-uniqueness `409` (FR from US1 AC6) —
  the existing `pending` row must be resent or the create request must use a different email.
- What if the linked `Employee`'s `userId` is cleared (unlinked) after the User account already
  exists? → Out of scope for this feature; unlinking/relinking an Employee↔User pair is not part of
  the invite flow and is not built here.
- What if two admins resend the same user's invite concurrently? → The second call's token
  generation happens after the first's write completes (single-row update, no read-then-write
  race at the DB level); the email that reaches the invitee is whichever token is currently valid
  at click time — the earlier email's link, if clicked after being invalidated, resolves to
  `{ valid: false, reason: 'consumed' }`, surfaced identically to a normal expiry.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST allow an admin to create a `shared.User` account with `status: 'pending'`
  and no password, given `email`, `roleId` (FK to `settings.Role`), `companyId` (required unless
  `roleId` resolves to the Super Admin role), and either `employeeId` (FK to an unlinked
  `hr.Employee`) or `displayName` (required when `employeeId` is absent).
- **FR-002**: System MUST generate a cryptographically random invite token on user creation,
  store only its hash (never the raw value), and set a 48-hour expiry from generation time —
  matching master PRD §7.1 step 2.
- **FR-003**: System MUST send the invite email via `resend` containing a link with the raw token,
  to the account's `email`; email delivery failure MUST NOT block user creation but MUST be
  surfaced in the creation response (`emailDispatchFailed`).
- **FR-004**: System MUST expose `GET /account-creation/invites/:token` returning whether a token
  is currently valid (unexpired, unconsumed) without requiring authentication (the invitee has no
  session yet).
- **FR-005**: System MUST expose `POST /account-creation/invites/:token/set-password` that, given
  a password meeting the complexity rule (min 8 chars, 1 uppercase, 1 number), argon2-hashes and
  stores it (reusing 001's `PasswordService`), marks the token consumed, and moves `User.status`
  to `active` — all in a single transaction.
- **FR-006**: System MUST reject a set-password call against an expired or already-consumed token
  without any side effect, distinguishing the two reasons in the response.
- **FR-007**: System MUST allow an admin to resend an invite for any account still in `pending`
  status, invalidating the previous token and generating/emailing a new one; MUST reject resend
  for an `active` account with `409`.
- **FR-008**: The shared `UsersService` this feature exports (research.md §8) MUST reject a direct
  `status: 'active'` write against a currently-`pending` account with `400`, regardless of which
  feature's controller invokes it — `002-settings-backend`'s `PATCH /settings/users/:id` is the
  admin-facing entry point for this rejection today, since deactivate/reactivate/role-edit of
  *existing* accounts is that feature's own scope, not rebuilt here (see spec's scope note under
  User Story 3).
- **FR-009**: System MUST export a `UsersService` (from `AccountCreationModule`) providing
  `create()`, `findAllForCompany()`, `updateRoleOrStatus()`, `deleteAccount()`, `countByRoleId()`,
  `clearRoleAssignment()`, and `countActiveSuperAdmins()` — the full set `002-settings-backend`'s
  User Story 3 and User Story 2 (Roles) already depend on and originally assumed would come from
  `AuthModule` (001), which never built it (research.md §8). This feature is the actual owner;
  002 imports it rather than reimplementing account CRUD.
- **FR-010**: System MUST enforce global email uniqueness across all `User` statuses (`pending`/
  `active`/`deactivated`) per 001's existing unique constraint, returning `409` with a message that
  distinguishes an already-active email from a deactivated one (which should be reactivated, not
  recreated).
- **FR-011**: The account-list shape this feature's exported `UsersService.findAllForCompany()`
  returns (consumed by `002-settings-backend`'s `GET /settings/users`, spec FR-013 there) MUST
  include `pending` accounts with each row's status, role name, company name, `inviteExpiresAt`
  (while pending), and either the linked Employee's name or the account's `displayName` — this
  feature does not expose its own separate `GET /account-creation/users` list endpoint (see User
  Story 3's scope note).
- **FR-012**: When `employeeId` is provided at creation, system MUST set that `Employee.userId` to
  the new account's id in the same transaction as the User row creation, and MUST reject the
  request with `409` if that Employee already has a `userId`.
- **FR-013**: Every endpoint in this feature except the two invite-token endpoints (FR-004, FR-005
  — the invitee has no session) MUST be gated by `JwtAuthGuard` plus
  `@RequirePermission(Permission.USER_MANAGEMENT)` — reusing 002's existing `USER_MANAGEMENT`
  permission value (already in its enum), not inventing a new one.
- **FR-015**: System MUST accept an optional `password` on account creation. When supplied, the
  account is created with `status: 'active'`, the password argon2-hashed via 001's
  `PasswordService`, and `mustChangePassword: true` — and MUST NOT generate an invite token or
  dispatch any email. When absent, FR-001 through FR-003's invite flow applies unchanged.
- **FR-016**: A supplied password MUST be held to the same complexity rule as the invitee's own
  (FR-005: min 8 characters, 1 uppercase, 1 number), and MUST be rejected before any account row
  is created, so a failed attempt leaves nothing behind.
- **FR-017**: An account created with a password MUST require a password change at first login.
  The admin necessarily knows the value they set, and these accounts reach payroll and biometric
  data; leaving it in force would leave a credential that signs in as someone else.
- **FR-017a**: The system MUST refuse requests from a session whose account was created through
  the direct path (FR-015) and has not yet changed its password — as `403` with a
  machine-readable `PASSWORD_CHANGE_REQUIRED` code in the body, so the client can route to the
  change screen without parsing message text — allowing exactly four: the change-password endpoint, the caller's own profile
  read, token refresh, and logout. Reads are not otherwise exempt — browsing payroll, attendance
  or biometric status on a password the admin chose is most of what this rule exists to prevent. Today the flag is reported to the
  client and enforced nowhere, so an account remains fully usable on a password its admin chose;
  a client-side redirect cannot fix that, since the token is already issued and any other route
  bypasses it.
- **FR-017a-i**: Because the refusal is scoped to directly-created accounts and not to every
  account carrying `mustChangePassword`, the account MUST record how its first credential was set.
  The refusal MUST trigger only on an explicit `admin_direct` value: an absent or unrecognised
  origin MUST NOT be refused, so missing metadata can never lock a real user out of the whole
  application. Failing open is confined to this one rule — session validity and permission checks
  are unaffected by it.
  The flag alone cannot carry the distinction: an account reset by an admin keeps today's advisory
  behaviour, and a directly-created one is refused, and nothing else separates them.
- **FR-017a-ii**: Accounts whose password was set by an admin *reset* remain unenforced. This is a
  deliberate limitation, not an oversight — such an account is still fully usable on a password its
  admin knows. Closing it means applying FR-017a to that path too, which is out of scope here
  because it would lock out anyone mid-reset the moment this deploys.
- **FR-017d**: Sessions issued before the forced password change are NOT revoked. Deferred
  deliberately while the system has no production users — with none, no admin is holding a live
  token for an account they created. It does mean the forced change currently removes the admin's
  *knowledge* of the password but not any access they already hold, so this MUST be revisited
  before real users exist; 001's refresh-token family revocation is the mechanism when it is.
- **FR-017b-i**: A password change MUST reject a new password identical to the current one. Without
  this the forced change is defeatable in one step: re-entering the admin's value clears the flag
  and leaves in force precisely the credential FR-017 exists to retire, while the screen reports
  success.
- **FR-017b**: Changing a password MUST clear the flag in the same write. Left set, it would
  redirect the user on every subsequent login with no way out, turning a one-time step into a
  permanent trap.
- **FR-017c**: The system MUST provide a working password-change screen for an account in this
  state. `/change-password` is a placeholder today, so a user redirected there has nowhere to go —
  which is why FR-017a's server-side refusal cannot ship without it.
- **FR-018**: The direct path MUST NOT weaken FR-008. That rule forbids transitioning a
  *currently-pending* account to `active` outside the invite flow, and remains in force —
  direct creation never produces a pending account to transition, so an account still has exactly
  one way to leave `pending`.
- **FR-014**: System MUST write audit log entries for: user creation, invite resend, and successful
  set-password (activation) — reusing `shared.AuditLogEntry` per Constitution Principle IV, with
  entityType `USER_ACCOUNT`. A direct creation (FR-015) MUST be distinguishable in the audit log
  from an invited one, since the two differ in who chose the credential. (Deactivation/reactivation
  audit logging is
  `002-settings-backend`'s own responsibility, using the same `USER_ACCOUNT` entityType so both
  features' writes to an account appear together in the Activity Log.)

### Key Entities

- **User Account (extended)**: Adds to 001's existing `shared.User` model — `status` gains a
  `'pending'` value (alongside 001's existing `active`/`deactivated`), `displayName` (nullable
  string, used only when no Employee is linked).
- **Invite Token** (`shared` schema — new): `id`, `userId` (FK), `tokenHash`, `expiresAt`,
  `consumedAt` (nullable), `createdAt`. One active (unconsumed, unexpired) token per user at a
  time — resend invalidates the prior row's usability without deleting it (audit trail).
- **Employee.userId** (`hr` schema — existing, feature 003): This feature is the first and only
  writer of this field outside of Employee's own creation flow — it is set here when an
  `employeeId` is supplied at user creation.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An admin can take a brand-new employee from "no login access" to "actively logged in
  with their own password" using only this feature's endpoints plus 001's existing login — zero
  manual database intervention required, closing the gap both 001 and 002 explicitly deferred.
- **SC-002**: Every invite token is single-use — no sequence of API calls against this feature can
  result in two successful `set-password` calls against the same token.
- **SC-003**: No invite email ever contains a raw token that remains valid after 48 hours or after
  one successful use, verified across all tested paths (normal use, resend, expiry).
- **SC-004**: Deactivating an account (via `002-settings-backend`'s endpoint, backed by this
  feature's exported `UsersService`) takes effect within the same request — no subsequent request
  from that account's existing session succeeds after deactivation.

## Assumptions

- 002's `settings.Role` (with its nine seeded default roles, one of which is Super Admin) and
  `settings.Permission` enum (including `USER_MANAGEMENT`, already present) are the source of
  truth this feature reads from — this feature adds no new Role or Permission definitions.
- 001's `PasswordService` (argon2 hashing), refresh-token revocation mechanism, and login endpoint
  are reused as-is; this feature does not reimplement or fork any part of them.
- `hr.Employee.userId` (003) is only ever set by this feature in practice — 003/005 create
  Employee rows without a User account attached, and this feature is what closes that loop when an
  admin is ready to grant the employee system access. Employees never requiring login (e.g. a
  Daily Worker, per 005) simply never get linked.
- `resend` (Node SDK) is used directly from a small `EmailService` in `shared`, following the same
  centralized-service pattern as `PasswordService` — no email templating engine is introduced;
  invite/resend emails use a single hardcoded (but centrally-defined, per Constitution Principle
  III) template string, not a general-purpose templating system.
- `002-settings-backend`'s existing `GET/PATCH/DELETE /settings/users` (its own User Story 3)
  remains the only admin-facing surface for listing, editing, and deleting *existing* accounts —
  this feature does not duplicate those endpoints under `/account-creation/*`. The two features
  share one exported `UsersService` (owned here) so there is exactly one implementation of
  account CRUD, not two independently-evolving ones.
