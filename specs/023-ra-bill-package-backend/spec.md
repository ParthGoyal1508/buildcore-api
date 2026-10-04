# Feature Specification: Running-Account Bill Package

**Feature Branch**: `023-ra-bill-package-backend`

**Created**: 2026-10-05

**Status**: Draft

**Input**: User description: "The client bills will be generated in this format … where company name
and name of subcontractor will be updated" — the format being
`docs/Parth Realcon Pvt Ltd. RA-12 (1).pdf`, a 24-page running-account bill package the client
maintains in Excel today. Depends on feature 022, which built the measurement this bills from.

## Why this feature exists

A running-account bill is not an invoice with lines on it. It is a **package** — a check list, an
abstract, a priced schedule, a measurement sheet for every item, and a debit-note register — and
the only reason it takes 24 pages is that each sheet answers a question somebody will ask before
releasing money. Today the client assembles all of it by hand in a workbook, which means the
arithmetic is retyped every month and the only link between a day's work and a claimed quantity is
whoever was holding the file.

Feature 022 gave the claimed quantity a source: per BOQ line, per period, the measurement actually
approved. This feature turns that into the document, in **both directions** — the package the
company issues to its own subcontractors, and the same layout issued to a government client with
the authority in the Company slot.

Two things in the real document are worth naming before anything else, because they are the whole
shape of the problem.

**The claimed quantity is a judgement, not a sum.** A month's claim is a fraction of the month, and
the reason sits beside it: *"30 % deduction Shoulder Slope, Supervisor Labour, Staff Not availeble &
ROW Not Cleaned"*. The approved measurement is where the claim starts; the deduction is what the
reviewer does to it; and a bill that recorded only the final figure would lose the argument the
whole document exists to settle.

**Every money figure appears three times** — *Upto Date*, *Upto Previous*, *This Month* — and the
three must agree with each other and with every bill previously issued. That consistency is the one
property of this package that nobody can check by reading a single bill.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Compose a bill for a period (Priority: P1)

A billing engineer opens a new bill for a project and a **period** — the client's run from the 21st
to the 20th — and the system proposes, for every BOQ line, the quantity approved in that period
from the daily work reports. The engineer accepts most of them, reduces a few, and must say why for
each reduction. The variance between what was approved and what is being claimed is kept.

**Why this priority**: this is the step that replaces the retyping, and the one that gives the
claimed quantity a provenance it has never had. Nothing else in the package can be assembled until
the lines exist.

**Independent Test**: approve measurement across two months for a project, open a bill for the
second month, and confirm each line is proposed at the quantity approved **in that period** — then
reduce one with a reason and confirm the reduction, the reason and the variance are all stored.

**Acceptance Scenarios**:

1. **Given** a project with approved measurement, **When** a bill is opened for a period, **Then**
   every BOQ line in the project appears with a proposed claim equal to the measurement approved
   within that period, and lines with no measurement appear at zero rather than being omitted.
2. **Given** a proposed claim, **When** the engineer accepts it unchanged, **Then** no reason is
   required and the variance is zero.
3. **Given** a proposed claim, **When** the engineer reduces it, **Then** a written reason is
   required, and the claim, the reason and the variance against the approved figure are stored
   against that line.
4. **Given** a proposed claim, **When** the engineer raises it above the approved measurement,
   **Then** [NEEDS CLARIFICATION: see Question 2 — whether over-claiming is refused, permitted with
   a reason, or permitted and flagged].
5. **Given** a bill under composition, **When** the same period is opened again for the same
   project, **Then** the existing bill is returned rather than a second one created — a period is
   billed once.
6. **Given** a line whose rate is still zero, **When** the bill is composed, **Then** the line is
   marked unpriced and the bill cannot be issued until it is priced or the line is excluded with a
   reason — "nobody has priced this" is not "this is free".
7. **Given** a bill period that overlaps one already billed, **When** it is opened, **Then** it is
   refused, naming the bill that covers the overlap: a day's measurement claimed on two bills is
   claimed twice.

---

### Story 2 - The abstract, and its three columns (Priority: P1)

The bill's front sheet carries the money, four blocks deep: the work and its tax, the recoveries,
the deductions, and the tax deducted at source — each in three columns showing the position up to
date, up to the previous bill, and in this bill alone. The payable figure is the arithmetic of all
four, and it must be reproducible by anybody holding a calculator.

**Why this priority**: the abstract is the sheet that is signed and paid against. The rest of the
package is its evidence.

**Independent Test**: compose a bill whose work done is a known figure, and confirm each tax,
recovery and deduction is computed at its configured rate and that the payable equals work plus tax
less recoveries, deductions and tax deducted — reproducing the real bill's own numbers.

**Acceptance Scenarios**:

1. **Given** a bill whose work done this period is a known amount, **When** the abstract is
   produced, **Then** the tax on it is computed at the rates in force for that bill and appears as
   either a pair of half-rate taxes or a single full-rate tax, never both.
2. **Given** a bill, **When** the abstract is produced, **Then** every one of the four recovery
   kinds and four deduction kinds appears as its own line, whether or not it carries an amount —
   a subcontractor disputing a payment asks *which* deduction accounts for the difference, and a
   single net figure cannot answer.
3. **Given** a bill, **When** the abstract is produced, **Then** the payable equals the work total
   less the recoveries, the deductions and the tax deducted, in that order, and the three columns
   each balance independently.
4. **Given** a deduction that is a one-time recovery already fully made, **When** a later bill's
   abstract is produced, **Then** it shows in the up-to-date and up-to-previous columns and is
   blank for this bill — a recovered deduction is not re-recovered.
5. **Given** a retention percentage set on the contract, **When** the abstract is produced, **Then**
   retention is computed from it rather than from a rate written into the system, because 5 % is a
   contract term and contracts differ.
6. **Given** a bill, **When** the up-to-previous column is produced, **Then**
   [NEEDS CLARIFICATION: see Question 1 — whether it is the sum of what previous bills actually
   stated, frozen, or recomputed from current data].

---

### Story 3 - The package as a workbook (Priority: P1)

The engineer downloads the bill as a spreadsheet with every sheet the client expects, in the order
they expect them, with the two party names filled in according to which direction the bill runs.
They print it, sign it, and send it.

**Why this priority**: an assembled bill that cannot be handed to the client has not replaced
anything. This is the deliverable.

**Independent Test**: produce the workbook for a composed bill and confirm it contains a sheet of
each of the five kinds, that the party names and statutory identifiers are those of the two parties
to **that** bill, and that the figures on the abstract match the figures the system holds.

**Acceptance Scenarios**:

1. **Given** a bill the company issues to a subcontractor, **When** the workbook is produced,
   **Then** the company occupies the issuing party's position and the subcontractor the receiving
   party's, with each party's registration identifiers, address and code drawn from their own
   record.
2. **Given** a bill the company issues to a client, **When** the workbook is produced, **Then** the
   client occupies the issuing party's position and the company the receiving party's — the same
   layout, the names exchanged.
3. **Given** either direction, **When** a party's registration identifier is missing, **Then** the
   workbook is still produced and the absence is reported, naming the party and the field: a bill
   that cannot be produced because a PAN is unrecorded is worse than one produced with a gap
   somebody fills by hand.
4. **Given** a bill, **When** the workbook is produced, **Then** every figure on it comes from the
   stored bill and none is recomputed at render time, so a bill downloaded twice is identical.
5. **Given** a bill with 17 items, **When** the workbook is produced, **Then** it contains one
   measurement sheet per item, including items with nothing in this period.
6. **Given** an item whose description runs to several paragraphs of specification, **When** the
   workbook is produced, **Then** the description is carried whole rather than truncated.

---

### Story 4 - The measurement sheet, and the argument on it (Priority: P2)

For each item, a sheet showing every month it has been claimed in, the quantity claimed each time,
the reason for each reduction, and which bill each claim went out on — footed by the quantity this
bill, the quantity up to the previous bill, and the total. Where the item's work is a machine
running or a crew present, the daily record sits beneath it as evidence.

**Why this priority**: this is the sheet a client's engineer actually argues over, and the one that
makes a reduction defensible six months later. Separated from Story 3 because the package is useful
with simpler measurement sheets and this is where most of the per-item variation lives.

**Independent Test**: claim the same item on three consecutive bills with a different reduction
reason each time, then confirm the third bill's measurement sheet for that item shows all three
claims, each against its own bill, with the right total.

**Acceptance Scenarios**:

1. **Given** an item claimed on three bills, **When** the current bill's measurement sheet is
   produced, **Then** it lists all three claims in period order, each with its period, its quantity,
   its reason and the bill it was claimed on.
2. **Given** a reduction, **When** the sheet is produced, **Then** the reason appears verbatim as
   the engineer wrote it.
3. **Given** an item whose work is a machine running on a date, **When** the sheet is produced,
   **Then** the daily record for the period appears beneath the claim history, with a row per date.
4. **Given** a date in the period with no daily record, **When** the sheet is produced, **Then** the
   date appears with its measurement absent rather than shown as nothing done, and the gap is
   visible.
5. **Given** an item with no measurement in this period, **When** the sheet is produced, **Then**
   the sheet still exists, with the quantities shown as absent.
6. **Given** a claim, **When** the sheet's footer is produced, **Then** this bill plus up to
   previous equals up to date, exactly.

---

### Story 5 - The debit-note register (Priority: P2)

Damage, shortages and missing equipment are debited to the subcontractor, and each debit is
recorded once and then recovered on whichever bill it is applied to. The register travels with
every package, showing each debit, what it was for, where, how much, and which bill recovered it.

**Why this priority**: the debits are real money — the sample package carries 29 lines — and they
are the recovery figure on the abstract. Separable because a bill with no debits is complete
without the register.

**Independent Test**: record three debits, apply two of them to a bill, and confirm the register
shows all three with the two naming that bill and the third naming none, and that the bill's
recovery total equals the two applied.

**Acceptance Scenarios**:

1. **Given** a debit, **When** it is recorded, **Then** it carries a description, a location, its
   dimensions where it has them, a quantity, a rate, a unit, the amount and the amount with tax.
2. **Given** a debit, **When** it is applied to a bill, **Then** it contributes to that bill's
   recoveries and is marked with that bill.
3. **Given** a debit already applied to a bill, **When** it is applied to a second, **Then** it is
   refused, naming the first: a debit recovered twice is money taken twice.
4. **Given** a register, **When** it is produced for any bill, **Then** it shows every debit against
   that project including those recovered on earlier bills, because the running total is the point.
5. **Given** a debit group heading, **When** the register is produced, **Then** debits appear under
   their heading rather than as a flat list.

---

### Story 6 - The check list (Priority: P2)

The package's front page asks six questions about what is attached, each answered yes, no, or not
required, with a note that the answers are the Planning and Project heads' responsibility and that
gaps may delay the bill.

**Why this priority**: it is the sheet that gates the others in practice — the real document says
non-compliance "may delay the process of bill/ deduction in amount" — and it is the cheapest sheet
to produce.

**Independent Test**: answer the six questions on a bill, produce the workbook, and confirm each
answer appears against its question with the unanswered ones distinguishable from the ones answered
"no".

**Acceptance Scenarios**:

1. **Given** a bill, **When** the check list is answered, **Then** each of the six questions carries
   yes, no or not-required, and an unanswered question is distinguishable from one answered no.
2. **Given** a check list with a question answered no, **When** the bill is issued, **Then** the
   bill is issued and the gap is reported — the check list records a fact and does not refuse.
3. **Given** a bill, **When** the check list is produced, **Then** the questions appear in a fixed
   order with their wording unchanged, because the client's reviewer reads them by position.

---

### Story 7 - Issue, revise, and certify (Priority: P3)

A composed bill is issued. The client certifies less than was claimed, or sends it back and a
revision goes out. What a bill *stated* when it was issued never changes, whatever happens
afterwards.

**Why this priority**: the lifecycle matters most once several bills exist, and the first bill can
be issued without it. But the rule it protects — an issued bill is a document that was sent —
constrains every sheet above.

**Independent Test**: issue a bill, revise its quantities, and confirm the original figures remain
readable as issued alongside the revised ones.

**Acceptance Scenarios**:

1. **Given** a draft bill, **When** it is issued, **Then** its figures are frozen and the date it
   went out is recorded.
2. **Given** an issued bill, **When** its quantities are revised, **Then** the revision is recorded
   with a reason and a count, and what the bill stated when issued remains readable.
3. **Given** an issued bill, **When** the client certifies a smaller amount, **Then** the certified
   figure is kept **beside** the billed one and never instead of it — the variance between them is
   what a project manager chases.
4. **Given** an issued bill, **When** measurement for its period is approved afterwards, **Then**
   [NEEDS CLARIFICATION: see Question 1 — whether the issued bill is unaffected and the measurement
   falls to the next bill, or the bill is flagged as understating its period].
5. **Given** an issued bill, **When** a daily work report underlying it is reversed, **Then** the
   bill is unaffected and the discrepancy is reportable — a bill that changed because somebody
   corrected a site record is a bill nobody can reconcile against the payment that came back.

---

### Edge Cases

- **A period with no approved measurement at all.** A bill may be opened and will claim nothing;
  issuing it is permitted, because a nil bill is a real thing a contract may require monthly.
- **A project whose BOQ has not been imported.** Refused, naming the absence: there is nothing to
  claim against.
- **A bill period that ends before it begins, or spans more than a year.** Refused.
- **An item deleted from the BOQ after it was claimed.** Already refused by the existing guard,
  which counts bill lines. This feature must not weaken it.
- **A party with no registration identifiers at all.** The workbook is produced with the gaps
  reported (Story 3 AC3).
- **Two parties in the same state, and in different states.** Decides which tax applies; derived
  rather than chosen.
- **A claimed quantity that exceeds the item's whole contracted scope**, not merely the period's
  measurement. Flagged, with the over-scope reason the existing model already carries.
- **A debit larger than the bill's work done.** Permitted; the payable may be negative, and a
  negative payable is a real outcome the client's own format can express.
- **The same item claimed twice on one bill.** Refused — one line per item per bill.
- **A revision that reduces a claim below what has already been paid.** Flagged, not refused: the
  remedy is commercial.

## Requirements *(mandatory)*

### Functional Requirements

#### Composition

- **FR-001**: System MUST open a bill against one project for one **period**, defined by a start and
  an end date, both inclusive.
- **FR-002**: System MUST refuse a period that overlaps a period already billed on the same project,
  naming the bill that covers the overlap.
- **FR-003**: System MUST propose, for every BOQ line in the project, a claimed quantity equal to
  the measurement **approved within the period**, and MUST include lines with no measurement at a
  proposed quantity of zero rather than omitting them.
- **FR-004**: System MUST allow a proposed quantity to be reduced, and MUST require a written reason
  for each reduction.
- **FR-005**: System MUST store, per line, the claimed quantity, the approved measurement it was
  proposed from, the reason where one was given, and the variance between the two.
- **FR-006**: System MUST handle a claim above the approved measurement as
  [NEEDS CLARIFICATION: see Question 2].
- **FR-007**: System MUST return the existing bill rather than creating a second when the same
  project and period are opened again.
- **FR-008**: System MUST refuse more than one line per BOQ item per bill.
- **FR-009**: System MUST mark a line whose rate is zero as unpriced, and MUST refuse to issue a
  bill carrying an unpriced line with a non-zero claim.
- **FR-010**: System MUST freeze each line's rate onto the line at composition, so revising the BOQ
  afterwards does not move an issued bill.
- **FR-011**: System MUST refuse to open a bill against a project with no BOQ lines, naming the
  absence.

#### The abstract

- **FR-012**: System MUST compute, for the bill's period, the work done as the sum of each line's
  claimed quantity at its frozen rate.
- **FR-013**: System MUST carry every money figure in three forms: the position up to date, the
  position up to the previous bill, and the amount in this bill alone.
- **FR-014**: The up-to-previous position MUST be [NEEDS CLARIFICATION: see Question 1].
- **FR-015**: System MUST compute tax on the work done at the rates in force for the bill, and MUST
  apply either the two half-rate taxes or the single full-rate tax according to whether the two
  parties are in the same state — never both, and never neither.
- **FR-016**: System MUST derive which tax applies from the parties' own registration data rather
  than from a choice made at composition.
- **FR-017**: System MUST carry four named recovery kinds and four named deduction kinds, each
  reported in its own right whether or not it carries an amount.
- **FR-018**: System MUST compute retention from the percentage recorded on the contract, never from
  a value fixed in the system.
- **FR-019**: System MUST compute tax deducted at source at a configured rate, recorded per bill so
  a rate change does not alter bills already issued.
- **FR-020**: System MUST NOT re-recover a one-time deduction that has been fully recovered: such a
  deduction MUST appear in the cumulative columns and be absent from this bill's.
- **FR-021**: System MUST compute the payable as the work total less recoveries, less deductions,
  less tax deducted, and MUST make each of the three columns balance independently.
- **FR-022**: System MUST permit a negative payable rather than clamping it to zero.
- **FR-023**: Every rate, percentage and deduction label MUST come from configuration or from the
  contract, and none MUST be fixed in the system: 5 % retention and 2 % tax deducted and 9 % tax are
  a contract term and two statutes, and all three change.

#### The workbook

- **FR-024**: System MUST produce a bill as a spreadsheet workbook containing a sheet of each of the
  five kinds: the check list, the abstract, the priced schedule, one measurement sheet per item, and
  the debit register.
- **FR-025**: System MUST bind the two party positions by the bill's direction: for a bill the
  company issues to a subcontractor the company is the issuing party; for a bill issued to a client
  the client is.
- **FR-026**: System MUST draw each party's name, registration identifiers, address and code from
  that party's own record, and MUST NOT require them to be retyped onto the bill.
- **FR-027**: System MUST produce the workbook with a missing party identifier reported as missing
  rather than refusing to produce it.
- **FR-028**: Every figure in the workbook MUST come from the stored bill, and none MUST be
  recomputed at production time — a bill produced twice MUST be byte-for-byte identical in its
  figures.
- **FR-029**: System MUST carry an item's full description, however long, without truncation.
- **FR-030**: System MUST produce one measurement sheet per BOQ item, including items with nothing
  claimed in this period.

#### The measurement sheet

- **FR-031**: System MUST show, per item, every period it has been claimed in, in period order, each
  with its quantity, its reason where one was given, and the bill it was claimed on.
- **FR-032**: System MUST reproduce a reduction's reason verbatim.
- **FR-033**: System MUST show, beneath the claim history of an item whose work is a machine running
  or a crew present, the daily record for the period, a row per date.
- **FR-034**: System MUST show a date with no daily record as having none, distinguishably from a
  date on which nothing was done.
- **FR-035**: The sheet's footer MUST satisfy: this bill plus up to previous equals up to date,
  exactly.

#### The debit register

- **FR-036**: System MUST record a debit with a description, a location, its dimensions where it has
  them, a quantity, a rate, a unit, an amount, and an amount including tax.
- **FR-037**: System MUST allow a debit to be applied to exactly one bill, and MUST refuse a second
  application, naming the first.
- **FR-038**: System MUST include an applied debit in that bill's recoveries.
- **FR-039**: System MUST show, in any bill's register, every debit recorded against the project,
  including those recovered on earlier bills.
- **FR-040**: System MUST group debits under their heading rather than listing them flat.

#### The check list

- **FR-041**: System MUST carry six fixed questions in a fixed order with fixed wording, each
  answerable yes, no or not-required.
- **FR-042**: System MUST keep an unanswered question distinguishable from one answered no.
- **FR-043**: System MUST NOT refuse to issue a bill on the strength of a check-list answer, and
  MUST report the gaps.

#### Lifecycle

- **FR-044**: System MUST freeze a bill's figures when it is issued and record when it went out.
- **FR-045**: System MUST keep what a bill stated when issued readable after any revision.
- **FR-046**: System MUST record each revision with a reason and a count.
- **FR-047**: System MUST keep a certified amount beside the billed amount and never instead of it.
- **FR-048**: System MUST leave an issued bill unaffected by a later reversal of measurement
  underlying it, and MUST make the resulting discrepancy reportable.
- **FR-049**: System MUST record, per bill line, the provenance of its claimed quantity as
  [NEEDS CLARIFICATION: see Question 3].

#### Isolation and permissions

- **FR-050**: Every table this feature creates MUST carry the tenant isolation policy **and** be
  covered by a test exercising it under a database role that cannot bypass it. The development and
  continuous-integration role is a superuser, and a superuser is exempt from row-level security
  unconditionally, so a policy without such a test has never been in force in any test run.
- **FR-051**: Composing, issuing and revising a bill MUST require the project-financials permission;
  recording and applying a debit MUST require it too.
- **FR-052**: Every write MUST be refused against a locked project, distinguishably from a refusal of
  permission.
- **FR-053**: Another company's bill MUST be reported as not found rather than refused.

### Key Entities

- **Bill**: one party's claim on another for one period. Carries the period, the direction, the
  frozen party identifiers, the work and tax totals, the recoveries, the deductions, the tax
  deducted, the payable, and its position in the draft → issued → certified lifecycle.
- **Bill line**: one BOQ item's claim on one bill. Carries the claimed quantity, the measurement it
  was proposed from, the reduction reason, the variance, and the rate frozen at composition.
- **Recovery and deduction**: a named amount on a bill, each kind reported in its own right. Some
  are computed from a rate; some are entered; one is the sum of the debits applied.
- **Debit**: a charge against the receiving party, recorded once and recovered on one bill. Carries
  its description, location, dimensions, quantity, rate, amounts, and the bill that recovered it.
- **Check-list answer**: one of six fixed questions, answered yes, no or not-required, per bill.
- **Approved measurement for a period**: not stored by this feature. Read from feature 022 per BOQ
  line per period, and the figure each claim is proposed from.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A billing engineer composes a month's bill for a 17-item contract by reviewing
  proposed quantities rather than entering them, and types a figure only where they are reducing one.
- **SC-002**: The package the system produces contains every sheet the client's own format contains,
  in the same order, and a reviewer can find each figure where they expect it.
- **SC-003**: The abstract's arithmetic reproduces the real bill's own figures exactly: a work-done
  amount of 18,41,686 yields two half-rate taxes of 1,65,752 each, retention of 92,084, tax deducted
  of 36,834, and a payable of 11,39,971.
- **SC-004**: For every item on every bill, this bill plus up to previous equals up to date, with no
  rounding difference.
- **SC-005**: Every reduction of a claimed quantity on any issued bill has a reason attached, and
  that reason is readable on the measurement sheet for that item a year later.
- **SC-006**: A bill issued and then revised can still be read as it was issued.
- **SC-007**: No debit is recovered on more than one bill.
- **SC-008**: Both bill directions produce the same layout with the party names and identifiers
  exchanged, from one renderer.
- **SC-009**: A bill downloaded twice is identical in every figure.
- **SC-010**: Every table this feature creates is proven isolated between companies under a database
  role that cannot bypass isolation.

## Assumptions

- **The period is the unit of claim, and the client's runs 21st to 20th.** Both dates are stored per
  bill rather than derived from a calendar month, because the real bills run across month ends and a
  contract may set any cycle.
- **Tax direction is derived from the parties' registration numbers**, whose first two digits are the
  state. Both parties in the sample are in the same state, so the two half-rate taxes apply and the
  full-rate line is blank. The project already carries a flag for this; the registration numbers are
  the more reliable source and the flag is the fallback.
- **A client record carries no state and no permanent account number today**, while a company and a
  vendor record carry both. For a bill issued to a client, those two fields are therefore the most
  likely to be reported missing under FR-027, and may need adding to the client record — out of
  scope here, and named so it is not discovered at the first bill.
- **The vendor code on the sheet is the vendor's own code**, which the vendor record already carries.
- **The work-order number and the external bill number are references the client's own systems
  assign**, so they are recorded on the bill rather than generated.
- **The sample package's priced schedule is headed "RA Bill - 09" while the package is RA-12.** This
  is an error in the client's own workbook, caused by copying a sheet. The system will not reproduce
  it: every sheet in a produced package names the bill it belongs to, from one source.
- **The daily record beneath a measurement sheet comes from feature 022 and the equipment logbook**,
  read rather than stored again.
- **Output is a spreadsheet and not a document.** The source is a workbook, the layout is native to
  one, and a client who wants to adjust a cell before signing can.
- **The existing bill tables cannot hold this.** Neither carries a period, any tax, recoveries, a
  full set of deductions, tax deducted, or the statutory header — the client-side table has never
  held a row, so there is no production data to migrate.
- **Feature 022 is complete and unchanged by this.** This feature reads its period figures and adds
  nothing to how a day's work is recorded or approved.

## Open Questions

Three decisions change what gets built and have no safe default.

### Question 1: Is the cumulative position frozen or recomputed? (FR-014, Story 2 AC6, Story 7 AC4)

**Context**: every figure appears as *Upto Date*, *Upto Previous* and *This Month*, and the second
must be the position as at the previous bill. Two readings, and they diverge the first time anything
behind an issued bill changes — a late-approved measurement, a revision, a reversal.

| Option | Answer | Implications |
|--------|--------|--------------|
| A | **Frozen.** Each bill stores its own cumulative figures when issued, and *Upto Previous* is read from the previous bill's stored *Upto Date*. | The package always agrees with the paper the client holds. Each bill is self-contained and reproducible for ever. The cost: a late-approved measurement for a billed period does not appear in that bill and must fall to the next, so a bill can be permanently short — and the system must be able to say so (Story 7 AC4). |
| B | **Recomputed** from current data each time a package is produced. | A bill always reflects what is now known to be true, and nothing is ever short. But an issued bill's successor would disagree with the signed copy of its predecessor, and reconciling a payment against a bill whose history has moved is the thing nobody can do. |
| C | **Frozen, with a restatement mechanism**: a bill can be explicitly restated, which records the change and re-freezes. | Honest about both. Also the largest: it needs a restatement to be a first-class act with its own trail, and a reader must be able to tell a restated bill from an original. |
| Custom | Provide your own answer | |

### Question 2: May a claim exceed the approved measurement? (FR-006, Story 1 AC4)

**Context**: the real sheets only ever reduce — every remark is a deduction. But the question is
what the system does when somebody claims more than the daily reports support, and the answer
decides whether the measurement is a control or a suggestion.

| Option | Answer | Implications |
|--------|--------|--------------|
| A | **Refused.** A claim cannot exceed the measurement approved for the period. | The measurement becomes a real control: nothing can be billed that was not approved on site. It also means a genuine site error — work done and the report never filed — blocks the bill until the report is filed and approved, which is arguably correct and will be unpopular in the last week of a billing cycle. |
| B | **Permitted with a reason**, flagged on the line and visible on the sheet. | Matches how over-scope is already handled elsewhere in this system: the site did the work, and refusing at entry means it is recorded nowhere. The risk is that the reason field becomes the route around the control. |
| C | **Permitted and flagged, no reason required.** | Least friction, least value: a flag nobody has to justify is a flag nobody reads. |
| Custom | Provide your own answer | |

### Question 3: Does a bill line record which measurement it consumed? (FR-049)

**Context**: feature 022 declined to invent this link and made deciding it an obligation here
(022 FR-020a). 022's reversal is currently guarded by a quantity floor rather than by provenance, so
whatever is decided here determines whether that can be tightened.

| Option | Answer | Implications |
|--------|--------|--------------|
| A | **The period is the link.** A bill line names its item and its bill names its period, so the measurement it consumed is exactly the approved measurement for that item in that period — no new column. | Nothing to maintain, and it is true by construction given that a period is billed once (FR-002, FR-007). It cannot answer "which reports did this line consume" after a report's work date is corrected across a period boundary, which is rare and detectable. |
| B | **Explicit links**, one row per report a line drew on, recorded at composition. | Exact provenance for ever, and it would let 022 refuse a reversal by naming the bill that consumed it. Also a row per report per line per bill — for a 312-line tender over a year, hundreds of thousands of rows whose only consumer is an audit question nobody has asked yet. |
| C | **Store the measurement figure and the period on the line** — the figure as proposed, not the reports behind it. | A middle: enough to show the claim against what was approved at the time, and to detect later divergence, without a link table. This is what FR-005 already requires, so the question becomes whether anything more is needed. |
| Custom | Provide your own answer | |
