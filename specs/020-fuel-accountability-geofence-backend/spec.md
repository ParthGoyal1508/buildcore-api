# Feature Specification: Fuel Accountability and Per-Employee Geofence

**Feature Branch**: `020-fuel-accountability-geofence`

**Created**: 2026-09-13

**Status**: Draft

**Input**: Client requirements spreadsheet, Notes 14 and 16.

**Surfaces**: buildcore-api (fuel variance consequences, deduction records, employee geofence
assignment and punch validation) and buildcore-web (fuel exception review, geofence assignment).

## Where each note already stands

**Note 14 is half built.** Equipment categories already carry a `fuelBenchmark`, and every fuel entry
already computes a `variancePercent` and raises a `varianceAlert`. The system already knows which
vehicle is drinking more diesel than it should. What it does not do is the part the client actually
asked for: *"then it can given alert and make deduction from Bill for Hiring and Deduct Salary of
Operator of that Vehicle."* Detection without consequence is where this stands today.

**Note 16 is site-shaped, not employee-shaped.** Geofences exist on sites — a centre and a radius,
and punches are validated against them. The client wants the fence fixed per employee: *"we can fix
every employee geo fencing location then other location does not capture attendance."*

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A thirsty machine costs its hirer money (Priority: P1)

A hired machine consistently consumes more diesel than its benchmark. The existing variance alert is
reviewed, and where the review confirms the overconsumption is the hirer's responsibility, a
deduction is raised against that machine's hire bill. The deduction appears on the bill with its
reason and the fuel entries that justify it, so the vendor can be shown why.

**Why this priority**: It is the first consequence the client names, it recovers money directly, and
it acts on data the system already produces.

**Independent Test**: Record fuel entries breaching the benchmark for a hired machine, review them,
raise a deduction, and confirm it appears on the hire bill with its evidence.

**Acceptance Scenarios**:

1. **Given** fuel entries for a hired machine breaching its benchmark over a period, **When** the fuel
   exception review is opened, **Then** the machine appears with its actual average, its benchmark
   and the shortfall quantified in both fuel and money.
2. **Given** a confirmed overconsumption, **When** a deduction is raised against the hire bill,
   **Then** the bill shows the deduction, its reason, and the fuel entries supporting it.
3. **Given** a raised deduction, **When** the hire bill is totalled, **Then** the net payable reflects
   it.
4. **Given** a reviewer decides the variance is not the hirer's fault, **When** they dismiss it,
   **Then** no deduction is raised and the dismissal, its author and its reason are recorded.
5. **Given** a machine that is owned rather than hired, **When** it breaches its benchmark, **Then**
   no hire deduction is possible and the exception routes to US2 only.

---

### User Story 2 - The operator is accountable for the machine they run (Priority: P2)

Where a review finds the operator responsible, a recovery is raised against that operator's salary.
It flows through payroll as a recorded deduction with its reason, visible to the employee on their
slip, and it requires approval before it reduces anyone's pay.

**Why this priority**: The client asks for it in the same sentence as US1. It is P2 because deducting
an employee's wages is a materially heavier act than deducting a vendor's invoice, and it must not be
automatic. It depends on the same review.

**Independent Test**: Raise an operator recovery from a confirmed fuel exception, approve it, and
confirm it appears as a deduction on that employee's payroll and salary slip.

**Acceptance Scenarios**:

1. **Given** a confirmed fuel exception attributed to an operator, **When** a recovery is raised,
   **Then** it is recorded against that employee with its amount, reason and supporting fuel entries.
2. **Given** a raised recovery, **When** it has not been approved, **Then** it does not affect payroll.
3. **Given** an approved recovery, **When** the next payroll run is computed, **Then** it appears as a
   named deduction on that employee's line and on their salary slip.
4. **Given** a recovery exceeding a defined proportion of the employee's wages, **When** it is raised,
   **Then** it is capped or spread as specified by the clarification below.
5. **Given** a machine operated by several people across the period, **When** a recovery is raised,
   **Then** the system requires the responsible operator to be named rather than guessing.
6. **Given** an employee disputes a recovery, **When** it is reversed, **Then** the reversal is
   recorded and the amount returned in the following run.

---

### User Story 3 - An employee punches where they are supposed to be (Priority: P1)

An employee is assigned the location they work at. Their punch is accepted only inside that fence.
An employee who moves between sites has their assignment changed, and the change is recorded.

**Why this priority**: Note 16 says geofencing is required *"must"*, and the client's intent is that
attendance cannot be marked from anywhere convenient. It is P1 because it directly protects
attendance integrity, which everything downstream — payroll, labour cost, project P&L — rests on.

**Independent Test**: Assign an employee to a location, attempt a punch inside and outside it, and
confirm acceptance and refusal respectively, with the refusal reaching the exception queue.

**Acceptance Scenarios**:

1. **Given** an employee assigned to a location, **When** they punch inside its fence, **Then** the
   punch is accepted.
2. **Given** the same employee, **When** they punch outside it, **Then** the punch is not accepted as
   present and is raised as an exception for review.
3. **Given** an employee with no location assigned, **When** they punch, **Then** the behaviour is as
   specified by the clarification below.
4. **Given** an employee transferred to another site, **When** their assignment is changed, **Then**
   the change, its author and its effective date are recorded, and punches are validated against the
   new location from that date.
5. **Given** an employee whose work is genuinely mobile, **When** they are marked as such, **Then**
   their punches are not refused for location, and this exemption is visible and attributable.
6. **Given** a punch refused for location, **When** the employee views their own attendance, **Then**
   they can see it was refused and why.

### Edge Cases

- GPS accuracy on a phone in a basement or under a slab is poor enough to place a worker outside a
  fence they are standing in the middle of. A hard refusal without a review path would deny pay for
  a day actually worked.
- A site's own geofence and an employee's assigned location disagree.
- An employee legitimately works at two sites in one day.
- A fuel benchmark is set unrealistically, generating deductions against every machine of that
  category.
- A machine's benchmark is changed after entries were recorded against the old one.
- An operator leaves the company with an unrecovered fuel deduction outstanding.
- Diesel is filled into a machine and then transferred to another.
- A deduction is raised against a hire bill already approved for payment.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST present fuel variance exceptions for review, showing actual average,
  benchmark, and the shortfall expressed in both quantity and money.
- **FR-002**: System MUST allow a reviewer to attribute a confirmed exception to the hirer, to the
  operator, to both, or to neither.
- **FR-003**: System MUST allow a deduction to be raised against a hire bill from a confirmed
  exception, carrying its reason and the fuel entries supporting it.
- **FR-004**: System MUST reflect such a deduction in the hire bill's net payable.
- **FR-005**: System MUST allow a recovery to be raised against an operator's salary from a confirmed
  exception, carrying its reason and supporting entries.
- **FR-006**: System MUST NOT apply an operator recovery to payroll until it has been approved.
- **FR-007**: System MUST show an applied recovery as a named deduction on the payroll line and the
  salary slip.
- **FR-008**: System MUST record the dismissal of an exception with its author and reason.
- **FR-009**: System MUST require the responsible operator to be named explicitly when a machine had
  more than one operator in the period.
- **FR-010**: System MUST support reversal of a raised or applied recovery, recording the reversal.
- **FR-011**: System MUST allow a location to be assigned to an employee, and MUST record every
  change to that assignment with author and effective date.
- **FR-012**: System MUST validate an employee's punch against their assigned location.
- **FR-013**: System MUST raise a punch outside the assigned location as an exception rather than
  discarding it.
- **FR-014**: System MUST support marking an employee as mobile, exempting them from location
  validation, and MUST make that exemption visible and attributable.
- **FR-015**: Employees MUST be able to see that their own punch was refused for location and why.
- **FR-016**: System MUST NOT change the existing site-level geofence behaviour for employees who
  have no individual assignment, except as decided by the clarification below.
- **FR-017**: System MUST retain the existing fuel benchmark and variance alert behaviour unchanged;
  this feature adds consequences, not detection.

### Non-Functional Requirements

- **NFR-001** *(Note 23)*: Punch validation including location checking MUST complete within 2
  seconds at the 95th percentile with 150 concurrent users punching in a 15-minute window. **Not
  verified today.** This is the specific peak the client describes, and the current deployment has
  not been load tested; see 016 NFR-001.
- **NFR-002** *(Note 25)*: The punch screen MUST remain fully operable on Android and iOS at 320px.
  This surface is already held to a mobile standard, so this is a regression guard rather than new
  scope.

### Key Entities

- **Fuel Exception**: A confirmed or pending finding that a machine consumed beyond its benchmark
  over a period, with the entries comprising it and its attribution.
- **Hire Deduction**: An amount withheld from a hire bill, its reason and its supporting evidence.
- **Operator Recovery**: An amount recovered from an employee's wages, its reason, its approval
  state, and its reversal if any.
- **Employee Location Assignment**: The location an employee's attendance is validated against, its
  effective date, and its history.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Every fuel variance alert reaches a recorded review outcome — deduction, recovery, both
  or dismissal — with none left unreviewed beyond the review period.
- **SC-002**: A hire deduction raised from an exception appears on the hire bill and changes its net
  payable by exactly the deducted amount.
- **SC-003**: No operator recovery reaches payroll without a recorded approval.
- **SC-004**: 100% of punches are validated against an assigned location or an explicit mobile
  exemption; none bypass both.
- **SC-005**: Every punch refused for location appears in the exception queue and is visible to the
  employee it belongs to.
- **SC-006**: An employee transferred between sites has punches validated against the correct location
  from the effective date, verified across the boundary.

## Assumptions

- The existing per-site geofence remains and continues to serve labour attendance marked by
  supervisors. Per-employee assignment is layered on for staff, not a replacement.
- Location exceptions route into the approval chain specified by feature 016 rather than introducing
  a second review mechanism. If 016 is not built, this feature needs its own single-step review and
  should say so at planning.
- Fuel benchmarks stay on the equipment category, as today. Per-machine benchmarks are not assumed;
  if the client needs them per vehicle, that is a small extension but must be stated.
- Operator recoveries use the existing payroll deduction mechanism rather than a new one.
- The money value of a fuel shortfall is computed from the fuel entries' own recorded rates.

### Needing the client's decision

- **[NEEDS CLARIFICATION: what happens when an employee has no assigned location?]** The options are
  to fall back to the site geofence as today, to refuse the punch, or to accept it as an exception.
  Refusing would break attendance for every existing employee on the day this ships, so the assumed
  default is to fall back to today's behaviour — but the client's *"must"* may mean otherwise.
- **[NEEDS CLARIFICATION: is there a cap on operator salary recovery?]** Indian wage law constrains
  deductions from wages. A cap, or spreading a recovery across months, is likely required; the limit
  must come from the client or their compliance advisor, not from this specification.
- **[NEEDS CLARIFICATION: what GPS accuracy is acceptable before a punch is treated as unlocatable?]**
  A phone reporting a 500-metre accuracy radius cannot meaningfully be inside or outside a 100-metre
  fence. The threshold decides how many honest workers get refused.
