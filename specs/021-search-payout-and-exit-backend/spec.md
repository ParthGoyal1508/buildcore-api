# Feature Specification: Search, Payout Communication and Exit Closure

**Feature Branch**: `021-search-payout-and-exit`

**Created**: 2026-09-13

**Status**: Draft

**Input**: Client requirements spreadsheet, Notes 4, 9, 10 and 11.

**Surfaces**: buildcore-api (search, salary slip delivery, transaction sheet ingestion, advance
settlement in the bank sheet, exit clearance) and buildcore-web (dashboard search, exit checklist).

## Why these four are together

They share no mechanism — they are grouped because each is small, self-contained and independently
shippable, and splitting them into four specifications would cost more in ceremony than it would
return in clarity. Each user story below can be built, tested and released on its own.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Find anything by its code (Priority: P1)

Somebody at head office has a vendor code, a vehicle number, an employee ID or a project code, and
types it into a search box on the dashboard. The matching record's summary appears, and from there
the full record is one click away. They do not need to know which module owns it.

**Why this priority**: The client asks for it twice — once for project codes (Note 4) and once, in
the sheet's Dashboard section, for *"every Vendor, Vehicle, Employee ID... that has must required."*
It is the most-used kind of interaction in a system with this many registers, and there is no search
of any kind today.

**Independent Test**: Search for a known code of each supported kind and confirm the right record is
found and reachable, and that a code belonging to another company is not.

**Acceptance Scenarios**:

1. **Given** a valid employee code, **When** it is searched, **Then** that employee appears with
   enough detail to identify them, and their record is reachable.
2. **Given** a valid vendor, vehicle or project code, **When** it is searched, **Then** the matching
   record appears in the same way.
3. **Given** a partial code, **When** it is searched, **Then** matching records are listed.
4. **Given** a code belonging to a company the user cannot access, **When** it is searched, **Then**
   nothing is returned — and the response does not reveal that the code exists elsewhere.
5. **Given** a search matching records the user lacks permission to view, **When** results are
   returned, **Then** those records are excluded.
6. **Given** a code that matches nothing, **When** it is searched, **Then** the empty result says so
   plainly.

---

### User Story 2 - The employee learns they have been paid, from the system (Priority: P2)

When a payroll run is paid, each employee receives their salary slip by email. Separately, the bank's
transaction sheet is uploaded against the run, so the portal holds the record of what was actually
transferred rather than only what was intended.

**Why this priority**: Note 9, which the client ends with *"Please check this"* — they are asking
whether it is feasible rather than stating a settled requirement. It is P2 because slips are already
available in the portal; this makes delivery active rather than passive.

**Independent Test**: Mark a run as paid and confirm each employee with an email address receives
their own slip and no one else's; upload a transaction sheet and confirm it reconciles against the
run.

**Acceptance Scenarios**:

1. **Given** a payroll run marked paid, **When** delivery runs, **Then** each employee with an email
   address receives their own salary slip and only their own.
2. **Given** an employee without an email address, **When** delivery runs, **Then** they are reported
   as undeliverable rather than silently skipped.
3. **Given** a delivery failure, **When** it occurs, **Then** it is recorded and retryable without
   resending to employees already delivered.
4. **Given** a bank transaction sheet, **When** it is uploaded against a run, **Then** each line is
   matched to a payroll line and unmatched lines are reported.
5. **Given** an uploaded transaction sheet, **When** the run is viewed, **Then** amounts actually
   transferred are visible beside amounts computed, with differences highlighted.
6. **Given** a run not yet fully approved, **When** delivery is attempted, **Then** it is refused.

---

### User Story 3 - A delayed salary settles its advances in the month it is paid (Priority: P2)

Salary for a month is approved but paid late, and in the meantime the employee has taken an advance.
When the bank payment sheet is produced, the advance is recovered against that payment, so the sheet
reflects what should actually be transferred rather than what was computed weeks earlier.

**Why this priority**: Note 10. It prevents paying out money that has already been handed over in
cash — a direct loss, and one that is easy to miss precisely because the two events sit in different
months.

**Independent Test**: Approve a run, record an advance afterwards, produce the bank sheet, and
confirm the advance is recovered and the net reflects it.

**Acceptance Scenarios**:

1. **Given** an approved run and an advance taken after approval but before payment, **When** the bank
   payment sheet is produced, **Then** the advance is recovered and the net transfer reflects it.
2. **Given** such a recovery, **When** the sheet is viewed, **Then** the recovery is shown as a named
   line against that employee, not folded silently into the net.
3. **Given** an advance larger than the net payable, **When** the sheet is produced, **Then** the
   transfer is not negative and the unrecovered balance carries forward.
4. **Given** a recovery applied at bank sheet time, **When** the advance balance is viewed, **Then**
   it reflects the recovery and cannot be recovered a second time in the next run.
5. **Given** a run paid on time with no intervening advance, **When** the sheet is produced, **Then**
   it is unchanged from today's behaviour.

---

### User Story 4 - Nobody leaves with the company's property or an open balance (Priority: P2)

When an employee exits, a clearance checklist runs: issued kit returned, company documents handed
back, advances and loans settled, reimbursements closed, accounts and access revoked. Final
settlement cannot be completed while anything on it is outstanding, or it is waived by somebody
who is recorded as having waived it.

**Why this priority**: Note 11. Exit records and final settlement payroll already exist, and kit
items already carry a recoverable-at-exit flag; what is missing is the checklist that ties them
together and the gate that makes it matter.

**Independent Test**: Exit an employee holding an outstanding advance and an issued item, and confirm
settlement is blocked until both are resolved or waived.

**Acceptance Scenarios**:

1. **Given** an employee with an exit initiated, **When** the clearance checklist is opened, **Then**
   every outstanding item is listed with its owner.
2. **Given** an outstanding recoverable kit item, **When** final settlement is attempted, **Then** it
   is refused until the item is returned or its recovery is waived.
3. **Given** an outstanding advance or loan, **When** final settlement is computed, **Then** the
   balance is recovered from it.
4. **Given** an item waived, **When** the waiver is recorded, **Then** the waiver's author and reason
   are retained.
5. **Given** a completed clearance, **When** final settlement is produced, **Then** it includes
   pending salary, notice recovery, outstanding advances, reimbursements and other deductions, with
   the final payable shown.
6. **Given** a completed exit, **When** the employee's access is reviewed, **Then** their account is
   revoked and the revocation is recorded.

### Edge Cases

- A search term that is a valid code in two registers at once (a vehicle number that is also a
  vendor code).
- A search that would match thousands of records.
- An employee's email bounces, or is a shared site address several employees use.
- A salary slip is emailed and the run is then corrected and re-approved.
- A bank transaction sheet in a format the bank changed without notice.
- An advance is recorded between bank sheet production and actual transfer.
- An employee exits mid-month with attendance not yet processed.
- An employee is rehired after an exit with waived recoveries outstanding.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Users MUST be able to search by code across at least employees, vendors, equipment and
  projects from the dashboard.
- **FR-002**: System MUST return results scoped to the user's company and permissions, and MUST NOT
  disclose the existence of records outside them.
- **FR-003**: System MUST support partial matching and MUST identify which register each result
  belongs to.
- **FR-004**: System MUST make the full record reachable from a result.
- **FR-005**: System MUST send each employee their own salary slip when a payroll run is marked paid.
- **FR-006**: System MUST report employees whose slip could not be delivered, and MUST allow retry
  without duplicate delivery.
- **FR-007**: System MUST refuse slip delivery for a run that is not fully approved.
- **FR-008**: Users MUST be able to upload a bank transaction sheet against a payroll run.
- **FR-009**: System MUST match uploaded transaction lines to payroll lines and report unmatched
  lines and amount differences.
- **FR-010**: System MUST recover advances outstanding at the time the bank payment sheet is produced,
  including advances taken after the run was approved.
- **FR-011**: System MUST show each recovery as a named line on the bank payment sheet.
- **FR-012**: System MUST NOT produce a negative transfer; an unrecovered balance MUST carry forward.
- **FR-013**: System MUST NOT recover the same advance twice.
- **FR-014**: System MUST present an exit clearance checklist covering recoverable kit, company
  documents, advances and loans, reimbursements, and access revocation.
- **FR-015**: System MUST prevent final settlement while a checklist item is outstanding and not
  waived.
- **FR-016**: System MUST record the author and reason for every waiver.
- **FR-017**: System MUST revoke the exiting employee's access on exit completion, and record it.
- **FR-018**: System MUST include pending salary, notice recovery, outstanding advances,
  reimbursements and other deductions in the final settlement, showing the final payable.

### Non-Functional Requirements

- **NFR-001**: Search MUST return results within 1 second at the 95th percentile across the full
  register. **Not verified today**; no search exists to measure, and this target should be held
  against realistic production data volumes rather than seed data.
- **NFR-002** *(Note 25)*: Dashboard search MUST be usable on Android and iOS at 320px width. **Not
  verified today.**
- **NFR-003**: Salary slip delivery for a 500-employee run MUST complete within 15 minutes, with
  failures isolated so one bad address does not stop the rest.

### Key Entities

- **Search Result**: A reference to a record in any register — its code, its identifying summary, its
  kind, and where to find it.
- **Slip Delivery**: A record that an employee's slip for a run was sent, to what address, when, and
  whether it succeeded.
- **Bank Transaction Record**: An uploaded line of what the bank actually transferred, matched to a
  payroll line.
- **Exit Clearance Item**: One obligation an exiting employee must settle, its state, and its waiver
  if any.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Any employee, vendor, equipment or project can be reached from the dashboard by code in
  under 10 seconds, with no knowledge of which module owns it.
- **SC-002**: A search never returns a record outside the user's company or permissions, verified
  across every register.
- **SC-003**: 100% of employees with a valid email address receive their own slip within 15 minutes
  of a run being marked paid, and no employee receives another's.
- **SC-004**: Every uploaded bank transaction line is either matched to a payroll line or reported as
  unmatched; none are silently dropped.
- **SC-005**: An advance taken between approval and payment is recovered on the bank sheet in 100% of
  cases, and never recovered twice.
- **SC-006**: No final settlement completes with an outstanding, unwaived clearance item.
- **SC-007**: Every exited employee's access is revoked, verified by attempting sign-in after exit.

## Assumptions

- Search covers codes and names, not free-text across every field. A general-purpose full-text search
  is a materially larger feature and is not what the client asked for.
- Salary slips are sent through the existing email mechanism, inheriting its sender configuration and
  its production safeguards.
- The bank transaction sheet is a spreadsheet the bank provides after transfer. Its format varies by
  bank; the specification assumes one configurable format rather than automatic detection.
- Advance recovery at bank sheet time adjusts the transfer, not the payroll computation. The payroll
  run's figures remain as approved, and the difference is a recovery line — this keeps the approved
  run immutable, consistent with how payroll runs already behave.
- Exit clearance reuses the existing exit record and final settlement payroll rather than introducing
  a parallel process.
- Access revocation on exit is an account operation and does not delete the employee's history.

### Needing the client's decision

- **[NEEDS CLARIFICATION: should salary slips be emailed automatically, or on an explicit action?]**
  The client asks *"Please check this"*, which reads as an open question rather than a decision.
  Automatic delivery on payment is assumed; an explicit send is safer if runs are sometimes corrected
  after being marked paid.
- **[NEEDS CLARIFICATION: which bank, and what transaction sheet format?]** FR-008 and FR-009 cannot
  be built without a real sample file.
- **[NEEDS CLARIFICATION: may an exit complete with a waived recovery, and who may waive?]** A waiver
  writes off company money. The authority for it should sit with the same person who holds final
  approval elsewhere, but the client should confirm.
