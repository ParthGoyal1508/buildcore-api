# Feature Specification: Projects Flow Completion

**Feature Branch**: `004-dashboard-backend`

**Created**: 2026-10-05

**Status**: Draft

**Input**: User description: "Fix the daily-work save failure and close every gap found auditing the BOQ → daily work → RA bill journey on 2026-10-05."

## Why this feature exists

Features 008, 018, 022 and 023 built a complete billing spine: a schedule of quantities, a day's
measurement, an approval that moves executed quantity, and a 24-sheet running-account package with
its abstract, its register and its check list. Ninety endpoints under `src/projects/`.

A user then tried to walk the journey and could not get past the first screen.

This feature is **completion and repair, not capability**. Almost every requirement below is a
screen placed over an endpoint that already works, or a field added to a form whose column already
exists. Two requirements fix something genuinely broken, one adds the single endpoint the audit
found missing, and the rest connect what is already there. **Each requirement states which**, so
that nobody implementing this rebuilds a service that has been passing its tests since August.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A day's work can be saved (Priority: P1)

A site engineer opens **Daily work → Record a day**, fills in the date, the people and machines on
site, adds a measured line against a BOQ item with its dimensions, and saves. The report appears in
the list under its own number, and the three facts the server reports alongside success — a work
date before the project started, a second report for a day already covered, a line past its BOQ
scope — are shown as what they are: facts beside a success, not failures.

**Why this priority**: Nothing downstream exists without it. A bill is composed from approved daily
measurement, so a day that cannot be recorded is a bill of zeros. This is also the defect the user
reported: the save succeeds on the server and the screen shows a parse error, which is the worst of
both — the work is recorded and the person who recorded it believes it was not, and records it
again.

**Independent Test**: Record a day with one measured line and one presence line, save, and find it
in the list with the right number, status and line count. Fully testable with no other story built.

**Acceptance Scenarios**:

1. **Given** a project with a BOQ, **When** a day is recorded with a measured line carrying
   dimensions, **Then** it saves and the list shows it by its report number with its status.
2. **Given** a measured line where the engineer fills the **Nos** and **Factor** boxes, **When** it
   is saved, **Then** it saves — those two boxes are part of the measurement, not a rejection.
3. **Given** a save that the server accepts with warnings, **When** it returns, **Then** each
   warning is shown in words the engineer can act on, and the report is not reported as failed.
4. **Given** a work date in the future, **When** it is saved, **Then** it is refused with the
   server's own sentence, and the form keeps what was typed.

---

### User Story 2 - An imported BOQ line can be planned (Priority: P1)

A planner opens **BOQ**, sees an imported tender reading *Not planned* in its three programme
columns, and edits a line in place: a start date, a finish date, and optionally a per-day target.
The row then reports a needed rate and a finish date, and joins the Delayed / Today / To be delayed
/ On track alert tabs that have had nothing to report since the importer was built.

**Why this priority**: A tender schedule carries no dates, by design. Today there is no update of
any kind for a BOQ item, so an imported line stays unplanned permanently and the only route is to
delete and re-create it — impossible once work has been recorded against it. The alert tabs, the
needed-rate calculation and the five-state classification were all built and are all unreachable.

**Independent Test**: Import or add a line, patch its three programme fields, and read the figures
back on the BOQ screen where *Not planned* previously stood.

**Acceptance Scenarios**:

1. **Given** an imported line reading *Not planned*, **When** a finish date is set, **Then** the
   needed per-day rate is derived from the outstanding quantity and the days remaining.
2. **Given** a line with a start date and recorded progress, **When** the BOQ is read, **Then**
   *Avg / day* reports what has actually been achieved rather than *Not planned*.
3. **Given** a line already planned, **When** a programme field is explicitly cleared, **Then** it
   returns to unplanned — distinguishable from a field simply not mentioned in the request.
4. **Given** a locked project, **When** a line's programme is edited, **Then** it is refused as
   locked, not as forbidden.

---

### User Story 3 - A bill can be raised to the client (Priority: P1)

A commercial manager records the contract's retention term on the project, then composes a
running-account bill in the client direction for a period, reviews the proposed quantities, issues
it and downloads the workbook.

**Why this priority**: The client direction is half of what feature 023 was built for — one
renderer, two bindings — and it cannot be exercised at all today. Composition refuses, correctly,
because billing at zero retention makes the payable five per cent too high and nothing downstream
would notice. The refusal is right; the absence of any way to answer it is the defect.

**Independent Test**: Compose a client-direction package on a project with no retention term
(refused, by name), record the term, compose again (accepted).

**Acceptance Scenarios**:

1. **Given** a project with no retention term, **When** a client bill is composed, **Then** it is
   refused naming the missing term and what to do about it.
2. **Given** the term recorded as a percentage, **When** the bill is composed, **Then** retention is
   withheld at that rate and the abstract's deduction block reflects it.
3. **Given** a term recorded and later read back, **When** it is displayed, **Then** it reads as the
   same percentage that was typed — a round trip may not drift.

---

### User Story 4 - A statutory rate can be changed without a database (Priority: P2)

A finance administrator changes the TDS rate from 2% when the statute changes, and every bill
composed afterwards uses the new rate while every bill already issued keeps the rate it froze.

**Why this priority**: The constitution's no-hardcoded-values principle exists for this case. The
four rates carry correct statutory defaults, so nothing is wrong today — but a statute that changes
on a Monday cannot wait for a developer.

**Independent Test**: Read the four rates, change one, compose a new package, and confirm the new
rate applies while an already-issued package is unchanged.

**Acceptance Scenarios**:

1. **Given** the four rates at their defaults, **When** they are read, **Then** each is reported
   with the figure in force.
2. **Given** a rate changed, **When** a new package is composed, **Then** it uses the new rate.
3. **Given** a package issued before the change, **When** it is read or re-produced, **Then** its
   figures are unchanged — issue freezes rates, and this feature must not unfreeze them.

---

### User Story 5 - What the system already does becomes reachable (Priority: P2)

Everything the backend already answers can be reached by the people it was built for: attachments on
a daily report, a draft corrected or withdrawn, the reconciliation between approved reports and
executed quantity with its repair, a measurement sheet read on screen rather than only inside a
workbook, a debit raised and recovered, an issued bill revised, a draft abandoned, the two reports
the billing decisions oblige, a work order corrected, retention released, an estimate imported, and
the letters a project needs.

**Why this priority**: Each of these is an endpoint with tests, a permission and an error
vocabulary, that no screen calls. They are not new capability and must not be built as if they
were. Grouped as one story because they share one acceptance rule: **the screen calls the existing
endpoint and adds no behaviour of its own.**

**Independent Test**: For each surface, the action succeeds through the interface and the result is
visible in the same session.

**Acceptance Scenarios**:

1. **Given** a daily report, **When** a photograph of the measurement sheet is attached, **Then** it
   can be opened again later by anyone who may read the report.
2. **Given** a draft report with a wrong figure, **When** it is corrected, **Then** the correction
   stands without deleting and re-entering the day.
3. **Given** executed quantity that has drifted from the sum of approved reports, **When** the
   reconciliation is read, **Then** the difference is shown per line and can be repaired
   deliberately — never automatically.
4. **Given** a debit against a subcontractor, **When** it is raised and applied to a bill, **Then**
   it appears in that bill's register and cannot be applied to a second.
5. **Given** an issued bill found wrong, **When** it is revised, **Then** the revision is visible as
   a revision rather than as a new bill.

---

### User Story 6 - The three corrections the audits left open (Priority: P3)

A punch at a site that has been closed is refused; the project's costing breakdown reconciles with
what the project screen reports; and the one requirement citing a function that does not exist is
corrected to cite what does.

**Why this priority**: Each is small, each is recorded as outstanding in an earlier feature's tasks,
and none blocks the journey. They are here because a task list that carries three permanent
unchecked items teaches people to ignore unchecked items.

**Independent Test**: A punch at an inactive site is refused; the costing figures agree; the
requirement text names a function that exists.

**Acceptance Scenarios**:

1. **Given** a site whose status is inactive, **When** attendance is punched there, **Then** it is
   refused naming the site's state.

---

### Edge Cases

- **A programme field cleared rather than omitted.** Omitting a field and clearing it are different
  intentions and must be distinguishable, or a planner who wants to remove a wrong finish date has
  no way to say so.
- **A finish date before the start date**, or a duration that contradicts both. The three programme
  fields can disagree with one another and the system must say which it believes.
- **A retention percentage above 100.** A retention larger than the bill makes every net payable
  zero: a typo, not a term.
- **A rate changed between composing a bill and issuing it.** Rates are frozen at issue, not at
  composition, so a draft composed on Monday and issued on Wednesday uses Wednesday's rates — and
  the draft's figures will have moved. This must be true deliberately rather than by accident.
- **An attachment on a report that is later reversed.** The attachment is evidence of the day, not
  of the approval, and survives.
- **A reconciliation repair on a line with a bill against it.** Repair moves executed quantity; a
  billed quantity is a floor. The two rules meet here and the floor wins.
- **A web response shape that drifts from the contract again.** The failure that prompted this
  feature produced a 201 on the server and an error on the screen; it must be caught by something
  other than a person trying it.

## Requirements *(mandatory)*

### The daily-work contract (repair — the reported defect)

- **FR-001**: The client's model of a daily work report MUST match the published contract field for
  field. The report's identifier is `dprNumber`; there is no `reportNumber` anywhere in the system.
- **FR-002**: The response to recording a day MUST be read as what it is — an identifier, a number,
  a status and a list of warnings — and MUST NOT require fields the server does not send. A client
  that demands a work date back from a creation response will reject every successful save.
- **FR-003**: A warning MUST be carried as the structured fact it is (a code, a sentence, and
  whatever detail the reader needs to act), not as a bare string. The three warnings are a work date
  before the project started, a second report for a date already covered, and a line past its BOQ
  scope; each names the thing it is about.
- **FR-004**: A warning MUST be displayed beside the success, never instead of it. A save that the
  server accepted is a save, and telling the user otherwise causes the day to be recorded twice.
- **FR-005**: The list of reports MUST be read as the list the server sends: a page of summaries
  carrying a line **count**, with a total, a page and a page size. The list does not carry the lines
  themselves and a client MUST NOT render them from it.
- **FR-006**: A control whose rule depends on a fact the response does not carry MUST NOT guess it.
  The rule that the author of a report may not approve it is enforced on the server; a client that
  cannot see who the author is either obtains that fact or stops claiming to know it.
- **FR-007**: A measured line MUST be sent with the six factor names the server defines — `nos1`,
  `nos2`, `length`, `breadth`, `depth`, `density`. Unknown fields are refused outright rather than
  stripped, so a field invented by a client is a failed save, not a missing figure.
- **FR-007a**: The quantity a client previews before saving MUST be computed from the same six
  factors the server multiplies. A preview over a different set of names shows a figure the save
  will not produce.
- **FR-008**: The published contract MUST be the artifact a reviewer compares a client model
  against, and a check MUST exist that fails when the two diverge. This defect was not a typo — a
  whole module was written against a contract nobody opened.

### Planning a schedule line (one new endpoint)

- **FR-009**: An existing BOQ line MUST accept its programme after creation: a start date, a finish
  date, a duration in working days and a per-day target. Today there is no update of any kind, and
  the importer carries no dates, so an imported line can never be planned.
- **FR-010**: The programme fields MUST be validated exactly as they are at creation. The shape
  already exists and is already validated; a second, differently-validated shape for the same four
  fields is how two paths come to disagree.
- **FR-011**: Omitting a field MUST leave it unchanged and explicitly clearing it MUST return it to
  unplanned. A planner removing a wrong finish date needs a way to say so that is not "set it to
  something else".
- **FR-012**: A programme that contradicts itself MUST be refused naming the contradiction — a
  finish date before the start date is a typo, and accepting it makes every derived figure negative.
- **FR-013**: Planning a line MUST require the same permission as any other change to the schedule,
  MUST be refused on a locked project as locked rather than as forbidden, and MUST report another
  company's line as not found rather than as refused.
- **FR-014**: The achieved rate reported per line is derived from the start date and the work
  recorded. A planning surface that cannot set a start date leaves that column permanently empty,
  so the start date MUST be settable wherever the other two are.
- **FR-015**: Planning MUST NOT change scope, rate, unit or description. A programme is when the
  work happens; those four are what the work is, and a screen that edits both invites a rate changed
  while planning a date.

### The client retention term (one new field on an existing form)

- **FR-016**: A project MUST carry the client contract's retention term, settable when the project
  is created and when it is edited. The column exists and the bill composer already reads it; there
  is no way to put a figure in it.
- **FR-017**: The term MUST be entered the way a contract states it — as a percentage — and stored
  the way the composer reads it. Exactly one place in the system performs that conversion.
- **FR-018**: The term MUST be bounded at nought and one hundred per cent. A retention larger than
  the bill makes every net payable zero, which is a typo rather than a term.
- **FR-019**: A term absent MUST remain a refusal to compose, not a default of zero. Billing at zero
  retention makes the payable five per cent too high and nothing downstream would notice.
- **FR-020**: The term read back MUST equal the term entered. A percentage that becomes 4.999999 on
  a round trip is a bill that disagrees with the contract by a rupee nobody can explain.

### Statutory rates (read and write on an existing module)

- **FR-021**: The four tax rates a bill is computed at — CGST, SGST, IGST and TDS — MUST be readable
  and changeable by an administrator, alongside the cess rate that already lives beside them.
- **FR-022**: A rate MUST be bounded at nought and one, and MUST be stated to enough precision to
  express the rates that exist. A rate entered as 9 when 0.09 was meant multiplies every tax by one
  hundred.
- **FR-023**: Changing a rate MUST NOT alter any bill that has been issued. Issue freezes the rates
  onto the bill precisely so that a document already sent reproduces identically.
- **FR-024**: Changing a rate MUST be recorded — who changed it, when, and from what to what. A
  statutory rate is the single figure most able to move money without anyone noticing.

### Making the built reachable (screens over existing endpoints)

- **FR-025**: Evidence MUST be attachable to a daily work report and retrievable afterwards. The
  upload and the download both exist and neither is called.
- **FR-026**: A draft report MUST be correctable and withdrawable by the people entitled to do so,
  without deleting and re-entering the day.
- **FR-027**: The reconciliation between approved reports and executed quantity MUST be readable per
  line, and its repair MUST be available as a deliberate, permissioned, recorded act — never
  automatic. The report and the repair both exist.
- **FR-028**: A line's measurement sheet — its claim history across bills and its daily record —
  MUST be readable on screen. It exists, and today it can only be seen by downloading a workbook.
- **FR-029**: A debit MUST be raisable against a counterparty and recoverable on exactly one bill,
  and the attempt to recover it twice MUST be refused. All of this exists and no screen calls it.
- **FR-030**: An issued bill MUST be revisable and a draft abandonable through the interface.
- **FR-031**: The understatement report and the over-claim report MUST be readable. They exist
  because the two billing decisions oblige them — a reason nobody aggregates is a reason nobody
  reads — and an unread report satisfies neither.
- **FR-032**: A work order MUST be correctable after creation, retention MUST be releasable against
  it, and an estimate MUST be importable. All three exist.
- **FR-033**: The letter kinds a project needs — work order, letter of intent, purchase order,
  indent, service order, service bill — MUST be reachable from the project module. They are already
  permitted and already produced; they appear only under recruitment.
- **FR-034**: A screen added under this section MUST NOT reimplement a rule the endpoint already
  enforces. Where a rule must be shown before it is attempted, the screen states it; where it is
  enforced, the screen passes the server's own sentence through.

### The outstanding corrections

- **FR-035**: Attendance MUST be refused at a site whose status is inactive, naming the site's state.
- **FR-036**: The project detail's costing breakdown MUST reconcile with the figures the project
  reports elsewhere, or state which basis it uses where they legitimately differ.
- **FR-037**: A requirement citing a function that does not exist MUST be corrected to cite what
  does. This is a documentation correction and implies no code.
- **FR-038**: The declared permission on the bill package's routes MUST be proven by a test that an
  authenticated caller without it is refused. A guard that is declared and never exercised is a
  guard nobody knows is wired.

### Key Entities

- **BOQ item**: already carries scope, rate, unit, description, executed quantity and the four
  programme fields. This feature adds no attribute to it; it adds the ability to change four that
  exist.
- **Project**: already carries the client retention term as a nullable column. This feature makes it
  settable.
- **Company**: already carries the four statutory rates with statutory defaults. This feature makes
  them readable and changeable.
- **No new table.** The audit found none required, and the isolation rule that applies to a new
  table therefore does not apply here — which must be confirmed during planning rather than assumed.

## Success Criteria *(mandatory)*

- **SC-001**: A site engineer can record a day with measured and presence lines and see it listed,
  without encountering a technical error message. Today this is impossible.
- **SC-002**: Every imported BOQ line can be given a start date, a finish date and a per-day target
  without deleting it, and the three programme columns report figures afterwards.
- **SC-003**: A running-account bill can be composed, issued and downloaded in **both** directions.
  Today only the subcontractor direction is reachable.
- **SC-004**: Each of the four statutory rates and the project's retention term can be changed by an
  administrator without database access.
- **SC-005**: Every endpoint under the projects module is reachable from the interface, or is
  recorded with a reason why it is not. The audit that prompted this feature found twelve API
  functions with no caller and six endpoints with no client at all.
- **SC-006**: A divergence between a client model and a published contract is caught by a check
  rather than by a user. The defect that prompted this feature reached a person.
- **SC-007**: No task in features 008 or 023 remains unchecked without a stated reason.

## Assumptions

- **The API does not move; the client moves to meet it.** The daily-work contract is published, its
  implementation has a passing end-to-end suite, and three other features read it. Renaming a field
  to match a client that guessed wrong would break the ones that guessed right.
- **The retention term is stored as a fraction, and the client converts.** This matches the
  subcontract retention term already in the system, which is documented as a fraction, bounded at
  one, and converted from a percentage by the screen that collects it. One convention, not two.
- **Clearing is expressed explicitly.** A programme field set to nothing clears it; a field not
  mentioned is untouched.
- **Rates freeze at issue, not at composition.** This is existing, deliberate behaviour and this
  feature inherits rather than revisits it.
- **The letters surface reuses the existing letter machinery.** The kinds, the templates and the
  production already exist; only the entry point is missing.
- **Two repositories, one feature.** The service work and the screen work are specified together
  because the defect that prompted this is precisely a seam between them.

## Out of Scope

- **The project schedule and progress module** — phases, activities, dependencies, baselines,
  weightage, periodic targets and variance reporting. It is the largest unbuilt area of the projects
  module and deserves its own feature; this one plans a *line*, not a *programme*.
- **The nine pre-existing index-name drifts** between the development database and the committed
  schema. They predate all of this and need their own correction.
- **The client's missing state and PAN**, which belong to another module's table and are today
  reported as missing header fields rather than refused.
- **PDF output.** The workbook is the deliverable the client signs.
- **Any change to how a daily report is recorded or approved on the server**, and any change to how
  a bill package is composed, issued or certified. Both are complete and tested; this feature
  reaches them, it does not revise them.
