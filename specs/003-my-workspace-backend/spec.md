# Feature Specification: My Workspace Backend (Punch, Leave, Salary, Face Enrolment)

**Feature Branch**: `003-my-workspace-backend`

**Created**: 2026-08-27

**Status**: Draft

**Input**: User description: "My Workspace Module (self-service employee portal: My Punch, My
Leave, My Salary Summary, Face Enrolment) for the BuildCore API backend, per the PRD at
/Users/parthgoyal/Projects/ERP-Demo/docs/prd/01-my-workspace.prd.md. This is the API/backend
surface only. Scope decision (already confirmed with the user): since no HR & Payroll admin module
has been specced yet in this repo, this feature defines minimal versions of the Employee, Site
(geofence), Attendance record, Leave type/balance, and Payroll-run-status entities it needs to
function standalone — matching the precedent already set by this repo's Settings feature
(specs/002-settings-backend), which similarly had to define Company because nothing else had. A
future HR & Payroll admin feature will extend/reconcile with these entities later, not redefine
them from scratch."

## Clarifications

### Session 2026-08-27

- Q: Since no HR & Payroll admin module exists yet, should this feature define minimal versions of
  the Employee/Site/Attendance/Leave/Payroll-run entities it needs, or assume they exist elsewhere?
  → A: Define minimal versions now — this feature owns Employee, Site, Attendance record, Leave
  type/balance, and Payroll-run-status as first-class entities; a future HR & Payroll admin feature
  extends/reconciles with these rather than redefining them.
- Q: Should face verification at punch time use in-house-built matching logic, an external
  cloud provider, or a stub? → A: Use an npm face-recognition library running in-process in the
  backend (computing and comparing face embeddings locally) — not a from-scratch trained model, and
  not an external cloud API call.
- Q: Should an offline-queued punch's client-supplied original timestamp be trusted, or held for
  mandatory review? → A: Trust it as the punch's official time, but tag the record "synced from
  offline queue" with the server-received time also recorded, so admins can audit without every
  offline punch requiring approval.
- Q: Does this feature implement the admin-side approve/reject endpoints for Leave Applications and
  Attendance Exceptions, or are those deferred to a future admin feature? → A: This feature
  implements them — an authorized admin can approve/reject a leave application and resolve
  (confirm or reject) a flagged attendance exception through this feature's own endpoints.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Enrol face biometrics (Priority: P1)

An employee captures 3–5 photos of their face, acknowledges biometric consent, and submits — the
system derives and stores a face template used to verify future punches.

**Why this priority**: Punch In/Out's face verification (User Story 2) has nothing to compare
against until an employee has enrolled — this is the true prerequisite, even though the PRD lists
Punch first.

**Independent Test**: Can be fully tested by capturing 3 photos, checking the consent
acknowledgement, submitting, and confirming the enrolment status becomes "Enrolled" with a face
template stored — separately from confirming a punch actually verifies against it.

**Acceptance Scenarios**:

1. **Given** an employee with no prior enrolment, **When** they submit 3–5 captured photos and a
   checked consent acknowledgement (with a selected consent method), **Then** a face template is
   derived and stored, the enrolment status becomes "Enrolled" with today's date, and the raw
   photos and consent record are retained per the biometric retention policy.
2. **Given** fewer than 3 photos or an unchecked consent acknowledgement, **When** enrolment is
   submitted, **Then** the request is rejected before any template is derived or stored.
3. **Given** an employee who is already enrolled, **When** they attempt to submit new photos
   directly (bypassing the re-enrolment request flow), **Then** the request is rejected — only User
   Story 7's granted-unlock path may replace an existing template.
4. **Given** an enrolled employee, **When** they withdraw biometric consent, **Then** their photos
   and face template are permanently deleted within the configured retention-policy window and
   their status reverts to "Not enrolled."

---

### User Story 2 - Punch in/out with face verification and geofence validation (Priority: P1)

An employee at their assigned site captures a live photo and submits a punch; the system verifies
the photo against their enrolled face template, validates their device's GPS location against the
site's geofence, and records the punch — or flags it as an exception for review.

**Why this priority**: The core value proposition of this entire feature — self-service attendance
recording without a supervisor's manual entry.

**Independent Test**: Can be fully tested by submitting a punch-in with a matching face photo and
in-geofence coordinates and confirming a Present-status attendance record is created; then
submitting one with out-of-geofence coordinates and confirming it's recorded but flagged as an
exception instead of silently accepted or silently rejected.

**Acceptance Scenarios**:

1. **Given** an enrolled, active employee inside their assigned site's geofence radius, **When**
   they submit a punch-in with a photo that matches their stored face template above the
   configured confidence threshold, **Then** the punch is recorded with server time, GPS
   coordinates, and a Present-track attendance state.
2. **Given** the same employee later in the day, **When** they submit a matching punch-out,
   **Then** worked hours are computed from the in/out pair and any hours beyond the assigned
   shift's duration are recorded as OT hours.
3. **Given** a punch submitted from outside the assigned site's geofence radius, **When** it's
   processed, **Then** it is still recorded but flagged as a geofence exception routed for
   supervisor/admin review, rather than silently accepted or rejected outright.
4. **Given** a punch whose photo does not match the stored template above the confidence
   threshold, **When** it's processed, **Then** it is recorded but flagged as a face-verification
   exception requiring supervisor override or manual approval before it counts as confirmed
   attendance.
5. **Given** an employee with no enrolled face template, **When** they attempt to punch, **Then**
   the request is rejected with a message directing them to complete enrolment first.
6. **Given** a company whose current period is past its configured payroll lock day for an
   already-processed month, **When** a punch is attempted for a date within that locked period,
   **Then** it is rejected regardless of client-side state.
7. **Given** an employee's monthly attendance history, **When** it's requested for a given month/
   year, **Then** it returns one row per calendar day with date, day-of-week, in/out times, OT
   hours, and status (Present/Absent/Weekly Off/Holiday), reflecting all punches and leave already
   recorded for that employee in that period.
8. **Given** a flagged attendance exception (geofence or face-verification), **When** an authorized
   admin/supervisor resolves it as Confirmed, **Then** the punch counts as Present-track attendance
   going forward; **When** they resolve it as Rejected, **Then** the punch does not count toward
   attendance and the employee is notified.

---

### User Story 3 - View attendance history (Priority: P2)

An employee retrieves their own monthly attendance history for any month/year they choose to view.

**Why this priority**: A read-only extension of User Story 2's data — valuable but not required for
punching itself to work, and naturally comes after punches exist to view.

**Independent Test**: Can be fully tested by requesting a specific month/year's history for an
employee with a mix of punches, leave, and holidays, and confirming each day's status is computed
correctly.

**Acceptance Scenarios**:

1. **Given** a month with punches, an approved leave day, and a company holiday, **When** that
   month's history is requested, **Then** each date shows the correct one of Present/Absent/On
   Leave/Weekly Off/Holiday, consistent with the day's actual recorded events.
2. **Given** a request for a month/year outside where any data exists yet, **When** it's requested,
   **Then** an empty/all-blank result is returned rather than an error.
3. **Given** an employee requesting another employee's attendance history, **When** the request is
   made, **Then** it is rejected — this endpoint only ever returns the caller's own data.

---

### User Story 4 - Apply for and manage leave (Priority: P2)

An employee views their leave balance by type, submits a new leave application (auto-calculating
working days excluding weekends/holidays), views their past/pending applications, and cancels a
still-pending one.

**Why this priority**: A distinct self-service capability independent of punching; valuable on its
own once an employee exists with a leave balance.

**Independent Test**: Can be fully tested by viewing a seeded leave balance, applying for leave
within that balance, confirming the application appears Pending, then cancelling it and confirming
the balance is unaffected (since it was never deducted pre-approval).

**Acceptance Scenarios**:

1. **Given** an employee's leave balances by type (Earned, Casual, Sick, Leave Without Pay),
   **When** requested for a given financial year, **Then** each type shows Opening, Accrued, Used,
   and Balance figures for that year.
2. **Given** a leave application with a From/To date range, **When** submitted, **Then** the number
   of days is computed excluding weekends and the assigned site's configured holidays, and the
   application is created with status Pending.
3. **Given** a leave type other than Leave Without Pay, **When** an application's computed days
   would exceed the employee's current available balance for that type, **Then** the submission is
   rejected before creating the application.
4. **Given** Leave Without Pay, **When** an application is submitted, **Then** it is not checked
   against any balance limit.
5. **Given** a Pending application, **When** the employee cancels it, **Then** its status becomes
   Cancelled and it no longer counts toward any pending total; a non-Pending application's Cancel
   action is rejected.
6. **Given** a Pending application, **When** an authorized admin approves or rejects it (rejection
   requires remarks) through this feature's own endpoint, **Then** the employee's list reflects the
   new status and a notification is queued for them; **When** an application is Approved, **Then**
   the corresponding dates in the employee's attendance history show "On Leave" instead of Absent.

---

### User Story 5 - View and download salary slip (Priority: P2)

An employee selects a month for which payroll has been processed and views (or downloads as a PDF)
their own salary slip.

**Why this priority**: A read-only, self-contained capability; valuable but depends on payroll
having been run for at least one period, which won't be true immediately after go-live.

**Independent Test**: Can be fully tested by requesting the month selector for an employee with one
Processed and one still-Draft payroll period, confirming only the Processed month is offered, then
requesting that month's slip and its PDF.

**Acceptance Scenarios**:

1. **Given** an employee's payroll history, **When** the available-months selector is requested,
   **Then** it includes only months whose payroll run status is Processed or Paid — never Draft or
   unprocessed months.
2. **Given** a Processed/Paid month, **When** its slip is requested, **Then** the response includes
   employee info, attendance summary (Month Days, Payable Days, LOP Days, OT Hours), earnings,
   deductions, informational employer contributions, and net pay.
3. **Given** the same month, **When** a PDF download is requested, **Then** a PDF matching the same
   slip content is returned.
4. **Given** an employee requesting another employee's salary slip, **When** the request is made,
   **Then** it is rejected — this endpoint only ever returns the caller's own data.

---

### User Story 6 - Offline punch queueing and sync (Priority: P3)

An employee's punch made without connectivity is queued client-side and, once connectivity
returns, synced to the backend preserving its original capture timestamp, tagged for admin
visibility as offline-synced.

**Why this priority**: An important resilience behavior for field conditions, but it's an
additive wrapper around User Story 2's punch endpoint, not a separate core capability — it can be
built once punching itself works.

**Independent Test**: Can be fully tested by submitting a punch whose payload declares a capture
timestamp earlier than the request's arrival time (simulating a delayed offline sync) and
confirming the attendance record uses the declared capture time while a separate "synced late" flag
and the actual server-received time are also recorded.

**Acceptance Scenarios**:

1. **Given** a punch submission whose declared capture timestamp is earlier than the time the
   request is received, **When** it's processed, **Then** the attendance record's official punch
   time is the declared capture timestamp, and the record is tagged as synced-from-offline-queue
   with the actual receipt time also stored.
2. **Given** an offline-synced punch, **When** it's evaluated against geofence/face-verification/
   payroll-lock rules, **Then** the same rules from User Story 2 apply using the declared capture
   timestamp (e.g., payroll-lock checks the capture date, not the sync date).
3. **Given** a declared capture timestamp implausibly far in the past (beyond a configured maximum
   offline-queue age), **When** it's processed, **Then** it is rejected rather than silently
   accepted as an old backdated punch.

---

### User Story 7 - Request and complete biometric re-enrolment (Priority: P3)

An already-enrolled employee whose face is no longer recognized requests re-enrolment with a
reason; an admin approves or rejects the request; on approval, the employee (or their site
supervisor) completes fresh photo capture within a limited window, replacing the old template.

**Why this priority**: Depends on User Story 1 (must already be enrolled to need re-enrolment);
important for the "no unauthorized biometric changes" security property but not needed until an
employee's first enrolment has already gone stale.

**Independent Test**: Can be fully tested end-to-end by requesting re-enrolment, approving it as
admin, completing fresh capture within the window, and confirming the old template is gone and the
new one is active; separately, confirming a fresh-capture attempt with no prior approval (or an
expired one) is rejected.

**Acceptance Scenarios**:

1. **Given** an enrolled employee, **When** they submit a re-enrolment request with a reason,
   **Then** its status becomes "Re-enrolment Requested (Pending Approval)" and a notification is
   raised for HR/Admin users.
2. **Given** a pending re-enrolment request, **When** an admin approves it (with optional remarks),
   **Then** a one-time-use unlock is granted to that employee, expiring in 7 days if unused.
3. **Given** a pending re-enrolment request, **When** an admin rejects it (mandatory remarks
   required), **Then** the request is closed, the employee is notified, and no unlock is granted.
4. **Given** an active, unexpired, unconsumed unlock, **When** the employee (or their assigned site
   supervisor, for an on-site reset) completes fresh photo capture (min 3, max 5) and re-
   acknowledges consent, **Then** the previous face template is securely deleted, the new one
   becomes active, and the unlock is consumed.
5. **Given** no active unlock (never granted, already consumed, or expired), **When** any
   photo-replace/re-enrolment-completion request is made, **Then** it is rejected at the API level
   regardless of what the request body claims — this cannot be bypassed by a direct API call.
6. **Given** an unlock granted 8 days ago and never used, **When** a completion request now arrives
   using it, **Then** it is rejected as expired, requiring a fresh request.
7. **Given** any request/approval/rejection/completed re-enrolment event, **When** it occurs,
   **Then** it is recorded in the audit log with the acting party and timestamp.

---

### User Story 8 - Submit reimbursement claims (Priority: P3)

An employee raises an expense reimbursement claim (category, amount, expense date, description,
receipt) and tracks its status through review.

**Why this priority**: Depends on Settings' Reimbursement Categories master (a new master this
feature's own scope reads, added to `settings` by feature 005); an optional convenience capability,
not blocking the P1/P2 self-service core (punch/leave/salary). PRD §7.9.5.

**Independent Test**: Can be fully tested by submitting a claim with a receipt above the
category's configured mandatory-receipt threshold, confirming rejection without one and acceptance
with one, then confirming it appears correctly in the employee's own claim history.

**Acceptance Scenarios**:

1. **Given** the Reimbursement Categories master (Settings), **When** an employee starts a new
   claim, **Then** the category options list the company's configured categories, each showing
   whether a receipt is required and any per-claim max amount.
2. **Given** a category requiring a receipt above a configured threshold, **When** the employee
   submits a claim above that threshold without a receipt, **Then** it is rejected; with a receipt
   attached, **Then** it is created with status Submitted and the Site Admin is notified.
3. **Given** a Draft claim (not yet submitted), **When** the employee edits or deletes it, **Then**
   the change succeeds; once Submitted, **When** the employee attempts to withdraw it, **Then** it
   succeeds only while status is still Pending review.
4. **Given** the employee's own claim history, **When** viewed, **Then** it lists every claim with
   status (Draft/Submitted/Approved/Rejected/Paid) and, once processed, whether paid via payroll or
   directly — this is the same underlying record feature 005's admin review acts on, never a
   duplicate.

---

### Edge Cases

- What happens when an employee's assigned site changes between enrolment and a punch? The
  geofence check always uses the employee's currently assigned site at punch time, not the site
  that was assigned when they enrolled (enrolment and site assignment are independent).
- What happens when two punch-in requests for the same employee arrive close together (double-tap/
  double-submit)? Only one open (unmatched) punch-in may exist per employee at a time; a second
  punch-in attempt while one is already open is rejected rather than creating a duplicate.
- What happens if an employee attempts to punch out without a prior open punch-in? The request is
  rejected — a punch-out must pair with an existing open punch-in.
- What happens when a leave application's date range spans a period that later becomes payroll-
  locked before an admin decides on it? The application itself may still be decided (approved/
  rejected) after lock, but any attendance recalculation the approval would otherwise trigger for
  that locked period is suppressed, consistent with the payroll-lock enforcement rule.
- What happens if biometric consent is withdrawn while a re-enrolment request is pending? The
  pending request is closed automatically and the employee's status reverts to "Not enrolled";
  face-verification punch failures then always route to exception/manual-approval since no
  template exists to compare against.
- What happens to an employee's open (unmatched) punch-in if the day rolls over before they punch
  out? It remains open and is not auto-closed by this feature; it continues to affect the "one open
  punch-in at a time" rule (Edge Case above) until resolved (matched or corrected elsewhere).
- What happens if the submitted punch/enrolment photo contains no detectable face at all (not just
  a low-confidence match)? It's treated identically to a below-threshold match — recorded as a
  face-verification exception (for a punch) or rejected before deriving a template (for
  enrolment) — never a silent crash or a silently-skipped check.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST accept a face-enrolment submission (3–5 photos, a consent method, and
  a checked consent acknowledgement) only when the employee has no active enrolment, rejecting
  submissions with fewer than 3 photos or an unchecked acknowledgement before deriving anything.
- **FR-002**: On a valid enrolment submission, the system MUST derive a face template from the
  submitted photos using an in-process, npm-library-based face-recognition computation (not an
  external cloud call), store the template and consent record, and mark the employee "Enrolled"
  with the current date.
- **FR-003**: The system MUST reject any attempt to submit new enrolment photos for an
  already-enrolled employee outside the granted-unlock re-enrolment path (FR-013).
- **FR-004**: The system MUST permanently delete an employee's stored face photos and template upon
  consent withdrawal, within the configured biometric retention-policy window, and revert their
  status to "Not enrolled."
- **FR-005**: The system MUST accept a punch (in or out) only from an enrolled employee, comparing
  the submitted live photo against the employee's stored face template using the same in-process
  face-recognition computation, and MUST reject punch attempts from an employee with no enrolled
  template.
- **FR-006**: The system MUST validate a punch's submitted GPS coordinates against the employee's
  currently assigned site's geofence center and radius, computed server-side.
- **FR-007**: The system MUST record every punch (matched or not) rather than silently discarding
  a failed check; a punch outside the geofence radius MUST be recorded and flagged as a geofence
  exception, and a punch whose face match falls below the configured confidence threshold MUST be
  recorded and flagged as a face-verification exception requiring supervisor override or manual
  approval.
- **FR-008**: The system MUST reject a punch-in when the employee already has an open (unmatched)
  punch-in, and MUST reject a punch-out when the employee has no open punch-in to match.
- **FR-009**: The system MUST compute worked hours from a matched punch-in/punch-out pair and MUST
  compute OT hours as time worked beyond the employee's assigned shift duration.
- **FR-010**: The system MUST reject any punch or leave-application create/edit whose date falls
  within a period that is already payroll-locked for the employee's company (per that company's
  configured payroll lock day and processed-period state), regardless of client-side state.
- **FR-011**: The system MUST provide an employee's own monthly attendance history (date,
  day-of-week, in/out times, OT hours, status) for any requested month/year, computed from that
  employee's punches, approved leave, and the site's holiday/weekly-off configuration — and MUST
  reject a request for any other employee's history.
- **FR-011a**: The system MUST allow an authorized admin/supervisor to resolve a flagged attendance
  exception (geofence or face-verification) as Confirmed (the punch counts as Present-track
  attendance) or Rejected (it does not), and MUST notify the employee of the resolution.
- **FR-012**: An offline-synced punch (one whose declared capture timestamp precedes the request's
  arrival time) MUST have its official punch time set to the declared capture timestamp, MUST also
  store the actual server-receipt time, and MUST be tagged as synced-from-offline-queue; a declared
  capture timestamp older than a configured maximum offline-queue age MUST be rejected. All other
  validation (geofence, face match, payroll lock) MUST apply using the declared capture timestamp.
- **FR-013**: The system MUST reject any re-enrolment/photo-replace completion request that lacks
  an active, unexpired, unconsumed admin-granted unlock for that employee, checked at the API level
  independent of the request body's contents.
- **FR-014**: The system MUST allow an already-enrolled employee to submit a re-enrolment request
  with a reason, setting its status to pending and raising a notification for HR/Admin users.
- **FR-015**: The system MUST allow an authorized admin to approve (optional remarks) or reject
  (mandatory remarks) a pending re-enrolment request; approval MUST grant a one-time-use unlock
  expiring 7 days after issuance if unused, and rejection MUST close the request with no unlock and
  notify the employee.
- **FR-016**: On a completed re-enrolment (valid unlock present, 3–5 fresh photos, re-acknowledged
  consent), the system MUST securely delete the previous face template, store the new one, and
  consume the unlock so it cannot be reused.
- **FR-017**: The system MUST automatically close any pending re-enrolment request and revert
  enrolment status to "Not enrolled" if biometric consent is withdrawn while the request is
  outstanding.
- **FR-018**: The system MUST provide an employee's leave balances by type (Earned, Casual, Sick,
  Leave Without Pay) for a given financial year, each with Opening, Accrued, Used, and Balance
  figures.
- **FR-019**: The system MUST compute a leave application's day count by excluding weekends and the
  assigned site's configured holiday dates from the requested date range.
- **FR-020**: The system MUST reject a leave application (for any type except Leave Without Pay)
  whose computed day count exceeds the employee's current available balance for that type; Leave
  Without Pay MUST NOT be checked against any balance limit.
- **FR-021**: The system MUST allow an employee to cancel their own application only while its
  status is Pending, and MUST reject a cancel attempt on any non-Pending application.
- **FR-022**: The system MUST provide an employee's own list of leave applications with type,
  date range, day count, reason, status, and remarks, and MUST reject any request for another
  employee's applications.
- **FR-022a**: The system MUST allow an authorized admin to approve or reject (rejection requires
  remarks) a Pending leave application; an Approved application's dates MUST subsequently show as
  "On Leave" in the employee's attendance history (FR-011) rather than Absent.
- **FR-023**: The system MUST queue a notification to an employee when their leave application's
  status changes to Approved or Rejected, and when a re-enrolment request they submitted is
  approved or rejected.
- **FR-024**: The system MUST provide an employee's available salary-slip months, limited to months
  whose payroll run status is Processed or Paid, and MUST reject requests for any other employee's
  salary data.
- **FR-025**: The system MUST provide a salary slip (employee info, attendance summary, earnings,
  deductions, informational employer contributions, net pay) for any of that employee's own
  Processed/Paid months, in both a structured response and a PDF-downloadable form with identical
  figures.
- **FR-026**: The system MUST encrypt biometric photos and derived face templates at rest, log
  every access to them, and apply the same regulated-data protection tier this repo's constitution
  requires for Aadhaar/PAN/bank-account fields (Principle IV), even though biometric data is not
  itself named in that list.
- **FR-027**: The system MUST log every enrolment, punch (including exceptions), leave application/
  cancellation, re-enrolment request/approval/rejection/completion, and consent-withdrawal-triggered
  deletion to the audit log, capturing the acting party, timestamp, and company.
- **FR-028**: Every endpoint in this feature MUST accept and return validated, typed request/
  response structures, consistent with this repo's existing DTO contract pattern, and MUST be
  scoped to the authenticated caller's own employee record and company — with no way for one
  employee to read or act on another's punch, leave, salary, or biometric data.

**Reimbursement Claims (Self-Service)**

- **FR-029**: The system MUST allow an employee to create a reimbursement claim (category from
  Settings' Reimbursement Categories master, amount, expense date, description, optional receipt
  upload) scoped to their own employee record.
- **FR-030**: The system MUST require a receipt upload when the claim amount exceeds the
  category's configured mandatory-receipt threshold, and MUST reject submission without one above
  that threshold.
- **FR-031**: The system MUST allow an employee to edit or delete their own claim while it is in
  Draft status, and to withdraw a Submitted claim only while it remains in Pending review.
- **FR-032**: The system MUST provide an employee's own list of reimbursement claims with status
  and, once processed, payment method (payroll/direct).
- **FR-033**: Every endpoint in this feature's Reimbursement scope MUST be scoped to the
  authenticated caller's own claims, consistent with FR-028.

### Key Entities

- **Employee** (minimal, this feature's own scope per the confirmed scope decision): The
  self-service actor — links to a user account, an assigned company, an assigned site, and an
  assigned shift; a future HR & Payroll admin feature is expected to extend this record with the
  fuller HR fields it needs, not redefine it.
- **Site**: A company's work location with a geofence center (latitude/longitude) and radius, and a
  holiday calendar used for leave-day calculation; an employee is assigned to exactly one site at a
  time.
- **Face Enrolment (Template + Consent)**: An employee's derived face template, its enrolment date,
  the raw photos it was derived from, and the consent record (method, acknowledgement) that
  authorized capturing them — exactly one active template per employee, replaced (never
  accumulated) on a completed re-enrolment.
- **Re-enrolment Request**: One employee's request to replace their existing template — reason,
  status (pending/approved/rejected), admin remarks, and, once approved, a one-time-use unlock with
  a 7-day expiry.
- **Punch Record**: One punch-in or punch-out event — captured photo reference, face-match result
  (matched/exception), GPS coordinates, geofence result (in/exception), declared capture time,
  server-receipt time, and an offline-sync flag when applicable. A punch-in/punch-out pair forms one
  attendance day's worked/OT hours.
- **Leave Type / Leave Balance**: A named leave category (Earned, Casual, Sick, Leave Without Pay)
  and, per employee per financial year, its Opening/Accrued/Used/Balance figures.
- **Leave Application**: One employee's request for a date range under one leave type — computed
  day count, reason, status (Pending/Approved/Rejected/Cancelled), and admin remarks.
- **Payroll Run (status only)**: Per company per period, whether payroll is Draft, Processed, or
  Paid — this feature only reads this status to gate punch/leave locking (FR-010) and salary-slip
  visibility (FR-024); it does not compute payroll itself.
- **Salary Slip (read projection)**: A per-employee, per-Processed/Paid-period read-only view
  (attendance summary, earnings, deductions, employer contributions, net pay) — this feature
  displays/exports it but does not calculate payroll figures itself; those are assumed to already
  exist once a period is Processed.
- **Reimbursement Claim**: Employee, category (Settings Reimbursement Categories master), amount,
  expense date, description, receipt reference, status (Draft/Submitted/Approved/Rejected/Paid) —
  this feature owns creation/own-history; feature 005 adds the admin review layer over the same
  record.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An enrolled employee can complete a punch-in (capture through confirmation) in under
  10 seconds under normal conditions.
- **SC-002**: Across all testing, zero punches are accepted from an employee with no enrolled face
  template.
- **SC-003**: Across all testing, every punch is recorded (none silently discarded), with geofence
  and face-verification exceptions correctly flagged rather than silently accepted or rejected.
- **SC-004**: Across all testing, zero punches or leave-application changes succeed against an
  already payroll-locked period.
- **SC-005**: Across all testing, zero re-enrolment completions succeed without a corresponding
  prior admin approval still active (unexpired, unconsumed).
- **SC-006**: 100% of leave applications for a limited leave type that would exceed the employee's
  balance are rejected before creation; Leave Without Pay applications are never rejected for
  balance reasons.
- **SC-007**: Across all testing, an employee's salary-slip month selector never includes a Draft/
  unprocessed period.
- **SC-008**: Across all testing, no employee can read or modify another employee's punch, leave,
  salary, or biometric data through this feature's endpoints.
- **SC-009**: Every enrolment, punch, leave action, and re-enrolment lifecycle event is present in
  the audit log with the correct actor, timestamp, and company, verifiable by direct inspection.

## Assumptions

- Per the confirmed scope decision, this feature defines minimal Employee, Site, Attendance/Punch,
  Leave type/balance, and Payroll-run-status entities rather than assuming an unspecced HR &
  Payroll admin module already provides them; a later admin-facing feature is expected to extend,
  not redefine, these.
- Face verification uses an in-process npm face-recognition library computing and comparing face
  embeddings locally in the backend, per the clarification — not a from-scratch trained model and
  not a third-party cloud API call; the specific library/confidence-threshold value is a
  planning-level detail.
- A face-verification or geofence exception does not block the punch outright — it's recorded and
  routed for supervisor/admin review (matching the PRD's "supervisor override or manual approval"
  wording), consistent with the geofence-exception handling the PRD describes explicitly.
- Payroll figure calculation itself (earnings/deductions/contribution amounts) is out of this
  feature's scope — it assumes a Processed/Paid payroll run's figures already exist to be read and
  formatted for the salary slip; computing them is a separate, future Payroll feature's
  responsibility.
- Per the clarification above, this feature implements the admin-side approve/reject/resolve
  endpoints for Attendance Exceptions (FR-011a), Leave Applications (FR-022a), and Biometric
  Re-enrolment Requests (FR-015) — but the admin-facing UI/workflow screens themselves (the actual
  "Attendance → Exceptions," "Leave Summary," and "Biometric Re-enrolment Requests" pages
  referenced by the PRD) belong to a separate, future HR & Payroll admin feature; this spec
  guarantees the endpoints and state transitions those screens will need, not the screens
  themselves.
- Biometric data (photos, templates) is treated with the same encryption/access-logging/
  retention-policy protection tier the constitution requires for its named regulated-PII fields
  (Aadhaar/PAN/bank details), per FR-026, even though it isn't itself named in that list — a
  reasonable extension given India's DPDP/SPDI treatment of biometric data as sensitive personal
  data, not a weakening of the constitution's existing requirement.
- "Supervisor" for an on-site re-enrolment reset (User Story 7, Acceptance Scenario 4) refers to
  whichever employee holds the Daily Worker Registry permission for that site, consistent with how
  this repo's Settings feature already resolved "Site Supervisor" as a functional responsibility
  rather than a distinct role.
