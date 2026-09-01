# Feature Specification: Labour Management Backend (Wage Masters, Supervisor Attendance, Muster, Cash Payment Sheets)

**Feature Branch**: `013-labour-management-backend`

**Created**: 2026-09-01

**Status**: Draft

**Input**: User description: "Labour Management module for the BuildCore API backend, closing the
gaps identified by the module/submodule matrix rows 11, 12, 15, and 18: 'Labour Attendance by GPS
Photo and Geo Fencing captured by Supervisor' and 'Payment Sheet' under My Workspace; 'Labour Wages
Creation Per Project' under Employee Master; and 'Labour Payment Sheet Per Project Cash' under
Payroll. Feature 005 (HR & Payroll) has a Daily Worker registry (US9, FR-023 to FR-028) that
registers workers, derives a face template, marks attendance, and produces a wage payout summary —
but it has no per-project wage rate master (every worker carries a single flat rate), no supervisor
mobile capture flow (005's marking is an admin desk action, while the matrix requires the same
GPS + photo + geofence discipline feature 003 applies to employees), no contractor/gang structure,
no overtime or attendance-type semantics for labour, and no cash payment sheet with denomination
breakup, disbursement recording, and thumb-impression acknowledgement. This feature owns the
`labour` schema and supersedes 005's Daily Worker surfaces."

**Supersession note**: this feature supersedes feature 005's US9 (Daily Worker Registry, FR-023 to
FR-028). The `DailyWorker` entity and its attendance and payout-summary surfaces move to the
`labour` schema and are extended here. Feature 005's spec is amended in the same pass to point at
this feature rather than retaining a second, thinner definition of the same records. The biometric
enrolment and face-match machinery is reused from feature 003 unchanged — this feature does not
re-specify it.

**Why its own feature rather than amendments**: the labour surfaces span three existing features
(003's mobile capture discipline, 005's registry and payroll, 008's project/site structure) and
introduce their own entities (wage rate masters, contractors and gangs, muster rolls, payment
sheets, denomination breakups). Splitting them across amendments to 003 and 005 would leave no
single owner for those entities.

## Clarifications

### Session 2026-09-01

- Q: Is a labour wage rate set per worker, per project, per skill category, or some combination? →
  A: Per project, per skill category, effective-dated — the same non-overlapping effective-dated
  history pattern feature 006 FR-014 uses for equipment hire rates. A worker inherits the rate for
  their skill category at the project they worked at on that date. An individual worker may carry
  an optional rate override that takes precedence, for a worker paid above the standard rate.
- Q: Are labour workers employed directly or through contractors? → A: Both. A worker is either
  `direct` (company-engaged, paid directly from the cash payment sheet) or `contractor` (engaged
  through a contractor from feature 007's Contractor Vault, where the payment sheet is the basis of
  the contractor's bill rather than a direct cash disbursement). The distinction changes who gets
  paid, not how attendance is captured.
- Q: Does supervisor labour attendance use the same face-match as employee punch in feature 003? →
  A: The same enrolment and face-match machinery, but a different capture pattern. An employee
  punches for themselves (self-capture, one punch-in and one punch-out per day). A supervisor
  captures a *muster* — a batch of workers marked present in one session, each with their own photo,
  under one GPS reading validated against the site geofence. Face match is advisory for labour, not
  blocking, because site conditions make it unreliable; a low-confidence match is recorded and
  flagged for review rather than rejected.
- Q: Is labour attendance half-day/overtime aware? → A: Yes. Each muster line records an attendance
  type (`full_day`, `half_day`, `absent`, `overtime_only`) plus optional overtime hours. Wage is
  computed as the day fraction times the applicable daily rate, plus overtime hours times the
  overtime rate derived from the daily rate and the company's configured OT multiplier — reusing
  005 FR-014a's existing company-level OT multiplier setting rather than adding a second one.
- Q: How is the cash payment sheet settled — one sheet per project per period? → A: One sheet per
  project, per wage period, per engagement type. The period is the company's configured labour wage
  cycle (weekly, fortnightly, or monthly, defaulting to weekly), independent of the monthly salary
  payroll cycle. A sheet is generated from approved muster rolls, frozen on approval, then
  disbursed line by line with acknowledgement.
- Q: Does labour cost flow into payroll runs or stay separate? → A: Separate. Labour is not part of
  the monthly `PayrollRun` — these are not employees on the salary register. Labour cost reaches
  the rest of the system through the Project P&L service method, the same way machinery,
  subcontractor, and material costs do.

### Session 2026-09-01 (ratification — gap-closure clarify pass)

- Q: Should this feature take over feature 005's Daily Worker registry, or extend it in place? → A:
  Supersede it — one owner, one definition, with migration of any existing code accepted as the cost.
- Q: Should face match block a labour muster line, or only flag it? → A: Advisory only — a
  below-threshold match is recorded and flagged for review, never blocked. Site conditions make
  labour face match unreliable, and the real controls are the captured photo, the GPS geofence, and
  the supervisor's identity.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Maintain labour masters: skill categories and per-project wage rates (Priority: P1)

An admin configures skill categories (Mason, Carpenter, Bar Bender, Helper, Fitter, Operator) and,
for each project, the daily wage rate per skill category with an effective-from date. Rates form a
non-overlapping history so any past date resolves to exactly one rate.

**Why this priority**: Nothing can be costed without a rate, and the matrix names "Labour Wages
Creation Per Project" explicitly as the missing master. No dependencies beyond Settings and
Projects.

**Independent Test**: Create a Mason skill category, set a ₹800/day rate for project A effective
1 Jan, then a ₹850 rate effective 1 Mar; confirm resolving the rate for 15 Feb returns ₹800 and for
15 Mar returns ₹850, and that the 1 Jan rate's effective-to was automatically closed.

**Acceptance Scenarios**:

1. **Given** an admin session, **When** `POST /settings/skill-categories` is called with `name`,
   `code`, and optional `defaultDailyRate`, **Then** the skill category is created.
2. **Given** a skill category with linked workers, **When** `DELETE /settings/skill-categories/:id`
   is attempted, **Then** `409 Conflict`.
3. **Given** a project and skill category, **When** `POST /labour/wage-rates` is called with
   `projectId`, `skillCategoryId`, `dailyRate`, and `effectiveFrom`, **Then** the rate is created and
   any prior open-ended rate for that project and skill category has its `effectiveTo` set to the day
   before the new `effectiveFrom`, preserving a non-overlapping effective-dated history — the same
   pattern 006 FR-014 uses for hire rates.
4. **Given** an existing rate, **When** a new rate is created with an `effectiveFrom` earlier than
   the existing rate's `effectiveFrom`, **Then** `400 Bad Request` — rates are appended forward, and
   a historical correction requires an explicit amendment endpoint.
5. **Given** a wage rate whose period overlaps approved muster rolls, **When** it is edited, **Then**
   `409 Conflict` — a rate that has already priced approved attendance is immutable.
6. **Given** a worker with a `rateOverride`, **When** their wage is computed for a date, **Then** the
   override takes precedence over the project rate, and the payment sheet line records which source
   was used.
7. **Given** a project with no rate configured for a worker's skill category on a worked date,
   **When** the payment sheet is generated, **Then** generation fails with `409 Conflict` naming the
   missing project, skill category, and date rather than silently costing at zero.
8. **Given** the rate list, **When** `GET /labour/wage-rates?projectId=&skillCategoryId=&asOf=`,
   **Then** the rates in force on that date are returned, and without `asOf`, the full history.

---

### User Story 2 - Register labour workers and contractors (Priority: P1)

A site admin registers labour workers with their identity details, skill category, engagement type,
site, and — for contractor-engaged workers — the contractor they work under. Workers may be grouped
into gangs under a gang leader for faster muster capture.

**Why this priority**: The worker record is what attendance and payment attach to. Supersedes 005's
thinner Daily Worker registration. Depends on US1 for skill categories.

**Independent Test**: Register a direct Mason at a site, register a contractor-engaged Helper under
a contractor from the Contractor Vault, confirm both appear in the site's active worker list with
their correct engagement type — without any attendance existing.

**Acceptance Scenarios**:

1. **Given** an admin session, **When** `POST /labour/workers` is called with `fullName`, `phone`,
   `gender`, `dateOfBirth`, `skillCategoryId`, `engagementType` (direct|contractor),
   `contractorId` (required when contractor), `siteId`, optional `aadhaarNumber`, optional
   `bankAccount`, and optional `rateOverride`, **Then** the worker is created with an auto-generated
   `labourCode` and `status: 'active'`.
2. **Given** `engagementType: 'contractor'` with no `contractorId`, **When** creation is attempted,
   **Then** `400 Bad Request`.
3. **Given** a `contractorId`, **When** it does not resolve to an active contractor via
   `PartnersService`, **Then** `400 Bad Request`.
4. **Given** a worker list request, **When** `GET /labour/workers?siteId=&skillCategoryId=&status=&search=`,
   **Then** paginated results are returned with `aadhaarNumber` and `bankAccount` masked to their
   last 4 characters, matching 005 FR-003's PII masking rule.
5. **Given** a worker, **When** face enrolment is submitted, **Then** it reuses feature 003's
   enrolment machinery unchanged (photos, template derivation, encryption at rest) with no
   duplicate implementation.
6. **Given** a worker with an `aadhaarNumber` already registered as active in the company, **When**
   creation is attempted, **Then** `409 Conflict` identifying the existing worker.
7. **Given** an admin session, **When** `POST /labour/gangs` is called with `name`,
   `gangLeaderWorkerId`, `siteId`, and `memberWorkerIds[]`, **Then** the gang is created and its
   members become selectable as a batch during muster capture.
8. **Given** a worker in a gang, **When** they are added to a second gang, **Then** `409 Conflict` —
   a worker belongs to at most one gang at a time.
9. **Given** an active worker, **When** `PATCH /labour/workers/:id/deactivate` is called with a
   `reason` and `lastWorkingDate`, **Then** the worker becomes inactive, is removed from their gang,
   and is excluded from future muster rolls while remaining in historical ones.
10. **Given** a worker with unsettled payment sheet lines, **When** deactivation is attempted,
    **Then** it succeeds but the worker is flagged `settlementPending` in the payment report.

---

### User Story 3 - Supervisor captures labour attendance with GPS, photo, and geofence (Priority: P1)

A supervisor at the site opens a muster session on their mobile app, is validated against the site's
geofence by GPS, and marks each present worker with a captured photo and an attendance type. The
whole batch is submitted as one muster roll for that site and date.

**Why this priority**: This is the matrix's headline missing item (row 11) and the module's primary
daily operation. It depends on workers (US2) existing.

**Independent Test**: As a supervisor inside a site's geofence, open a muster session, mark three
workers present with photos, submit, and confirm one muster roll exists for that site and date with
three lines and a recorded GPS reading — without any wage being computed.

**Acceptance Scenarios**:

1. **Given** a supervisor assigned to a site, **When** `POST /labour/musters` is called with
   `siteId`, `date`, `latitude`, `longitude`, and `accuracyMetres`, **Then** a muster session opens
   with `status: 'draft'` and the GPS reading is validated against the site's configured geofence.
2. **Given** a GPS reading outside the site geofence, **When** a muster is opened, **Then** the
   muster is still created but flagged `geofenceViolation: true` with the computed distance, and it
   requires supervisor-level approval to be approved — matching how 003 FR-007 records rather than
   discards out-of-fence punches.
3. **Given** a GPS reading whose `accuracyMetres` exceeds the configured maximum, **When** a muster
   is opened, **Then** it is flagged `lowGpsAccuracy` and treated the same way as a geofence
   violation for approval purposes.
4. **Given** an open muster, **When** `POST /labour/musters/:id/lines` is called with `workerId`,
   `attendanceType` (full_day|half_day|absent|overtime_only), optional `overtimeHours`, and a
   captured photo, **Then** the line is recorded with the photo stored as an encrypted
   object-storage reference and an advisory face-match result.
5. **Given** a muster line whose face match falls below the configured confidence threshold, **When**
   it is recorded, **Then** the line is accepted and flagged `faceMatchLow` for review — face match
   is advisory for labour, never blocking.
6. **Given** a muster line for a worker not active at that site on that date, **When** it is added,
   **Then** `400 Bad Request`.
7. **Given** a muster line with `attendanceType: 'overtime_only'` and no `overtimeHours`, **When**
   it is added, **Then** `400 Bad Request`.
8. **Given** a gang, **When** `POST /labour/musters/:id/lines/bulk` is called with a `gangId` and a
   default attendance type, **Then** a line is created for every active gang member, each still
   requiring its own photo before submission.
9. **Given** a draft muster, **When** `PATCH /labour/musters/:id/submit` is called, **Then** the
   muster becomes `submitted`, its lines become immutable, and it enters the approval queue.
10. **Given** an existing submitted or approved muster for the same site and date, **When** a second
    muster is submitted for that site and date, **Then** `409 Conflict` — one muster roll per site
    per day.
11. **Given** a worker already marked on another site's muster for the same date, **When** they are
    added to this muster, **Then** `409 Conflict` naming the other site — a worker cannot be present
    at two sites on one day.
12. **Given** a muster submitted with a captured timestamp preceding the request time (an offline
    sync), **When** it is received, **Then** it is accepted and tagged as offline-synced with both
    timestamps retained, matching 003 FR-012's treatment of offline punches.
13. **Given** a muster for a date outside the configured backdating window, **When** submission is
    attempted, **Then** `400 Bad Request`, matching 003 FR-010's backdating rule.

---

### User Story 4 - Approve muster rolls (Priority: P1)

A project manager reviews submitted muster rolls — particularly those flagged for geofence
violation, low GPS accuracy, or low face match — and approves or returns them. Only approved musters
price into a payment sheet.

**Why this priority**: Approval is the control that makes cash disbursement defensible, and no
payment sheet can be generated without it. Depends on US3.

**Independent Test**: Submit a muster with one geofence-violation flag, approve it as a manager, and
confirm its status becomes `approved` and it becomes eligible for payment sheet generation — without
generating a sheet.

**Acceptance Scenarios**:

1. **Given** a submitted muster, **When** `PATCH /labour/musters/:id/approve` is called by a holder
   of `LABOUR_APPROVE`, **Then** the muster becomes `approved` and its lines become eligible for
   payment sheet inclusion.
2. **Given** a submitted muster with any flagged line or muster-level flag, **When** approval is
   attempted by a caller without `LABOUR_APPROVE`, **Then** `403 Forbidden`.
3. **Given** a submitted muster, **When** `PATCH /labour/musters/:id/return` is called with a
   `reason`, **Then** it returns to `draft`, its lines become editable again, and the supervisor is
   notified.
4. **Given** an approved muster, **When** any edit to its lines is attempted, **Then** `409
   Conflict`.
5. **Given** an approved muster included in a frozen payment sheet, **When** un-approval is
   attempted, **Then** `409 Conflict` naming the payment sheet.
6. **Given** an approval queue request, **When**
   `GET /labour/musters?status=submitted&siteId=&flagged=true`, **Then** submitted musters are
   returned with their flag counts, supervisor, and line count, sorted oldest first.
7. **Given** an approved muster, **When** it is read, **Then** each line shows attendance type,
   overtime hours, face-match result, photo reference, and the resolved wage rate that would apply.

---

### User Story 5 - Generate cash payment sheets per project (Priority: P1)

At the end of a wage period, an admin generates a payment sheet for a project: every approved muster
line in the period is priced against the applicable wage rate, aggregated per worker into days
worked, overtime, gross wage, deductions (advances, fines), and net payable. Direct-engagement
sheets carry a cash denomination breakup; contractor-engagement sheets become the basis of the
contractor's bill.

**Why this priority**: This is the matrix's "Payment Sheet" (row 12) and "Labour Payment Sheet Per
Project Cash" (row 18). It is the module's financial output. Depends on US1 and US4.

**Independent Test**: With approved musters covering one week at a project, generate the payment
sheet and confirm each worker's days worked, gross, and net reconcile against the muster lines and
the wage rates in force on each date.

**Acceptance Scenarios**:

1. **Given** approved musters for a project in a wage period, **When** `POST /labour/payment-sheets`
   is called with `projectId`, `periodFrom`, `periodTo`, and `engagementType`, **Then** a sheet is
   generated with one line per worker aggregating days worked (full days plus half days as 0.5),
   overtime hours, gross wage, deductions, and net payable, with `status: 'draft'`.
2. **Given** a payment sheet line, **When** the gross wage is computed, **Then** it equals the sum
   over each worked date of `dayFraction × applicableDailyRate`, plus
   `overtimeHours × (applicableDailyRate / configuredStandardHours) × companyOtMultiplier`, using
   the company OT multiplier already defined by 005 FR-014a rather than a second setting.
3. **Given** a worked date with no applicable wage rate, **When** generation is attempted, **Then**
   `409 Conflict` naming the project, skill category, and date.
4. **Given** a worker with outstanding labour advances, **When** the sheet is generated, **Then** the
   configured recovery instalment is included as a deduction line and the advance's outstanding
   balance is reduced only on disbursement, not on generation.
5. **Given** a period overlapping an existing sheet for the same project and engagement type,
   **When** generation is attempted, **Then** `409 Conflict` naming the existing sheet.
6. **Given** a draft sheet, **When** `PATCH /labour/payment-sheets/:id/approve` is called by a holder
   of `LABOUR_APPROVE`, **Then** the sheet becomes `approved` and every figure on it becomes
   immutable, matching how 005 FR-015 freezes a processed payroll run.
7. **Given** an approved direct-engagement sheet, **When** `GET /labour/payment-sheets/:id/denominations`,
   **Then** the cash denomination breakup is returned — the count of each currency denomination
   needed to disburse the total net payable, minimising the note count.
8. **Given** an approved sheet whose net payable is not fully expressible in available denominations,
   **When** the breakup is computed, **Then** the residual rounding amount is reported per worker and
   carried forward to the next period rather than silently dropped.
9. **Given** an approved contractor-engagement sheet, **When** it is read, **Then** it is grouped by
   contractor with each contractor's total, forming the basis of that contractor's bill, and no cash
   denomination breakup is produced.
10. **Given** an approved sheet, **When** `?format=xlsx` or `?format=pdf` is requested, **Then** a
    real file is produced using the project's existing export libraries.

---

### User Story 6 - Disburse payments and record acknowledgement (Priority: P2)

A disbursing officer pays each worker on an approved sheet — in cash, or by bank transfer where the
worker has an account — and records acknowledgement, capturing a thumb impression or signature image
for cash payments. The sheet closes when every line is settled.

**Why this priority**: Disbursement with acknowledgement is what makes a cash payment sheet
auditable. Depends on US5.

**Independent Test**: Disburse two of three lines on an approved sheet with thumb impressions,
confirm the sheet shows `partially_disbursed` with the correct outstanding total, then disburse the
third and confirm it closes.

**Acceptance Scenarios**:

1. **Given** an approved sheet line, **When** `PATCH /labour/payment-sheets/lines/:id/disburse` is
   called with `paymentMode` (cash|bank), `paidOn`, `paidAmount`, and — for cash — an acknowledgement
   image, **Then** the line becomes `disbursed`, the acknowledgement is stored as an encrypted
   object-storage reference, and any advance recovery on that line is applied to the advance's
   outstanding balance.
2. **Given** a cash disbursement with no acknowledgement image, **When** it is attempted, **Then**
   `400 Bad Request`.
3. **Given** a bank disbursement for a worker with no recorded bank account, **When** it is
   attempted, **Then** `400 Bad Request`.
4. **Given** a `paidAmount` that differs from the line's `netPayable`, **When** disbursement is
   attempted, **Then** it is rejected unless a `shortPaymentReason` is supplied, in which case the
   difference is carried forward as an unpaid balance to the next period.
5. **Given** a partially disbursed sheet, **When** it is read, **Then** `disbursedCount`,
   `pendingCount`, `disbursedAmount`, and `outstandingAmount` are returned.
6. **Given** every line disbursed, **When** the last line settles, **Then** the sheet's status
   becomes `closed` and its closure date is recorded.
7. **Given** a disbursed line, **When** reversal is attempted by a holder of `LABOUR_APPROVE` with a
   reason, **Then** the line returns to pending, the advance recovery is reversed, and both actions
   are audit-logged; a line on a `closed` sheet cannot be reversed without reopening the sheet.
8. **Given** an approved sheet older than a configurable ageing threshold with pending lines, **When**
   the sheet list is read, **Then** it is flagged `disbursementOverdue`.

---

### User Story 7 - Labour advances (Priority: P2)

A worker takes an advance against future wages. The advance is approved, disbursed, and recovered in
instalments through subsequent payment sheets until its balance is cleared.

**Why this priority**: Advances against daily wages are routine on sites and the payment sheet's
deduction line is meaningless without them. Depends on US2, and its recovery integrates with US5.

**Independent Test**: Grant a ₹3,000 advance to a worker recoverable in 3 instalments, generate the
next payment sheet, and confirm a ₹1,000 deduction line appears and the outstanding balance falls to
₹2,000 only after that line is disbursed.

**Acceptance Scenarios**:

1. **Given** an active worker, **When** `POST /labour/advances` is called with `workerId`, `amount`,
   `reason`, `recoveryInstalments`, and `recoveryStartPeriod`, **Then** the advance is created with
   `status: 'pending'` and a computed per-instalment recovery amount.
2. **Given** a pending advance, **When** `PATCH /labour/advances/:id/approve` is called by a holder
   of `LABOUR_APPROVE`, **Then** it becomes `approved` and eligible for disbursement.
3. **Given** an advance whose amount exceeds a configurable multiple of the worker's applicable
   daily rate, **When** it is created, **Then** it is flagged `exceedsLimit` and requires
   `LABOUR_APPROVE` to be approved.
4. **Given** an approved advance, **When** it is disbursed, **Then** its `outstandingBalance` equals
   the full amount and recovery begins from the configured start period.
5. **Given** a worker with an outstanding advance, **When** a payment sheet is generated for a period
   at or after the recovery start, **Then** the instalment appears as a deduction line, capped at the
   worker's gross wage for that period so net payable never goes negative.
6. **Given** a period where the instalment was capped, **When** recovery continues, **Then** the
   uncovered remainder extends the recovery into subsequent periods rather than being written off.
7. **Given** an advance fully recovered, **When** its balance reaches zero, **Then** its status
   becomes `closed`.
8. **Given** a worker with an outstanding advance who is deactivated, **When** the advance list is
   read, **Then** the advance is flagged `recoveryAtRisk` with the outstanding balance.

---

### User Story 8 - Labour reports and Project P&L contribution (Priority: P3)

Managers view labour deployment and cost reports — headcount by skill category and site over time,
attendance percentage, cost per project — and feature 008's Project P&L calls into this module for
labour cost, alongside material, machinery, and subcontractor cost.

**Why this priority**: A cross-module integration mirroring the pattern 006, 007, 009, and 012
follow. Every underlying record must exist first.

**Independent Test**: With one week of approved musters and a closed payment sheet at a project,
call the labour cost method for that week and confirm it equals the sheet's gross wage total.

**Acceptance Scenarios**:

1. **Given** approved musters in a range, **When**
   `LabourService.getLabourCostByProject(projectId, dateRange)` is called, **Then** it returns the
   gross wage total for that project's approved muster lines in the range, split into direct and
   contractor engagement, and is the only path by which feature 008 reads labour data.
2. **Given** a range partially covered by an unapproved muster, **When** the cost is computed,
   **Then** only approved musters contribute and the response reports the count of unapproved
   musters excluded, so the P&L consumer can flag incompleteness.
3. **Given** a period and project, **When**
   `GET /labour/reports/deployment?projectId=&from=&to=&groupBy=skill|site|contractor`, **Then**
   headcount and man-days are returned per group per day with period totals.
4. **Given** a period, **When** `GET /labour/reports/attendance?siteId=&from=&to=`, **Then** each
   worker's days present, half days, absent days, overtime hours, and attendance percentage are
   returned.
5. **Given** a period, **When** `GET /labour/reports/payment-register?projectId=&from=&to=`, **Then**
   every payment sheet line in the period is returned with worker, days, gross, deductions, net,
   payment mode, and disbursement status — the labour equivalent of a salary register.
6. **Given** any labour report, **When** `?format=xlsx` or `?format=pdf` is requested, **Then** a
   real file is produced, generated asynchronously as a background job above the configured row
   threshold, matching 004 FR-021.
7. **Given** a caller without `REPORTS`, **When** any labour report is requested, **Then** `403
   Forbidden`.
8. **Given** a contractor with labour at a project, **When** the deployment report is grouped by
   contractor, **Then** the figures reconcile with what feature 007's subcontractor cost method
   reports for the same contractor and period, or the discrepancy is explicitly reported.

---

### Edge Cases

- A supervisor's device has no GPS fix at all → the muster cannot be opened; the supervisor must
  either wait for a fix or the muster must be captured by an admin at the desk, which is recorded
  with `source: 'admin_entry'` and always requires approval.
- A worker is marked present on a muster, and the muster is later returned to draft and the worker
  removed → the removal is retained in muster line history so an approved-then-returned sequence is
  reconstructable.
- A wage rate is created for a project after musters for that period were already approved but before
  the payment sheet is generated → the rate resolves by worked date, so the newly created rate
  applies only from its effective date forward; earlier dates still fail generation if uncovered.
- A worker changes skill category mid-period → the payment sheet prices each date against the skill
  category recorded on that date's muster line, not the worker's current category.
- A worker is transferred between sites mid-period → their muster lines follow the site they were
  marked at, and the payment sheet attributes each date's cost to that date's project.
- Two supervisors submit musters for the same site and date concurrently → the uniqueness check is
  applied under a row-level lock; the second receives `409 Conflict`.
- A payment sheet is approved and then a muster in its period is discovered to be wrong → the sheet
  must be reopened by a holder of `LABOUR_APPROVE` with a reason (only while no line is disbursed),
  which un-approves the sheet and releases its musters; a sheet with disbursed lines cannot be
  reopened and requires a correcting adjustment in the next period.
- A worker's net payable is zero or negative after advance recovery → the deduction is capped so net
  is never negative, and the shortfall carries forward (FR-024).
- Cash denominations available do not cover the exact amount → the residual is reported and carried
  forward per FR-027, never silently rounded away.
- A contractor is deactivated in feature 007 while their workers have open payment sheets → the
  sheets remain settleable and the contractor name resolves with an `inactive` marker.
- The same worker is registered twice under different Aadhaar spellings → only the exact-match
  duplicate check catches it; fuzzy identity resolution is out of scope.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: All `labour` schema tables MUST carry `companyId` with RLS enforcing tenant isolation,
  following the constitution's multi-tenant isolation principle.
- **FR-002**: This feature MUST supersede feature 005's Daily Worker surfaces (005 US9, FR-023 to
  FR-028); the worker registry, attendance, and payout summary MUST have exactly one definition,
  owned here, and feature 005's spec MUST be amended to reference this feature rather than retaining
  a parallel definition.
- **FR-003**: Skill Categories MUST live in the `settings` schema, matching how every other module's
  reference-data masters are Settings-owned in this project; wage rates, workers, gangs, musters,
  payment sheets, and advances live in `labour`.
- **FR-004**: Wage rates MUST be maintained as a non-overlapping, effective-dated history per
  project and skill category — creating a rate MUST automatically close the prior open-ended rate's
  `effectiveTo` to the day before the new `effectiveFrom` — using the same pattern 006 FR-014 uses
  for equipment hire rates.
- **FR-005**: A wage rate MUST be immutable once it has priced any approved muster; edits MUST be
  rejected with `409 Conflict`, and backdating a rate before an existing rate's `effectiveFrom` MUST
  be rejected with `400 Bad Request`.
- **FR-006**: Wage rate resolution for a worked date MUST prefer the worker's `rateOverride` when set,
  otherwise the project-and-skill-category rate in force on that date; the payment sheet line MUST
  record which source was used.
- **FR-007**: Payment sheet generation MUST fail with `409 Conflict` naming the project, skill
  category, and date when any worked date has no applicable rate — it MUST NOT cost the date at
  zero.
- **FR-008**: A worker MUST be either `direct` or `contractor`-engaged; a contractor-engaged worker
  MUST carry a `contractorId` resolvable through `PartnersService` to an active contractor, with no
  direct cross-schema query into the `partners` schema.
- **FR-009**: Worker `aadhaarNumber` and `bankAccount` MUST be masked to their last 4 characters in
  all list responses, matching 005 FR-003's PII masking rule, and unmasked only on the
  single-worker detail endpoint with the access audit-logged.
- **FR-010**: A worker's `aadhaarNumber`, when supplied, MUST be unique among active workers in the
  company; a duplicate MUST be rejected with `409 Conflict` identifying the existing worker.
- **FR-011**: Worker face enrolment MUST reuse feature 003's existing enrolment and face-match
  machinery unchanged — template derivation, encryption at rest, and photo deletion on
  de-enrolment — with no second implementation.
- **FR-012**: A worker MUST belong to at most one gang at a time; adding them to a second gang MUST
  be rejected with `409 Conflict`.
- **FR-013**: Opening a muster MUST validate the supplied GPS reading against the site's configured
  geofence; a reading outside the fence or exceeding the configured accuracy limit MUST be recorded
  and flagged rather than rejected, and MUST require `LABOUR_APPROVE` to be approved — matching how
  003 FR-007 records rather than discards out-of-fence punches.
- **FR-014**: Face match on a muster line MUST be advisory, never blocking: a below-threshold match
  MUST be accepted and flagged `faceMatchLow` for review, because site conditions make labour face
  match unreliable.
- **FR-015**: Every muster line MUST carry a captured photo stored as an encrypted object-storage
  reference, using the same mechanism as 003's biometric blobs, and the system MUST refuse to start
  in production when configured to store these blobs on the local filesystem (matching 003 FR-026a).
- **FR-016**: At most one submitted-or-approved muster may exist per site per date; the uniqueness
  MUST be enforced both in the submission transaction and by a database-level constraint, matching
  how 003 FR-008c enforces the one-punch-pair-per-day rule.
- **FR-017**: A worker MUST NOT appear on more than one site's muster for the same date; the second
  attempt MUST be rejected with `409 Conflict` naming the other site.
- **FR-018**: A muster whose declared capture timestamp precedes the request's receipt time MUST be
  accepted as offline-synced with both timestamps retained, matching 003 FR-012.
- **FR-019**: A muster MUST be rejected when its date falls outside the configured backdating
  window, matching 003 FR-010.
- **FR-020**: Muster lines MUST become immutable on submission and the muster MUST become immutable
  on approval; an approved muster included in an approved payment sheet MUST NOT be un-approvable.
- **FR-021**: Every calendar day this feature reckons MUST use the same company-configured timezone
  basis feature 003 FR-018a establishes, so a muster date, an attendance date, and a wage period
  boundary never disagree.
- **FR-022**: Gross wage MUST be computed as the sum over each worked date of
  `dayFraction × applicableDailyRate` plus
  `overtimeHours × (applicableDailyRate / configuredStandardHours) × companyOtMultiplier`, where
  `dayFraction` is 1 for `full_day`, 0.5 for `half_day`, and 0 for `absent`, and the OT multiplier
  is the company-level payroll setting already defined by 005 FR-014a — not a second setting.
- **FR-023**: A payment sheet MUST be scoped to one project, one wage period, and one engagement
  type; an overlapping sheet for the same combination MUST be rejected with `409 Conflict`.
- **FR-024**: An advance recovery deduction MUST be capped at the worker's gross wage for the period
  so net payable is never negative; the uncovered remainder MUST extend recovery into subsequent
  periods rather than being written off.
- **FR-025**: An advance's `outstandingBalance` MUST be reduced on disbursement of the payment sheet
  line carrying its recovery, not on sheet generation, so an ungenerated or unpaid sheet never
  understates the outstanding balance.
- **FR-026**: An approved payment sheet's figures MUST be immutable, matching how 005 FR-015 freezes
  a processed payroll run; reopening MUST require `LABOUR_APPROVE`, MUST be rejected once any line
  is disbursed, and MUST release the sheet's musters when it succeeds.
- **FR-027**: A direct-engagement sheet MUST produce a cash denomination breakup minimising note
  count for the total net payable, and MUST report any per-worker residual that available
  denominations cannot express, carrying it forward to the next period rather than dropping it.
- **FR-028**: A contractor-engagement sheet MUST be grouped by contractor with per-contractor totals
  and MUST NOT produce a cash denomination breakup.
- **FR-029**: A cash disbursement MUST require an acknowledgement image (thumb impression or
  signature) stored as an encrypted object-storage reference; a bank disbursement MUST require the
  worker to have a recorded bank account.
- **FR-030**: A `paidAmount` differing from the line's `netPayable` MUST be rejected unless a
  `shortPaymentReason` is supplied, in which case the difference carries forward as an unpaid
  balance.
- **FR-031**: A disbursement reversal MUST require `LABOUR_APPROVE` and a reason, MUST reverse any
  advance recovery it applied, and MUST be audit-logged.
- **FR-032**: Labour cost MUST NOT be included in any monthly `PayrollRun` — labour workers are not
  on the salary register; labour cost reaches the rest of the system only through the exported
  Project P&L service method.
- **FR-033**: `LabourService.getLabourCostByProject(projectId, dateRange)` MUST be exported for
  feature 008's Project P&L, returning approved-muster gross wage split by engagement type, and MUST
  report the count of unapproved musters excluded so the consumer can flag incompleteness. It MUST
  be the only path by which 008 reads labour data — no cross-schema query.
- **FR-034**: Site and project resolution MUST go through `ProjectsService.getSitesByProject()` and
  contractor resolution through `PartnersService`, with no direct cross-schema query — matching
  009 FR-011 and FR-012.
- **FR-035**: Muster submission and payment sheet approval MUST be applied under row-level locks so
  concurrent operations cannot both succeed; the losing request MUST receive `409 Conflict`.
- **FR-036**: Workers, musters, payment sheets, and advances MUST NOT be hard-deleted; removal MUST
  be a soft-delete preserving attendance and payment history.
- **FR-037**: Every endpoint in this feature MUST be gated by `JwtAuthGuard` plus a
  `@RequirePermission()` check, using the existing `DAILY_WORKER_REGISTRY` permission for worker and
  muster capture operations, the new `LABOUR_APPROVE` permission for approvals, reopening, and
  reversals, and the existing `REPORTS` permission for report endpoints.
- **FR-038**: The `Permission` enum MUST be extended with exactly one new value — `LABOUR_APPROVE` —
  reusing the already-existing `DAILY_WORKER_REGISTRY` and `REPORTS` values everywhere else rather
  than inventing further values.
- **FR-039**: All write operations MUST be written to the audit log with new entity types
  `LABOUR_WORKER`, `LABOUR_GANG`, `WAGE_RATE`, `MUSTER_ROLL`, `LABOUR_PAYMENT_SHEET`, and
  `LABOUR_ADVANCE`, and every unmasked read of worker PII MUST also be audit-logged.
- **FR-040**: Every endpoint in this feature MUST accept and return validated, typed request/
  response DTOs per the constitution's validated-DTO-contracts principle.
- **FR-041**: The labour wage cycle (weekly, fortnightly, or monthly, defaulting to weekly) MUST be
  a company-level configurable setting, independent of the monthly salary payroll cycle.
- **FR-042**: Report exports MUST produce real XLSX/PDF files using the project's existing export
  libraries and MUST be generated asynchronously as a background job above the configured row
  threshold, matching 004 FR-021.

### Key Entities

- **LabourWorker**: A daily-wage worker. Carries identity and masked PII, skill category,
  engagement type, contractor (when contractor-engaged), site, optional rate override, optional bank
  account, face enrolment reference, and status.
- **LabourGang**: A named group of workers under a gang leader at a site, used to batch muster
  capture. A worker belongs to at most one gang.
- **WageRate**: An effective-dated daily rate for a project and skill category, forming a
  non-overlapping history.
- **MusterRoll**: One site's labour attendance for one date: supervisor, GPS reading, geofence and
  accuracy flags, capture source, offline-sync timestamps, status, and its lines.
- **MusterLine**: One worker's attendance on a muster: attendance type, overtime hours, captured
  photo reference, advisory face-match result and flag, and the skill category recorded on the day.
- **LabourPaymentSheet**: A project's priced wage period for one engagement type: status, period
  bounds, totals, denomination breakup (direct only), contractor grouping (contractor only), and
  its lines.
- **PaymentSheetLine**: One worker's aggregate for the period: days worked, overtime hours, resolved
  rate and its source, gross wage, deductions, net payable, payment mode, disbursement status,
  acknowledgement reference, and any carried-forward balance.
- **LabourAdvance**: An advance against future wages: amount, reason, recovery instalments, recovery
  start period, outstanding balance, status, and risk flags.
- **SkillCategory** *(settings schema)*: The labour skill vocabulary with an optional default daily
  rate.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A supervisor can capture a full site's labour attendance for a day from the mobile app
  in one session, including a photo per worker, without any desk-side re-entry.
- **SC-002**: Every muster line is attributable to a supervisor, a GPS reading, a timestamp, and a
  photo — there is no labour attendance record without all four.
- **SC-003**: Every rupee on a payment sheet is traceable to a specific worker, date, attendance
  type, and the wage rate in force on that date, verified by recomputing a sheet from raw muster
  lines and matching it exactly.
- **SC-004**: No payment sheet can be generated over a date with no applicable wage rate — the
  failure is explicit and names the gap.
- **SC-005**: Every cash disbursement carries an acknowledgement image, verified by a test asserting
  that a cash disbursement without one is rejected.
- **SC-006**: A worker's net payable is never negative, and no advance balance is ever reduced by an
  undisbursed recovery.
- **SC-007**: A worker never appears as present at two sites on the same date, verified under
  concurrent muster submissions.
- **SC-008**: Labour cost recomputed from approved muster lines matches the value the Project P&L
  service method returns exactly, with unapproved musters explicitly excluded and counted.
- **SC-009**: Worker PII never appears unmasked in any list response, verified across every
  worker-listing endpoint.

## Assumptions

- Statutory compliance for labour (PF/ESIC for direct labour, BOCW cess, contract labour registers
  under the CLRA Act) is out of scope here. Contractor-side compliance is already feature 007's
  Contractor Vault and RAG matrix; direct-labour statutory treatment is deferred, and this feature's
  data is structured so a later compliance feature can consume it.
- The mobile client handles offline capture and queueing; this feature specifies only the server's
  acceptance of offline-synced musters, reusing 003's established offline pattern.
- Site geofences are already defined by the `Site` model in the `projects` schema, which feature 003
  already relies on for employee punch validation. This feature adds no new geofence configuration.
- Face match for labour is advisory by design. Sites are dusty, workers wear helmets and masks, and
  a blocking match would stop legitimate attendance. The photo plus GPS plus supervisor identity is
  the control; the face match is a review signal.
- Cash denominations are the standard Indian currency denominations, configurable per company to
  reflect what a site office actually holds.
- Piece-rate and lump-sum labour contracts are out of scope; this feature costs day-rate and
  overtime labour only. A piece-rate variant would extend the wage rate master.
- Worker identity is established by Aadhaar where available; fuzzy or biometric deduplication across
  spelling variants is out of scope.
- Feature 005's US9 is superseded rather than deleted — its spec is amended in the same pass to
  point here, and any implementation already built against it migrates to the `labour` schema.
