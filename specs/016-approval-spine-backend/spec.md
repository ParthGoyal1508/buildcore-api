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

## Clarifications

### Session 2026-09-13

- Q: Which roles should the chain's "HR Office" and "Site Incharge" levels resolve to? → A: Neither.
  Levels reference **configurable role slots**, and each company maps a slot to whichever of its
  roles fills it.
- Q: May one person record decisions at more than one level of the same chain? → A: No. Once a person
  has decided on an item they cannot decide on it again at a later level.
- Q: Which actions require final Super Admin ("Director") approval? → A: Payment release, payroll run
  approval, letters that commit money (work order, LOI, purchase order), and final settlement on exit.
- Q: Which module gains the shared Action/Review control first? → A: Attendance exceptions.
  *(Sequencing; recorded in the web spec.)*

**A consequence worth stating.** Forbidding a second decision and mapping levels to slots interact:
if one company maps two slots to the same role, and only one person holds it, every item in that
chain stalls at the second of those levels. Nothing in the model prevents that configuration. The
escape is FR-019 (reassignment), which becomes load-bearing rather than a convenience — and FR-021b
below requires the configuration to be refused at definition time rather than discovered when work
stops.

### Session 2026-09-16

Raised against the client's re-stated requirement list, item 2: *"Block attendance marking if
location or photo verification fails. Log all manual attendance modifications (by any role) with
details of who changed what, and it should also reflect in the attendance of the affected employee."*
The first half is specified in feature 020; it changes what this feature's User Story 1 reviews.

- Q: Feature 020 now refuses a punch that fails location or face validation, recording no attendance at all. User Story 1 exists to route exactly those refusals through the chain. What is left for it to route? → A: **The manual attendance correction, not the punch.** US1 is re-aimed, not retired. Its subject becomes the correction a supervisor raises for a day with no accepted punch, and that correction travels the same employer → HR → director chain, with the same attribution and the same three levels. The mechanism is unchanged; only its input changes.
- Q: Does this weaken the note the client wrote first? → A: **No, it moves where the protection sits.** Note 2's concern was that an unreviewed exception becomes a paid day. Under 020's refusal there is no exception to become a paid day; the risk moves to the correction, which is an assertion by a supervisor with nothing behind it but their word. That makes the chain over corrections more load-bearing than the chain over punches ever was, not less.
- Q: Who may raise a manual attendance modification, and which ones are logged? → A: **Any role that may edit attendance, and all of them.** The client's wording is "by any role", and the logging is not conditional on the actor's seniority — a Super Admin edit is logged on the same terms as a supervisor's. This is deliberately wider than the chain: not every modification needs approval, but every modification needs a record.
- Q: What does "reflect in the attendance of the affected employee" mean — a notification, or something on the record? → A: **On the record, in the employee's own view.** The employee opening their own attendance sees that the day was modified, by whom, when, and from what to what. It is not a notification that can be missed or cleared; it is a property of the day, permanent and visible for as long as the record is.
- Q: Does an employee see the reason a modification was made? → A: **Yes, where one was stated.** Withholding the reason from the person whose pay it changes would leave them able to see that something happened to their attendance and unable to find out why, which is worse than not showing it at all.

### Session 2026-09-29

Raised against the client's re-stated requirement list, item 7: *"Every critical action across the
system requires Director-level approval before execution."* FR-018 names four action types; the
client's sentence names all of them. The gap between those two readings is the whole of US5.

- Q: Should the director-final set be widened to every state-changing action, with an exemption list? → A: **No — the named, configurable set stays.** Defaulting every write to a director gate means the Director approves each attendance edit, each inventory issue and each meter reading, and the predictable outcome is that the gate is bypassed by sharing the Director's account. A closed set is also the only version that can be tested: "every critical action" cannot be verified, because nothing defines critical. What changes instead is that the set becomes visible and its editing becomes guarded (FR-018b, FR-018c) — so the client can see at any time exactly which actions are final and which are not, and nobody can quietly remove payment release from the list.
- Q: FR-018a said "the client confirmed these four". Did they? → A: **No, and the wording is corrected.** The four were proposed on 2026-09-13 as the defensible reading of Note 8; the client's re-statement on 2026-09-16 asks for all actions, which is the opposite of a confirmation. The requirement now says the four are this product's proposal pending the client's list, which is what is true.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - An attendance correction survives the people who must see it (Priority: P1)

A worker's day was not captured — their punch was refused outside the geofence, or their face did not
match, and feature 020 recorded nothing. Their supervisor raises a correction for that day. Rather
than taking effect on one person's word, it is raised as a reviewable item: it goes to the
employer/site level first, then to HR, then to the director, and each of them can approve it, reject
it, or send it back. At every point, anyone looking at that day's attendance can see exactly where it
is and who last touched it — the affected employee included.

**Why this priority**: This is the note the client wrote first (Note 2) and the one with money
attached. Under feature 020's refusal behaviour (its FR-013, Clarifications 2026-09-16) the risk has
moved: there is no unreviewed exception to become a paid day, but there is a manual correction
standing on nothing but a supervisor's assertion. The chain over corrections is therefore more
load-bearing than the chain over punches was, and it is the part the client asked for.

**Independent Test**: Raise a manual correction for a day with no accepted punch, walk it through all
three levels, and confirm the attendance record shows the correct state and actor after each one, and
that the affected employee can see the modification. Deliverable on its own: even with no other story
built, attendance stops being correctable by one person in one step.

**Acceptance Scenarios**:

1. **Given** a manual correction raised for a day with no accepted punch, **When** the attendance
   review queue is opened, **Then** the correction appears with its current approval level, the name
   of the person it is waiting on, and the day and employee it concerns.
2. **Given** an exception approved at the first level, **When** the first approver views it again,
   **Then** it is no longer in their queue and is shown as awaiting the next level.
3. **Given** a correction rejected at any level, **When** the rejection is recorded, **Then** the day
   is not counted as present, the rejecting person and their stated reason are recorded, and the
   chain stops.
3a. **Given** an approved correction, **When** the affected employee views their own attendance,
   **Then** the day shows as modified, with who modified it, when, from what to what, and the stated
   reason.
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
3a. **Given** an attempt to remove an action type from the director-final set, **When** it is
    submitted, **Then** it is itself held for the director's approval, and the set before and after is
    recorded.
3b. **Given** the director-final set, **When** it is reported, **Then** every action type the system
    knows of is listed with whether it is final, so the client can see what is and is not gated.
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
- The director-final set is edited while items are pending under the previous configuration. An item
  already in a chain must not lose or gain a level underneath it.
- An action type is added to the set while an instance of it is mid-flight and has already taken
  effect. Nothing retrospective can be gated; the specification must not imply otherwise.
- Two approvers at the same level act at the same moment. Exactly one decision may be recorded.
- An item's underlying data changes after partial approval (US2 scenario 4 for payroll). Every
  chain must state whether prior approvals survive; the default is that they do not.
- The scheduled payroll run fires while the previous month's run is still unapproved.
- A rejected item is resubmitted repeatedly. There must be a visible count, so a chain cannot be
  worn down by repetition without trace.
- The director rejects at the final step after a long chain. Everyone who approved must be able to
  see that their approval was overridden and why.
- A supervisor raises a correction for a day the employee did not work, and it is approved. Nothing in
  the data distinguishes this from a genuine correction — which is why the chain and the permanent,
  employee-visible record of who made it are the only controls available.
- An employee disputes a modification they can see on their own attendance. The specification records
  the modification and its author; it does not define a dispute mechanism, and one may be needed.
- A modification is made to a day, then reverted. Both the modification and the reversion are logged;
  neither erases the other.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST support an ordered sequence of approval levels per action type, where each
  level names a **role slot** rather than a role directly.
- **FR-001a**: System MUST allow each company to map a role slot to one of its own roles, and MUST
  resolve a level's authority through that mapping at the time a decision is attempted.
- **FR-001b**: System MUST refuse a decision at a level whose slot is unmapped, and MUST surface the
  unmapped slot as a configuration fault rather than an authorisation failure — the two have
  different remedies and telling them apart is the difference between a settings change and a
  fruitless permissions investigation.
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
- **FR-010**: System MUST supply, with every item's approval state, everything the interface needs to
  render a consistent control without inferring anything: whether the caller may act now, and the
  label of the level that decides.
- **FR-011**: System MUST supply a machine-readable reason when the caller may **not** act,
  distinguishing at minimum *awaiting another person*, *this caller already decided at an earlier
  level*, *insufficient authority*, and *the level's slot is unmapped*.

  The last two of those are the point. "Already decided" is knowable only here — the browser cannot
  compute it — and without it the interface must say "no permission" to a Super Admin who has every
  permission, which is untrue and sends the one person who can change permissions to go and change
  them. "Slot unmapped" is a configuration fault whose remedy is a settings screen, not a permission
  grant.

  *The presentation of these states is specified in `buildcore-web/specs/016-approval-spine`
  (its FR-001, FR-003, FR-003a). It is deliberately not restated here: the same requirement written
  in two artifacts is how two artifacts drift.*
- **FR-012**: System MUST raise a manual attendance correction into an approval chain rather than
  applying it in a single step (Clarifications, 2026-09-16). This requirement previously named
  location and face mismatch exceptions as the chain's input; feature 020 FR-013 now refuses such
  punches outright and records nothing, so the correction is what remains to review.
- **FR-012a**: System MUST log every manual modification to an attendance record, by **any** role
  including Super Admin, capturing the actor, the time, the day and employee affected, the value
  before, the value after, and the stated reason where one was given.
- **FR-012b**: An attendance modification log entry MUST be immutable and MUST NOT be deletable while
  the attendance record it concerns exists. A log that the powerful can edit is not a log.
- **FR-012c**: System MUST make every modification to a day visible to the employee that day belongs
  to, on their own attendance record, showing the actor, the time, the before and after values, and
  the stated reason. Visibility MUST NOT depend on a notification being read or retained.
- **FR-012d**: The modification log MUST be readable in full by roles permitted to audit attendance,
  ordered oldest to newest, for any employee, day or actor.
- **FR-012e**: System MUST log a modification whether or not it required approval. Logging and
  approval are independent: not every modification passes a chain, and every modification is
  recorded.
- **FR-013**: System MUST create a payroll run automatically on the first day of each month for the
  preceding period, exactly once per period.
- **FR-014**: System MUST apply advances and deductions when the scheduled run is created, without
  manual intervention.
- **FR-015**: System MUST hold a payroll run from producing a bank transfer sheet until its chain is
  complete.
- **FR-016**: System MUST restrict attendance edits for a period under payroll review to HR only.
- **FR-017**: System MUST invalidate approvals already given for a payroll run when its underlying
  attendance changes, and restart its chain.
- **FR-018**: System MUST require final approval by the Super Admin role (the client's "Director")
  before any of the following takes effect, and MUST hold each until it is given:
  1. **Payment release** — a bank payment sheet or a vendor payment.
  2. **Payroll run approval** — already the last level of the payroll chain (US2), named here so the
     two descriptions cannot drift apart.
  3. **Letters that commit money** — work order, LOI and purchase order. The mechanism belongs here;
     the letters themselves are feature 017, which MUST consume this rather than build its own gate.
  4. **Final settlement on exit**, including any waived recoveries.
- **FR-018a**: The set above MUST be configurable, so that an action type can be added to or removed
  from it without a code change. Note 8 asks for "every final work" and the client's re-stated item 7
  asks for "every critical action"; four are named because applying either literally to every action
  would halt daily work. These four are **this product's proposal, not the client's answer** — the
  client has re-stated the broad reading rather than confirming a list, and the list they will accept
  is still open (see "Needing the client's decision").
- **FR-018b**: A change to the director-final set MUST itself be a director-final action, and MUST be
  recorded with its actor, its time, and the set before and after. Without this, FR-018a is the way
  around FR-018: whoever may edit the set may remove payment release from it and then release a
  payment.
- **FR-018c**: System MUST be able to report the director-final set in full at any time — every action
  type the system knows of, and for each whether it is director-final. This is how item 7's "every
  critical action" is answered: not by a claim, but by a list the client can read and amend.
- **FR-019**: System MUST allow a pending item to be reassigned to another holder of the same level
  when the original approver is unavailable.
- **FR-020**: System MUST record and surface the number of times an item has been returned and
  resubmitted.
- **FR-021**: System MUST prevent two approvers at the same level from both recording a decision on
  the same item.
- **FR-021a**: System MUST prevent any person from recording a decision on an item they have already
  decided on at an earlier level, whatever roles they hold. Super Admin holds every permission, so
  without this one person could raise an item, approve it as HR and approve it again as Director —
  and the chain would record three decisions that were all the same judgement.
- **FR-021b**: System MUST refuse a chain configuration in which two levels resolve to the same role
  **at definition time**, naming the conflict. Such a chain is unsatisfiable under FR-021a wherever
  only one person holds that role, and discovering it when payroll stalls is the expensive way to
  find out.
- **FR-022**: System MUST NOT lose or alter any existing approval permission behaviour for modules
  that are not migrated onto the chain in this feature.

### Non-Functional Requirements

- **NFR-001** *(Note 23)*: The system MUST sustain 150 concurrent users performing attendance actions
  within a 15-minute window, and 60 concurrent users performing general work, with the 95th
  percentile response under 2 seconds for read operations and under 4 seconds for approval writes.
  **Partially verified on 2026-09-17.** A read-only load test was run against the production
  deployment (Render free tier, 0.1 shared CPU, 512 MB) on the unauthenticated status route, ramping
  5 → 10 → 25 → 50 → 75 → 100 → 150 concurrent connections at 15 seconds per step, from a client in
  India:

  | Connections | RPS | p50 | p90 | p99 | Errors |
  |---|---|---|---|---|---|
  | 5 | 18.3 | 249 ms | 258 ms | 762 ms | 0 |
  | 25 | 90.5 | 249 ms | 268 ms | 826 ms | 0 |
  | 50 | 168.1 | 249 ms | 315 ms | 937 ms | 0 |
  | 100 | 186.7 | 411 ms | 1099 ms | 1265 ms | 0 |
  | 150 | 181.1 | 692 ms | 1408 ms | 1603 ms | 0 |

  Zero errors, zero timeouts and zero non-2xx responses at every step; the instance degraded by
  queueing rather than failing, and returned to its ~305 ms baseline immediately afterwards. The knee
  is at roughly 50 connections, beyond which throughput plateaus at **170–190 requests per second**
  while latency climbs. Below the knee p50 is pinned at 249 ms, which is the client's own network
  round-trip floor — the server's service time for a request of this weight is negligible.

  **What this settles.** Request *volume* is not the constraint. 150 employees punching within a
  15-minute window is 0.17 requests per second on average, and 2.5 per second even if every one of
  them punches inside the same minute — against a measured ceiling of 170. The concurrency figure in
  this requirement is comfortably within reach on the free tier.

  **What this does NOT settle, and it is the part that matters.** The route measured touches no
  database and does no work. It says nothing about the cost of an *attendance action*, which decodes
  and resizes an image, runs face matching on the WASM/CPU backend (the constitution's no-native-binding
  constraint means there is no GPU or native acceleration), encrypts a blob and writes several rows.
  That work is CPU-bound, and 0.1 shared CPU is where it will hurt; concurrency makes a CPU-bound
  path worse rather than better. Feature 020's NFR-001 is the requirement that turns on this, and it
  remains unverified.

  **Cold start also remains unmeasured.** The instance was already awake when tested, so the
  "tens of seconds" figure previously asserted here is still neither confirmed nor refuted. Render's
  free tier suspends after roughly 15 minutes idle, which would land on whoever punches first each
  morning — the 2-second target cannot be met through a cold start, whatever its exact length.

  A secondary ceiling was identified but not exercised: no `connection_limit` is set, so Prisma
  defaults to `cpus × 2 + 1`, which is a very small pool on this instance class. It binds only on
  database-backed routes, which the measured route is not.
- **NFR-002** *(Note 25)*: Every screen carrying an Action/Review control MUST be operable on Android
  and iOS phones at 320px width, with all decisions reachable, targets no smaller than 44px, and no
  horizontal scrolling of the page body. **This is not verified today.** Only the `/my/*` employee
  screens are currently held to a mobile standard; the admin surfaces this feature touches are
  desktop-first by existing constitutional principle, so this requirement deliberately widens that
  scope and needs real-device testing to confirm.

### Key Entities

- **Approval Chain**: The ordered list of levels an action type must pass through. Belongs to a
  company, so two companies may review the same kind of work differently.
- **Approval Level**: One step in a chain — its position, the **role slot** authorised to act, and
  whether it is the final authority.
- **Role Slot**: A named position in a chain ("first approver", "HR", "final") that each company maps
  to one of its own roles. It exists so a chain describes a shape of authority rather than a
  particular org chart — the client runs two companies that may staff the same chain differently.
- **Approval Decision**: One recorded act by one person at one level: approve, reject or return, with
  actor, time and reason. Immutable once written.
- **Reviewable Item**: Any record that enters a chain — a manual attendance correction, a payroll run,
  and whichever others the client nominates. Carries its current level and current state.
  *Historical attendance exceptions are also reviewable items: they were backfilled as completed
  single-level instances (research §7) and remain real. What changed on 2026-09-16 is that no new ones
  arise from punches, because feature 020 FR-013 refuses such a punch and records nothing.*

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of manual attendance corrections reach a recorded decision by a named person;
  none takes effect without one.
- **SC-001a**: 100% of manual attendance modifications are logged with actor, time, before value and
  after value — verified for every role including Super Admin, and across every path by which
  attendance can be changed.
- **SC-001b**: An employee opening their own attendance can name who modified any modified day, when,
  and from what to what, without asking anyone.
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
  chain applies to action types the company nominates, with manual attendance corrections and payroll
  named by the client explicitly, and that the set is configurable rather than universal. *The client
  named attendance exceptions in Note 2; the 2026-09-16 clarification re-aimed that at the correction,
  because feature 020 FR-013 leaves no refused punch to review.*
- Existing single-step approval permissions keep working for modules not migrated here. This feature
  adds a mechanism; it does not remove the ones already in use.
- The scheduled payroll run uses the business timezone already established for attendance
  (Asia/Kolkata), so "the 1st" means the 1st locally.
- Reassignment (FR-019) is an administrative act, not something an approver can do to skip their own
  level. It carries more weight than originally assumed: with FR-021a forbidding a second decision by
  the same person, reassignment is the only way an item stalled by thin staffing can move.
- Slot mappings are company-scoped settings, so the two companies may staff the same chain shape
  differently without either chain being redefined.

### Needing the client's decision

All three markers raised when this specification was written were answered on 2026-09-13 and are
recorded under Clarifications above. The client's re-stated requirement list re-opened three,
reviewed on 2026-09-29:

- **[NEEDS CLARIFICATION: which action types are director-final?]** *(item 7)* FR-018 names four as
  this product's proposal. The client has twice asked for the broad reading — "every final work"
  (Note 8) and "every critical action" (item 7) — and has not been shown a list to accept or amend.
  FR-018c exists so that list can be produced and put in front of them. **Not blocking**: the four
  named are buildable now, and FR-018a makes changing the set a configuration change rather than a
  rewrite.
- **[NEEDS CLARIFICATION: which of the nine roles are "Site Incharge" and "HR Office"?]** *(item 6)*
  Neither exists among the roles this system has. FR-016 — only HR may edit attendance during a
  payroll review — cannot be built without the answer, because naming the wrong role either locks out
  the people doing the work or grants the right to people who should not have it. **Blocking for
  FR-016 and for US2's chain**; nothing else in this feature waits on it.
- **[NEEDS CLARIFICATION: is buildcore-web's Principle VI to be amended?]** *(item 22)* The client
  asks that the whole admin portal work on Android and iOS. buildcore-web's Principle VI closes the
  mobile-critical list to punch, attendance viewing and leave, and is NON-NEGOTIABLE — no feature
  specification can amend it, and the v2.1.0 amendment already moved every other screen's breakage
  floor to 320px, which may or may not be what the client means by "fully functional". Reviewed on
  2026-09-29 and **deliberately left for a separate decision**: widening the principle is a MAJOR
  version bump affecting all six web features and every one shipped before them, which is not a
  side effect a bug batch should have. NFR-002 here states the 320px floor and nothing stronger.

Two items are deliberately deferred to planning rather than left as open questions, because they
are design decisions rather than client decisions:

- **How a slot is presented in settings.** Whether slots appear as a dedicated screen or as part of
  role editing is a planning concern; the requirement (FR-001a) is only that the mapping exists and
  is changeable without a code change.
- **Whether a chain may be edited while items are in flight.** The safe default is that an in-flight
  item keeps the chain it entered, so a configuration change cannot retroactively invalidate
  approvals already given. Planning should confirm this is achievable before it is assumed.
