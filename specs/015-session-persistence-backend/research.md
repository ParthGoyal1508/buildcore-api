# Phase 0 Research — Session Persistence (Backend)

Five open questions, each resolved with the alternative that was rejected and why.

---

## §1 — `rememberMe` on `RefreshToken`: keep vestigial or drop?

**Decision**: Drop the column by migration. `LoginDto.rememberMe` becomes optional and is ignored.

**Rationale**: Once FR-001 gives every session the same duration, the column influences nothing.
A column that is still written but no longer read is worse than no column at all: the next person
to open the schema has to work out, from the service, that it is inert — and the intervening
guess is that sessions still differ by it. Its audit value is nil, because it records a choice the
product no longer offers.

FR-004 (no live session invalidated) is satisfied because expiry lives in `expiresAt`, not in this
column. Dropping it leaves every live row's `expiresAt` exactly where it is; those sessions keep
working to their original expiry and pick up the 90-day window at their next rotation, which is
precisely what FR-004 asks for.

`LoginDto.rememberMe` is made **optional and ignored** rather than removed, because the web and
the API deploy independently. A deployed web build still sending `rememberMe: false` must not
start receiving 400s the moment the API ships — `forbidNonWhitelisted` is on globally, so removing
the field outright would do exactly that.

**Alternatives considered**:
- *Keep the column, always write `true`.* Rejected: same information loss, plus a lie in the data.
- *Keep it and honour it.* Rejected: it is the defect. 74 of 89 sign-ins left it false.

---

## §2 — Replay tolerance: time window, or generational?

**Decision**: Keep a wall-clock tolerance measured from `usedAt`, widen the default from 5 s to
60 s, and move it into configuration (`REFRESH_REUSE_GRACE_SECONDS`).

**Rationale**: The window exists to tell "one client renewing twice because several of its
requests lapsed together" from "two different parties holding the same credential". Five seconds
distinguishes those correctly only when the instance answers fast. This deployment cold-starts,
and a cold start comfortably exceeds five seconds — so the window has been classifying slowness as
theft. Five sessions have already been destroyed that way, none of them a security event.

Sixty seconds is chosen against the thing it has to cover: the longest plausible spread between
the first and last of one client's concurrent renewals, which is bounded by how long a cold
instance takes to answer. It is not a security parameter in any meaningful sense — the window only
ever applies to a credential the *legitimate* client has already rotated, and an attacker able to
present it has already achieved the interception that `httpOnly` and first-party delivery exist to
prevent. Reuse detection here is defence in depth, not the primary control.

It also matters that the web-side single-flight fix (web FR-007) removes nearly all concurrency at
source. After that, this window only has to cover genuine oddities — two tabs, a retry after a
dropped connection — and its exact value stops being load-bearing.

**Alternatives considered**:
- *Generational rule: tolerate a credential that is the immediate predecessor of the family head,
  regardless of elapsed time.* Attractive, and time-independent, which is why it was examined
  first. **Rejected because it breaks above two-way concurrency**: with three simultaneous
  renewals, the first rotates A→B, the second finds A is the immediate predecessor and rotates
  A→C, and by the time the third arrives A is two generations back and is destroyed as a replay.
  It would convert a common case into the exact failure being fixed.
- *Remove reuse detection entirely.* Rejected: FR-006 requires it, and it is the only signal that
  would ever reveal a stolen credential.
- *Make the tolerance depend on observed response latency.* Rejected as unjustifiable complexity
  for a parameter that stops mattering once single-flight lands.

---

## §3 — FR-008: telling "expired" apart from "suspected theft"

**Decision**: Keep both as `401`, and carry a machine-readable `code` in the body —
`SESSION_EXPIRED` when the credential is unknown, expired or already revoked, and
`SESSION_REVOKED` when reuse detection has just destroyed the family.

**Rationale**: The codebase already has this exact mechanism and a client that understands it:
`ApiError` carries `code` separately from `message` precisely so callers branch on a stable
identifier rather than on prose, and `PASSWORD_CHANGE_REQUIRED` is the existing precedent. Adding
a second code costs nothing and needs no new concept.

The status stays `401` because both cases mean the same thing to any client that is not this
application: present credentials again. Inventing a different status to carry a nuance only one
client reads would be a worse contract.

**Alternatives considered**:
- *Different HTTP statuses (401 vs 403).* Rejected: 403 means "authenticated but not permitted",
  which a destroyed session is not.
- *Distinguish by message text.* Rejected outright — the reason `code` exists.

---

## §4 — FR-010: who owns the cookie path, the API or the proxy?

**Decision**: The API owns it. The cookie path becomes configuration
(`REFRESH_COOKIE_PATH`, default `/auth`), and the deployed API is configured with the prefix the
web application proxies under.

**Rationale**: A cookie's attributes belong to whoever sets the cookie. The alternative — the
proxy intercepting `Set-Cookie` and rewriting `Path=` — means parsing and re-serialising cookie
attributes on every auth response: quoting rules, attribute ordering, multiple cookies in one
response, and the `__Host-`/`__Secure-` prefix rules if they are ever adopted. That is a
well-known source of subtle breakage, and it would put security-relevant string manipulation in
the layer least equipped to reason about it.

Configuration does create a coupling — the API must be told the web's proxy prefix — but it is an
explicit, single-line, environment-level coupling rather than an implicit one buried in transform
code. It is also the honest description of the situation: the two services genuinely do have to
agree on that path.

Keeping the default at `/auth` means nothing changes for any deployment that has not adopted the
proxy, so this change is safe to ship before the web change.

**Alternatives considered**:
- *Proxy rewrites `Set-Cookie`.* Rejected as above.
- *Path `/` so it always matches.* Rejected: the credential would then ride on every request to
  the origin, including every page and asset, for no benefit. A narrow path is the one cheap
  containment this cookie has.

---

## §5 — FR-009: cookie attributes and local development

**Decision**: `sameSite` becomes plain configuration (`REFRESH_COOKIE_SAMESITE`) defaulting to
`lax`; `secure` stays `true` everywhere. The existing `CORS_ORIGINS ? 'none' : 'strict'` inference
is removed.

**Rationale**: That inference encodes the very assumption this feature removes — that the browser
talks to the API cross-site. Once the web application proxies, the browser's request is
same-origin and `none` is both unnecessary and strictly worse: `SameSite=None` is what makes the
cookie third-party data in the first place, which is the defect.

`lax` rather than `strict`: `strict` withholds the cookie on top-level navigations *into* the
application, so following a link from an email into a deep page would arrive logged-out and only
recover on the next renewal. `lax` sends it on top-level GET navigations and withholds it on
cross-site subrequests, which is the behaviour wanted.

`secure: true` is unchanged and safe locally: browsers exempt `localhost` from the HTTPS
requirement.

Local development keeps working without special handling. The browser talks only to the web
application's own origin on port 3001; the web application reaches the API on port 3000 from the
server side, where cookie policy does not apply. Same-origin in development, same-origin in
production, one code path.

**Alternatives considered**:
- *Leave the inference and add the proxy.* Rejected: `CORS_ORIGINS` would still be set in
  production, so the cookie would still be issued `SameSite=None` and would still be third-party
  for any request that did not go through the proxy — silently preserving the bug on exactly the
  paths most likely to be missed.
- *`strict`.* Rejected for the inbound-link case above.

---

## §6 — FR-013: removing expired rows

**Decision**: A nightly scheduled job deletes `RefreshToken` rows whose `expiresAt` or `revokedAt`
passed more than a configurable retention ago (default 7 days), running as a system job under
`withRlsContext(..., { isSuperAdmin: true })`.

**Rationale**: `@nestjs/schedule` is already installed and
`src/partners/cron/compliance-check.cron.ts` is the working precedent for a system job in this
codebase, including how it obtains a super-admin context. Nothing new is introduced.

A ninety-day window produces roughly ninety times the rows a one-day window did, and the table
already carries 215 rows for 89 sign-ins on a near-empty deployment. Left alone it grows without
bound.

The retention delay, rather than deleting the instant a row expires, keeps a short forensic tail:
if reuse detection fires, the family's history is the only evidence of what happened, and deleting
it immediately would destroy the record needed to tell a genuine event from a false positive —
which is what FR-007 exists to make possible.

**Alternatives considered**:
- *Delete on expiry with no retention.* Rejected for the forensic reason above.
- *Never delete.* Rejected: unbounded growth of a table on the hot path of every renewal.
