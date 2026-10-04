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

## Clarifications

### Session 2026-09-16

Raised against the client's re-stated requirement list, item 4: *"Add a search bar on the dashboard
to quickly find projects."*

- Q: FR-001 specifies search by *code*. The client asks to "quickly find projects", which people do by name. Widen it? → A: **Yes — code and name, in every register.** Nobody at head office memorises project codes; they know the site by what it is called. Partial matching was already required, so matching a name is the same mechanism applied to a second field rather than new machinery. The widening applies to all four registers, not only projects: the same argument holds for a vendor's trading name and an employee's name.
- Q: Does a name match rank differently from a code match? → A: **An exact code match ranks first.** A code is unambiguous and someone who typed one knows exactly what they want; a name match is a guess the system is helping with. Beyond that single rule, ordering is not specified here.
- Q: Does searching by name widen what a user can see? → A: **No.** FR-002's company and permission scoping is applied to results regardless of which field matched. A name is not a weaker key than a code for authorisation purposes — it is only a second way to arrive at the same record, and a record the caller may not view stays invisible either way.

### Session 2026-10-02, second round — the files arrived

`docs/RING ROAD JULY SALARY.xls` and `docs/NC0060_Payslip_Feb 2026.pdf`.

- Q: What does the bank sheet actually look like? → A: **16 fixed columns, 7 of them always empty**,
  a NEFT run with one debit account and 23 beneficiary rows. Now FR-008a to FR-008g.
- Q: Did waiting for it change anything, or was the configurable-mapping offer equivalent? → A: **It
  changed three things a reasonable person would have got wrong.** Account numbers must be text, not
  numbers, or leading zeros vanish — and the sample is itself inconsistent, numeric except where a
  leading zero forced Excel's hand. The value date is a `DD/MM/YYYY` *string*, not a date cell. And the
  column labelled "Swift Code" holds an IFSC. None of those is guessable from a column mapping.
- Q: Where does the beneficiary name come from? → A: **The bank account, not the employee record.**
  Several names in the sample are misspelled against any HR master (`Arivnd`, `Viashal`) because they
  match what the beneficiary's own bank holds. An export using our spelling fails for the employees
  whose records are most carefully kept, which is the opposite of the intuition.
- Q: And the payslip PDF? → A: **A layout reference from another company**, not BuildCore data — it is
  Next Creation Software's own payslip. Taken as the shape item 8 should produce: a company address
  block, a two-column employee detail panel (bank, PAN, PF UAN, location, effective work days, LOP),
  earnings as **Full and Actual** side by side, deductions, totals, net pay in words, and a "system
  generated, does not require signature" line.
- Q: Does it settle how loss-of-pay prorating is shown? → A: **No — LOP is zero in it**, so Full and
  Actual are identical in every row and the proration the two columns exist for is unexercised. The
  two-column shape is adopted; a sample with LOP above zero would be worth having before the
  arithmetic is finalised. Recorded rather than assumed.

### Session 2026-10-02

The last items on this feature's open list.

- Q: Who may waive an outstanding item on an exit clearance? → A: **HR proposes, the Director
  countersigns.** The waiver becomes a reviewable item on the existing approval spine, matching the
  authority that already governs final settlement. This supersedes the shipped behaviour, which
  required only write access on Employees — a placeholder, and wider than a write-off of company money
  deserves.
- Q: Does an exit therefore wait on an approval whenever something is outstanding? → A: **Yes, and that
  cost was accepted.** The alternatives were a single named Director, which stalls exits whenever they
  are away and invites account sharing, and a dedicated permission, which is more machinery than the
  spine already standing.
- Q: Is the value of an unreturned asset recovered from the final payable? → A: **No, by decision
  rather than by default.** Original cost, depreciated book value and replacement cost were each
  offered and declined. The waiver records the write-off with a name and a reason; no rupee figure is
  involved.
- Q: And the bank transaction sheet? → A: **Still open; the client is supplying a real file.** A
  configurable column mapping was offered as a way to begin without one and declined in favour of
  waiting. Nothing is built against a guessed layout.

### Session 2026-09-29

Raised against the client's re-stated requirement list, item 10, whose second bullet — *"Support for
asset allocation tracking — any assets assigned to the employee should appear in the F&F summary"* —
had no counterpart anywhere in this specification. FR-014's "recoverable kit" is the inventory issue
register; the asset register's custody assignment (feature 012) was not reached at all, so an
employee holding a company laptop could clear exit without it being noticed.

- Q: Should an asset the employee still holds block final settlement, or only be listed on the summary? → A: **Block it, on the same terms as recoverable kit.** The client's words ask only for visibility, but a line on a summary nobody is required to act on is how property leaves the company. Blocking is the behaviour FR-015 already establishes for every other obligation, and it is waivable under FR-016, so the case where somebody decides the asset is not worth chasing is already handled — with the decision on the record and attributed, which a summary line would not give.
- Q: Should the value of an unreturned asset be recovered from the final payable? → A: **No, not in this feature.** Recovery needs a valuation rule — original cost, depreciated value, or replacement — and that is a commercial decision the client has not made. The waiver under FR-016 records that the asset was written off; turning that into a rupee figure is separable work and is listed under "Needing the client's decision".

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Find anything by its code (Priority: P1)

Somebody at head office has a vendor code, a vehicle number, an employee ID or a project code — or
just the name of the site, the vendor or the person — and types it into a search box on the
dashboard. The matching record's summary appears, and from there the full record is one click away.
They do not need to know which module owns it, and they do not need to know its code.

**Why this priority**: The client asks for it twice — once for project codes (Note 4) and once, in
the sheet's Dashboard section, for *"every Vendor, Vehicle, Employee ID... that has must required."*
It is the most-used kind of interaction in a system with this many registers, and there is no search
of any kind today.

**Independent Test**: Search for a known code and a known name of each supported kind and confirm
the right record is found and reachable in both cases, and that neither a code nor a name belonging
to another company is.

**Acceptance Scenarios**:

1. **Given** a valid employee code, **When** it is searched, **Then** that employee appears with
   enough detail to identify them, and their record is reachable.
2. **Given** a valid vendor, vehicle or project code, **When** it is searched, **Then** the matching
   record appears in the same way.
3. **Given** a partial code, **When** it is searched, **Then** matching records are listed.
3a. **Given** a project's name or part of it, **When** it is searched from the dashboard, **Then** the
   project is listed and reachable, with no knowledge of its code required.
3b. **Given** an employee's or vendor's name, **When** it is searched, **Then** the matching records
   are listed on the same terms.
3c. **Given** a term that is an exact code for one record and part of another's name, **When** it is
   searched, **Then** the exact code match is listed first.
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

When an employee exits, a clearance checklist runs: issued kit returned, **company assets in their
custody returned**, company documents handed back, advances and loans settled, reimbursements
closed, accounts and access revoked. Final settlement cannot be completed while anything on it is
outstanding, or it is waived by somebody who is recorded as having waived it.

**Why this priority**: Note 11, and the client's re-stated item 10. Exit records and final settlement
payroll already exist, and kit items already carry a recoverable-at-exit flag; what is missing is the
checklist that ties them together and the gate that makes it matter. Asset custody was added to this
story on 2026-09-29: the asset register already records who holds what and when it is due back, and
exit was the one event that ignored it.

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
7. **Given** an employee holding an asset whose allocation is still open, **When** final settlement is
   attempted, **Then** it is refused, naming the asset and the site it was allocated at.
8. **Given** that asset returned through the asset register's own return path, **When** the clearance
   is reopened, **Then** its item reads satisfied with no second action taken here.
9. **Given** an asset allocated to the employee's project but with no custodian named, **When** the
   clearance is opened, **Then** it is not listed — it is not that employee's obligation.
10. **Given** an asset item waived, **When** the final settlement summary is produced, **Then** the
    asset appears on it with the waiver's author and reason, and the allocation is **not** recorded as
    returned.

### Edge Cases

- A search term that is a valid code in two registers at once (a vehicle number that is also a
  vendor code).
- A search that would match thousands of records. Name matching makes this likelier than code
  matching did — a two-letter term against a name field matches almost everything.
- A search term matching one record by code and a different record by name.
- Two projects or two employees with the same name, distinguishable only by code.
- An employee's email bounces, or is a shared site address several employees use.
- A salary slip is emailed and the run is then corrected and re-approved.
- A bank transaction sheet in a format the bank changed without notice.
- An advance is recorded between bank sheet production and actual transfer.
- An employee exits mid-month with attendance not yet processed.
- An employee is rehired after an exit with waived recoveries outstanding.
- An asset is allocated to the employee after their exit is initiated but before settlement.
- An asset comes back damaged: the allocation closes and the clearance item is satisfied, but the
  company is out of pocket. FR-018b is deliberate about this.
- A bulk allocation of ten units where six are returned. The asset register closes an allocation as a
  whole, so this reads as outstanding until all ten are accounted for.
- The employee is custodian of an asset at a site they were transferred away from months ago.
- An asset's allocation is closed by somebody else during the exit, between the checklist being read
  and settlement being attempted.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Users MUST be able to search by code across at least employees, vendors, equipment and
  projects from the dashboard.
- **FR-001a**: Users MUST be able to search by **name** as well as by code, across the same four
  registers, from the dashboard (Clarifications, 2026-09-16). Finding a project by the site's name is
  the client's stated need in item 4, and no register is exempt from it.
- **FR-001b**: Where a term is an exact code match for one record, that record MUST be returned ahead
  of records matched only by name.
- **FR-001c**: Company and permission scoping (FR-002) MUST apply identically to name matches and
  code matches. A record the caller may not view MUST NOT become reachable by searching its name.
- **FR-002**: System MUST return results scoped to the user's company and permissions, and MUST NOT
  disclose the existence of records outside them.
- **FR-003**: System MUST support partial matching on both code and name, and MUST identify which
  register each result belongs to.
- **FR-004**: System MUST make the full record reachable from a result.
- **FR-005**: System MUST send each employee their own salary slip when a payroll run is marked paid.
- **FR-006**: System MUST report employees whose slip could not be delivered, and MUST allow retry
  without duplicate delivery.
- **FR-007**: System MUST refuse slip delivery for a run that is not fully approved.
- **FR-008**: Users MUST be able to upload a bank transaction sheet against a payroll run.
- **FR-009**: System MUST match uploaded transaction lines to payroll lines and report unmatched
  lines and amount differences.
- **FR-008a**: The bank sheet MUST emit exactly 16 columns in this order: `CUSTOM_DETAILS1`,
  `Value Date`, `Message Type`, `Debit Account No.`, `Beneficiary Name`, `Payment Amount`,
  `Beneficiary Bank Swift Code / IFSC Code`, `Beneficiary Account No.`, `Transaction Type Code`,
  `CUSTOM_DETAILS2` … `CUSTOM_DETAILS6`, `Remarks`, `Purpose Of Payment`. Seven are always empty and
  MUST still be present — a bank parser counting columns rejects a sheet that omits the blanks.
- **FR-008b**: **Account numbers MUST be written as text, never as numbers.** The client's own sample
  is inconsistent on this — some account numbers are numeric cells and some are text — and the ones
  that are text are exactly the ones beginning with a zero: `0060311000001404`, `05152122005693`,
  `05213211061311`. Excel was forced into text for those and left the rest numeric. Writing a numeric
  cell destroys the leading zero, and the first anybody knows is a failed transfer on payment day.
  This is the single most consequential line in this feature.
- **FR-008c**: `Value Date` MUST be written as the **text** `DD/MM/YYYY`, not as a date cell. The
  sample carries a string. A real date cell is re-rendered by the reader's locale, and `21/08/2026`
  read as month 21 is a rejected file at best and the wrong date at worst.
- **FR-008d**: The column labelled *Swift Code / IFSC Code* MUST carry the **IFSC**. Every value in the
  sample is an IFSC (`SBIN0062263`, `HDFC0002533`); none is a SWIFT code. The label is the bank's and
  cannot be corrected, so the requirement names what goes in it.
- **FR-008e**: `Beneficiary Name` MUST come from the **bank account holder's name**, not from the
  employee master. The sample's names are short and several are misspelled relative to any HR record
  (`Arivnd`, `Viashal`, `Rosan`) because they match what the beneficiary's bank holds. A transfer is
  validated against the account, so an export using our own spelling will fail for exactly the
  employees whose records are tidiest.
- **FR-008f**: The sheet MUST carry a header row and payment rows only — **no totals row**. The sample
  has none, and a total appended to a file a parser reads row-by-row becomes a payment instruction.
- **FR-008g**: `Message Type` and `Transaction Type Code` both carry the mode (`NEFT` in the sample)
  and MUST both be emitted. The duplication is the bank's; collapsing it to one column changes the
  column count FR-008a fixes.
- **FR-010**: System MUST recover advances outstanding at the time the bank payment sheet is produced,
  including advances taken after the run was approved.
- **FR-011**: System MUST show each recovery as a named line on the bank payment sheet.
- **FR-012**: System MUST NOT produce a negative transfer; an unrecovered balance MUST carry forward.
- **FR-013**: System MUST NOT recover the same advance twice.
- **FR-014**: System MUST present an exit clearance checklist covering recoverable kit, **assets in
  the employee's custody**, company documents, advances and loans, reimbursements, and access
  revocation.
- **FR-014a**: The checklist MUST include every asset allocation that names the exiting employee as
  custodian and is not yet closed, as one item per allocation, stating the asset, the project or site
  it was allocated at, the quantity held where an allocation covers more than one unit, and the date
  its return was expected.
- **FR-014b**: An open asset allocation MUST prevent final settlement under FR-015 on the same terms
  as recoverable kit — satisfied by return, or by a waiver recorded under FR-016.
- **FR-014c**: The asset register MUST remain the sole owner of custody state. This feature MUST
  reflect it and MUST NOT keep a second record of who holds what: an asset returned through the asset
  module's own return path MUST satisfy its clearance item without a further action here, and waiving
  a clearance item MUST NOT mark the allocation returned or closed.
- **FR-014d**: An allocation with no custodian named MUST NOT appear on any employee's checklist. An
  asset held by a project or a site is the project's obligation, not a departing person's.
- **FR-014e**: The checklist MUST recompute custody at the moment it is read, so that an allocation
  opened after the exit was initiated is caught rather than missed by a snapshot taken earlier.
- **FR-015**: System MUST prevent final settlement while a checklist item is outstanding and not
  waived.
- **FR-016**: System MUST record the author and reason for every waiver.
- **FR-017**: System MUST revoke the exiting employee's access on exit completion, and record it.
- **FR-018**: System MUST include pending salary, notice recovery, outstanding advances,
  reimbursements and other deductions in the final settlement, showing the final payable.
- **FR-018a**: The final settlement summary MUST list every asset the employee held at exit with its
  outcome — returned, or waived with the waiver's author and reason — whether or not it blocked the
  settlement. This is the client's item 10 read literally; FR-014b is what makes it act.
- **FR-018b**: The value of an unreturned asset MUST NOT be deducted from the final payable under
  this feature. No valuation rule is specified (Clarifications, 2026-09-29), and a deduction computed
  from an unstated rule is worse than none.

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
  if any. Obligations are of several kinds; an **asset custody** obligation derives from the asset
  register's own allocation record rather than being stored here (FR-014c).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Any employee, vendor, equipment or project can be reached from the dashboard by code
  **or by name** in under 10 seconds, with no knowledge of which module owns it and no knowledge of
  its code.
- **SC-001a**: A term that exactly matches one record's code returns that record first, verified
  where the same term also matches another record's name.
- **SC-002**: A search never returns a record outside the user's company or permissions, verified
  across every register.
- **SC-003**: 100% of employees with a valid email address receive their own slip within 15 minutes
  of a run being marked paid, and no employee receives another's.
- **SC-004**: Every uploaded bank transaction line is either matched to a payroll line or reported as
  unmatched; none are silently dropped.
- **SC-005**: An advance taken between approval and payment is recovered on the bank sheet in 100% of
  cases, and never recovered twice.
- **SC-006**: No final settlement completes with an outstanding, unwaived clearance item.
- **SC-006a**: No final settlement completes while an asset allocation naming the exiting employee is
  open and unwaived, verified with a serialised asset and with a bulk allocation.
- **SC-006b**: Every asset the employee held at exit appears on the final settlement summary with its
  outcome, verified for a returned asset and for a waived one.
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
- Asset custody is read from the asset register (feature 012), which already records the custodian,
  the site, the expected return date and the condition on return. This feature adds no parallel
  record of custody and no new way to return an asset.
- An asset allocation is open or closed as a whole. Partial return of a bulk allocation is not a state
  the asset register holds, so the checklist cannot report it and does not pretend to.

### Needing the client's decision

- **RESOLVED 2026-10-01: an explicit action, not automatic delivery.** Decided while planning the web
  half and recorded there; this entry corrects the drift, because the answer sat in one repository's
  specification while the other still called it open. A run can be corrected after being marked paid,
  and an automatic send puts the wrong figure in somebody's inbox where it cannot be recalled.
- **RESOLVED 2026-10-02: the sample arrived** — `docs/RING ROAD JULY SALARY.xls`, 23 payment rows of a
  real NEFT run. The format is now FR-008a to FR-008g below. Waiting rather than guessing was the right
  order: the file contradicts three things a sensible person would have assumed.
- **RESOLVED 2026-10-02: HR proposes, the Director countersigns.** A waiver becomes a reviewable item
  on the existing approval spine rather than a unilateral act. The authority therefore matches final
  settlement itself, which is already director-final.

  This **supersedes what shipped**: the waiver currently requires write access on Employees, which was
  a placeholder I chose, and it is wider than a write-off of company money deserves. The change is
  wiring an existing mechanism, not new machinery — but it does mean an exit with something
  outstanding now waits on an approval, which is the cost the client accepted.
- **RESOLVED 2026-10-02: nothing is recovered, and that is now a decision rather than a default.**
  FR-018b recovers no money for an unreturned asset; the waiver records the write-off with a name and
  a reason against it. Original cost, depreciated book value and replacement cost were each offered
  and each declined. Worth stating positively: this is no longer "pending a valuation rule" — the
  client was asked and chose not to recover.
