# Feature Specification: User Login Backend & Access Control

**Feature Branch**: `001-user-login-backend`

**Created**: 2026-08-26

**Status**: Draft

**Input**: User description: "Build the backend for the Login flow in buildcore-api: POST
/auth/login, POST /auth/refresh-token, POST /auth/logout, plus the account-lockout,
activity-logging, and session-management behavior they depend on. Backend counterpart to the
already-built buildcore-web frontend feature (buildcore-web specs/001-user-login), reconciled with
this repo's own constitution: argon2 hashing, refresh-token rotation, throttler-based rate
limiting, multi-tenant company_id + RLS, audit logging, and (per this feature's expanded scope) a
general-purpose role/permission guard system."

## Clarifications

### Session 2026-08-26

- Q: How does login resolve which company (tenant) a user account belongs to? → A: One company per
  account — the JWT carries a single `companyId` from the account record; no company-selection
  step is needed.
- Q: Should refresh-token rotation also include reuse detection (an already-rotated-out token being
  replayed is treated as a theft signal)? → A: Yes — replaying a rotated-out refresh token revokes
  that account's entire session family and is recorded as a security event.
- Q: Should this feature build the general-purpose role/permission guard system (currently a TODO
  gap in this repo), or just a minimal active/deactivated re-check? → A: Build the full RBAC guard
  system now, as part of this feature — not deferred to a separate feature.
- Q: Does a Super Admin account still belong to exactly one company for login/RLS purposes, or
  does that role need cross-company access? → A: Super Admin needs cross-company access — an
  explicit, narrowly-scoped exception to the otherwise-strict one-company-per-account model.
- Q: How should Super Admin cross-company access actually work at login/session level? → A: No
  company scope on the token — a Super Admin's access token carries no `companyId` (or an explicit
  "all companies" marker) instead of one specific company; login/session behavior is otherwise
  identical to any other account.
- Q: Does this feature need to expose any way to read back the audit log, or is writing to it
  sufficient? → A: Write-only in this feature — reading/querying the audit log is a separate,
  later Activity Log feature.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Authenticate with valid credentials (Priority: P1)

A client application (buildcore-web, or any future authorized client) submits a registered,
active account's correct email and password and receives a usable, scoped session.

**Why this priority**: Nothing else in this feature — or in any endpoint that depends on
authentication — has value if this doesn't work.

**Independent Test**: Can be fully tested by calling the login endpoint with a known-valid
email/password for an active account and confirming the response carries a usable access token,
the account's name and `mustChangePassword` flag, and a session cookie scoped to that account's
company.

**Acceptance Scenarios**:

1. **Given** an active account with correct credentials, **When** a login request is submitted,
   **Then** the response includes a short-lived access token, the account's name, and its
   `mustChangePassword` flag, and a refresh-session cookie is set.
2. **Given** an active account whose stored password was hashed with argon2, **When** the
   submitted password is verified, **Then** verification succeeds without ever re-encoding,
   logging, or exposing the plaintext password anywhere in the process.
3. **Given** an account belonging to a specific company, **When** login succeeds, **Then** the
   issued access token carries that one company's identifier and no other company's data becomes
   reachable through it.
4. **Given** a Super Admin account (which is not scoped to any single company), **When** login
   succeeds, **Then** the issued access token carries no single company identifier — instead an
   explicit cross-company marker that the access-control layer recognizes as an intentional,
   narrowly-scoped exception to the otherwise-strict one-company-per-account rule.

---

### User Story 2 - Safely reject invalid credentials (Priority: P1)

A login request with a wrong password, an unregistered email, or a deactivated account is rejected
without revealing which of those was the cause.

**Why this priority**: Equally critical to a successful login — this is the feature's primary
security property (enumeration resistance), matching the already-agreed buildcore-web contract.

**Independent Test**: Can be fully tested by submitting a wrong password for a real account, a
well-formed but unregistered email, and a deactivated account's correct credentials, and
confirming all three produce an identical response.

**Acceptance Scenarios**:

1. **Given** an email that is not registered, **When** any password is submitted for it, **Then**
   the response is the same generic rejection used for a registered email with a wrong password.
2. **Given** a registered, active account, **When** the wrong password is submitted, **Then** the
   response is the generic rejection and no session is issued.
3. **Given** a registered account whose status is deactivated, **When** its correct credentials are
   submitted, **Then** the response is the same generic rejection as a wrong password — a
   deactivated account is never distinguishable from a wrong-password case.
4. **Given** a login request missing the email or password field, **When** it is submitted,
   **Then** the request is rejected as invalid input before any credential check occurs.

---

### User Story 3 - Session persistence, rotation, and revalidation (Priority: P2)

A session issued at login remains usable for as long as it should — 30 days if "Remember Me" was
requested, a short default otherwise — is renewed via one-time-use refresh tokens, and is cut off
the moment the account's status or role no longer permits it.

**Why this priority**: Depends on User Story 1 existing first; important for not forcing frequent
re-logins and for closing the token-theft window, but the account can already authenticate without
it.

**Independent Test**: Can be fully tested by refreshing a session repeatedly (confirming each
refresh token works exactly once), replaying an already-used refresh token (confirming the entire
session family is revoked), and deactivating an account mid-session (confirming the next request
is rejected).

**Acceptance Scenarios**:

1. **Given** a valid refresh token, **When** it is used to obtain a new access token, **Then** a
   new refresh token is also issued and the one just used becomes permanently invalid.
2. **Given** a refresh token that has already been used once (rotated out), **When** it is
   presented again, **Then** the request is rejected and every other still-active session
   descended from that same original login is also revoked.
3. **Given** a session created with "Remember Me", **When** a refresh is attempted at any point
   within 30 days of the original login, **Then** it succeeds (subject to rule 1); after 30 days,
   **Then** it is rejected.
4. **Given** a session created without "Remember Me", **When** the client is expected to have
   discarded its session (e.g., after a browser restart), **Then** any refresh attempt using that
   session is rejected server-side as well, not merely relied upon to be absent client-side.
5. **Given** a signed-in account, **When** an administrator deactivates it or changes its role,
   **Then** the very next authenticated request made with that account's existing access token is
   rejected, without waiting for the access token to expire naturally.

---

### User Story 4 - Log out (Priority: P2)

A logout request ends the specific session it targets, server-side, immediately.

**Why this priority**: A basic, expected capability that makes deactivation and "Remember Me"
meaningfully reversible; depends on Story 1 (a session must exist to end one).

**Independent Test**: Can be fully tested by logging in, logging out, and confirming both the
presented refresh token and any access token issued from it are rejected on the next attempted use,
while a second, separate session for the same account is unaffected.

**Acceptance Scenarios**:

1. **Given** an active session, **When** a logout request is made for it, **Then** that session's
   entire refresh-token family is revoked immediately and any further use of it is rejected.
2. **Given** an account signed in on two separate sessions, **When** one is logged out, **Then**
   the other remains fully usable.

---

### User Story 5 - Brute-force lockout after repeated failures (Priority: P2)

An account that accumulates 5 consecutive failed login attempts is locked for 15 minutes, its
owner is emailed, and every attempt against it during that window is rejected regardless of
correctness.

**Why this priority**: A named security requirement; important, but normal login/logout/session
behavior (Stories 1–4) works independently of an attacker ever triggering this.

**Independent Test**: Can be fully tested by submitting 5 consecutive wrong passwords for one
account and confirming: the 6th attempt (even correct) is rejected with a distinct locked-account
response, an email is sent, and the account recovers once the window elapses.

**Acceptance Scenarios**:

1. **Given** an account with 4 prior consecutive failures, **When** a 5th also fails, **Then** the
   account is locked for 15 minutes and its owner is emailed.
2. **Given** a currently locked account, **When** any login attempt is made against it, **Then**
   the response is a distinct locked-account rejection (not the generic invalid-credentials
   response), stating roughly when it unlocks.
3. **Given** a locked account, **When** the 15-minute window elapses, **Then** the next correct
   login succeeds normally and the failure count resets to zero.
4. **Given** high login-attempt volume from a single originating address, **When** it exceeds the
   configured rate limit, **Then** further attempts from that address are throttled independent of
   any individual account's lock state.

---

### User Story 6 - Declarative access control for protected endpoints (Priority: P2)

Any endpoint (in this feature or elsewhere) can require the caller to hold specific roles by
declaring it, without hand-writing a role check inside the handler.

**Why this priority**: Expanded scope decided during clarification — genuinely useful the moment a
second protected endpoint exists, but this feature's own endpoints (login, refresh, logout) are
intentionally public/authenticated-only and don't themselves require role restriction, so this
capability can be built and verified independently of Stories 1–5.

**Independent Test**: Can be fully tested by declaring a role requirement on a sample protected
route and confirming a request from an authenticated-but-wrong-role account is rejected before
reaching that route's own logic, while a correctly-roled account passes through.

**Acceptance Scenarios**:

1. **Given** an endpoint that declares it requires a specific role, **When** an authenticated
   request from an account without that role is made, **Then** it is rejected before the
   endpoint's own logic runs.
2. **Given** the same endpoint, **When** an authenticated request from an account that does hold
   the required role is made, **Then** it proceeds normally.
3. **Given** an endpoint with no declared role requirement, **When** any authenticated request is
   made, **Then** it proceeds without any role check being applied.

---

### Edge Cases

- What happens when two refresh requests for the same session race each other (e.g., two tabs
  refreshing at nearly the same moment)? A short grace window should tolerate this without
  incorrectly triggering theft/reuse revocation, while a genuinely late replay (well outside that
  window) still triggers it.
- What happens to an email/case-variant of a registered address (e.g., trailing whitespace, mixed
  case)? It must resolve to the same account as its canonical stored form, not be treated as
  unregistered.
- What happens when a login request arrives for an account flagged as requiring a mandatory
  password change? Credentials still validate normally and a session is still issued; the response
  simply also carries that flag so the calling client can route accordingly — this feature does
  not implement the password-change step itself.
- What happens to consecutive-failure counting for attempts made while an account is already
  locked? They must not extend or reset the lock in a way that creates an unbounded lockout; the
  window remains anchored to when the 5th failure occurred.
- What happens if a request for a role-restricted endpoint arrives with a valid access token whose
  account was deactivated moments earlier? It must be rejected by the same status-recheck this
  feature already requires (User Story 3), not permitted through on a stale token.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST expose a login endpoint accepting an email, a password, and a
  "remember me" flag, validating the request shape and rejecting any unexpected field before any
  credential check occurs.
- **FR-002**: The system MUST reject a login attempt whenever the email is unregistered, the
  password is wrong, or the account is deactivated, returning the identical generic rejection in
  every one of these cases.
- **FR-003**: The system MUST treat the registered email as case-insensitive and trim surrounding
  whitespace before every lookup or comparison.
- **FR-004**: The system MUST hash and verify passwords using argon2, and MUST NOT store, log, or
  otherwise expose a password in plaintext at any point.
- **FR-005**: On a successful login, the system MUST issue a short-lived access token (target: 15
  minutes) carrying the account's identity, its role, and its company identifier, along with the
  account's name and its `mustChangePassword` flag — except for a Super Admin account, whose token
  MUST instead carry an explicit cross-company marker in place of a single company identifier
  (FR-020a).
- **FR-006**: The system MUST deliver the refresh token exclusively as a secure, HttpOnly,
  same-site-restricted cookie — never in a response body or any client-script-readable location —
  with a lifetime of 30 days when "remember me" was requested, and a short, non-persistent
  (browser-session-scoped) lifetime otherwise.
- **FR-007**: The system MUST rotate refresh tokens on every use: the presented token is
  invalidated immediately and a new one is issued in its place.
- **FR-008**: The system MUST detect refresh-token reuse — a token already invalidated by a prior
  rotation being presented again — and MUST respond by revoking every session descended from that
  same original login, not merely rejecting the one replayed request.
- **FR-009**: The system MUST re-validate an account's active/deactivated status (and current
  role) on every authenticated request, not only at token issuance, rejecting the request if the
  account no longer qualifies.
- **FR-010**: The system MUST provide a declarative mechanism for any endpoint to require the
  caller hold one or more specific roles, enforced before that endpoint's own logic runs, so
  individual endpoints do not each hand-write their own role check.
- **FR-011**: The system MUST provide a logout endpoint that immediately revokes the entire
  refresh-token family tied to the presented session, without affecting any other session belonging
  to the same account.
- **FR-012**: The system MUST count an account's consecutive failed login attempts and lock that
  account for 15 minutes upon the 5th consecutive failure.
- **FR-013**: The system MUST reset an account's consecutive-failure count to zero immediately upon
  its next successful login.
- **FR-014**: While an account is locked, the system MUST reject every login attempt against it
  (regardless of credential correctness) with a distinct locked-account response stating
  approximately when it will unlock.
- **FR-015**: The system MUST send an email notification to the account's registered address the
  moment it becomes locked.
- **FR-016**: The system MUST rate-limit requests to the login, refresh, and logout endpoints by
  originating address, independent of any single account's lock state.
- **FR-017**: The system MUST record every login success, login failure, account lockout, logout,
  and refresh-token-reuse event to the audit log, capturing the acting account (or attempted email,
  for an unregistered-email failure), timestamp, originating address, and company — and MUST NOT
  include password material in any such record.
- **FR-018**: Every request and response for these endpoints MUST be a validated, typed structure
  that rejects unexpected fields, and MUST be documented so the endpoints stay accurately
  discoverable.
- **FR-019**: All environment-dependent settings these endpoints rely on (signing secrets, token
  lifetimes, lockout threshold/duration, rate-limit thresholds) MUST come from centralized
  configuration, never a scattered raw environment-variable read; user-facing error text and
  lockout constants MUST live in one shared, reusable location rather than being duplicated inline.
- **FR-020**: Every table this feature relies on (account status/lockout state, session/refresh
  records, audit log entries) MUST carry a company identifier and MUST be protected so that a query
  can never return or modify data belonging to a different company, even if application logic has a
  bug.
- **FR-020a**: The system MUST support exactly one explicit, narrowly-scoped exception to FR-020's
  isolation for a Super Admin account: its cross-company marker (FR-005) MUST be recognized by the
  access-control layer as deliberately spanning all companies, and this exception MUST NOT be
  extendable to any other role.
- **FR-021**: These endpoints MUST be reachable only over an encrypted connection; no credential or
  session token is ever accepted or issued over an unencrypted connection.

### Key Entities

- **User Account**: A registered person who can authenticate — holds the argon2 password hash, a
  role, a status (active/deactivated, plus a `pending` pre-activation state added by
  `010-account-creation-backend`), and a mandatory-password-change flag. Every account except a
  Super Admin carries exactly one company identifier; a Super Admin account instead carries the
  explicit cross-company marker described in FR-020a. Owned by `010-account-creation-backend`
  (built via the Invite Flow — was an unresolved forward reference to a "separate Account Creation
  feature" until that feature was specced); this feature reads and enforces this state but does
  not create or edit accounts.
- **Session (Refresh Token Family)**: One signed-in period on one device/client, represented as a
  chain of rotating refresh tokens sharing a common lineage — a reuse of any non-current token in
  the chain revokes the whole chain. Carries its own expiry (30 days for "remember me", a short
  default otherwise) independent of the account's other sessions.
- **Login Attempt Record**: Tracks one account's consecutive login failures and, once that count
  reaches 5, the resulting 15-minute locked window; resets on that account's next success.
  Source-address rate limiting (FR-016) is a separate, coarser mechanism not tied to this record.
- **Audit Log Entry**: An immutable record of a login-related security event (success, failure,
  lockout, logout, reuse-detected) with the acting account or attempted email, timestamp,
  originating address, and company — never a password.
- **Role/Permission Requirement**: A declaration attached to an endpoint stating which role(s) may
  call it; not itself a stored record per request, but a piece of metadata the access-control
  mechanism (FR-010) reads to decide whether to admit a given authenticated request.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A login request with valid credentials completes and returns a usable session in
  under 1 second under normal load.
- **SC-002**: More than 99% of login requests with valid credentials for active accounts succeed.
- **SC-003**: Across all testing, zero requests succeed against a deactivated account or an account
  currently within its lockout window.
- **SC-004**: Across all testing, no rejection response (unregistered email, wrong password,
  deactivated account) is distinguishable from any other by status code or body content.
- **SC-005**: Across all testing, replaying an already-rotated-out refresh token results in every
  session descended from that login being revoked within the same request cycle that detects the
  reuse.
- **SC-006**: 100% of accounts that reach 5 consecutive failed attempts are locked for 15 minutes
  and their owner is emailed.
- **SC-007**: Every login success, login failure, lockout, logout, and reuse-detection event is
  present in the audit log's underlying data with the correct actor, timestamp, address, and
  company, verifiable by direct inspection (no dedicated read/query endpoint is required by this
  feature).
- **SC-008**: Across all testing, 100% of requests to a role-restricted endpoint from an account
  lacking the required role are rejected before that endpoint's own logic executes.
- **SC-009**: Across all testing, no query scoped to one company ever returns or modifies another
  company's data, except through the single, explicit Super Admin cross-company exception
  (FR-020a) — which itself never grants access beyond what that exception deliberately allows.

## Assumptions

- This feature is responsible for extending the current placeholder account model (today a single,
  non-tenant-scoped table) with the company/status/lockout/session fields it needs — that schema
  work is in scope for this feature, not a precondition assumed already done elsewhere.
- One company per account (per clarification), with a single explicit exception: a Super Admin
  account is not scoped to any one company, and its token instead carries a cross-company marker
  (FR-005, FR-020a). No other role receives this exception. A user does not select a company at
  login in either case — the token's scope is entirely determined by the account's own role/data,
  not a login-time choice.
- Refresh-token rotation includes reuse detection via a token-lineage/family model (per
  clarification); a short grace window is expected to absorb benign concurrent-refresh races
  without falsely triggering revocation — the exact window length is a planning-level detail.
- The general-purpose role/permission guard mechanism (User Story 6, FR-010) is built as part of
  this feature per the clarification, even though this feature's own endpoints (login/refresh/
  logout) don't themselves require a specific role — it exists so future protected endpoints can
  adopt it without rework.
- Forgot Password (OTP) and Password Change (logged-in user) remain out of scope for this feature.
  Account Creation (admin provisioning) also remained out of scope here, matching the
  already-agreed boundary on the buildcore-web side of this feature — it is now built separately
  as `010-account-creation-backend`.
- The buildcore-web frontend's already-built expectations (response shapes, status codes, cookie
  behavior) are the starting contract this backend targets; where this repo's constitution requires
  stricter behavior than that frontend spec assumed (e.g., rotation with reuse detection instead of
  plain revocable tokens), this backend spec's stricter version governs, and the frontend's
  behavior (transparent refresh-and-retry) remains compatible with it unchanged.
