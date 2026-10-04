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
   **Then** it is **accepted with a written reason**, the line is flagged as over-claimed, and the
   flag appears on that item's measurement sheet. The site does work that the paperwork has not
   caught up with, and refusing at entry means the claim is recorded nowhere — but the flag is
   counted and reportable, so the reason field cannot quietly become the route around the control.
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
6. **Given** a bill, **When** the up-to-previous column is produced, **Then** it is read from the
   **previous bill's stored up-to-date figures**, not recomputed — so the package always agrees
   with the signed copy the client holds.
7. **Given** an issued bill, **When** measurement for its period is approved afterwards, **Then**
   that bill does not move, the measurement falls to the next bill, and the bill is **reportable as
   having understated its period** — the shortfall is a fact somebody must be able to find, not a
   silent gap.

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
   the bill is unaffected, the measurement is available to the next bill, and the understatement is
   reportable against the bill that missed it.
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
- **FR-002**: System MUST refuse a period that overlaps a period already billed **on the same
  schedule to the same counterparty** — the project's own schedule for a bill to a client, that
  work order's schedule for a bill to a subcontractor — naming the bill that covers the overlap.
  The check is deliberately not per project: one project is legitimately billed to its client and
  to several subcontractors over the same month, and a per-project rule would refuse the second of
  those, which is the direction the company bills every month.
- **FR-002a**: A period is occupied by a bill in **any** status, draft included, so that two drafts
  cannot both propose the same approved measurement.
- **FR-002b**: System MUST provide a way to abandon a draft bill, releasing its period. Without
  one, a mistakenly-opened draft occupies its period for ever and the only way out is deleting the
  row that records that the period was billed (FR-044a).
- **FR-003**: System MUST propose, for every line of **the schedule the bill's direction
  measures** — the project's BOQ lines for a bill to a client, that subcontractor's award lines for
  a bill to a subcontractor — a claimed quantity equal to the measurement **approved within the
  period**, and MUST include lines with no measurement rather than omitting them. The two
  directions measure different schedules, so "every BOQ line in the project" is the right
  population for only one of them.
- **FR-003a**: Where a line has **no measurement source at all** — an award line mapped to no BOQ
  line, which the subcontract model permits because a subcontract may itemise work differently —
  the proposal MUST be reported as *no measurement available*, distinguishably from a proposal of
  zero. Zero means the measurement was read and was nothing. The two must never print the same, and
  on the subcontractor direction they otherwise would, for every unmapped line, every month.
- **FR-003b**: Where two or more award lines map to one BOQ line, System MUST NOT propose that
  line's full approved measurement to each of them. It MUST either refuse the composition, naming
  the lines, or require the quantity to be apportioned explicitly — never silently duplicate it,
  which FR-008's one-line-per-item rule would not catch because they are two different lines.
- **FR-004**: System MUST allow a proposed quantity to be reduced, and MUST require a written reason
  for each reduction.
- **FR-004a**: System MUST clear a reason when a later edit returns the claimed quantity to the
  proposed one. A reason left beside a zero variance argues on the measurement sheet for a
  deduction the bill does not make.
- **FR-005**: System MUST store, per line, the claimed quantity, the approved measurement it was
  proposed from, the reason where one was given, and the variance between the two.
- **FR-006**: System MUST accept a claim above the approved measurement, MUST require a written
  reason for it, and MUST flag the line as over-claimed.
- **FR-006a**: An over-claim's flag MUST appear on that item's measurement sheet, and MUST be
  countable per bill and per project, so that over-claiming can be observed as a pattern rather than
  only inspected one line at a time. This is what keeps the reason field from becoming the route
  around the control: a reason nobody aggregates is a reason nobody reads.
- **FR-006b**: The over-claim count MUST be reported against the number of lines it was drawn
  from. A count without its denominator cannot be read as a pattern, which is the whole purpose
  FR-006a states for it.
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

- **FR-012**: System MUST compute the work done for the bill's period as the sum of its lines' own
  stored amounts, and each line's amount from its claimed quantity at its frozen rate adjusted by
  any percentage quoted against that schedule. The abstract's work-done figure and the priced
  schedule's footer are the same number and MUST come from the same stored amounts — a work-done
  figure computed as quantity times rate alone would disagree with the schedule it totals on every
  tender quoted above or below its rates.
- **FR-012a**: System MUST state the rounding applied to money: the unit, the direction, and that a
  total is rounded from unrounded components rather than summed from rounded ones. The real
  document's figures are whole rupees reached from fractions — a half-rate tax of 1,65,751.74 shown
  as 1,65,752 — so an unstated rule is a rule each implementation invents, and rounding each row
  before summing breaks FR-021's balance by a few rupees per column.
- **FR-012b**: System MUST report a cumulative claim that has passed its line's scope or awarded
  quantity, and MUST show the quantity remaining as the negative figure it is rather than as its
  magnitude.
- **FR-013**: System MUST carry every money figure in three forms: the position up to date, the
  position up to the previous bill, and the amount in this bill alone.
- **FR-013a**: The up-to-previous position MUST NOT be derived from this bill's own figures. Up to
  date less this bill equals up to previous only while the chain is unbroken — and defining the
  column that way makes FR-035's identity a restatement of its own definition, true for any values
  whatever. It is read from a stored figure or it is not an independent column.
- **FR-013b**: A bill that has not been issued has no frozen cumulative position (FR-014a), so its
  abstract's up-to-date column MUST be marked provisional. A figure that changes when the engineer
  presses Issue is a figure they did not approve.
- **FR-014**: The up-to-previous position MUST be read from the previous bill's stored up-to-date
  position, and MUST NOT be recomputed from current data. **The previous bill** is the one with the
  highest sequence number below this bill's on the same schedule to the same counterparty that has
  been issued; where there is none, every up-to-previous figure is zero — stated as zero, which is
  a position, and not as absent, which is not.
- **FR-014a**: System MUST store each bill's own cumulative position when the bill is issued, so
  that every bill is reproducible from itself for ever.
- **FR-014b**: System MUST report, **on demand**, any bill whose period's approved measurement has
  since grown beyond what the bill claimed — the understatement a frozen cumulative position makes
  possible. The comparison is exact: quantities are fixed-point, so no tolerance applies and any
  difference at all is reportable. Without this, choosing to freeze would turn a late-approved
  report into a quantity nobody ever bills.
- **FR-014c**: System MUST provide a route to bill a reported understatement, and MUST state it.
  Feature 022 attributes measurement by work date, so a quantity approved late whose work date
  falls inside an already-billed period will never appear in any later period's proposal: it is not
  late, it is unreachable. The route is an over-claim on a later bill under FR-006, carrying the
  understatement report as its written reason. Left unstated, one engineer finds it and the next
  writes the quantity off.
- **FR-015**: System MUST compute tax on the work done at the rates in force for the bill, and MUST
  apply either the two half-rate taxes or the single full-rate tax according to whether the two
  parties are in the same state — never both, and never neither.
- **FR-015a**: The taxable base MUST be stated, and MUST be the work done before any recovery,
  deduction or withholding. Where an amount is withheld from release, System MUST state whether
  that amount leaves the taxable base, and MUST apply the answer identically in all three columns.
  The sample package withholds nothing, so no test drawn from it constrains this at all.
- **FR-016**: System MUST derive which tax applies from the parties' own registration data rather
  than from a choice made at composition.
- **FR-016a**: Where the basis cannot be derived from both parties' registration data and falls back
  to the project's flag, System MUST report that it fell back. A client record carries no state
  today, so for a bill to a client the fallback is the likely path rather than the exceptional one —
  and a fallback recorded on a row and shown to nobody is a tax decision nobody made.
- **FR-017**: System MUST carry four named recovery kinds and four named deduction kinds, each
  reported in its own right whether or not it carries an amount.
- **FR-018**: System MUST compute retention from the percentage recorded on the contract, never from
  a value fixed in the system.
- **FR-018a**: Retention's base MUST be stated, and MUST be the work done before tax, recoveries
  and other deductions. FR-018 fixes where the percentage comes from and says nothing about what it
  multiplies; 5 % of the right base reproduces the sample's 92,084 and 5 % of the tax-inclusive
  total does not.
- **FR-019**: System MUST compute tax deducted at source at a configured rate, recorded per bill so
  a rate change does not alter bills already issued.
- **FR-019a**: The base for tax deducted at source MUST be stated, and MUST be the work done before
  tax, recoveries and other deductions — not the payable it is subtracted from.
- **FR-020**: A one-time recovery — a mobilisation advance, a performance security — MUST carry the
  **total** to be recovered and the amount recovered to date, and "fully recovered" MUST be the
  comparison of the two. Nothing else can make the distinction: without a recorded total, a
  deduction that is complete and one somebody happened to enter as zero this month are the same row,
  and the requirement is satisfied by an implementation that does nothing at all.
- **FR-020a**: A fully-recovered one-time deduction MUST appear in the cumulative columns and be
  absent from this bill's, which is what the sample package's performance security does.
- **FR-020b**: System MUST refuse a recovery that would carry the amount recovered to date past the
  recorded total, naming the total and what remains of it.
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
- **FR-024a**: Every sheet in the workbook MUST be named by a rule that cannot lose one. A sheet
  name is limited to 31 characters, may not contain the characters a file path uses, and must be
  unique within the workbook — so a name taken from an item's number or description will collide or
  be truncated on a 312-item schedule, and what the writer does with a collision decides whether an
  item's sheet silently disappears. The rule MUST be stated, MUST guarantee uniqueness, and each
  sheet MUST identify its item **inside** the sheet rather than only by its name.
- **FR-025**: System MUST bind the two party positions by the bill's direction: for a bill the
  company issues to a subcontractor the company is the issuing party; for a bill issued to a client
  the client is.
- **FR-026**: System MUST draw each party's name, registration identifiers, address and code from
  that party's own record, and MUST NOT require them to be retyped onto the bill.
- **FR-027**: System MUST produce the workbook with a missing party identifier reported as missing
  rather than refusing to produce it.
- **FR-027a**: The missing identifiers MUST be reported to the caller that produced the workbook. A
  workbook is a file download, so a list recorded on the bill and absent from the response is a gap
  nobody is told about.
- **FR-028**: Every figure in the workbook MUST come from the stored bill, and none MUST be
  recomputed at production time: a bill produced twice MUST carry an identical value in every cell.
  Not byte-for-byte — a workbook file records when it was written, so two productions are never
  identical as bytes, and a requirement stated that way could only ever be met by abandoning it.
- **FR-029**: System MUST carry an item's full description, however long, without truncation.
- **FR-029a**: Where a description exceeds what a single cell can hold, System MUST report that it
  could not be carried whole rather than truncating it silently.
- **FR-030**: System MUST produce one measurement sheet per line of the bill's own schedule
  (FR-003), including lines with nothing claimed in this period.
- **FR-030a**: The number of measurement sheets MUST equal the number of lines that schedule holds,
  and the equality MUST be assertable without knowing the number in advance. An assertion over the
  sheets a workbook contains passes just as happily over a short list, and a missing sheet is a
  smaller invoice.

#### The measurement sheet

- **FR-031**: System MUST show, per item, every period it has been claimed in, in period order, each
  with its quantity, its reason where one was given, and the bill it was claimed on.
- **FR-032**: System MUST reproduce a reduction's reason verbatim.
- **FR-033**: System MUST show, beneath the claim history of an item whose work is a machine running
  or a crew present, the daily record for the period, a row per date.
- **FR-034**: System MUST show a date with no daily record as having none, distinguishably from a
  date on which nothing was done.
- **FR-035**: The sheet's footer MUST satisfy: this bill plus up to previous equals up to date,
  **exactly** — where up to previous is the figure stored on the previous bill (FR-013a, FR-014) and
  not this bill's own up-to-date figure less its own quantity. The distinction is the whole value of
  the requirement: stated against a stored figure the identity can fail and is therefore worth
  asserting, while stated against a derived one it is a rearrangement of its own definition and
  holds for any values whatever.

#### The debit register

- **FR-036**: System MUST record a debit with a description, a location, its dimensions where it has
  them, a quantity, a rate, a unit, an amount, and an amount including tax.
- **FR-037**: System MUST allow a debit to be applied to exactly one bill, and MUST refuse a second
  application, naming the first.
- **FR-037a**: The one-bill rule MUST hold under two simultaneous applications of one debit, not
  only under a second attempt made after the first has finished. A debit recovered twice is money
  taken twice, so the rule belongs where concurrent writers meet it rather than only in the service
  that looks first.
- **FR-037b**: A debit MUST be applicable only to a bill that has not been issued. Applying one
  afterwards either moves a figure FR-044 froze or records a recovery the bill never made.
- **FR-038**: System MUST include an applied debit in that bill's recoveries.
- **FR-038a**: System MUST state which of the four named recovery kinds an applied debit is
  reported under, so that two compliant implementations cannot produce two different abstracts.
- **FR-039**: System MUST show, in a bill's register, every debit recorded against the project,
  including those recovered on earlier bills, because the running total is the point of a register.
- **FR-039a**: For a bill that has been issued, the register MUST be the register **as at issue**.
  Otherwise FR-039 and FR-028 contradict each other outright: a debit recorded between two
  productions of one issued bill would change a document that has been signed.
- **FR-040**: System MUST group debits under their heading rather than listing them flat.

#### The check list

- **FR-041**: System MUST carry six fixed questions in a fixed order with fixed wording, each
  answerable yes, no or not-required.
- **FR-042**: System MUST keep an unanswered question distinguishable from one answered no.
- **FR-043**: System MUST NOT refuse to issue a bill on the strength of a check-list answer, and
  MUST report the gaps.

- **FR-043a**: The gaps FR-043 requires reported MUST be reported to the caller issuing the bill
  and not only recorded against it. "MUST report the gaps" with no addressee is satisfied by
  storing them where nobody looks.

#### Lifecycle

- **FR-044**: System MUST freeze a bill's figures when it is issued and record when it went out.
- **FR-044a**: An issued bill MUST NOT be deletable. A draft MUST be abandonable (FR-002b), which
  is the only way a period is ever released.
- **FR-045**: System MUST keep what a bill stated when issued readable after any revision.
- **FR-046**: System MUST record each revision with a reason and a count.
- **FR-047**: System MUST keep a certified amount beside the billed amount and never instead of it.
- **FR-048**: System MUST leave an issued bill unaffected by a later reversal of measurement
  underlying it, and MUST make the resulting discrepancy reportable.
- **FR-048a**: FR-048's discrepancy and FR-014b's understatement MUST be answered by **one**
  comparison of a billed period's claims against that period's approved measurement as it now
  stands. Two implementations of one comparison disagree, and the first time they do nobody will
  know which of them to believe.
- **FR-049**: A bill line's provenance **is its line and its bill's period**. System MUST NOT
  create a link between a bill line and the individual daily work reports it drew on. A line names
  one line of one schedule, its bill names one period, and **one line of one schedule is billed
  once in one period** (FR-002, FR-002a, FR-007) — so the measurement it consumed is exactly the
  approved measurement for that line in that period, true by construction rather than by
  maintenance. The narrow phrasing is deliberate: "a period is billed once" is false of a *project*,
  which may be billed to its client and to several subcontractors over the same month, and the
  whole of this decision rests on the sentence being true.
- **FR-049a**: Because provenance is the period rather than a recorded link, feature 022's reversal
  guard **stays a quantity floor and is not tightened**. Recorded here as the answer to 022
  FR-020a, so the question is closed rather than left open in two features at once.
- **FR-049b**: System MUST be able to detect the one case the period cannot answer: a daily work
  report whose work date is corrected across a period boundary after the earlier period was billed.
  Rare, and detectable by comparing a billed period's claimed quantities against its approved
  measurement — which FR-014b already requires for its own reason.

#### Isolation and permissions

- **FR-050**: Every table this feature creates MUST carry the tenant isolation policy **and** be
  covered by a test exercising it under a database role that cannot bypass it. The development and
  continuous-integration role is a superuser, and a superuser is exempt from row-level security
  unconditionally, so a policy without such a test has never been in force in any test run.
- **FR-050a**: The isolation test MUST assert, **before anything else**, that the role which cannot
  bypass isolation was actually created. Every assertion after it is vacuous if it was not.
- **FR-050b**: An isolation test that cannot run MUST report as skipped and MUST NOT report as
  passed. A suite that warns and returns is counted as a pass by every summary that reads it.
- **FR-050c**: The test MUST exercise the write half of each policy as well as the read half. A
  probe that proves another company's rows are invisible says nothing about whether a row can be
  written *into* another company.
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
- **SC-003**: The abstract's arithmetic reproduces the real bill's own figures exactly. From a
  work-done amount of 18,41,686 the derived figures are two half-rate taxes of 1,65,752 each,
  retention of 92,084 and tax deducted of 36,834 — each exact to the rupee, and each wrong under a
  rate applied to the wrong base. The payable of 11,39,971 is **not** derivable from those figures
  alone: the work total of 21,73,190 less retention and tax deducted leaves 20,44,272, so the
  sample's own recoveries and remaining deductions account for 9,04,301, and they MUST be
  transcribed from the source document into the test rather than inferred. A figure back-solved to
  make a test pass tests nothing.
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
- **SC-011**: A package for a 312-line schedule is composed inside one transaction's budget and
  produced as a workbook in under ten seconds and under twenty megabytes.

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

## Decisions

All three open questions were put to the user on 2026-10-05 and answered. Recorded with their
consequences, because each answer creates an obligation that the question itself did not mention.

### D1 — The cumulative position is frozen when a bill is issued (FR-014, FR-014a, FR-014b)

Each bill stores its own up-to-date figures at issue, and the next bill reads them. The package
therefore always agrees with the signed copy the client holds, and every bill is reproducible from
itself for ever.

**Why not recompute**, which would mean no bill was ever short: a later bill's *Upto Previous* would
disagree with the signed predecessor sitting in the client's file, and reconciling a payment against
a bill whose history has moved is the one thing nobody can do. A bill is a document that was sent.

**The obligation this creates**, and the reason FR-014b exists: freezing makes it possible for a
late-approved report to belong to a period that has already been billed, so the quantity falls to
the next bill — or, if nobody notices, to no bill at all. Choosing to freeze without also requiring
the understatement to be *reportable* would trade a reconciliation problem for a revenue leak, which
is the worse of the two because it is silent.

**And reporting it is not enough** (FR-014c). Feature 022 attributes measurement by work date, so a
quantity approved after a bill went out, whose work date sits inside that bill's period, will never
appear in any later period's proposal either. It is not deferred, it is unreachable — so the
decision to freeze obliges both a report *and* a stated route back onto a bill, which is an
over-claim under FR-006 carrying the report as its reason.

### D2 — A claim may exceed the approved measurement, with a reason, flagged (FR-006, FR-006a)

The site does work the paperwork has not caught up with, and the alternative — refusing the claim —
means the work is recorded nowhere and the bill waits on a report somebody has to go and file in the
last week of a billing cycle. This is the same judgement the system already makes about over-scope:
flag, never refuse, because a refusal at entry loses the measurement entirely.

**The obligation this creates**, and the reason FR-006a exists: the stated risk of permitting it is
that the reason field becomes the route around the control. The mitigation is not a stricter rule but
**visibility** — the flag appears on the measurement sheet and is countable per bill and per project.
A reason nobody aggregates is a reason nobody reads, and an over-claim that can only be found by
inspecting lines one at a time is an over-claim that will not be found.

### D3 — Provenance is the period, not a recorded link (FR-049, FR-049a, FR-049b)

A bill line names one BOQ item; its bill names one period; a period is billed once. So what the line
consumed is exactly the approved measurement for that item in that period — true by construction,
with nothing to maintain and nothing that can drift.

**Why not explicit links**, which would give exact provenance for ever: a row per report per line per
bill is, for a 312-line tender over a year of daily reporting, hundreds of thousands of rows whose
only consumer is an audit question nobody has yet asked. The real sheets claim a **month** against a
line, not a set of days, which is why feature 022 declined to design the link from inside itself.

**The sentence this rests on had to be narrowed.** "A period is billed once" is false of a project:
one project is billed to its client and to several subcontractors over the same month, legitimately.
What is true is that **one line of one schedule is billed once in one period**, and FR-002 was
rewritten to be the rule that makes it true — the overlap check is per schedule and per counterparty
rather than per project. A decision resting on a sentence is only as sound as the sentence.

**This closes 022 FR-020a.** That requirement made deciding the linkage an obligation on this
feature, and the decision is: no linkage. 022's reversal guard therefore stays a quantity floor —
refusing a reversal that would drop a line's executed quantity below what has been billed — and is
not tightened to provenance. Written down in both places so the question is closed rather than left
open in two features at once.

**The one case the period cannot answer** is a report whose work date is corrected across a period
boundary after the earlier period was billed. FR-049b requires it to be detectable, by the same
comparison FR-014b already needs for a different reason — which is why the two requirements share a
mechanism rather than each having their own.
