# Feature Specification: Session Persistence (Backend)

**Feature Branch**: `015-session-persistence-backend`
**Created**: 2026-09-11
**Status**: Draft
**Input**: The backend half of the session-persistence defect. Companion to
`buildcore-web` feature 015; that specification carries the user-facing scenarios and the
production evidence. This one covers only what the API owns.

## Context

Signed-in users are being logged out on page reload and part-way through a working session. The
fault was root-caused from this system's own session records before either specification was
written:

| Observation | Count |
|---|---|
| Sign-ins recorded | 89 |
| Sign-ins whose session was **never once renewed** | **74 (83%)** |
| Longest-lived single session (renewals) | 29 |
| Sessions terminated by replay protection | 5 |
| Sign-ins that asked to be remembered | 23 |

The dominant cause is a browser-storage problem owned by the web application and fixed there: the
renewal credential is currently kept by the browser as third-party data and most browsers refuse
it. This specification covers the three parts the API owns, none of which the web change fixes on
its own:

1. **Session duration is too short and conditional.** A session lasts one day unless the user
   asked to be remembered, in which case thirty. 74 of 89 sign-ins did not ask.
2. **Replay protection mistakes ordinary concurrency for theft.** When one client renews more than
   once in quick succession — which is normal when several parts of a screen discover at the same
   moment that their working credential has lapsed — the later arrivals are treated as a stolen
   credential being re-presented and the whole session is destroyed. The tolerance for this is
   currently five seconds, which a cold or loaded instance exceeds. Five sessions have already
   been destroyed this way.
3. **The renewal credential is delivered with attributes chosen for a cross-site deployment.**
   Once the web application routes its own traffic, those attributes are wrong: they weaken the
   cookie's protections for no remaining benefit, and its path no longer matches where the browser
   will send it.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A session that lasts as long as the user keeps using it (Priority: P1)

Anyone who signs in keeps that session for as long as they keep using the product, and for a long
time after they stop. No one is asked to choose this, and no one is penalised for not choosing it.

**Why this priority**: This is the defect. A one-day session is the reason the majority of users
are signed out daily regardless of anything the browser does.

**Independent Test**: Establish a session, confirm the recorded expiry is ninety days out. Renew
it, confirm the expiry has moved ninety days from the renewal rather than staying where it was.
Confirm the same holds whether or not the caller asked to be remembered.

**Acceptance Scenarios**:

1. **Given** any successful sign-in, **When** the session is created, **Then** it is valid for
   90 days, irrespective of anything the caller requested.
2. **Given** a session being renewed, **When** the renewal succeeds, **Then** the new expiry is
   90 days from the moment of renewal, not from the original sign-in.
3. **Given** a session last used 89 days ago, **When** it is renewed, **Then** the renewal
   succeeds.
4. **Given** a session last used 91 days ago, **When** it is presented, **Then** it is refused,
   and the refusal is distinguishable from a refusal caused by suspected theft.
5. **Given** a session created before this change with a one-day or thirty-day expiry, **When**
   it is next renewed, **Then** it succeeds and the replacement carries the new 90-day expiry.

---

### User Story 2 - Concurrency is not theft (Priority: P1)

A client that renews the same session more than once in quick succession keeps working. Replay
protection continues to catch a credential genuinely presented by two different parties.

**Why this priority**: Equal-first. This is the failure that interrupts work already in progress,
and it destroys the session outright rather than merely ending it early.

**Independent Test**: Present the same renewal credential several times in quick succession and
confirm every attempt succeeds and the session survives. Repeat with the presentations spread over
a period longer than the current five-second tolerance, simulating a slow instance. Then confirm
that a genuinely stale credential — one presented long after the session moved on — is still
refused and still destroys the session.

**Acceptance Scenarios**:

1. **Given** a renewal credential presented several times within a short interval, **When** each
   is processed, **Then** all succeed and the session remains valid.
2. **Given** the same, but spread over a period long enough to exceed the present tolerance
   because the instance was slow to respond, **When** each is processed, **Then** the session is
   still **not** destroyed.
3. **Given** a credential presented long after the session has moved well past it, **When** it is
   processed, **Then** it is refused and the whole session is destroyed — the protection must
   still work.
4. **Given** a session destroyed by suspected theft, **When** that happens, **Then** it is
   recorded in the audit trail with enough detail to tell a genuine event from a false positive
   afterwards.

---

### User Story 3 - Credential delivery matched to first-party routing (Priority: P2)

Once the web application routes its own backend traffic, the renewal credential is delivered with
the attributes appropriate to a same-site request, and reaches the browser at a path the browser
will actually send it back to.

**Why this priority**: Lower only because it is consequential on the web change rather than
independently visible. If it is wrong, however, the web change does not work at all.

**Independent Test**: Exercise sign-in and renewal through the web application's own route and
confirm the credential is stored and returned by the browser on the next renewal.

**Acceptance Scenarios**:

1. **Given** a sign-in arriving through the web application's own origin, **When** the session is
   established, **Then** the renewal credential is delivered with attributes that a browser will
   accept and retain as first-party data.
2. **Given** the credential's delivery path, **When** the browser later makes a renewal request,
   **Then** the path matches and the credential is sent.
3. **Given** a sign-out, **When** it is processed, **Then** the credential is cleared using
   attributes that match those it was set with, so no stale credential is left behind.
4. **Given** the credential, **When** inspected in the browser, **Then** it remains unreadable to
   page scripts.

---

### Edge Cases

- A session renewed twice concurrently must leave the client holding a credential that still
  works; whichever renewal the client ends up with must be valid.
- Deploying this change must not invalidate any session that is currently live.
- Removing the remembered/not-remembered distinction must not break records that already carry it.
- A session destroyed for suspected theft must remain destroyed; widening tolerance must not make
  the protection re-admit a credential it has already rejected.
- Expired session records accumulate; a ninety-day window produces more of them than a one-day
  window did.
- A sign-out arriving with an already-invalid credential must still clear the browser's copy
  rather than failing outright.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: A session MUST be valid for **90 days** from its creation, for every sign-in, with
  no dependence on anything the caller requested.
- **FR-002**: Renewing a session MUST set its expiry to 90 days from the moment of renewal, so
  that continued use extends it indefinitely (a sliding window).
- **FR-003**: The request to sign in MUST NOT require the caller to state a session-duration
  preference. If such a field is still supplied by an older client, it MUST be accepted and
  ignored rather than rejected.
- **FR-004**: Sessions that exist when this change is deployed MUST remain valid, and MUST adopt
  the new duration at their next renewal. No live session may be invalidated by the deployment.
- **FR-005**: Replay protection MUST tolerate the same session being renewed repeatedly in quick
  succession by one client, including when responses are slow enough that the presentations are
  separated by a substantial interval.
- **FR-006**: Replay protection MUST continue to destroy a session when a credential is presented
  that the session has genuinely moved beyond. Widening tolerance MUST NOT remove the protection.
- **FR-007**: A session destroyed by replay protection MUST be recorded in the audit trail with
  enough context to distinguish a genuine theft signal from a false positive after the fact.
- **FR-008**: A refusal caused by an expired session MUST be distinguishable, by the client, from
  a refusal caused by suspected theft, so the user can be told which occurred.
- **FR-009**: The renewal credential MUST be delivered with attributes appropriate to same-site
  delivery through the web application's own origin, and MUST remain unreadable to page scripts.
- **FR-010**: The path at which the renewal credential is delivered MUST match the path at which
  the browser will present it, given that requests now arrive through the web application's route.
- **FR-011**: Clearing the credential at sign-out MUST use attributes matching those it was set
  with, so that no credential survives a sign-out.
- **FR-012**: Both the session duration and the replay tolerance MUST be configurable without a
  code change, so either can be adjusted in response to what is observed after release.
- **FR-013**: Expired and destroyed session records MUST be removable, so that a ninety-day window
  does not accumulate rows indefinitely.

### Key Entities

- **Session record**: The stored representation of one renewal credential — which session family
  it belongs to, whether it has been used, when it expires, and whether it has been destroyed. The
  fields expressing a duration *preference* become redundant under FR-003.
- **Session family**: The chain of successive credentials issued for one sign-in. Replay
  protection operates on the family: a genuine replay destroys all of it.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Every session created after this change carries a 90-day expiry, and every renewal
  moves that expiry forward.
- **SC-002**: **Zero** sessions are destroyed by replay protection during ordinary use after this
  change. Any occurrence indicates a genuine security event.
- **SC-003**: A session presented repeatedly within a short interval survives, and the same holds
  when those presentations are separated by an interval representative of a cold instance.
- **SC-004**: A genuinely stale credential is still refused and still destroys its session.
- **SC-005**: No session that was live before the deployment is invalidated by it.
- **SC-006**: Signing in and renewing through the web application's own origin results in the
  browser retaining and returning the credential.

## Assumptions

- 90 days was agreed with the product owner as the balance between never interrupting a working
  user and not leaving an abandoned device signed in indefinitely.
- The short lifetime of the working credential attached to each request is unchanged. It is not
  the cause of this defect, and keeping it short limits the value of a leaked one.
- Replay protection is correct in intent and only mis-calibrated for concurrency. This feature
  re-calibrates it; it does not remove or replace it.
- The web application will route its own backend traffic, making requests same-site. FR-009 and
  FR-010 depend on that and are meaningless without it.
- The audit trail already exists and is the right place for FR-007.
- This system has automated unit and end-to-end tests, so the scenarios above are expected to be
  covered by real tests rather than manual passes.

## Out of Scope

- The browser-storage fix itself, which is `buildcore-web` feature 015.
- Any change to how passwords are set, reset or enforced.
- Any change to permissions, roles, or what a session authorises.
- Multi-factor authentication, device registration, listing active sessions, or revoking a
  session from another device.
- Changing the lifetime of the working credential.
