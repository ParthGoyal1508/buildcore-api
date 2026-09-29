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

## Clarifications

### Session 2026-09-16

Raised against the client's re-stated requirement list, item 2: *"Block attendance marking if
location or photo verification fails."* This reverses the answer FR-013 originally carried.

- Q: FR-013 raises an out-of-fence punch as an exception rather than discarding it. The client asks for the marking to be *blocked*. Which holds? → A: **Blocked, with nothing recorded.** A punch that fails location validation is refused at the point of marking. No attendance record is created, not even a pending or unapproved one, so there is no state for a later process to mistake for a present day. The client was asked directly and chose this over recording the refusal for review.
- Q: The client names *photo* verification alongside location. Does a face mismatch block identically? → A: **Yes, identically.** Both are identity-and-place checks on the same act, and a punch failing either is refused on the same terms. Face matching itself is unchanged — it already exists from feature 003; what changes is that its failure is now terminal for that punch rather than advisory.
- Q: If nothing is recorded, what happens to a day the employee genuinely worked but could not punch for — GPS drift in a basement, a camera that would not focus? → A: **A manual attendance correction, raised by their supervisor.** That correction is what travels feature 016's employer → HR → director chain; it is the audited recovery route, and every such modification is logged under 016's attendance-modification requirements. The blocked punch leaves no trace, so the correction stands on the supervisor's assertion rather than on a refused record — which is precisely why the logging matters.
- Q: Feature 016's User Story 1 is built on routing refused punches through the approval chain. With nothing recorded, what is left for it to route? → A: **The manual correction, not the punch.** 016 US1 is re-aimed rather than retired: its subject becomes the supervisor-raised correction for a day with no accepted punch. Recorded in 016's own Clarifications for the same date. The chain, its three levels and its attribution are unchanged; only what enters it changes.
- Q: FR-013a promises a refused day reads as "no punch" to *every later reader*, naming three by example. Which readers does it actually bind? → A: **An enumerated list, and the guarantee is structural.** Raised by the requirements-quality review of this decision (`checklists/refusal.md` CHK001–CHK005), which found this the one requirement here that cannot be discharged by inspection — and the one whose failure pays somebody for a refused day. The readers are now listed in FR-013a, and the list surfaced three nobody had named: absence counting, leave-balance accrual, and shift-compliance reporting. Each had a different plausible answer for a refused day. FR-013d then makes the guarantee structural rather than per-reader: because a refusal is never stored where attendance is stored, a reader that has never heard of refusals is correct by default, and one written next year inherits that.
- Q: Does the employee learn their punch was refused? → A: **At the moment of the attempt, and only then.** FR-015 previously promised the refusal would be visible in their own attendance later; with nothing recorded there is nothing there to see. The refusal and its reason are shown in the response to the attempt, so the employee knows to ask their supervisor rather than assuming the day was captured.
- Q: What happens when an employee has no assigned location? → A: **Fall back to the site geofence, as today.** No employee carries an individual assignment on the day this ships, so refusing an unassigned punch would refuse everyone's attendance at once. The per-employee fence is layered over the site fence rather than replacing it, and an employee without an assignment is validated the way they are validated now.
- Q: FR-014 exempts a mobile employee from location validation and says nothing about the face check. Does the exemption cover both? → A: **Location only.** Raised by the requirements-quality review (`checklists/refusal.md` CHK025) and material under the hard block, where a mismatch now costs a day. The two checks answer different questions — mobility says where a person legitimately works, and the face check says who is holding the phone — and nothing about working across sites makes an impersonated punch acceptable. A mobile employee is refused for a face mismatch exactly as anyone else is.
- Q: What GPS accuracy is acceptable before a punch is treated as unlocatable? → A: **A Super Admin setting, not a fixed figure.** The threshold is a company-level configuration under `COMPANY_SETTINGS`, changeable without a deploy, because the right number differs between an open site and a basement slab and the people who know which is which are not the people who deploy. It defaults to **50 metres** — the figure feature 013 already uses for labour muster fixes — and the rule inside it is benefit of the doubt: a punch counts as inside when its distance is within the fence radius plus its own reported accuracy, and is refused as unlocatable when the reported accuracy exceeds the configured maximum. The default rule was chosen alongside the setting; the client chose configurability over the fixed number, not a different rule.
- Q: What face-match confidence refuses a punch? → A: **Unchanged from feature 003.** The decision of this session changes the consequence of a mismatch, not the matching. The existing threshold is the documented default of the matching mechanism 003 selected, the figure its published accuracy numbers are quoted at, and it is already loosenable per deployment for sites with harsh outdoor lighting. Re-tuning it because the consequence hardened would change two variables at once and make a rise in refusals unattributable.

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

### User Story 3 - An employee punches where they are supposed to be, or not at all (Priority: P1)

An employee is assigned the location they work at. Their punch is accepted only inside that fence,
and only when their face matches. A punch that fails either check is refused outright — the employee
is told why, and no attendance is recorded. An employee who moves between sites has their assignment
changed, and the change is recorded.

**Why this priority**: Note 16 says geofencing is required *"must"*, restated by the client as a
block rather than a review. It is P1 because it directly protects attendance integrity, which
everything downstream — payroll, labour cost, project P&L — rests on.

**Independent Test**: Assign an employee to a location, attempt a punch inside it, outside it, and
with a mismatched face; confirm the first is accepted and the other two are refused with no
attendance record created by either.

**Acceptance Scenarios**:

1. **Given** an employee assigned to a location, **When** they punch inside its fence, **Then** the
   punch is accepted.
2. **Given** the same employee, **When** they punch outside it, **Then** the punch is refused, the
   reason is returned to them, and no attendance record of any state is created.
2a. **Given** an employee inside their assigned fence, **When** their face does not match their
   enrolment, **Then** the punch is refused on the same terms — reason returned, nothing recorded.
2b. **Given** a punch refused for either reason, **When** that day's attendance is later read by
   anyone, **Then** it shows no punch at all rather than a rejected or pending one.
2c. **Given** a day with no accepted punch, **When** the employee's supervisor raises a manual
   attendance correction for it, **Then** the correction enters feature 016's approval chain and is
   logged with its author.
3. **Given** an employee with no location assigned, **When** they punch, **Then** the punch is
   validated against the site's geofence exactly as it is today.
3a. **Given** a punch whose reported location accuracy exceeds the configured maximum, **When** it is
   submitted, **Then** it is refused as unlocatable and nothing is recorded.
3b. **Given** a punch just outside the fence radius but within it once its reported accuracy is
   allowed for, **When** it is submitted, **Then** it is accepted.
3c. **Given** a Super Admin who raises the maximum acceptable accuracy in settings, **When** the same
   previously unlocatable punch is retried, **Then** it is judged against the new threshold with no
   deployment.
4. **Given** an employee transferred to another site, **When** their assignment is changed, **Then**
   the change, its author and its effective date are recorded, and punches are validated against the
   new location from that date.
5. **Given** an employee whose work is genuinely mobile, **When** they are marked as such, **Then**
   their punches are not refused for location, and this exemption is visible and attributable.
5a. **Given** the same mobile employee, **When** their face does not match their enrolment, **Then**
   the punch is refused exactly as it would be for any other employee — the exemption covers location
   and not identity.
6. **Given** a punch refused for location or face, **When** the refusal is returned, **Then** the
   employee is told which check failed and what to do about it, at the moment of the attempt.

### Edge Cases

- GPS accuracy on a phone in a basement or under a slab is poor enough to place a worker outside a
  fence they are standing in the middle of. The client has chosen a hard refusal, so this worker's
  only route to being paid is a supervisor-raised manual correction. FR-012a and FR-012b bound how
  much of that traffic the system generates: the accuracy allowance gives the benefit of the doubt,
  and a Super Admin can widen it for a site where reception is genuinely bad.
- A Super Admin sets the maximum acceptable accuracy so high that the allowance swallows the fence
  entirely — a 500-metre tolerance on a 100-metre fence accepts a punch from the next village. The
  setting is a company decision and the specification does not cap it, but its effect on FR-012a is
  worth stating plainly rather than discovering.
- A camera fails, a face is masked by a helmet and dust, or the light is wrong. Under a hard refusal
  this is indistinguishable from an impersonation attempt, and costs the same day.
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
- **FR-012**: System MUST validate an employee's punch against their assigned location, and MUST
  validate the punch photo against the employee's enrolled face.
- **FR-013**: System MUST refuse a punch that fails either check, and MUST create no attendance
  record for it — not a pending, unapproved, or rejected one (Clarifications, 2026-09-16). This
  reverses the exception-for-review behaviour this requirement previously specified.
- **FR-013a**: A punch refused under FR-013 MUST leave that day reading as no punch at all. The
  readers this binds are enumerated rather than exemplified (Clarifications, 2026-09-16), because a
  guarantee over an unnamed set cannot be discharged:
  1. Payroll calculation, and the payment sheet it produces.
  2. The administrative daily and monthly attendance views.
  3. The employee's own attendance history.
  4. Labour cost and project expense roll-ups.
  5. Absence counting and leave-balance accrual.
  6. Late-coming, early-departure and shift-compliance reporting.
  7. Any export or report derived from attendance.

  Each MUST read a refused day as a day with no punch — not as absent-by-exception, not as pending,
  not as anything requiring interpretation.
- **FR-013d**: The guarantee in FR-013a MUST hold **structurally**, not by each reader excluding
  refusals: a refusal MUST NOT be stored where attendance is stored. A reader that knows nothing about
  refusals MUST therefore be correct by default, so that a reader added after this feature inherits the
  guarantee without being told about it.
- **FR-013b**: System MUST return the failing check and its reason to the employee in the response to
  the refused attempt.
- **FR-012a**: System MUST treat a punch as inside its fence when the distance to the fence centre
  is within the fence radius plus the punch's own reported location accuracy, and MUST refuse the
  punch as unlocatable when that reported accuracy exceeds the configured maximum
  (Clarifications, 2026-09-16).
- **FR-012b**: The maximum acceptable location accuracy MUST be configurable per company by a caller
  holding `COMPANY_SETTINGS`, changeable without a deployment, defaulting to 50 metres. A threshold
  that can only be changed by deploying is a threshold the people who know the sites cannot change.
- **FR-012c**: System MUST validate the punch photo against the employee's enrolled face at the
  confidence threshold established by feature 003, unchanged by this feature. A photo in which no
  face can be detected MUST be refused under FR-013 on the same terms as a mismatch.
- **FR-013c**: System MUST record the refusal for operational and security purposes — who attempted,
  when, where, and which check failed — separately from attendance, so that a pattern of refusals is
  reviewable without any of them being attendance. This is a log, not a reviewable item, and nothing
  in it can be approved into a present day.
- **FR-014**: System MUST support marking an employee as mobile, exempting them from location
  validation, and MUST make that exemption visible and attributable. The exemption MUST NOT extend to
  face validation: a mobile employee's punch MUST still be refused for a face mismatch under FR-013
  (Clarifications, 2026-09-16). Mobility is a claim about *where* someone works; the face check
  establishes *who* is punching, and nothing about working across sites makes an impersonated punch
  more acceptable.
- **FR-015**: Employees MUST be told at the moment of the attempt that their punch was refused and
  which check refused it. A refusal is not retrievable from their attendance afterwards, because
  FR-013 records nothing there (Clarifications, 2026-09-16).
- **FR-015a**: A day with no accepted punch MUST be correctable by the employee's supervisor through
  a manual attendance correction, which MUST enter feature 016's approval chain and MUST be logged
  under 016's attendance-modification requirements. This is the only route by which a genuinely
  worked day survives a refused punch.
- **FR-016**: System MUST NOT change the existing site-level geofence behaviour for employees who
  have no individual assignment: such a punch MUST be validated against the site's fence as it is
  today (Clarifications, 2026-09-16). The per-employee fence is layered over the site fence, never a
  replacement for it.
- **FR-017**: System MUST retain the existing fuel benchmark and variance alert behaviour unchanged;
  this feature adds consequences, not detection.

### Non-Functional Requirements

- **NFR-001** *(Note 23)*: Punch validation including location checking MUST complete within 2
  seconds at the 95th percentile with 150 concurrent users punching in a 15-minute window. **Still
  unverified, and now known to be the binding risk.** A read-only load test on 2026-09-17 (recorded
  in full under 016 NFR-001) established that the production free-tier instance sustains 170–190
  requests per second with zero errors, and that the request *volume* this requirement describes —
  0.17 per second averaged over the window, 2.5 per second in a one-minute burst — is nowhere near
  that ceiling.

  That result narrows the risk rather than clearing it. The measured route touches no database and
  does no work; a punch decodes and resizes an image, runs face matching on the WASM/CPU backend,
  encrypts a blob and writes rows. On 0.1 shared CPU that path is CPU-bound, so its cost per request
  — not the arrival rate — decides whether this requirement holds, and concurrency makes a CPU-bound
  path worse. Verification therefore needs the punch path itself measured, not more read traffic.

  The hard refusal decided on 2026-09-16 raises the stakes: under it a punch that is too slow to
  complete is not a delayed punch but an absent one, with the employee's only recourse a supervisor
  correction.
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
- **SC-005**: No punch failing location or face validation produces an attendance record of any
  state, verified across every punch path; and every such refusal returns its reason to the employee
  and appears in the refusal log.
- **SC-005d**: A refused day reads as a day with no punch through **each of the seven readers
  enumerated in FR-013a**, verified reader by reader rather than at the write. The write is one
  assertion; the guarantee is seven.
- **SC-005a**: Every day lost to a refused punch that was genuinely worked is recoverable through a
  logged manual correction, with the correction's author recorded in all cases.
- **SC-005b**: The maximum acceptable location accuracy can be changed by a Super Admin and takes
  effect on the next punch with no deployment, verified by changing it and retrying a punch that the
  previous value refused.
- **SC-005c**: An employee with no individual location assignment punches successfully against their
  site's fence, verified on a database where no assignment exists — the state this feature ships into.
- **SC-006**: An employee transferred between sites has punches validated against the correct location
  from the effective date, verified across the boundary.

## Assumptions

- The existing per-site geofence remains and continues to serve labour attendance marked by
  supervisors. Per-employee assignment is layered on for staff, not a replacement.
- Manual attendance corrections — not refused punches — route into the approval chain specified by
  feature 016, rather than introducing a second review mechanism. If 016 is not built, a refused
  punch has no recovery route at all and this feature must not ship its hard refusal until one
  exists; that ordering constraint belongs in planning.
- Face matching behaviour itself is unchanged from feature 003. This feature changes only the
  consequence of a mismatch, from advisory to terminal.
- Fuel benchmarks stay on the equipment category, as today. Per-machine benchmarks are not assumed;
  if the client needs them per vehicle, that is a small extension but must be stated.
- Operator recoveries use the existing payroll deduction mechanism rather than a new one.
- The money value of a fuel shortfall is computed from the fuel entries' own recorded rates.

### Needing the client's decision

- **[NEEDS CLARIFICATION: is there a cap on operator salary recovery?]** Indian wage law constrains
  deductions from wages. A cap, or spreading a recovery across months, is likely required; the limit
  must come from the client or their compliance advisor, not from this specification.
*The three clarifications that blocked the 2026-09-16 hard-refusal decision — the unassigned-location
fallback, the acceptable GPS accuracy, and the face-match confidence — were resolved on that date and
are recorded above. Only the recovery cap below remains open, and it belongs to User Story 2 rather
than to the geofence work.*
