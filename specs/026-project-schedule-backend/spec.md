# Feature Specification: Project Schedule & Progress

**Feature Branch**: `(not started)`

**Created**: 2026-10-05

**Status**: Draft — **specified, not planned and not built.** Written while the ground was fresh,
at the end of feature 025, so the decisions below are captured rather than rediscovered.

**Input**: 008's `TA001`–`TA020` amendment, unbuilt since September 2026, plus what features 022,
023 and 025 learned about how this project's work is actually measured.

## Why this is its own feature

Feature 008 specified a schedule and progress module as an amendment — phases, activities,
dependencies, baselines, weightage, periodic targets and variance reporting — created no tables for
it, and built none of it. Features 022 and 023 then built the measurement and the billing that sit
*above* a programme without needing one, which is why nothing has blocked.

What exists today is a programme of exactly one level: a BOQ line can carry a start date, a finish
date and a per-day target (025 FR-009), and the alert tabs classify every line into one of five
states. That is a schedule of **items**, and it is genuinely useful. What it cannot express is the
thing a project manager actually plans:

- **work that is not a BOQ line** — mobilisation, a monsoon shutdown, a client approval nobody bills
  for but everything waits on;
- **order** — that the sub-base cannot start until the earthwork at that chainage is done;
- **a commitment that stops moving** — a baseline, against which "we are three weeks late" means
  something, as opposed to a plan edited until it agrees with what happened;
- **weight** — that two activities ten per cent complete are not equally ten per cent of a project.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A project has a programme, not just dated lines (Priority: P1)

A planner groups the work into phases, each holding activities with planned start and finish dates,
and gives each activity a weight. The project then reports a single completion figure that means
something, because the parts that matter count for more.

**Why this priority**: every other story reads this one. A dependency needs two activities to link,
a baseline needs something to freeze, and a target needs something to be a target *of*.

**Independent Test**: create a phase, two activities, set weights summing to 100, and read a project
completion figure that moves differently as each advances.

**Acceptance Scenarios**:

1. **Given** a project with no programme, **When** it is read, **Then** it says so plainly rather
   than reporting nought per cent complete — those are different statements, and the second is the
   one that gets escalated.
2. **Given** an activity whose planned finish precedes its planned start, **When** it is saved,
   **Then** it is refused naming the contradiction (as 025 FR-012 does for a BOQ line).
3. **Given** activity weights that do not sum to 100, **When** a completion figure is requested,
   **Then** the figure states that it is computed over incomplete weighting rather than quietly
   normalising — a rollup over weights summing to 60 reads as a project 40% smaller than it is.

---

### User Story 2 - Order is recorded, and a violation is reported rather than refused (Priority: P1)

A planner links activities — finish-to-start, start-to-start, finish-to-finish — and when planned
dates contradict a link, the system **flags** it and keeps the dates.

**Why this priority**: a programme without order is a list of dates. But the refusal matters more
than the link: a partly-planned project must stay saveable.

**Independent Test**: link two activities, plan the successor to start before the predecessor
finishes, and find the violation reported with both activities named — and the dates still stored.

**Acceptance Scenarios**:

1. **Given** a dependency, **When** planned dates violate it, **Then** the violation is flagged and
   the dates are kept. A planner mid-way through revising a programme would otherwise be unable to
   save the half they have done.
2. **Given** a link that would close a cycle, **When** it is saved, **Then** it **is** refused — a
   cycle is not a disagreement about dates, it is a programme with no possible order.
3. **Given** a cycle spanning two phases, **When** it is attempted, **Then** it is detected. Cycle
   detection within a phase and across phases are the same check, and an implementation that only
   does the first passes every single-phase test.

---

### User Story 3 - A baseline is a commitment, and it stops moving (Priority: P1)

Once the programme is agreed, it is baselined. From then on the planned dates may be revised, and
every report says what was *committed*, what is *planned now*, and what *happened*.

**Why this priority**: without it "behind schedule" is unfalsifiable, because the plan can be edited
until it agrees with reality. This is the story that makes variance mean anything.

**Independent Test**: baseline a programme, revise an activity's planned finish, and read all three
dates back distinctly.

**Acceptance Scenarios**:

1. **Given** weights that do not sum to 100, **When** a baseline is attempted, **Then** it is
   refused, reporting the shortfall. A baseline is the one moment the arithmetic must be whole.
2. **Given** a baselined programme, **When** an activity is revised, **Then** the baseline is
   unchanged and both are readable.
3. **Given** a project with no baseline, **When** variance is requested, **Then** the answer is an
   explicit "no baseline" rather than a comparison against unset values — which reads as perfectly
   on schedule.

---

### User Story 4 - Targets are set, and actuals come from approved measurement (Priority: P2)

A manager sets a weekly or monthly target per activity, and achievement is reported from **approved
daily work reports only**.

**Why this priority**: this is where the module meets what 022 built. It is also where it could most
easily be wrong in a way that looks right.

**Independent Test**: set a target, approve a report against it, and find achievement matching the
approved figure exactly — then reverse the approval and find it taken back.

**Acceptance Scenarios**:

1. **Given** a submitted but unapproved report, **When** achievement is read, **Then** it counts for
   nothing. Approval is what moves executed quantity (022 FR-013) and this must not invent a second
   rule.
2. **Given** an activity with no target for a period, **When** the report is read, **Then** it says
   *no target set* rather than *0% achieved*.
3. **Given** an approval reversed, **When** achievement is re-read, **Then** exactly what the
   approval added has been taken back.

---

### User Story 5 - Variance, and what it is measured against (Priority: P2)

Per activity: baseline, current plan, actual, status, and slippage in days past a configured
tolerance.

**Independent Test**: an activity past its baseline finish with work outstanding reports as behind
schedule, with slippage in days.

**Acceptance Scenarios**:

1. **Given** an activity finished before its baseline date, **When** variance is read, **Then** it
   is not reported as needing attention. (025's BOQ alert states exist because the first draft of
   that classification reported completed work as overdue.)
2. **Given** a tolerance, **When** slippage is within it, **Then** no flag is raised — and the
   tolerance is configuration, never a literal.

---

### User Story 6 - The monthly report somebody actually sends (Priority: P3)

Planned against actual cumulative progress, man-days, equipment hours and material consumed,
exportable.

**Acceptance Scenarios**:

1. **Given** a month, **When** the report is produced, **Then** each figure comes from the module
   that owns it, through its exported reader — never a cross-schema query.

---

### Edge Cases

- **An activity spanning two phases**, or moved between them after baselining.
- **A weight changed after baselining** — does the baseline keep the weights it was set with? It
  must, or the committed figure changes retrospectively.
- **An activity deleted with measurement against it.**
- **A project where some activities map to BOQ lines and some do not** — the ordinary case, and the
  one that decides whether completion can be computed at all.
- **Two activities claiming the same BOQ line**, which would double-count its executed quantity.

## Requirements *(mandatory)*

### The programme

- **FR-001**: A project MUST support phases, each holding activities, each with a planned start,
  planned finish and weight.
- **FR-002**: An activity MUST be able to exist without a BOQ line. Mobilisation and a monsoon
  shutdown are programme items nobody bills.
- **FR-003**: An activity MAY name BOQ lines it measures, and **no BOQ line may be claimed by two
  activities** — the same line counted under two activities is a project reported as more complete
  than it is.
- **FR-004**: A programme that contradicts itself MUST be refused naming the contradiction.
- **FR-005**: A project with no programme MUST report that, distinctly from nought per cent.

### Order

- **FR-006**: Dependencies MUST be typed: finish-to-start, start-to-start, finish-to-finish.
- **FR-007**: A dependency violated by planned dates MUST be flagged, not refused.
- **FR-008**: A dependency closing a cycle MUST be refused, within a phase and across phases alike.

### The baseline

- **FR-009**: A programme MUST be baselinable, and a baseline MUST be immutable once set.
- **FR-010**: A baseline MUST be refused while weights do not sum to 100, reporting the shortfall.
- **FR-011**: Baseline, current plan and actual MUST be separately readable for every activity.
- **FR-012**: A project with no baseline MUST answer variance with an explicit no-baseline response.

### Targets and achievement

- **FR-013**: Periodic targets (weekly or monthly) MUST be settable per activity.
- **FR-014**: Achievement MUST be summed from **approved** daily work reports only, and MUST follow
  a reversal exactly.
- **FR-015**: An unset target MUST be reported as unset, never as nought achieved.

### Variance and reporting

- **FR-016**: Variance MUST report baseline, current, actual and status per activity.
- **FR-017**: Behind-schedule flagging MUST use a configured tolerance and report slippage in days.
- **FR-018**: An activity complete before its baseline finish MUST NOT be reported as needing
  attention.
- **FR-019**: A weighted project rollup MUST state whether it used baseline or current weights.
- **FR-020**: The monthly report MUST source man-days, equipment hours and material consumed through
  each owning module's exported reader.
- **FR-021**: All three reports MUST be exportable, asynchronously above a configured row threshold.

### Open questions, for whoever picks this up

- **FR-022**: [NEEDS CLARIFICATION: **How is an activity weighted?** By its share of contract value,
  by quantity, or typed by the planner? Value is objective and available but makes an unpriced
  activity weightless — and mobilisation, the clearest example of an activity with no BOQ line, is
  exactly the kind that matters to the programme and carries no value.]
- **FR-023**: [NEEDS CLARIFICATION: **Does a baseline freeze weights as well as dates?** If weights
  may change afterwards, the committed completion figure changes retrospectively, which makes the
  baseline unfalsifiable in the dimension it was created to fix.]
- **FR-024**: [NEEDS CLARIFICATION: **Where does an activity's percent complete come from when it
  names no BOQ line?** Typed by the planner, or derived from elapsed time? Typed is honest and
  unverifiable; derived is verifiable and frequently wrong.]

## Success Criteria *(mandatory)*

- **SC-001**: A manager can answer "are we on schedule, and by how much" without opening a
  spreadsheet.
- **SC-002**: Reported achievement reconciles **exactly** with approved daily work reports — the
  same exact-tolerance rule 022 FR-039a set for executed quantity.
- **SC-003**: Every activity is in exactly one variance state, and a completed activity is never in
  a state that asks for attention.
- **SC-004**: A programme can be revised after baselining without the baseline moving.

## Assumptions

- **Approved measurement is the only source of actuals.** 022 settled that approval moves executed
  quantity; this feature reads that and invents no second rule.
- **This module owns no money.** Progress is quantity and time; value belongs to the P&L and to
  billing, both of which exist.
- **Flag rather than block.** 008's own TA006 chose this and 025 followed it for BOQ programmes: a
  partly-planned project must stay saveable.

## Out of Scope

- **Resource levelling, critical-path computation and Gantt rendering.** Order and variance are not
  a scheduling engine, and saying so now is cheaper than discovering it mid-build.
- **Any change to how daily work is recorded or approved** (022), **or to how a bill is composed**
  (023, 025).
- **The BOQ line's own programme** (025 FR-009), which stays where it is. This feature must decide
  how the two relate — see FR-003 — not replace it.
