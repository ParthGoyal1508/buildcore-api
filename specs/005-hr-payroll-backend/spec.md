# Feature Specification: HR & Payroll Backend (Employees, Attendance, Leave, Payroll, Challans, Loans, Daily Workers)

**Feature Branch**: `005-hr-payroll-backend`

**Created**: 2026-08-27

**Status**: Draft

**Input**: User description: "HR & Payroll Module (Employees, Attendance, Leave, Payroll Runs,
Challans, Loans, Daily Worker Registry) for the BuildCore API backend, per the PRD at
/Users/parthgoyal/Projects/ERP-Demo/docs/prd/03-hr-payroll.prd.md. This is the API/backend surface
only, and it is the admin-facing HR & Payroll module every prior feature (Settings, My Workspace,
Dashboard) has explicitly deferred to. It extends — never redefines — the minimal Employee/Site/
PunchRecord/LeaveApplication/PayrollRun(status)/ReEnrolmentRequest entities My Workspace already
built, and reuses Settings' Company/Department/Designation/DocumentType/Shift/Code-Series masters
(Employee Setup) as-is rather than rebuilding them."

## Clarifications

### Session 2026-08-27

- Q: How should TDS (income tax) deduction be handled, given full slab/exemption calculation is a
  large separate compliance domain? → A: Manual entry field, no calculation — a per-employee,
  per-run editable amount an admin enters (or leaves at zero); the payroll engine includes it in
  deductions/net pay but does not compute it from tax slabs.
- Q: How should document virus scanning (PRD NFR) be handled, given no scanning capability exists
  in this stack yet? → A: Defer — document upload/storage is fully built (encrypted,
  access-logged), but virus scanning itself is a noted gap, not implemented in this pass.
- Q: Payroll generation computes OT Wages, but the PRD doesn't state the overtime pay multiplier —
  what should the engine use? → A: Admin-managed — the OT multiplier is a company-configurable
  rate (extending Settings' existing per-company payroll-rate pattern: PF/ESIC/Gratuity/Bonus),
  editable by an admin, not a value this spec hardcodes as authoritative. A shipped default (2x,
  matching common Indian statutory practice) seeds new companies, exactly as PF's 12% default does.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Maintain full employee records (Priority: P1)

An HR admin creates and edits employee records across the PRD's eight tabs (Identity, Employment,
Statutory, Pay & Bank, Contact, Documents, Letters, Onboarding), and views the Employee List with
its filters and the Employee Detail page's summary tabs.

**Why this priority**: Everything else in this feature — attendance, leave, payroll, loans — reads
the employee record this story builds. My Workspace's minimal Employee (userId, companyId, siteId,
shiftId, employeeCode) already exists; this story extends it, not redefines it.

**Independent Test**: Can be fully tested by creating an employee across all eight tabs, confirming
it appears in the Employee List with correct Documents-progress and Status, then editing each tab's
fields and confirming persistence, independent of attendance/leave/payroll existing yet.

**Acceptance Scenarios**:

1. **Given** a company with departments/designations/shifts already configured (Settings feature),
   **When** an HR admin creates an employee across all eight tabs with valid data, **Then** the
   employee is created with an auto-generated code (via Settings' existing code-series service) and
   appears in the Employee List.
2. **Given** the Employment tab, **When** Type is set to Daily Wage, Contract, or Full Time,
   **Then** the record accepts the type-appropriate fields (Salary Rate ₹/Day, Calculation Mode)
   without requiring fields irrelevant to that type.
3. **Given** the Statutory tab, **When** PF Applicable or ESIC Applicable is set to No, **Then**
   the corresponding number fields (UAN/PF Number, ESIC Number) are not required; **When** set to
   Yes, **Then** they are required before save.
4. **Given** the Employee List, **When** filtered by Department, Project/Site, Status, or Company,
   or searched by name/code, **Then** results narrow accordingly, server-side paginated.
5. **Given** an employee record, **When** viewed on the Employee Detail page, **Then** Overview,
   Personal Info, Employment, Salary Structure, Attendance Calendar (monthly heatmap), Leave
   Summary, Documents, and Loan History each show that employee's current data.
6. **Given** an employee whose Aadhaar, PAN, bank account number, or UAN is displayed, **When**
   rendered, **Then** only the last 4 digits are shown by default, with an explicit, access-logged
   reveal action required to see the full value.
7. **Given** an employee marked Inactive, **When** attendance/leave/payroll actions are attempted
   for them, **Then** they are excluded from active-employee lists and payroll generation, while
   their historical records remain intact and viewable.

---

### User Story 2 - Manage employee documents with mandatory/expiry gating (Priority: P1)

An HR admin uploads documents per employee against the document types Settings' Employee Setup
already defines, and attendance marking is blocked for any employee missing a document type
flagged Mandatory.

**Why this priority**: The PRD's own success metric ("100% employees have all mandatory docs before
attendance marking") makes this a hard gate other stories depend on; Settings already built the
Document Type master (002) and a `hasMissingMandatoryDocs()` check — this story is what actually
stores and evaluates real per-employee document records against it.

**Independent Test**: Can be fully tested by uploading fewer than the mandatory set for a test
employee, attempting to mark their attendance (rejected), then uploading the remaining mandatory
document and confirming attendance marking becomes possible.

**Acceptance Scenarios**:

1. **Given** an employee and Settings' configured document types for their company, **When** a
   document is uploaded against one type, **Then** it's stored (encrypted at rest, access-logged)
   and linked to that employee and document type, with an optional document number and expiry date
   where the type requires them.
2. **Given** an employee missing one or more Mandatory-flagged document types, **When** any
   attendance-marking action is attempted for them (self-service punch, admin mark, daily-worker-
   style capture is not applicable here), **Then** it is rejected — reusing Settings'
   `hasMissingMandatoryDocs()` check (002) against this feature's actual document records.
3. **Given** a document with an expiry date, **When** that date is within a configurable warning
   window (default 30 days) or has passed, **Then** it is flagged for the Dashboard/Notifications
   feature's Document Expiry notification type to surface (that feature's own placeholder becomes
   real once this story ships).
4. **Given** the Employee List's Documents progress bar, **When** rendered, **Then** it reflects the
   proportion of that employee's Mandatory document types currently on file.

---

### User Story 3 - Administer attendance (Priority: P1)

An HR/site admin views and edits the Daily Attendance table for a date/site, reviews geofence
exceptions, reviews a full audit of manual edits, and declares company/site holidays.

**Why this priority**: My Workspace (003) already built self-service punch submission and exception
recording (FR-011a resolves an exception's confirmed/rejected state); this story is the full admin
surface around that same data — editing entries directly, auditing every edit, and the Holidays
master that attendance-status computation (003's research.md §6) already reads.

**Independent Test**: Can be fully tested by viewing a date's attendance for a site, manually
editing one employee's In/Out time, confirming the edit appears in the Modifications audit with
before/after values, and confirming a declared holiday causes that date to show Holiday status for
all employees at an applicable site.

**Acceptance Scenarios**:

1. **Given** a date and site, **When** the Daily Attendance view is requested, **Then** it returns
   each employee's In/Out time, OT/worked hours, status, and approval state for that date, scoped
   to the site.
2. **Given** the Mark/Edit Attendance action, **When** an admin sets Employee, Date, In/Out time,
   status override, OT hours, and remarks, **Then** the underlying attendance record is created or
   updated, and the change is captured for the Modifications audit (Changed By, Changed From → To,
   Timestamp).
3. **Given** the Exceptions view, **When** requested for a date/site, **Then** it lists punches
   recorded outside the assigned site's geofence radius with employee, punch time, GPS coordinates,
   distance from site, and current resolution status (extending 003's FR-011a data).
4. **Given** a holiday declared for a date with an applicability scope (All sites or specific
   sites), **When** attendance/history is computed for that date at an applicable site, **Then** it
   shows Holiday status — extending 003's per-site `holidays` representation into a first-class,
   named, typed entity.
5. **Given** an attendance record within an already payroll-locked period (003's existing lock
   rule), **When** an edit is attempted, **Then** it is rejected regardless of admin role.

---

### User Story 4 - Administer leave (Priority: P1)

An HR admin views all leave applications (not just their own), approves or rejects pending ones,
and views leave balances across employees.

**Why this priority**: My Workspace (003) already built the employee-facing apply/cancel flow and
the admin decide endpoint (FR-022a); this story is the admin list/oversight surface around that
same data.

**Independent Test**: Can be fully tested by listing all pending applications across employees,
approving one (confirming it becomes visible as "On Leave" in that employee's attendance), and
rejecting another with mandatory remarks.

**Acceptance Scenarios**:

1. **Given** the Leave Applications admin view, **When** requested, **Then** it lists every
   employee's applications (not scoped to one employee, unlike My Workspace's self-service list),
   filterable by status, with Approve/Reject/Cancel actions shown per its current status.
2. **Given** a Pending application, **When** an admin approves (optional remarks) or rejects
   (mandatory remarks), **Then** it uses 003's existing decide endpoint/behavior — this story adds
   no new decision logic, only the admin-facing list.
3. **Given** the Leave Balance admin view, **When** requested for an employee or across employees,
   **Then** it shows Opening/Accrued/Used/Available per leave type, matching 003's existing balance
   computation.

---

### User Story 5 - Generate payroll and produce salary slips (Priority: P1)

An HR admin selects a month and triggers payroll generation; the system computes each active
employee's pay from their salary structure, attendance, and active loan EMIs, producing a payroll
run an admin can move through Draft → Processed → Paid, with a real (not placeholder) salary slip
and a bank salary sheet export.

**Why this priority**: The PRD's central compliance-and-payout capability, and the point at which
My Workspace's `PayrollRun` (status-only) and `SalarySlip` (read-projection "assumes figures already
exist") specs are finally made real — this story is exactly the "figures already exist" precondition
003 deferred.

**Independent Test**: Can be fully tested by generating payroll for a month with seeded attendance/
leave/salary-structure/loan data, confirming each employee's computed earnings/deductions/net pay
match hand-calculated expectations, then progressing the run through Processed and Paid and
confirming 003's `/my/salary` endpoints (which already exist) now return real, non-404 data for
that period.

**Acceptance Scenarios**:

1. **Given** a month with no existing payroll run for a company, **When** generation is triggered,
   **Then** the system computes, for every active employee, Payable Days (from attendance), LOP
   Days, OT Hours/Wages, each earnings component (Basic/HRA/Conveyance/Site/Special Allowance) at
   its configured monthly rate scaled by payable days, PF/ESIC employee deductions (from the
   employee's applicability flags and the company's configured rates — Settings' existing
   `pfEmployerRate`/`esicEmployerRate` fields cover the employer side; employee-side statutory
   percentages are fixed per FR-below), Professional Tax (slab-based per company/state
   configuration), active loan EMI (from Loans), TDS (manual entry per clarification, default
   zero), and Net Pay — creating the run in Draft status.
2. **Given** a Draft run, **When** an admin marks it Processed, **Then** its figures become
   immutable — any further edit requires a new adjustment entry in a subsequent cycle (003's
   existing payroll-lock rule now has a real trigger point, not just a manually-set status).
3. **Given** a Processed run, **When** marked Paid, **Then** its status updates and (per 003's
   existing contract) it becomes visible in employee-facing `/my/salary` for that period.
4. **Given** a Processed/Paid run, **When** a salary slip is requested for one employee (admin
   view or, per 003, the employee's own `/my/salary` view), **Then** it returns the full PRD-
   specified sections (header, attendance summary, earnings, deductions, informational employer
   contributions, net pay in words, minimum-wages note) with real computed figures, and the same
   data is available as a PDF (reusing `pdfkit`, already pre-approved).
5. **Given** a Processed/Paid run, **When** the Bank Salary Sheet is exported, **Then** it returns
   employee/bank/account/IFSC/net-pay rows in a structured export file (`exceljs`, already
   pre-approved) suitable for a bank upload process — exact conformance to any one specific bank's
   proprietary format is not guaranteed by this feature (see Assumptions).
6. **Given** an employee inactive as of the payroll period, **When** generation runs, **Then** they
   are excluded from that run.

---

### User Story 6 - Generate statutory challans (Priority: P2)

An HR admin views PF, ESIC, and PT challan data for a processed payroll month, auto-derived from
that run's figures, and exports each in a structured file.

**Why this priority**: Directly depends on User Story 5's processed payroll figures existing;
feeds the Dashboard's already-registered (but currently placeholder) PF/ESIC-pending widgets and
Statutory Calendar, making those real.

**Independent Test**: Can be fully tested by requesting the PF/ESIC/PT challan tabs for a Processed
payroll month and confirming each employee's row and the summary totals match that run's own
deduction/contribution figures.

**Acceptance Scenarios**:

1. **Given** a Processed/Paid payroll run, **When** the PF Challan tab is requested, **Then** it
   returns per-employee UAN, PF Wages, EPS Wages, Employee PF (12%), Employer PF (3.67%), EPS
   (8.33%), EDLI, Admin Charges, and Total, with a summary row — all derived from that run's
   figures, not recomputed independently.
2. **Given** the same run, **When** the ESIC Challan tab is requested, **Then** it returns
   per-employee ESIC Number, ESIC Wages, Employee ESIC (0.75%), Employer ESIC (3.25%), and Total,
   summed.
3. **Given** the same run, **When** the PT Challan tab is requested, **Then** it returns slab-based
   Professional Tax per employee using the company's configured PT slabs.
4. **Given** any challan tab's data, **When** exported, **Then** a structured file suitable for the
   respective statutory portal's upload process is produced (best-effort structured export, not
   guaranteed byte-for-byte EPFO/ESIC portal format conformance — see Assumptions).
5. **Given** a month with no processed payroll run yet, **When** challan data is requested for it,
   **Then** a clear "no processed payroll for this period" result is returned, not fabricated data.

---

### User Story 7 - Track employee loans and EMI deductions (Priority: P2)

An HR admin records a loan for an employee with an auto-generated EMI repayment schedule; active
EMIs automatically appear as a payroll deduction each cycle.

**Why this priority**: A self-contained capability that only needs Story 1's employee records to
exist; its payroll integration is a dependency Story 5 already accounts for (Acceptance Scenario 1
above lists "active loan EMI" as a deduction input).

**Independent Test**: Can be fully tested by creating a loan with an amount and EMI value,
confirming the repayment schedule auto-generates with correct per-month figures, then generating a
payroll run for a month within the schedule and confirming that month's EMI appears as a deduction.

**Acceptance Scenarios**:

1. **Given** a loan amount, EMI amount, disbursement date, and reason, **When** created, **Then** a
   month-by-month repayment schedule (EMI amount, principal, interest, remaining balance, status)
   is generated automatically and the loan's status becomes Active.
2. **Given** an Active loan, **When** payroll is generated for a month within its schedule,
   **Then** that month's EMI is included as a payroll deduction, and the schedule entry's status
   updates to Paid once that payroll run reaches Processed.
3. **Given** a loan whose outstanding balance reaches zero, **When** the final EMI is processed,
   **Then** its status becomes Closed and it stops appearing as a future deduction.
4. **Given** a loan, **When** an admin views it, **Then** Total Paid and Outstanding Balance are
   computed from its schedule's actual paid/upcoming entries, not stored as separately-maintained
   fields that could drift.

---

### User Story 8 - Transfer an employee across companies (Priority: P2)

An HR admin transfers an employee's record to a different company within the group, optionally
retaining their employee code, with the transfer logged.

**Why this priority**: A distinct, self-contained capability building on Story 1's employee record
and Settings' multi-company model; not required for the core attendance/payroll loop to function.

**Independent Test**: Can be fully tested by transferring a test employee to a second seeded
company, confirming their `companyId` updates, their prior company's records remain historically
intact, and the transfer appears in the Activity Log.

**Acceptance Scenarios**:

1. **Given** an employee and a target company, transfer date, reason, and a Retain Employee Code
   toggle, **When** submitted, **Then** the employee's `companyId` updates to the target company,
   a new employee code is generated under the target company's series unless Retain Employee Code
   is checked, and the transfer is recorded (audit log + a dedicated transfer-history record).
2. **Given** a completed transfer, **When** the employee's historical attendance/leave/payroll
   records from before the transfer are viewed, **Then** they remain attributed to the original
   company, not silently reassigned.

---

### User Story 9 - Register and mark attendance for daily workers (Priority: P3)

A Site Supervisor enrols a daily/casual worker (name, trade, wage rate, 3–5 photos, simplified
consent) without creating a full Employee or user account, then marks that worker's daily
attendance via face-match or manual selection, feeding site headcount figures without entering the
statutory payroll pipeline.

**Why this priority**: An entirely parallel, lighter-weight system reusing the same biometric
pipeline (003's `BiometricsService`) but with no dependency on Stories 1–8; valuable for a large
share of on-site labour but distinct enough to be its own, lower-priority story.

**Independent Test**: Can be fully tested by enrolling a worker with 3 photos, marking them present
via face-match at their assigned site, confirming the attendance record stores photo/GPS/timestamp/
marking-supervisor, and confirming that worker does not appear in any payroll-generation input.

**Acceptance Scenarios**:

1. **Given** a Site Supervisor (a user whose role holds the Daily Worker Registry permission,
   scoped to their assigned site), **When** they submit the one-time enrolment form (name, phone,
   gender, site, trade, wage rate, 3–5 photos, supervisor-attested consent), **Then** a Daily
   Worker record is created with an auto-generated Worker ID and a face template derived the same
   way as Employee enrolment (003's `BiometricsService`), without any login credential or
   statutory-identifier field being collected or required.
2. **Given** the Daily Worker Attendance capture screen for a site, **When** a supervisor marks a
   worker present via face-match or manual selection, **Then** a Daily Worker Attendance record
   stores the captured photo (if taken), GPS location, timestamp, marking supervisor, and status.
3. **Given** face-match is inconclusive or the camera is unavailable, **When** the supervisor marks
   attendance manually instead, **Then** it succeeds without a photo, logged as an exception
   (distinct from a rejected attempt).
4. **Given** multiple workers at one site, **When** a supervisor bulk-marks several present in one
   session, **Then** each gets its own attendance record with that session's shared timestamp
   context, individually correctable later (e.g., marking one absent afterward).
5. **Given** a supervisor not assigned to a worker's site, **When** they attempt to enrol or mark
   attendance for that worker, **Then** the request is rejected server-side.
6. **Given** daily worker attendance data, **When** aggregated, **Then** it feeds the same
   site-level headcount figures used by Dashboard's "Workers Today"/Site Dashboard widgets (making
   those figures reflect daily workers too, not only Employees), tagged distinctly as "Daily
   Worker" rather than merged indistinguishably with Employee attendance.
7. **Given** a Daily Worker record, **When** deactivated, **Then** they no longer appear in the
   attendance capture roster, but their historical attendance remains queryable.
8. **Given** daily worker wage data for a site/period, **When** summarized, **Then** it produces a
   payout summary (worker, days present, rate, total) for cash/bank disbursement — explicitly
   separate from the statutory payroll pipeline (Story 5); a daily worker never appears in a
   `PayrollRun`.

---

### User Story 10 - Administer biometric re-enrolment requests (Priority: P3)

An HR/Admin views the queue of employees' pending re-enrolment requests (003 already builds the
request/approve/reject actions) with site and reason context, and acts on them.

**Why this priority**: My Workspace (003) already implements the approve/reject/unlock mechanics
in full; this story adds only the admin-facing list/queue view those actions operate on, so it's
small and can be built anytime after 003 exists.

**Independent Test**: Can be fully tested by seeding two pending re-enrolment requests, listing the
queue (confirming employee, site, reason, requested-on are all present), and approving one via
003's existing endpoint.

**Acceptance Scenarios**:

1. **Given** pending, approved, and rejected re-enrolment requests exist, **When** the admin queue
   is requested, **Then** it lists each with employee, site (via the employee's current site
   assignment), reason, requested-on timestamp, and status, filterable by status.
2. **Given** the queue, **When** an admin acts on a request, **Then** it uses 003's existing
   approve/reject endpoints unchanged — this story does not duplicate or alter that logic.

---

### User Story 11 - Employee Offboarding and Full & Final Settlement (Priority: P3)

An HR admin initiates an employee's exit (last working day, reason), computes the Full & Final
(F&F) settlement (pending salary, leave encashment, loan recovery), processes it as a special
payroll run, and deactivates the employee's user account on exit.

**Why this priority**: A complete HR lifecycle capability; depends on payroll (US5) and loans
(US7) existing. PRD §7.3.7.

**Independent Test**: Can be fully tested by initiating exit for a test employee, computing F&F
(confirming leave encashment and loan recovery appear), processing it as an F&F payroll run, and
confirming the employee's status becomes Inactive and their login is revoked.

**Acceptance Scenarios**:

1. **Given** an active employee, **When** `POST /hr/employees/:id/exit` is called with
   `lastWorkingDay`, `reason` (Resignation/Termination/Contract End), and optional `remarks`,
   **Then** an `ExitRecord` is created; the employee's departure is scheduled for `lastWorkingDay`.
2. **Given** an exit record, **When** `GET /hr/employees/:id/fnf` is called, **Then** it returns
   the F&F computation: pending salary (pro-rated for partial month), earned leave encashment
   (EL balance × daily rate), active loan recovery amount, and net F&F payable.
3. **Given** the F&F computation, **When** `POST /hr/employees/:id/fnf/process` is called,
   **Then** a `PayrollRun` flagged as F&F is created for the employee, incorporating the computed
   components; processed through the standard payroll lock flow.
4. **Given** `lastWorkingDay` has passed and the F&F payroll is processed, **When** the employee
   record is updated, **Then** `status → Inactive`; the linked `User.active` is set to false
   (login disabled, all refresh tokens revoked in Redis).
5. **Given** an inactive employee, **When** attendance/leave/payroll actions are attempted,
   **Then** they are rejected with a "employee is inactive" error; historical records remain intact.

---

### User Story 12 - Reimbursement Claims (Admin) (Priority: P3)

An HR/Site Admin reviews employee-submitted reimbursement claims, approves or rejects them,
and marks approved claims as paid (via payroll or direct payment).

**Why this priority**: Depends on Settings' Reimbursement Categories master (added by this feature
to 002's scope) and employees existing. PRD §7.3.8.

**Independent Test**: Can be fully tested by seeding a submitted claim, approving it, marking it
paid directly, and confirming a second claim can be rejected with mandatory remarks.

**Acceptance Scenarios**:

1. **Given** submitted reimbursement claims, **When** `GET /hr/reimbursements?status=submitted&
   employeeId=&companyId=&page=` is called, **Then** it returns paginated claims with employee,
   category, amount, expense date, description, receipt reference, and status.
2. **Given** a Submitted claim, **When** `PATCH /hr/reimbursements/:id/approve` is called with
   optional `remarks`, **Then** status → `approved`; the claim is queued for payment.
3. **Given** a Submitted claim, **When** `PATCH /hr/reimbursements/:id/reject` is called with
   mandatory `remarks`, **Then** status → `rejected`; employee is notified.
4. **Given** an Approved claim, **When** `PATCH /hr/reimbursements/:id/pay` is called with
   `{ paymentMode: 'direct', paymentDate, paymentReference }`, **Then** status → `paid`,
   payment details recorded. Alternatively, `paymentMode: 'payroll'` includes the claim amount
   as an earnings line in the employee's next payroll run.
5. **Given** the Reimbursement Register, **When** `GET /hr/reimbursements/register` is called,
   **Then** it returns all claims with status filters; summary totals by status.

---

### Edge Cases

- What happens when an employee's Employment Type changes from Daily Wage to Full Time mid-cycle?
  The change takes effect for payroll runs generated after the change; an already-Processed run is
  never retroactively recalculated (per the immutability rule).
- What happens when two admins edit the same employee's record concurrently? The later save
  succeeds and overwrites the earlier one — this feature does not implement field-level optimistic-
  lock conflict detection beyond showing the latest server-confirmed data on next load (consistent
  with the Settings feature's own established posture).
- What happens when a loan's EMI exceeds an employee's net pay for a given month? The deduction is
  still applied in full (the PRD does not describe a partial/deferred-EMI mechanism); Net Pay may
  go negative, which is surfaced clearly rather than silently floored at zero — a genuinely
  unusual case an admin would need to address by adjusting the loan or salary structure.
- What happens to a Daily Worker's face template if they're later converted to a full Employee
  record? Per the PRD, their photo and enrolment history carry forward rather than requiring
  re-enrolment — the conversion creates a new Employee/FaceEnrolment record seeded from the Daily
  Worker's existing template and photos, and the original Daily Worker record is marked converted
  (not deleted, to preserve its attendance history's referential integrity).
- What happens when a challan is requested for PT in a state/company with no configured PT slabs
  yet? It returns a clear "PT slabs not configured for this company" result rather than a zero or
  fabricated value.
- What happens when a document upload's file type or size is invalid? Rejected before storage with
  a specific validation error, not a generic failure.

## Requirements *(mandatory)*

### Functional Requirements

**Employees & Documents**

- **FR-001**: The system MUST extend the existing minimal Employee record (My Workspace, 003) with
  the full field set across Identity, Employment, Statutory, Pay & Bank, and Contact tabs, without
  redefining `userId`/`companyId`/`siteId`/`shiftId`/`employeeCode`.
- **FR-002**: The system MUST provide a paginated, server-side-filterable (search, department,
  project/site, status, company) Employee List and an Employee Detail view covering Overview,
  Personal Info, Employment, Salary Structure, a monthly Attendance Calendar, Leave Summary,
  Documents, and Loan History.
- **FR-003**: The system MUST mask Aadhaar, PAN, bank account number, and UAN to their last 4
  digits by default in every response, requiring an explicit, access-logged reveal action to
  return the unmasked value, and MUST encrypt these fields at rest.
- **FR-004**: The system MUST store per-employee document uploads against Settings' existing
  Document Type master (002), including an optional document number and expiry date where the type
  requires them, encrypted at rest and access-logged; virus scanning is explicitly deferred (per
  clarification) and MUST be tracked as a known gap, not silently omitted.
- **FR-005**: The system MUST evaluate Settings' `hasMissingMandatoryDocs()` (002) against this
  feature's real per-employee document records before permitting any attendance-marking action, for
  both self-service (003) and admin-marked (this feature) attendance.
- **FR-006**: The system MUST flag a document as expiring within a configurable warning window
  (default 30 days) or already expired, in a form the Dashboard feature's Document Expiry
  notification provider (004, currently a placeholder) can consume to become real.
- **FR-007**: The system MUST allow transferring an employee to a different company (target
  company, date, reason, retain-code toggle), updating `companyId` and generating a new employee
  code under the target company's series unless retention is requested, while preserving
  pre-transfer historical records under the original company and logging the transfer.

**Attendance**

- **FR-008**: The system MUST provide an admin Daily Attendance view (date + site scoped) showing
  each employee's in/out time, OT/worked hours, status, and approval state.
- **FR-009**: The system MUST provide a Mark/Edit Attendance action that creates or updates an
  attendance record (employee, date, in/out time, status override, OT hours, remarks), rejected for
  any date within an already payroll-locked period regardless of admin role.
- **FR-010**: The system MUST record every manual attendance edit's actor, before/after values, and
  timestamp in a queryable Modifications audit, and MUST provide an Exceptions view listing punches
  outside the assigned site's geofence radius (extending 003's exception data) with GPS coordinates
  and distance from site.
- **FR-011**: The system MUST provide Holiday declaration (name, date, type, applicability to all
  sites or specific sites) as a first-class entity, superseding 003's flat per-site `holidays` date
  array, and MUST make declared holidays reflect as Holiday status in attendance computation for
  every applicable site.

**Leave**

- **FR-012**: The system MUST provide an admin Leave Applications view listing every employee's
  applications (not scoped to one employee), filterable by status, reusing 003's existing approve/
  reject/cancel logic unchanged.
- **FR-013**: The system MUST provide an admin Leave Balance view showing Opening/Accrued/Used/
  Available per employee per leave type, reusing 003's existing balance computation.

**Payroll**

- **FR-014**: The system MUST compute, on payroll generation for a company/month, each active
  employee's Payable Days, LOP Days, OT Hours/Wages (OT hours paid at the company's configurable OT
  multiplier — see FR-014a — applied to the employee's standard hourly rate), earnings components
  (Basic/HRA/Conveyance/Site/Special Allowance) scaled by payable days, employee-side PF/ESIC
  deductions where applicable (per the employee's statutory applicability flags), Professional Tax
  (slab-based, company-configured), active loan EMI deductions (summed across every currently
  Active loan if an employee holds more than one), a manually-entered TDS amount (default zero, per
  clarification), and Net Pay, persisting the run in Draft status.
- **FR-014a**: The system MUST store the OT pay multiplier as a company-configurable payroll
  setting (extending Settings' existing PF/ESIC/Gratuity/Bonus rate pattern, 002), admin-editable
  per company, seeded with a default of 2x for a newly created company — never a value hardcoded in
  application logic.
- **FR-015**: The system MUST make a Processed or Paid payroll run's figures immutable — any
  correction MUST be a new adjustment entry in a subsequent cycle, never an edit to the original
  run, consistent with 003's existing payroll-lock rule (which this feature is the first to
  actually trigger from a real event).
- **FR-016**: The system MUST provide a real Salary Slip (superseding 003's "assumes figures already
  exist" placeholder) for any Processed/Paid run, matching the PRD's specified sections, available
  both as a structured response and a `pdfkit`-rendered PDF, consumable identically by this
  feature's own admin view and 003's existing employee-facing `/my/salary` endpoints.
- **FR-017**: The system MUST provide a Bank Salary Sheet export (employee, bank name, account
  number, IFSC, net pay) for a Processed/Paid run via `exceljs`.
- **FR-018**: The system MUST exclude an employee inactive as of the payroll period from that
  period's generation.

**Challans**

- **FR-019**: The system MUST derive PF, ESIC, and PT challan data entirely from a Processed/Paid
  payroll run's own stored figures — never an independent recomputation — for a requested company/
  month, and MUST return a clear "not yet processed" result (not fabricated data) when no such run
  exists for that period.
- **FR-020**: The system MUST provide a structured export (`exceljs`/`pdfkit`) for each challan
  type, suitable for a statutory-portal upload workflow (best-effort structured conformance, per
  clarification-adjacent Assumptions — not guaranteed byte-exact to EPFO/ESIC's proprietary formats).

**Loans**

- **FR-021**: The system MUST auto-generate a month-by-month EMI repayment schedule (EMI, principal,
  interest, remaining balance, status) when a loan is created, and MUST compute a loan's Total Paid
  and Outstanding Balance from that schedule's actual entries, never as independently stored fields.
- **FR-022**: The system MUST include every employee's Active loan's current-cycle EMI as a payroll
  deduction during generation (FR-014), and MUST advance the corresponding schedule entry to Paid
  and the loan to Closed (if it was the final entry) when that payroll run reaches Processed.

**Daily Worker Registry**

- **FR-023**: The system MUST provide a Daily Worker enrolment action (name, phone, gender, site,
  trade/skill, wage rate, 3–5 photos, supervisor-attested consent) restricted to a caller whose role
  holds the Daily Worker Registry permission and who is assigned to the target site, storing no
  login credential or statutory identifier.
- **FR-024**: The system MUST derive a face template for a Daily Worker using the same biometric
  computation as Employee enrolment (003's `BiometricsService`), scoped to a separate Daily Worker
  record, never merged into the Employee/FaceEnrolment tables.
- **FR-025**: The system MUST provide a Daily Worker attendance-marking action (face-match or manual
  selection, with photo/GPS/timestamp/marking-supervisor captured when available) restricted to a
  supervisor assigned to that worker's site, supporting marking multiple workers in one session.
- **FR-026**: The system MUST tag Daily Worker attendance distinctly from Employee attendance while
  including it in the same site-level headcount aggregates the Dashboard/Site Dashboard features
  (004) read, and MUST exclude Daily Workers entirely from payroll generation (FR-014/FR-018).
- **FR-027**: The system MUST deactivate a Daily Worker (excluding them from the active attendance-
  capture roster while preserving historical records) and MUST support converting a Daily Worker to
  a full Employee record that carries forward their existing photos/face template rather than
  requiring re-enrolment.
- **FR-028**: The system MUST provide a per-site/period Daily Worker wage payout summary (worker,
  days present, rate, total) explicitly outside the statutory payroll pipeline.

**Cross-cutting**

- **FR-029**: The system MUST provide an admin queue view over 003's existing re-enrolment-request
  data (employee, site, reason, requested-on, status), without altering 003's approve/reject/unlock
  logic.
- **FR-030**: Every endpoint in this feature MUST accept and return validated, typed request/
  response structures, be scoped to the caller's company (with the existing Super Admin cross-
  company exception), and log every create/update/delete action to the audit log with the acting
  admin's identity.

### Key Entities

- **Employee (extended)**: My Workspace's minimal record (003) plus the full Identity/Employment/
  Statutory/Pay & Bank/Contact field set, Letters toggles, and a 7-item Onboarding checklist.
- **Employee Document**: One uploaded file linked to an employee and a Settings Document Type
  (002), with optional number/expiry.
- **Employee Transfer (history)**: One record of a completed cross-company move — from/to company,
  date, reason, code-retention choice.
- **Attendance Record (admin-editable)**: The same underlying data as 003's `PunchRecord`, now also
  directly creatable/editable by an admin, with every edit captured in the Modifications audit.
- **Attendance Modification (audit)**: One logged edit — employee, date, actor, before/after
  values, timestamp.
- **Holiday**: Name, date, type (National/Regional/Company), applicability (all sites or a specific
  list) — supersedes 003's flat `Site.holidays` array.
- **Payroll Run**: Extends 003's status-only stub with real per-employee line items (earnings,
  deductions, net pay) and the Draft/Processed/Paid lifecycle.
- **Payroll Line Item**: One employee's computed figures within one Payroll Run.
- **Challan (PF / ESIC / PT)**: A derived, read-only view over a Processed/Paid Payroll Run's line
  items, grouped and formatted per statutory requirement — not independently stored.
- **Loan**: Employee, amount, EMI, disbursement date, reason, status, with an auto-generated
  repayment schedule.
- **Loan Repayment Schedule Entry**: One month's EMI/principal/interest/remaining-balance/status
  row within a Loan.
- **Daily Worker**: A lightweight, non-Employee, non-login worker record — name, phone, gender,
  site, trade, wage rate, face template/photos, consent attestation, status.
- **Daily Worker Attendance**: One day's presence record for a Daily Worker — photo (optional),
  GPS, timestamp, marking supervisor, status.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Payroll generation for 100 employees completes in under 30 minutes end-to-end
  (generation + review), per the PRD's own target.
- **SC-002**: Across all testing, zero attendance-marking actions (self-service or admin) succeed
  for an employee missing a Mandatory document type.
- **SC-003**: Across all testing, zero edits succeed against a Processed or Paid payroll run's
  original figures — 100% of corrections appear as new adjustment entries.
- **SC-004**: Across all testing, every PF/ESIC/PT challan figure traces exactly to its source
  Payroll Run's own stored line items — zero independent recomputation drift.
- **SC-005**: Across all testing, zero Daily Workers appear in any Payroll Run.
- **SC-006**: Across all testing, an employee's Aadhaar/PAN/bank-account/UAN value is never
  returned unmasked without a corresponding access-log entry.
- **SC-007**: 100% of loans' Total Paid/Outstanding Balance figures match an independent
  hand-computation from their repayment schedule, in testing.
- **SC-008**: Daily worker enrolment (form submission through confirmation) completes in under 2
  minutes; attendance marking completes in under 15 seconds per worker, per the PRD's own targets.
- **SC-009**: Across all testing, zero cross-site Daily Worker enrolment/attendance actions succeed
  for a supervisor not assigned to that site.
- **SC-010**: F&F settlement computation matches hand-calculation of pending salary + EL
  encashment + loan recovery for a test employee across all testing.
- **SC-011**: Reimbursement claims in `rejected` or `draft` status never appear in payroll runs
  or the payment queue across all testing.

## Assumptions

- Per the confirmed scope decisions: TDS is a manual per-run entry (no slab calculation built);
  document virus scanning is deferred as a tracked gap, not implemented.
- **Reimbursement Categories** is a new Settings master added by this feature to `settings.Company`
  scope: `{ id, companyId, name, receiptRequired (bool), maxAmount (decimal?) }`. This feature
  adds the Prisma model and the Settings endpoints to manage it; the `hr` module reads via
  `SettingsService.getReimbursementCategories(companyId)`.
- F&F settlement: leave encashment rate = employee's `basic / 26` per day (standard); loan
  recovery = remaining loan outstanding balance; pro-rated salary = (days worked / month days) ×
  monthly gross. These are computed by the F&F service, not configurable rates.
- This feature extends, never redefines, the entities My Workspace (003) and Settings (002) already
  specced — `Employee`, `Site`, `PunchRecord`, `LeaveApplication`/`LeaveBalance`, `PayrollRun`,
  `ReEnrolmentRequest` (003) and `Company`, `Department`, `Designation`, `DocumentType`, `Shift`,
  employee-code-series (002) — Employee Setup (Code Series/Departments/Designations/Document Types/
  Shifts) is explicitly out of scope here since Settings already built it.
- Government-prescribed challan file formats (EPFO ECR, ESIC) and bank-specific NEFT/RTGS batch
  formats are approximated as structured, correctly-columned exports (`exceljs`/`pdfkit`) rather
  than verified byte-exact conformance to any one portal/bank's proprietary spec — achieving exact
  conformance would require integration testing against live external systems, out of scope for
  this spec-only pass; refining a specific format is expected as a follow-up once a real
  bank/statutory-portal integration is prioritized.
- Employee-side PF (12%) and ESIC (0.75%) percentages, and employer-side PF (3.67%)/EPS (8.33%)/
  EDLI (0.5%)/Admin Charges (0.5%)/ESIC (3.25%) percentages are the PRD's own stated current
  statutory rates; PT is slab-based and company/state-configured (no universal default exists).
  Gratuity/Bonus employer-contribution rates reuse Settings' existing per-company configurable
  fields (002); the OT multiplier (FR-014a) is a new company-configurable field added to that same
  Settings' Company payroll-settings group, per clarification.
- Daily Worker consent is a supervisor attestation (supervisor identity + timestamp), not a digital
  signature or the employee-grade consent-method/acknowledgement pair Employee Face Enrolment (003)
  uses — a deliberately lighter-weight model matching the PRD's own "simplified on-site consent"
  wording for a highly transient population.
- "Site Supervisor" continues to mean any user whose role holds the Daily Worker Registry
  permission (Settings' existing fixed permission enum, 002), consistent with how this repo has
  resolved that PRD phrase in every prior feature.
