# Feature Specification: Daily Work Reports

**Feature Branch**: `022-daily-work-reports-backend`

**Created**: 2026-10-04

**Status**: Draft

**Input**: User description: "Plan daily work reports and client bill generation" — driven by the
client's real bill package at `docs/Parth Realcon Pvt Ltd. RA-12 (1).pdf`. Split into two features
at the user's direction: **022 records the day's work**, 023 renders the bill package from it.

## Why this feature exists

Feature 008 specified daily work reports in August 2026 as User Story 5, created their tables, and
never built the module. The consequence is not an absent screen — it is a **number that is wrong
everywhere it appears**. Every BOQ line in the system reports 0% executed, because `doneQty` is
only ever moved by approving a daily work report and nothing can approve one. The progress figure
on the project detail, the pending quantity on the BOQ tree and the executed column on any report
are all reading a counter that no code path can increment.

Everything around the feature was built: the two tables and their three enums, the `DWR`
permission seeded into roles, the audit entity type and its activity-log bucket, the project lock
guard, and `BOQService.updateDoneQty` — written for this caller, exported from the module for it,
and never called. Three delete guards already refuse to remove a site, a project or a BOQ line
that daily work reports reference. The scaffolding is complete and the floor is missing.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Record a day's work (Priority: P1)

A site engineer opens a new report for a project and a work date, names the supervisor, records the
weather, how many workers and machines were on site, and their own assessment of progress. Against
each BOQ line worked that day they add a measurement: the location (chainage from and to, layer,
road side) and the measurement factors. The system computes each line's quantity from the factors
and shows it back. The report is a draft and nothing in the project's progress has moved.

**Why this priority**: Nothing else in this feature can be tested until a day can be recorded, and
this story alone replaces the paper register the site keeps today.

**Independent Test**: Create a report against a seeded project and BOQ line with the six factors
set, read it back, and confirm the computed quantity matches the product of the factors — while the
BOQ line's done quantity is still exactly what it was.

**Acceptance Scenarios**:

1. **Given** a project and a BOQ line, **When** a report is created with a work date, supervisor,
   weather, worker count, machinery count, progress assessment and one measurement line, **Then**
   the report is stored with status `draft`, a report number is generated, and the line's quantity
   is computed by the system from the factors supplied.
2. **Given** a measurement line, **When** it is created with only some factors supplied, **Then**
   the unsupplied factors are treated as 1 and the computed quantity is the product of those
   actually given — an unused dimension is multiplicatively neutral, never zero.
3. **Given** a measurement line, **When** a factor is supplied as 0, **Then** the report is refused
   with a message naming the factor, because a product of zero is a data-entry error rather than a
   day on which no work was done — the latter is recorded by omitting the line or by recording a
   quantity of zero explicitly against a presence-based line (US5).
4. **Given** a client-supplied quantity for a measurement line, **When** the report is created,
   **Then** the supplied quantity is ignored and the computed one is stored, so the arithmetic
   cannot differ between two clients or between a client and the server.
5. **Given** a measurement line whose quantity takes its BOQ line past its scope quantity,
   **When** the report is created, **Then** the line is stored and **flagged** as exceeding scope —
   never refused. The site did the work; an under-scoped BOQ line is a commercial question, and a
   refusal at entry means the measurement is recorded nowhere.
6. **Given** a locked project, **When** a report is created against it, **Then** the write is
   refused as locked.
7. **Given** a report, **When** a file is attached, **Then** it is stored as an object-storage
   reference, linked to the report, and served back with its own file name and content type.
8. **Given** a report for a work date that already has one for the same project, **When** it is
   created, **Then** it is accepted and the existing report is named in the response — two reports
   for one day happen when two stretches are worked by two crews, and refusing the second loses it.

---

### User Story 2 - Submit, approve, and move the project's progress (Priority: P1)

A site engineer submits the day's report. Nothing in the project's progress changes: a submitted
report is a claim, not a fact. A reviewer approves it, and at that moment — and only then — each
BOQ line's done quantity increases by the measurement approved against it, with the approver and
the time recorded on the report.

**Why this priority**: This is the transition the whole feature exists for, and the distinction
between submission and approval is the one 008 corrected its own first draft to make. Without it
the executed figure is still a number nobody can trust.

**Independent Test**: Submit a report and confirm the BOQ line's done quantity has not changed;
approve the same report and confirm it increments by exactly the approved measurement, once.

**Acceptance Scenarios**:

1. **Given** a draft report, **When** it is submitted, **Then** its status becomes `submitted` and
   **no** BOQ line's done quantity changes.
2. **Given** a submitted report, **When** it is approved, **Then** its status becomes `approved`,
   the approver and the approval time are recorded on it, and each measured BOQ line's done
   quantity increases by that report's measurement against it.
3. **Given** an approved report, **When** approval is attempted again, **Then** it is refused and
   no done quantity moves a second time — approving twice must not bill twice.
4. **Given** a draft report, **When** approval is attempted without submission, **Then** it is
   refused, naming the status it is in.
5. **Given** a report being approved, **When** the done quantity of one of its lines cannot be
   moved, **Then** none of the report's lines move and the report stays submitted — a report that
   is half-approved is worse than one that is not approved at all.
6. **Given** an approval, **When** it completes, **Then** an audit entry records who approved
   which report and the quantities it moved.
7. **Given** a submitted report, **When** approval is attempted by the person who submitted it,
   **Then** it is refused, naming the segregation rule. Approval is a direct transition by a
   permission holder rather than a routed one — a project produces a report a day, and thirty
   routed approvals a month per project would put a day's measurement behind a chain nobody has
   configured. The control is that the approver is not the author.

---

### User Story 3 - Correct a report, including one already approved (Priority: P1)

A report is found to be wrong. A draft is edited freely. A submitted one is returned to draft by
the author or the reviewer. An approved one cannot simply be edited — approving it moved the
project's executed quantities and may already have been billed — so it is reversed explicitly, and
the reversal takes the quantities back out.

**Why this priority**: Promoted to P1 because this path is what makes approval safe. 008 specified
the forward transitions and never said what undoes them, which leaves a wrong approved report with
no remedy but a direct database edit — and leaves `doneQty` permanently overstated.

**Independent Test**: Approve a report, reverse it, and confirm the BOQ lines' done quantities
return to exactly their pre-approval values, with both the approval and the reversal visible.

**Acceptance Scenarios**:

1. **Given** a draft report, **When** it is edited, **Then** the change is stored and quantities
   are recomputed from the new factors.
2. **Given** a submitted report, **When** it is returned to draft, **Then** its status becomes
   `draft` and no quantity moves, because submission never moved one.
3. **Given** an approved report, **When** it is edited, **Then** the edit is refused, naming the
   reversal path instead.
4. **Given** an approved report, **When** it is reversed with a stated reason, **Then** each
   measured BOQ line's done quantity decreases by exactly what that report added, the report
   returns to `draft`, and the reversal is recorded with actor, time and reason.
5. **Given** an approved report whose measurement has since been claimed on a bill, **When**
   reversal is attempted, **Then** it is refused and the bill is named — the quantity on a bill
   that has left draft is a figure already sent, and the remedy there is a bill revision, not a
   silent change beneath it.
6. **Given** a reversal, **When** it completes, **Then** no BOQ line's done quantity is negative.

---

### User Story 4 - Read what a project has executed (Priority: P2)

A project manager lists the reports for a project, filtered by date range and status, and opens
one. The detail shows each measured line beside the BOQ line's own position: total scope, done,
pending, and the target quantity for the period.

**Why this priority**: The daily record is only useful if it can be found. Depends on US1 but not
on US2 — a list of drafts is already worth reading.

**Independent Test**: Seed reports across three months in two statuses, list with a date range and
a status filter, and confirm the page returned contains exactly the reports that match and a total
count that does not depend on the page size.

**Acceptance Scenarios**:

1. **Given** reports across several projects, dates and statuses, **When** the list is requested
   with a project, a date range and a status, **Then** only matching reports are returned, ordered
   by work date, paginated by the server with a total count.
2. **Given** a report, **When** its detail is requested, **Then** each measured line carries the
   BOQ line's scope quantity, done quantity, pending quantity and period target alongside the
   measurement.
3. **Given** a caller without the daily-work-report permission, **When** any of these is requested,
   **Then** it is refused.
4. **Given** a caller in one company, **When** a report belonging to another company is requested
   by its identifier, **Then** it is not found — not refused, not returned.

---

### User Story 5 - Presence-based lines, and the evidence beneath them (Priority: P2)

Much of a maintenance contract is not measured by quantity at all. A BOQ line reads "Providing of
New Ambulance on monthly basis" at a monthly rate, or "Security Guards … 40 Nos per day", and what
the site records each day is that the asset and its crew were there and performing — with the
running evidence (opening and closing odometer, hours, the day's incidents) recorded against the
equipment itself. The report records the day served; the evidence is read from the equipment's own
logbook rather than copied into the report.

**Why this priority**: Eleven of the seventeen lines in the client's real package are of this kind,
so a feature that only records quantity-measured work cannot produce their bill. Separated from US1
because quantity-measured civil work is the simpler case and ships first.

**Independent Test**: Record a presence-based line for a date on which the equipment's logbook
carries an entry, and confirm the day's served quantity and the logbook evidence are both readable
for that date through one request, without the report storing a copy of the odometer readings.

**Acceptance Scenarios**:

1. **Given** a BOQ line that is paid for presence rather than measurement, **When** a day is
   recorded against it, **Then** the day's **served quantity is entered directly** — a full day as
   1, or less with a remark saying why — and is stored in a field of its own, separate from the
   factor-computed quantity. The six factors are not read for such a line at all, so the product of
   their defaults can never be mistaken for a day served.
2. **Given** a presence-based line for a day on which the asset was absent or not performing,
   **When** the day is recorded, **Then** a quantity of zero is accepted **with** a remark, and is
   distinguishable from no record at all for that day.
3. **Given** a presence-based line whose work is done by a specific piece of equipment, **When**
   the day's record is read, **Then** the equipment's logbook entry for that date — opening
   reading, closing reading, total run and remarks — is available alongside it, read from the plant
   module across its own boundary and **not** duplicated into this one.
4. **Given** a date on which the equipment has no logbook entry, **When** the day's record is read,
   **Then** the absence is reported as an absence and the day's record is still returned — missing
   evidence is a gap to chase, not a reason to hide the record.

---

### User Story 6 - Approved measurement per BOQ line, per period (Priority: P2)

Before a bill is composed, somebody needs one number per BOQ line: how much was approved in this
billing period, how much was approved before it, and how much that comes to in total. This is the
figure the bill defaults each claimed quantity from.

**Why this priority**: This is 022's contract to feature 023, and 023 cannot start without it. It
is specified here, with its own tests, rather than left to be discovered as an implementation
detail of the bill.

**Independent Test**: Approve reports in two different months and leave a third in submitted state;
request the period figures for the second month and confirm the period sum counts only the
approved reports inside it, the prior sum counts only approved reports before it, and the submitted
report appears in neither.

**Acceptance Scenarios**:

1. **Given** a project and a date range, **When** the approved measurement is requested, **Then**
   each BOQ line in the project is returned with the measurement approved **within** the range, the
   measurement approved **before** it, and the two added together.
2. **Given** reports in draft or submitted status inside the range, **When** the figures are
   requested, **Then** they contribute nothing to any of the three — only approval counts.
3. **Given** a BOQ line with no approved measurement at all, **When** the figures are requested,
   **Then** the line is returned with zeros rather than omitted, so nothing composing a bill can
   silently drop a line by not finding it.
4. **Given** a range, **When** the figures are requested, **Then** the measurement is attributed to
   the range by the **work date** of the report, not the date it was approved — a report approved
   late belongs to the day it describes.
5. **Given** a reversed report, **When** the figures are requested, **Then** its measurement is
   absent from all three figures.
6. **Given** the figures for consecutive, non-overlapping ranges, **When** they are summed, **Then**
   the total equals the BOQ line's own done quantity — the two are the same fact counted two ways,
   and a discrepancy between them is reportable rather than silent.

---

### Edge Cases

- **A work date in the future.** Refused: a report describes a day that happened.
- **A work date before the project started.** Accepted with the discrepancy reported, because
  project start dates are corrected after the fact more often than work is invented.
- **A measurement line against a BOQ line in a different project.** Refused, naming both.
- **A measurement line against no BOQ line at all.** Accepted — the existing record already allows
  it, because freeform work that the BOQ itemises differently is ordinary. Such a line moves no
  done quantity and contributes to no period figure, and this is stated rather than discovered.
- **A report with no measurement lines.** Accepted as a draft; refused at submission, because a
  day's report asserting nothing is a form somebody abandoned.
- **Deleting a BOQ line a report measures.** Already refused by the existing guard, which names the
  report count. This feature must not weaken it.
- **Deleting a report.** A draft may be deleted. A submitted or approved one may not; an approved
  one is reversed first.
- **Two concurrent approvals of the same report.** Exactly one succeeds; the other is refused as
  already approved, and the done quantity moves once.
- **Concurrent approvals of two different reports measuring the same BOQ line.** Both succeed and
  both increments are applied — the counter must be moved by a relative increment and never by
  writing a figure read beforehand.
- **A report whose supervisor has since left.** Still readable; the supervisor is recorded as an
  identifier and a name at the time, not resolved afresh on every read.
- **A period figure requested for a range that ends before it begins.** Refused.

## Requirements *(mandatory)*

### Functional Requirements

#### Recording

- **FR-001**: System MUST allow a daily work report to be created against one project and one work
  date, carrying supervisor, weather, worker count, machinery count, a progress assessment, and
  optional location, description, contract reference, request-for-inspection number and layer.
- **FR-002**: System MUST generate each report's number without the caller supplying it, unique
  within the company — a uniqueness this requirement asserts in its own right and does not merely
  inherit from an existing constraint. **The number MUST derive from the project**, not the site: a
  report references a project and not a site, and a site carries no code to build a number from.
- **FR-002a**: The number MUST be the project's code, a separator, and a per-project sequence, in
  that order. Specified to one rendering because a report number is printed and filed.
- **FR-002b**: Two reports created for one project at the same instant MUST NOT both be given the
  same number, and neither attempt may be lost: a collision MUST be resolved and retried, not
  reported to the caller.
- **FR-002c**: Gaps in a project's sequence ARE permitted and carry no meaning — a refused creation
  and a deleted draft both leave one. Stated because a gap in a numbered site register is otherwise
  the first thing an auditor asks about.
- **FR-003**: System MUST compute every **work-measured** line's quantity itself, as the product of
  the six factors, and MUST ignore any quantity the caller supplies. A presence-paid line is
  governed by FR-030 to FR-030c instead; this requirement does not reach it. (Narrowed on
  2026-10-04: as first written this said "every measurement line", which contradicted FR-030b
  outright — see `checklists/silent-failure.md` CHK003.)
- **FR-004**: System MUST treat an unsupplied factor as 1 and MUST refuse a factor supplied as 0,
  naming the factor refused.
- **FR-005**: System MUST record a measurement line's position — chainage from and to, layer, road
  side, section — and its engineer, remark and payment basis.
- **FR-006**: System MUST flag, and MUST NOT refuse, a measurement line whose quantity takes its
  BOQ line past its scope quantity.
- **FR-007**: System MUST accept a measurement line that references no BOQ line, and MUST exclude
  such a line from every done-quantity movement and every period figure.
- **FR-008**: System MUST refuse any write against a locked project, distinguishably from a refusal
  of permission — the same caller may do it once the project is unlocked.
- **FR-009**: System MUST store attachments as object-storage references and MUST serve each back
  with the file name it was uploaded under and a content type that matches its actual bytes.

#### The lifecycle

- **FR-010**: System MUST hold a report in exactly one of draft, submitted or approved.
- **FR-011**: System MUST NOT change any BOQ line's done quantity on submission.
- **FR-012**: System MUST, on approval, increase each measured BOQ line's done quantity by that
  report's measurement against it, recording the approver and the time.
- **FR-012a**: System MUST refuse approval by the person who submitted the report, naming the
  rule. Approval is a direct transition requiring the daily-work-report permission, **not** a
  routed chain action: segregation of duty is the control, chosen because a report a day per
  project makes routing disproportionate and because a chain left unconfigured would block the
  site's measurement rather than review it.
- **FR-013**: System MUST apply every one of a report's increments or none of them, and MUST leave
  the report submitted — that being the **only** permitted outcome of a failed approval, not one of
  several.
- **FR-013a**: System MUST make a failed approval observable rather than merely prevented: the
  refusal MUST name the line that could not be moved and the reason, and the attempt MUST be
  recorded. An all-or-nothing rule that reports nothing leaves an operator retrying a write that
  will fail again for a reason nobody has been told.
- **FR-014**: System MUST move each report's quantities at most once, however many times approval
  is attempted.
- **FR-015**: System MUST apply each increment as a relative change to the stored counter and MUST
  NOT write a value derived from one read earlier in the same operation.
- **FR-015a**: Where two reports measuring the same BOQ line are approved concurrently, **both**
  increments MUST be applied. Stated as a required outcome and not only as the mechanism of
  FR-015, because a read-then-write loop would lose one of the two and lose it silently.
- **FR-014a**: Where the same report is approved twice concurrently, exactly one attempt MUST
  succeed and the counter MUST move once — the same guarantee as FR-014's sequential case, which it
  does not by itself imply.
- **FR-016**: System MUST refuse approval of a report that has not been submitted, naming its
  status.
- **FR-017**: System MUST allow a submitted report to be returned to draft.
- **FR-018**: System MUST refuse to edit an approved report, naming the reversal path.
- **FR-019**: System MUST allow an approved report to be reversed with a stated reason, taking back
  exactly the quantities its approval added and returning it to draft.
- **FR-020**: System MUST refuse a reversal that would reduce a BOQ line's done quantity **below
  the quantity already billed against that line** on a bill that has left draft, naming the bill.
  The bills that count are a client bill that is submitted or certified, and a subcontractor bill
  that is submitted or approved, including one reaching the line through a work-order award line.
  (Rewritten on 2026-10-04. As first written this required refusal of "a report whose measurement
  has been claimed on a bill", which **no implementation can determine**: nothing in the data links
  a bill line to the measurement it consumed. A reader of this requirement alone would have
  believed provenance was implemented — see `checklists/silent-failure.md` CHK029 and research §4.)
- **FR-020a**: The system MUST NOT claim to know *which* report's measurement a given bill line
  consumed. That linkage does not exist, and feature 023 — which composes a bill from a period's
  approved measurement — MUST decide whether to record it. Written as an obligation on 023 rather
  than as a remark, so that it is asked rather than inherited.
- **FR-021**: System MUST NOT allow any BOQ line's done quantity to become negative by any path.
- **FR-022**: System MUST record an audit entry for each submission, approval and reversal, naming
  the actor, the report and the quantities moved.
- **FR-023**: System MUST allow a draft report to be deleted and MUST refuse to delete a submitted
  or approved one.
- **FR-024**: System MUST refuse to submit a report carrying no measurement lines.
- **FR-025**: System MUST refuse a work date in the future, and MUST accept one before the
  project's start date while reporting the discrepancy.

#### Reading

- **FR-026**: System MUST list reports filtered by project, date range and status, ordered by work
  date, paginated by the server, with a total count independent of the page returned.
- **FR-027**: System MUST return, for each measured line in a report's detail, the BOQ line's scope
  quantity, done quantity, pending quantity and period target alongside the measurement.
- **FR-028**: System MUST require the daily-work-report permission for every one of these
  operations.
- **FR-029**: System MUST confine every read and write to the caller's own company, and MUST report
  another company's report as not found rather than as refused.

#### Presence-based work and its evidence

- **FR-030**: System MUST distinguish a line measured by quantity from one paid for presence, by
  the payment basis already carried on the line, and MUST record a presence-based day's quantity as
  a **served quantity supplied by the caller**, held in a field distinct from the factor-computed
  quantity.
- **FR-030a**: System MUST hold exactly one quantity in force per measurement line, decided by that
  line's payment basis: the factor-computed quantity for a line measured by work, the served
  quantity for one paid by presence. The quantity in force is the one that moves the BOQ line's
  done quantity and the one that feeds the period figures. **Exactly one of the two MUST be
  present**: a line carrying both, or neither, MUST be impossible to store — enforced where the
  data lives and not only where it is written, because an invariant held solely by a service is one
  direct write away from being bypassed.
- **FR-030b**: System MUST NOT read the six factors for a presence-based line. With every factor
  defaulting to 1 their product is 1, which resembles one day served while being only an artefact
  of the defaults — a figure that would be right by accident and wrong the moment a factor is set.
- **FR-030d**: Where a presence-paid line carries factor values other than 1 — set by a seed, a
  migration, a hand-edit or any path other than this feature's own input — the quantity in force
  MUST still be the served quantity, unchanged. Stated as an expected **answer** and not only as a
  prohibition, so that it can be asserted rather than reviewed.
- **FR-030e**: System MUST treat a served quantity of 1 as one full day. Any other basis for "a
  full day" MUST NOT be inferred from the line's unit or rate.
- **FR-030c**: System MUST require a remark on any presence-based day whose served quantity is less
  than a full day, because that shortfall is the fact a client's deduction is later argued from.
- **FR-031**: System MUST accept a presence-based day of zero with a remark, distinguishably from
  no record for that day.
- **FR-032**: System MUST make the equipment's own logbook entry for the work date — opening
  reading, closing reading, total run, remarks — readable alongside a presence-based day, read
  across the plant module's boundary, and MUST NOT store a second copy of those readings.
- **FR-033**: System MUST report the absence of a logbook entry as an absence and MUST still return
  the day's record.

#### Approved measurement per period — the contract to feature 023

- **FR-034**: System MUST return, for a project and a date range, every BOQ line in the project
  with three figures: the measurement approved within the range, the measurement approved before
  it, and their sum.
- **FR-035**: System MUST count only approved reports toward those figures, and MUST exclude
  reversed ones entirely.
- **FR-036**: System MUST attribute measurement to a range by the report's **work date**, not by
  its approval date.
- **FR-037**: System MUST return every BOQ line in the project — every line under every group,
  **including lines that are still unpriced and lines already measured past their scope** — and
  MUST return a line with no approved measurement carrying zeros rather than omitting it. An
  unpriced line is "nobody has priced this", not "this is not billable", and a bill needs to see it.
- **FR-037a**: The count of lines returned MUST equal the project's own count of BOQ lines, and that
  equality MUST be assertable. An assertion over a returned list passes just as happily over a
  short list, which is the vacuity this feature's other guards exist to prevent.
- **FR-037b**: System MUST return an empty set of lines, and not an error, for a project with no
  BOQ lines, and for a range in which the project had none.
- **FR-038**: System MUST refuse a range whose end precedes its start.
- **FR-039**: System MUST report, on demand and per BOQ line, any discrepancy between the stored
  done quantity and the sum of approved measurement against it. "On demand" means a caller can ask
  and be answered — a log line nobody reads does not satisfy this.
- **FR-039a**: The tolerance MUST be exact. Both figures are decimal quantities to three places and
  the increments are exact, so any non-zero difference is a defect and MUST be reported as one.
- **FR-039b**: **The sum of approved measurement is authoritative; the stored done quantity is a
  cache of it.** When the two disagree, the sum is right by construction — it is derived from the
  reports that are the record of what happened — and the counter is what has drifted.
- **FR-039c**: System MUST allow the counter to be repaired to the authoritative sum as an explicit
  act by a permission holder, recorded with actor, time and the previous value, and MUST NOT repair
  it automatically. A silent self-heal erases the evidence that something moved the counter without
  a report, which is the only symptom that bug would ever have.

#### Isolation

- **FR-040**: The daily work report and measurement line tables MUST each be covered by a test that
  exercises their tenant isolation policy under a database role which **cannot bypass it**. Both
  already carry the policy; neither has ever had it in force in a test run, because the development
  and continuous-integration role is a superuser and a database superuser is exempt from row-level
  security unconditionally. The tables are named rather than described, because "every table this
  feature writes" is satisfied by doing nothing when the feature creates no table.
- **FR-040a**: Such a test MUST assert that the non-bypassing role was actually created, **before
  asserting anything else**. Without it every later assertion runs against a privileged connection
  and passes while proving nothing.
- **FR-040b**: Where the probe role cannot be created, the test MUST report as **skipped**, never as
  passed, and MUST say why. The visibility is the requirement, not a courtesy: this feature carries
  FR-040 at all because for two months an isolation policy that was never in force looked exactly
  like one that was.
- **FR-040c**: The BOQ line table, whose done quantity this feature writes, is **out of** FR-040's
  scope. It is written through an existing service that owns it, and its isolation is that feature's
  to prove; naming it here would claim coverage this feature does not deliver.

### Key Entities

- **Daily work report**: one project's record of one work date. Carries who supervised it, the
  weather, how many workers and machines were present, a supervisor's own progress assessment, the
  attachments, and its position in the draft/submitted/approved lifecycle with the approver and
  approval time. Already exists as a table; this feature gives it behaviour and adds what reversal
  needs.
- **Measurement line**: one measured piece of work within a report, optionally against one BOQ
  line. Carries the location, the six factors, the server-computed quantity, the payment basis, the
  over-scope flag, and the engineer's remark. Already exists as a table.
- **BOQ line**: the contracted scope being worked against. Owns the done quantity this feature's
  approvals move. Unchanged by this feature except for that counter.
- **Equipment logbook entry**: the plant module's existing daily record of one machine on one date
  — opening and closing readings, total run, fuel, operator, remarks. **Read, never written, by
  this feature**, and never copied into it.
- **Approved measurement for a period**: not a stored entity. A figure assembled per BOQ line from
  approved reports in a date range, which feature 023 defaults a bill's claimed quantity from.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A site engineer can record a full day's work — the day's conditions and every line
  worked — in a single submission, without the quantities being computed anywhere but on the server.
- **SC-002**: Every BOQ line in the system reports a true executed quantity. Today every line
  reports 0% regardless of work done; after this feature the executed figure for any line equals
  the approved measurement against it, and the two can be compared on demand.
- **SC-003**: Submitting a day's report changes no project's reported progress; approving it changes
  it by exactly the approved measurement, and approving it twice changes it once.
- **SC-004**: A wrongly approved report can be fully undone, returning every affected line to the
  quantity it held beforehand, with both the approval and the undoing on the record — and cannot be
  undone once its measurement has been billed.
- **SC-005**: For any project and any billing period, the approved measurement for every BOQ line
  can be obtained in one request, with lines that have no measurement present and reading zero.
- **SC-006**: Eleven of the seventeen line types in the client's real bill package — the
  presence-paid ones — can be recorded for a month, with each day's running evidence readable from
  the equipment's own logbook and stored only once in the system.
- **SC-007**: Every table this feature writes is proven isolated between companies by a test
  running under a database role that cannot bypass isolation.
- **SC-008**: A day's report covering seventeen BOQ lines is recorded, submitted and approved in
  under three seconds per step, and a month of such reports for one project is listed in under two
  seconds.

## Assumptions

- **The report number derives from the project code.** 008 US5 specified `{siteCode}-{sequence}`,
  which cannot be built: a report references a project and not a site, and `Site` carries no code
  field at all — only a name. The project's code is unique within the company and the report
  already references the project, so the number is formed from it. A site reference can be added
  later without changing the numbering.
- **The six-factor formula stays as 008 defined it** — the product of two counts, length, breadth,
  depth and density, each defaulting to 1. The factors and their defaults are already in the table.
- **The daily running log is the plant module's, not this one's.** `plant.LogbookEntry` already
  records date, opening reading, closing reading, total hours, fuel, operator and remarks, unique
  per machine per date — which is exactly the odometer register printed beneath the client's
  measurement sheets. This feature reads it across the module boundary, as the project P&L already
  reads four other modules, rather than adding a second place for the same readings to live.
- **A measurement line keeps the BOQ line's rate out of it.** Daily work records quantity; pricing
  happens on the bill, where the rate is frozen at composition. Nothing in this feature reads or
  writes a rate.
- **The supervisor is an employee identifier held bare**, as the existing column already does,
  resolved through the HR module's own service for display and never joined across schemas.
- **Attachments reuse the existing storage service and its file-type detection.** Nothing new is
  built for them.
- **The web screens are a separate feature in the other repository.** This specification covers the
  server only.
- **Feature 023 depends on this one** for the period figures in FR-034 to FR-039 and for the
  presence-based day in FR-030. Nothing in 023 — the check list, abstract sheet, BOQ annexure,
  measurement sheets, debit note register, the tax and deduction spine, or the workbook renderer —
  is in scope here.
- **Client bills and subcontractor bills are unchanged by this feature.** 022 adds a read they can
  default from; it does not alter how either is composed today.

## Decisions

Both open questions were put to the user on 2026-10-04 and answered. Recorded here with the
reasoning, because each rules out an option that would otherwise look reasonable to a later reader.

### D1 — A presence-based day's quantity is entered directly (FR-030, FR-030a to FR-030c, US5 AC1)

Eleven of the seventeen lines in the client's real package are paid for presence — an ambulance or
a patrolling vehicle on a monthly rate, forty security guards a day — and the quantity claimed for
a month is a fraction of it: 0.700 of a month, reduced from 1.000 for non-performance. A day is
therefore entered as served or part-served, with a remark required for any shortfall, in a field
of its own.

**Why not derive it from the equipment's logbook**, which would avoid double entry: a derived day
cannot express *present but not performing*, and that is precisely what the client's deductions
are about — "30 % deduction Shoulder Slope, Supervisor Labour, Staff Not available". It would also
make a month's claim depend on another module being complete.

**Why not deployment counts converted by the bill renderer**: it moves the judgement into code the
site cannot see or correct, and two sites recording identical counts would bill differently
according to a rule nobody at either site can read.

**Why the served quantity gets its own field** rather than reusing the computed one: every factor
defaults to 1, so their product is 1 — which looks exactly like one day served. A figure that is
right by coincidence is wrong as soon as somebody sets a factor, and nothing in a test would say
so. The two quantities are kept apart so that the one in force is a stated property of the line
rather than an inference about which fields happen to be filled.

### D2 — Approval is direct, and the approver is not the author (FR-012a, US2 AC7)

008 US5 specified a direct approval by an admin, written before feature 016 built the approval
spine. Subcontractor bills now route through that spine, which is an argument for consistency, and
approving a report moves a quantity a bill is later built from, which is an argument for rigour.

Direct, because a project produces one report a day: roughly thirty routed approvals a month per
project, each capable of stalling behind a chain that no company has configured, would mean the
site's measurement waits on administration rather than on review. The control that matters is kept
— the person who submitted a report cannot approve it — so a site engineer still cannot certify
their own claim.

**Why not a threshold** above which it routes: two mechanisms and a number to argue about, and the
first question anybody asks of a report becomes which path it took rather than whether it is right.

### D3 — The aggregate is authoritative and repair is an explicit act (FR-039b, FR-039c)

Decided on 2026-10-04 while answering `checklists/silent-failure.md` CHK016, which found that
FR-039 obliged a reconciliation report and specified no response to it — a number returned to
nobody with any duty to act on it.

**The sum of approved measurement is authoritative.** It is derived from the reports that are the
record of what happened; the stored done quantity is a cache of that sum, maintained by this
feature's approvals and reversals for the sake of fast reads. When they disagree it is the cache
that has drifted, by construction.

**Repair is explicit, permissioned and recorded, never automatic.** An automatic self-heal would be
easy and is the wrong choice: the discrepancy is the *only* symptom of whatever moved the counter
without a report — a partial transaction, a hand-edit, a bug in reversal — and a system that
silently corrects it destroys the evidence each time, so the underlying fault is never found. A
repair that must be asked for leaves a trail saying somebody found a drift of this size on this day.

**Why not make the counter authoritative**, which would make repair meaningless: the counter is
written by this feature and nothing else validates it, while the sum can be rebuilt from the
reports at any time. A cache cannot outrank the thing it caches.
