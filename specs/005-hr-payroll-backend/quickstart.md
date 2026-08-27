# Quickstart: Validating the HR & Payroll Backend

## Prerequisites

- Seeded company (002), departments/designations/document types/shifts (002), at least one Site
  (003), a Super Admin session.
- Local Postgres migrations applied (Employee extension, EmployeeDocument, Holiday, PayrollLineItem,
  Loan, DailyWorker, etc.).

## Scenario 1 — Full employee record + PII masking (User Story 1)

1. `POST /hr/employees` with all eight tabs' data including Aadhaar/PAN/bank account. **Expected**:
   201; `GET /hr/employees/:id` shows those fields masked to last 4 digits.
2. `POST /hr/employees/:id/reveal-pii` with `{ field: 'aadhaar' }`. **Expected**: 200, unmasked
   value; an `AuditLogEntry` records the reveal.
3. `GET /hr/employees?search=<name>&department=<id>`. **Expected**: correct filtered, paginated
   results.

## Scenario 2 — Documents and mandatory gating (User Story 2)

1. Upload only 2 of the company's Mandatory document types for a new employee.
2. Attempt a self-service punch (003's `/my/punch`) for that employee. **Expected**: rejected
   (FR-005 reusing 002's `hasMissingMandatoryDocs`).
3. Upload the remaining mandatory documents; retry the punch. **Expected**: succeeds.
4. Upload a document with `expiresAt` 10 days out. **Expected**: flagged for the (currently
   placeholder, feature 004) Document Expiry notification.

## Scenario 3 — Admin attendance (User Story 3)

1. `POST /hr/attendance` marking an employee present with specific in/out times.
2. `PATCH /hr/attendance/:id` changing the out time. **Expected**: `GET
   /hr/attendance/modifications` shows the before/after diff.
3. `GET /hr/attendance/exceptions?date=&siteId=`. **Expected**: lists any out-of-geofence punches
   from 003 test data.
4. `POST /hr/holidays` for today, `appliesToAllSites: true`. **Expected**: today's attendance
   status for all employees at any site now computes as Holiday.
5. Mark a period Processed (Scenario 6), then attempt `PATCH /hr/attendance/:id` for a date in it.
   **Expected**: 423.

## Scenario 4 — Admin leave (User Story 4)

1. `GET /hr/leave/applications?status=pending`. **Expected**: lists every employee's pending
   applications.
2. Approve one via 003's existing decide endpoint. **Expected**: reflected in `GET
   /hr/leave/balances`.

## Scenario 5 — Loans (User Story 7)

1. `POST /hr/loans` for an employee with amount/EMI. **Expected**: 201, `GET
   /hr/loans/:id/schedule` shows a correct month-by-month breakdown.

## Scenario 6 — Payroll generation, slip, challans (User Stories 5, 6)

1. `POST /hr/payroll/generate` for a month with the Scenario 3/5 data seeded.
   **Expected**: 201, a Draft run with one `PayrollLineItem` per active employee; the loan's EMI
   appears as a deduction; OT wages reflect the company's configured `otMultiplier`.
2. `GET /hr/payroll/runs/:id/employees/:employeeId/slip`. **Expected**: full slip with correct
   figures; `.../slip.pdf` returns a matching PDF.
3. `POST /hr/payroll/runs/:id/process`. **Expected**: 200; a further `PATCH` to that period's
   attendance now returns 423 (Scenario 3 step 5).
4. `GET /hr/challans/pf?period=&companyId=`. **Expected**: figures trace exactly to the processed
   run's line items.
5. `POST /hr/payroll/runs/:id/pay`. **Expected**: 200; 003's `GET /my/salary/available-periods`
   for an employee in this run now includes this period.
6. `GET /hr/payroll/runs/:id/bank-sheet`. **Expected**: an `.xlsx` file with employee/bank/IFSC/
   net-pay rows.

## Scenario 7 — Employee transfer (User Story 8)

1. `POST /hr/employees/:id/transfer` to a second seeded company, `retainCode: false`. **Expected**:
   `companyId` updates, a new code is generated, transfer appears in the Activity Log.

## Scenario 8 — Daily Worker Registry (User Story 9)

1. `POST /hr/daily-workers` with 3 photos and consent attestation, as a supervisor assigned to the
   site. **Expected**: 201, no login/statutory fields required.
2. As a supervisor NOT assigned to that site, attempt the same. **Expected**: 403.
3. `POST /hr/daily-worker-attendance` with a matching photo (face-match). **Expected**: 201,
   `markingMethod: 'face_match'`.
4. Repeat with `markingMethod: 'manual'`, no photo. **Expected**: 201, exception logged.
5. `GET /hr/daily-workers/wage-summary?siteId=&period=`. **Expected**: correct payout summary;
   confirm this worker never appears in any `PayrollLineItem` (Scenario 6).
6. `POST /hr/daily-workers/:id/convert`. **Expected**: a new Employee + FaceEnrolment exists,
   carrying forward the same photos/descriptor; original DailyWorker status becomes `converted`.

## Scenario 9 — Re-enrolment admin queue (User Story 10)

1. Seed a pending re-enrolment request via 003's employee-facing endpoint.
2. `GET /hr/re-enrolment-requests?status=pending`. **Expected**: lists it with employee/site/
   reason/requested-on.

## Scenario 10 — Audit logging (NFR)

1. Perform one create/update across Employees, Attendance, Payroll, Loans, and Daily Workers.
2. Inspect `AuditLogEntry` directly. **Expected**: one correctly-fielded entry per action.
