# Feature Specification: Approval Spine

**Feature Branch**: `016-approval-spine`

**Created**: 2026-09-13

**Status**: Draft

**Input**: Client requirements spreadsheet, Notes 2, 5, 6, 7 and 8.

**Surfaces**: buildcore-api (approval state, chain definition, payroll schedule, attendance edit
restriction) and buildcore-web (inline actor attribution, the Action/Review control, approval
queues). Written as one specification because the five notes describe a single mechanism; the
per-repo split belongs to planning.

## Why these five notes are one feature

Notes 2, 5, 6, 7 and 8 read as five requests and are one. Each asks for some part of: *a record
moves through named people in a fixed order, everyone can see who did what, and somebody has the
last word.* Specifying them separately would produce five incompatible approval mechanisms — the
outcome this feature exists to prevent.

Today the system has approval **permissions** (`INVENTORY_APPROVE`, `LABOUR_APPROVE`,
`RECRUITMENT_APPROVE`, `ASSETS_APPROVE`) and single-step resolutions. It has no concept of a
*sequence* of approvers, and no concept of a decision that is final.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - An attendance correction survives the people who must see it (Priority: P1)

A site supervisor marks a worker present, but the punch was taken outside the geofence or the face
did not match. Rather than being silently accepted or silently dropped, the punch is raised as an
exception. It goes to the employer/site level first, then to HR, then to the director, and each of
them can approve it, reject it, or send it back. At every point, anyone looking at that day's
attendance can see exactly where it is and who last touched it.

**Why this priority**: This is the note the client wrote first (Note 2) and the one with money
attached — an unreviewed exception becomes a paid day. The system already detects these exceptions
and already has a resolution endpoint; what it lacks is the chain, which is the part the client
asked for.

**Independent Test**: Raise an out-of-geofence punch, walk it through all three levels, and confirm
the attendance record shows the correct state and actor after each one. Deliverable on its own: even
with no other story built, exceptions stop being resolvable by one person in one step.

**Acceptance Scenarios**:

1. **Given** a punch flagged for a location or face mismatch, **When** the attendance exception queue
   is opened, **Then** the punch appears with its current approval level and the name of the person
   it is waiting on.
2. **Given** an exception approved at the first level, **When** the first approver views it again,
   **Then** it is no longer in their queue and is shown as awaiting the next level.
3. **Given** an exception rejected at any level, **When** the rejection is recorded, **Then** the
   punch is not counted as present, the rejecting person and their stated reason are recorded, and
   the chain stops.
4. **Given** an exception sent back for correction, **When** the originator views it, **Then** they
   see who returned it and why, and can resubmit it into the chain from the beginning.
5. **Given** an exception awaiting the second level, **When** somebody without that level's authority
   attempts to approve it, **Then** the attempt is refused and recorded.

---

### User Story 2 - Payroll runs itself, then waits for the right people (Priority: P1)

On the first of each month the payroll run for the previous month is created automatically, with
attendance, advances and deductions already applied. Nobody has to remember to start it. It then
waits for the site in-charge, then HR, then the director. Only after the director approves can a bank
transfer sheet be produced. Between those points, only HR may change attendance — a site user cannot
quietly adjust the inputs of a run that is already under review.

**Why this priority**: Note 7 is the most specific note in the sheet and the one where an error
costs real money. It is P1 alongside US1 because the two share the chain mechanism; building either
alone still leaves the other cheap to add.

**Independent Test**: Let the scheduled run fire (or trigger it manually for a closed period), then
confirm it cannot reach a payable state without all three approvals, and that a non-HR user cannot
alter attendance for the period under review.

**Acceptance Scenarios**:

1. **Given** the first day of a month, **When** the scheduled run executes, **Then** a payroll run for
   the preceding period exists with every active employee's computed figures and a state of awaiting
   first approval.
2. **Given** a payroll run awaiting approval, **When** a bank transfer sheet is requested, **Then** the
   request is refused and the reason names the outstanding approval level.
3. **Given** a payroll run under review, **When** a non-HR user attempts to edit attendance falling in
   that period, **Then** the edit is refused.
4. **Given** a payroll run under review, **When** an HR user edits attendance in that period, **Then**
   the edit is permitted, the run's figures are recomputed, and approvals already given are
   invalidated so the chain restarts.
5. **Given** a payroll run approved at every level, **When** the bank transfer sheet is downloaded,
   **Then** it is produced and the run is recorded as approved for payment with all three approvers
   named.
6. **Given** a run already created for a period, **When** the schedule fires again for the same period,
   **Then** no duplicate run is created.

---

### User Story 3 - Every record says who did what to it (Priority: P2)

Wherever a record can be acted on — an attendance remark, a leave approval, an indent, a muster roll,
a bill — the person looking at it can see the last action taken, who took it, and when, without
leaving the page. The client's own words: *"jis user ne jo action kiya same vo us jagah show kare."*

**Why this priority**: P2 rather than P1 because it changes what people can *see* rather than what the
system will *allow*. It is the note (5) that makes the chain trustworthy in daily use, and it is
cheap once US1 and US2 have recorded the decisions.

**Independent Test**: Approve any item, then view it from a different account and confirm the actor,
action and timestamp are visible on the record itself.

**Acceptance Scenarios**:

1. **Given** a record that has been approved, rejected or returned, **When** any user with permission
   to view it opens it, **Then** the most recent action, the person's name and the time are shown on
   the record.
2. **Given** a record with several past actions, **When** the user asks for its history, **Then** the
   full sequence is shown, oldest to newest, each with actor, action, time and any stated reason.
3. **Given** a record that has never been acted on, **When** it is viewed, **Then** no action is
   implied and its state reads as awaiting its first decision.
4. **Given** a user whose role does not permit viewing the record, **When** they request its history,
   **Then** it is refused.

---

### User Story 4 - One control, in the same place, on everything reviewable (Priority: P2)

Anything awaiting a decision carries the same Action/Review control, in the same position, behaving
the same way, whichever module it belongs to. A reviewer learns it once.

**Why this priority**: Note 6 asks for it "at all places". Consistency is the requirement, and
consistency can only be specified once — which is why this is part of this feature rather than
twenty separate ones.

**Independent Test**: Open a reviewable item in three different modules and confirm the control is
present, identically placed, and offers the same decisions.

**Acceptance Scenarios**:

1. **Given** an item awaiting the current user's decision, **When** it is displayed in any list or
   detail view, **Then** the Action/Review control is present and offers approve, reject and return.
2. **Given** an item awaiting somebody else's decision, **When** the current user views it, **Then**
   the control is visible but inert, and names who it is waiting on.
3. **Given** a decision requiring a reason, **When** the user rejects or returns without giving one,
   **Then** the decision is not recorded and the reason is requested.
4. **Given** the control is used on a narrow screen, **When** the item is displayed at 320px width,
   **Then** every decision remains reachable and each target is at least 44px.

---

### User Story 5 - The director has the last word (Priority: P3)

Actions the company defines as final — payment release, letter issue, final settlement — do not take
effect until the director has approved them, whatever approvals preceded.

**Why this priority**: P3 not because Note 8 matters least, but because "every action requires
director approval" applied literally would halt daily work. It needs the chain from US1 and US2 to
exist first, and it needs the client to say which actions are genuinely final.

**Independent Test**: Mark an action type as director-final, complete every prior approval, and
confirm it does not take effect until the director approves.

**Acceptance Scenarios**:

1. **Given** an action type configured as director-final, **When** all prior levels have approved,
   **Then** it remains pending and is shown as awaiting the director.
2. **Given** such an action, **When** the director approves, **Then** it takes effect and the director
   is recorded as the final authority.
3. **Given** such an action, **When** the director rejects, **Then** it does not take effect, and the
   reason is visible to everyone who approved earlier.
4. **Given** no active user holds the Super Admin role, **When** such an action is submitted,
   **Then** it is accepted into the chain and held, and the configuration problem is surfaced rather
   than silently stalling. (The system already refuses to deactivate the last Super Admin, so this
   should be unreachable — the scenario exists to prove it.)

### Edge Cases

- An approver leaves the company or is deactivated mid-chain. The item must not become
  unapprovable; it must be reassignable to another holder of that level.
- The same person holds two or more levels — unavoidable for Super Admin, which holds every
  permission. The specification must say whether one action satisfies several levels, or whether each
  must be recorded separately; silent double-satisfaction would let one person approve their own work
  through an entire chain.
- An approver acts on an item they created. This must be refused, or explicitly permitted by
  configuration, but never unexamined.
- Two approvers at the same level act at the same moment. Exactly one decision may be recorded.
- An item's underlying data changes after partial approval (US2 scenario 4 for payroll). Every
  chain must state whether prior approvals survive; the default is that they do not.
- The scheduled payroll run fires while the previous month's run is still unapproved.
- A rejected item is resubmitted repeatedly. There must be a visible count, so a chain cannot be
  worn down by repetition without trace.
- The director rejects at the final step after a long chain. Everyone who approved must be able to
  see that their approval was overridden and why.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST support an ordered sequence of approval levels per action type, where each
  level names the role authorised to act at it.
- **FR-002**: System MUST record for every decision: the item, the level, the actor, the action
  (approve, reject, return), the time, and any stated reason.
- **FR-003**: System MUST refuse a decision from a user whose role does not hold the current level,
  and record the refused attempt.
- **FR-004**: System MUST advance an item to the next level on approval, and stop the chain on
  rejection.
- **FR-005**: System MUST allow an approver to return an item for correction, and allow the
  originator to resubmit it, restarting the chain.
- **FR-006**: System MUST require a reason for rejection and for return.
- **FR-007**: System MUST prevent an item from taking effect until every level in its chain has
  approved.
- **FR-008**: Users MUST be able to see, on the record itself, the most recent action, its actor and
  its time, without navigating elsewhere.
- **FR-009**: Users MUST be able to see the full ordered decision history of a record, subject to
  their permission to view that record.
- **FR-010**: System MUST present a single consistent Action/Review control wherever a decision is
  possible, offering the same decisions in the same place across every module.
- **FR-011**: System MUST show the control in an inert state, naming the awaited approver, when the
  item is not awaiting the current user.
- **FR-012**: System MUST raise attendance exceptions (location mismatch, face mismatch) into an
  approval chain rather than resolving them in a single step.
- **FR-013**: System MUST create a payroll run automatically on the first day of each month for the
  preceding period, exactly once per period.
- **FR-014**: System MUST apply advances and deductions when the scheduled run is created, without
  manual intervention.
- **FR-015**: System MUST hold a payroll run from producing a bank transfer sheet until its chain is
  complete.
- **FR-016**: System MUST restrict attendance edits for a period under payroll review to HR only.
- **FR-017**: System MUST invalidate approvals already given for a payroll run when its underlying
  attendance changes, and restart its chain.
- **FR-018**: System MUST allow an action type to be marked as requiring final approval by the
  Super Admin role (the client's "Director"), and MUST hold such actions until it is given.
- **FR-019**: System MUST allow a pending item to be reassigned to another holder of the same level
  when the original approver is unavailable.
- **FR-020**: System MUST record and surface the number of times an item has been returned and
  resubmitted.
- **FR-021**: System MUST prevent two approvers at the same level from both recording a decision on
  the same item.
- **FR-022**: System MUST NOT lose or alter any existing approval permission behaviour for modules
  that are not migrated onto the chain in this feature.

### Non-Functional Requirements

- **NFR-001** *(Note 23)*: The system MUST sustain 150 concurrent users performing attendance actions
  within a 15-minute window, and 60 concurrent users performing general work, with the 95th
  percentile response under 2 seconds for read operations and under 4 seconds for approval writes.
  **This is not verified today.** No load test exists, and the production API is currently deployed on
  an instance class that suspends when idle — a suspended instance's first request has been observed
  taking tens of seconds, which alone breaches this target. Verification requires a load test against
  a production-equivalent instance; until that runs, this requirement is a target, not a claim.
- **NFR-002** *(Note 25)*: Every screen carrying an Action/Review control MUST be operable on Android
  and iOS phones at 320px width, with all decisions reachable, targets no smaller than 44px, and no
  horizontal scrolling of the page body. **This is not verified today.** Only the `/my/*` employee
  screens are currently held to a mobile standard; the admin surfaces this feature touches are
  desktop-first by existing constitutional principle, so this requirement deliberately widens that
  scope and needs real-device testing to confirm.

### Key Entities

- **Approval Chain**: The ordered list of levels an action type must pass through. Belongs to a
  company, so two companies may review the same kind of work differently.
- **Approval Level**: One step in a chain — its position, the role authorised to act, and whether it
  is the final authority.
- **Approval Decision**: One recorded act by one person at one level: approve, reject or return, with
  actor, time and reason. Immutable once written.
- **Reviewable Item**: Any record that enters a chain — an attendance exception, a payroll run, and
  whichever others the client nominates. Carries its current level and current state.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of attendance exceptions reach a recorded decision by a named person; none can be
  resolved without one.
- **SC-002**: A payroll run cannot produce a bank transfer sheet without three recorded approvals —
  demonstrated by attempting it at each incomplete stage.
- **SC-003**: The monthly payroll run is created without human action on the 1st, for 3 consecutive
  months, exactly once per period.
- **SC-004**: For any record that has been acted on, a reviewer can name who acted and when within 5
  seconds of opening it, without navigating away.
- **SC-005**: The Action/Review control appears in the same position, with the same options, on every
  reviewable item across at least 5 different modules.
- **SC-006**: No attendance edit by a non-HR user succeeds for a period under payroll review, across
  all attempted paths.
- **SC-007**: Every decision refused for insufficient authority is recorded and retrievable.

## Assumptions

- **Director is the Super Admin role** (client, 2026-09-13). The final approval level in every chain
  resolves to Super Admin.

  This carries a consequence the client should see stated, because it is not obvious from the answer:
  Super Admin currently holds *every* permission in the system, including `USER_MANAGEMENT`,
  `COMPANY_SETTINGS` and `DATA_DELETE`. Making it the final financial authority means the person who
  releases payroll is also the person who can change who approves payroll, alter permissions, and
  delete records. An approval chain exists to create control, and a final approver who can
  reconfigure the chain is a weaker control than the client probably intends.

  This specification proceeds with Super Admin as Director because that is the answer given. It is
  worth revisiting whether the final-approval authority should be a distinct role holding
  approval rights *without* system administration rights — which feature 019's read/write
  granularity would make expressible. Flagged, not blocking.

- The client's "Employer-HR-Director" (Note 2) and "Site Incharge < HR Office < Director" (Note 7)
  describe the same three-tier shape at different levels of the organisation, and both are
  configurable instances of one mechanism rather than two hardcoded chains.
- Notes 6 and 8 say "every" and "all places". Taken literally, every action in the system would
  require director approval, which would stop the company working. This specification assumes the
  chain applies to action types the company nominates, with attendance exceptions and payroll named
  by the client explicitly, and that the set is configurable rather than universal.
- Existing single-step approval permissions keep working for modules not migrated here. This feature
  adds a mechanism; it does not remove the ones already in use.
- The scheduled payroll run uses the business timezone already established for attendance
  (Asia/Kolkata), so "the 1st" means the 1st locally.
- Reassignment (FR-019) is an administrative act, not something an approver can do to skip their own
  level.

### Needing the client's decision

- **[NEEDS CLARIFICATION: which roles are "HR Office" and "Site Incharge"?]** Of the three names the
  client uses, only Director is now settled (see Assumptions — it is Super Admin). The nine roles
  that exist are Accountant, HO User, Project Manager, Site Admin, Site Engineer, Site User, Store
  Keeper, Super Admin and Viewer. **Neither "HR Office" nor "Site Incharge" is among them.** HO User
  and Site Admin are the plausible candidates respectively, but plausible is not good enough here:
  FR-016 gives HR the exclusive right to edit attendance during a payroll review, so naming the
  wrong role either locks out the people who do the work or hands the right to people who should
  not have it.
- **[NEEDS CLARIFICATION: which action types require final director approval?]** Note 8 says every
  final work. The list must be enumerated before FR-018 is implementable, or the default is that only
  payment release, letter issue and final settlement are director-final.
- **[NEEDS CLARIFICATION: may one person satisfy more than one level of the same chain?]** This
  became sharper once Director resolved to Super Admin: a Super Admin holds every permission, so
  without a rule they could satisfy *every* level of a chain single-handedly — raising an attendance
  correction, approving it as HR, and approving it again as Director. The chain would then be
  ceremony rather than control.

  The options are to forbid one person from recording two decisions on the same item, to permit it
  with each decision recorded separately and visibly, or to permit it silently. The third is what
  happens if nobody decides. In a small company forbidding it may deadlock, so this needs the
  client's judgement about their own staffing, not a default.
