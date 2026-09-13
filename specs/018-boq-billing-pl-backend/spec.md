# Feature Specification: BOQ, Billing and Project P&L

**Feature Branch**: `018-boq-billing-pl`

**Created**: 2026-09-13

**Status**: Draft

**Input**: Client requirements spreadsheet, Notes 12, 13 and 15.

**Surfaces**: buildcore-api (BOQ-linked billing, measurement records, project cost roll-up) and
buildcore-web (billing entry sheets, project P&L and budget screens).

## The gap in one sentence

The project already has a BOQ — task groups and task items — and already has work orders, RA bills
and a budget; but **client billing is untethered from all of it**, carrying only a description, an
amount, a date and a status, so nothing in the system can answer whether what was billed matches
what was measured, or what a project has actually earned against what it has spent.

The client says this plainly in Note 12: *"Projects Menu have required so much changes for entry of
every project BOQ and Create a Separate wing for generate of vendor bill and Client Bill also for
reconsillation according to the BOQ Work order amount and Qty for P&L and Budget Summary."*

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Client bills are raised from the BOQ, not typed from memory (Priority: P1)

A billing engineer raises a client bill by selecting BOQ lines and entering the quantity executed
this period against each. The system prices them at the BOQ rate, totals them, and knows how much of
each line's contracted quantity has now been billed cumulatively. Over-billing a line is visible at
the moment it is attempted, not at final reconciliation.

**Why this priority**: This is the core of Note 12 and everything else in this feature depends on it.
A client bill that is a free-text amount cannot be reconciled against anything.

**Independent Test**: Raise a bill against a project with a BOQ, confirm the total derives from
quantity times rate, and confirm cumulative billed quantity per line is correct after two bills.

**Acceptance Scenarios**:

1. **Given** a project with a BOQ, **When** a client bill is raised, **Then** its lines reference BOQ
   items and its value is computed from executed quantity and BOQ rate.
2. **Given** a BOQ line already billed in an earlier period, **When** a new bill is raised for it,
   **Then** the cumulative billed quantity to date is shown before the new quantity is entered.
3. **Given** a quantity that would exceed the BOQ contracted quantity for a line, **When** it is
   entered, **Then** the excess is flagged and the bill cannot be submitted without an explicit
   deviation reason.
4. **Given** a submitted client bill, **When** the BOQ rate for one of its lines is later revised,
   **Then** the submitted bill retains the rate it was billed at.
5. **Given** a project with no BOQ, **When** a client bill is attempted, **Then** it is refused and
   the missing BOQ is named.

---

### User Story 2 - Subcontractor bills are measured against the BOQ they were awarded (Priority: P1)

A subcontractor's RA bill is entered as measured quantities against the BOQ lines in their work
order, not as a single figure. Each bill shows quantity this period, quantity to date, and what
remains of the awarded scope. Retention, deductions and advances recovered are applied per bill and
visible.

**Why this priority**: Note 13 asks for exactly this, and it is the other half of the reconciliation
— without it the project knows its revenue but not its direct cost.

**Independent Test**: Enter two RA bills against one subcontractor work order and confirm
quantity-to-date, balance scope and deductions are correct after each.

**Acceptance Scenarios**:

1. **Given** a subcontractor work order carrying BOQ lines, **When** an RA bill is entered, **Then**
   its lines reference those BOQ lines with quantity measured this period.
2. **Given** an RA bill, **When** it is viewed, **Then** quantity to date and remaining awarded
   quantity are shown per line.
3. **Given** measured quantity exceeding the awarded quantity for a line, **When** submitted, **Then**
   it is flagged and requires an explicit reason.
4. **Given** an RA bill with retention and recovery of an advance, **When** it is totalled, **Then**
   gross, each deduction and net payable are shown separately.
5. **Given** an RA bill under approval, **When** its quantities are edited, **Then** approvals already
   given are invalidated.

---

### User Story 3 - What the project earned against what it cost (Priority: P1)

A project manager opens the project and sees, for a chosen month and cumulatively: billed to client,
certified subcontractor cost, labour cost, material issued, plant and machinery cost, and the margin
between them — against the project budget.

**Why this priority**: Note 12 names P&L and budget summary as the point of the exercise, and Note 15
asks for per-project monthly expense against what was billed. This is the answer the client is
actually asking for; US1 and US2 exist to make it truthful.

**Independent Test**: For a project with client bills, RA bills, labour payment sheets and material
issues in one month, confirm every cost line on the summary traces to those source records.

**Acceptance Scenarios**:

1. **Given** a project with activity in a month, **When** its summary is opened, **Then** revenue and
   each cost category for that month and cumulative to date are shown with the budget alongside.
2. **Given** a cost figure on the summary, **When** it is opened, **Then** the source records
   comprising it are listed.
3. **Given** a month with no activity in a category, **When** the summary is viewed, **Then** the
   category shows zero rather than being omitted.
4. **Given** a project over budget in a category, **When** the summary is viewed, **Then** the
   variance is visible without calculation by the reader.
5. **Given** labour costs from muster rolls and payment sheets, **When** the monthly labour figure is
   computed, **Then** it reconciles to the sum of that month's approved payment sheets for the
   project.

---

### User Story 4 - Group-level view across projects (Priority: P2)

A director sees every project's billed, spent and margin position on one screen, and the totals
across the company.

**Why this priority**: Sheet row 2 (Group Dashboard) asks for the P&L summary of total projects
against total bills and expenses at main board level. P2 because it is an aggregation of US3 — it
cannot be right before US3 is.

**Acceptance Scenarios**:

1. **Given** several active projects, **When** the group view is opened, **Then** each project's
   revenue, cost and margin appear with a company total.
2. **Given** a project the user may not see, **When** the group view is opened, **Then** that project
   is excluded from both the list and the totals.
3. **Given** the group view, **When** a project is selected, **Then** its own summary opens.

### Edge Cases

- A BOQ is revised mid-project after bills have been raised against the old version.
- A variation order adds scope not in the original BOQ. The specification must say whether variations
  are BOQ lines, a separate schedule, or refused.
- A client certifies less than was billed. The difference must be visible and must not silently
  vanish from cumulative billed quantity.
- A subcontractor's awarded BOQ differs from the client BOQ for the same work — different rates,
  sometimes different line structure. This is normal and the reconciliation must not assume they
  match line for line.
- Material issued to a project is returned. The cost roll-up must handle negatives.
- A project spans a financial year boundary.
- Two billing engineers raise bills for the same BOQ lines concurrently.
- Labour cost for a month where the payment sheet is frozen but not yet disbursed.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST allow a client bill to be composed of lines referencing BOQ items with
  quantity executed in the period.
- **FR-002**: System MUST compute client bill line value from executed quantity and the BOQ rate in
  force when the bill is raised, and MUST retain that rate on the bill thereafter.
- **FR-003**: System MUST maintain and display cumulative billed quantity per BOQ line.
- **FR-004**: System MUST flag a billed quantity exceeding the contracted quantity for a line, and
  MUST require an explicit reason before such a bill can be submitted.
- **FR-005**: System MUST record client certification against a raised bill where the certified
  amount differs from the billed amount, retaining both.
- **FR-006**: System MUST allow a subcontractor RA bill to be composed of measured lines referencing
  the BOQ lines in that subcontractor's work order.
- **FR-007**: System MUST show, per RA bill line, quantity this period, quantity to date and
  remaining awarded quantity.
- **FR-008**: System MUST apply and display retention, deductions and advance recovery per RA bill,
  showing gross, deductions and net payable separately.
- **FR-009**: System MUST invalidate approvals on an RA bill whose quantities are edited after
  approval.
- **FR-010**: System MUST produce, per project and per month, revenue billed and cost by category
  covering at least subcontractor, labour, material and plant.
- **FR-011**: System MUST present each project's monthly and cumulative position against its budget,
  with variance shown.
- **FR-012**: Users MUST be able to open any figure on the project summary and see the source records
  that comprise it.
- **FR-013**: System MUST reconcile the monthly labour cost figure to the approved labour payment
  sheets for that project and month.
- **FR-014**: System MUST present a group view across projects with per-project and total position,
  respecting the viewer's project and company visibility.
- **FR-015**: System MUST NOT alter the meaning of existing work order, RA bill or budget records in
  a way that changes previously reported figures without a recorded migration.
- **FR-016**: System MUST record the actor and time for every bill raised, edited, certified or
  approved.

### Non-Functional Requirements

- **NFR-001**: The project summary for a project with 12 months of activity MUST render within 3
  seconds at the 95th percentile. **Not verified today**; no equivalent roll-up exists to measure.
- **NFR-002** *(Note 23)*: The group view MUST remain within that budget with 60 concurrent users.
  **Not verified today** — see 016 NFR-001 for why the current deployment would not meet it.

### Key Entities

- **BOQ Line**: An item of contracted work — description, unit, contracted quantity, rate. Already
  exists; this feature makes it the anchor for billing.
- **Client Bill**: A periodic bill to the client, composed of lines referencing BOQ lines with
  executed quantity and the rate applied, plus its certified outcome.
- **Subcontractor Measurement**: A line on an RA bill referencing an awarded BOQ line with quantity
  measured in the period.
- **Project Cost Position**: The derived monthly and cumulative view of revenue and cost by category
  for a project, against budget. Derived, not entered.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of client bills raised after this feature reference BOQ lines; none can be raised
  as a free-text amount.
- **SC-002**: For any BOQ line, cumulative billed quantity equals the sum of executed quantities on
  its bills, verified across a full project.
- **SC-003**: Every cost figure on a project summary traces to source records that sum to it exactly.
- **SC-004**: The monthly labour cost on the summary equals the sum of approved labour payment sheets
  for that project and month, to the rupee.
- **SC-005**: A project manager can state a project's month margin within 30 seconds of opening the
  project, without exporting anything.
- **SC-006**: Over-billing of a BOQ line is impossible without a recorded reason, across all entry
  paths.

## Assumptions

- The existing BOQ task group and task item structure is adequate as the billing anchor and does not
  need restructuring. If the client's BOQs are deeper than two levels, this assumption fails and the
  structure must be revisited before planning.
- The client BOQ and each subcontractor's awarded BOQ are separate schedules that may differ in rate
  and structure. Reconciliation is at project and category level, not line-for-line between them.
- "P&L" here means project contribution — revenue billed less direct cost. Company overheads,
  depreciation and tax are out of scope; this is a project control report, not a statutory account.
- Material cost is taken from issues to the project at the weighted average rate already maintained
  by inventory, not from purchase invoices.
- Plant cost is taken from hire bills and internal hire rates already recorded.
- Existing project budget records remain the budget baseline; this feature reports against them
  rather than replacing them.

### Needing the client's decision

- **[NEEDS CLARIFICATION: how are variations and extra items handled?]** Almost every construction
  project bills work outside the original BOQ. Whether a variation becomes a new BOQ line, a separate
  schedule with its own approval, or is refused entirely, changes the data model and cannot be
  guessed.
- **[NEEDS CLARIFICATION: is retention a percentage held per bill, and is it released on a schedule?]**
  Retention terms vary by contract; the rule must come from the client's actual contracts.
- **[NEEDS CLARIFICATION: does client certification enter the system?]** If the client certifies less
  than billed, somebody must record that. Whether the company tracks certification or only billing
  determines whether FR-005 is needed at all.
