# Contract: `/hr/*` endpoints

All endpoints require `JwtAuthGuard` plus the matching `Permission` (002's enum, reused verbatim —
research.md §11): `EMPLOYEES`, `ATTENDANCE`, `PAYROLL`, `CHALLANS`, `LOANS`, or
`DAILY_WORKER_REGISTRY`. Every response masks PII fields by default (research.md §3).

## Employees — `/hr/employees` (permission: `EMPLOYEES`)

- `GET /hr/employees?search=&department=&site=&status=&company=&page=` — paginated list.
- `POST /hr/employees` / `PATCH /hr/employees/:id` — create/update across all eight tabs' fields.
- `GET /hr/employees/:id` — detail (Overview/Personal/Employment/Salary Structure/Attendance
  Calendar/Leave Summary/Documents/Loan History — the latter two composed from this feature's own
  data, Attendance Calendar delegating to 003's `getMonthHistory` for this `employeeId`).
- `POST /hr/employees/:id/reveal-pii` — `{ field: 'aadhaar' | 'pan' | 'bankAccountNumber' | 'uan'
  }` → `{ value: string }`, audit-logged (research.md §3).
- `POST /hr/employees/:id/transfer` — `{ toCompanyId, transferDate, reason, retainCode: boolean }`.
- `POST /hr/employees/:id/documents` — `{ documentTypeId, file, documentNumber?, expiresAt? }`.
- `GET /hr/employees/:id/documents` — list with derived flags (reuses 002's derivation).

## Attendance — `/hr/attendance` (permission: `ATTENDANCE`)

- `GET /hr/attendance?date=&siteId=` — daily view.
- `POST /hr/attendance` / `PATCH /hr/attendance/:id` — Mark/Edit; `423` if the date is
  payroll-locked.
- `GET /hr/attendance/exceptions?date=&siteId=` — extends 003's `PunchRecord` exception data.
- `GET /hr/attendance/modifications?employeeId=&dateRange=` — audit trail (research.md §7).
- `GET/POST /hr/holidays` — declare/list holidays (name, date, type, site applicability).

## Leave — `/hr/leave` (permission: `ATTENDANCE`, matching the PRD's Attendance-adjacent placement)

- `GET /hr/leave/applications?status=` — all-employee admin list (003's decide endpoint reused
  unchanged for the actual approve/reject).
- `GET /hr/leave/balances?employeeId=` — admin balance view (003's computation reused).

## Payroll — `/hr/payroll` (permission: `PAYROLL`)

- `POST /hr/payroll/generate` — `{ companyId, period }` → creates a Draft `PayrollRun` +
  `PayrollLineItem`s (research.md §4).
- `GET /hr/payroll/runs?period=&status=` — list.
- `POST /hr/payroll/runs/:id/process` / `.../pay` — status transitions; `process` makes figures
  immutable (FR-015).
- `GET /hr/payroll/runs/:id/employees/:employeeId/slip` — full slip (JSON); `.../slip.pdf` — same
  via `pdfkit`.
- `GET /hr/payroll/runs/:id/bank-sheet` — `exceljs` export (FR-017).

## Challans — `/hr/challans` (permission: `CHALLANS`)

- `GET /hr/challans/pf?period=&companyId=`, `/esic?...`, `/pt?...` — derived from the period's
  Processed/Paid `PayrollRun` (research.md §5); `404`-equivalent "not processed yet" result if none.
- `GET /hr/challans/pf/export?...` (and `/esic`, `/pt`) — structured file export.

## Loans — `/hr/loans` (permission: `LOANS`)

- `GET /hr/loans?employeeId=&status=`
- `POST /hr/loans` — `{ employeeId, amount, emiAmount, disbursementDate, reason, remarks? }` →
  auto-generates the schedule.
- `GET /hr/loans/:id/schedule`
- `POST /hr/loans/:id/close` — manual early closure.

## Daily Worker Registry — `/hr/daily-workers` (permission: `DAILY_WORKER_REGISTRY`, site-scoped —
research.md §8)

- `GET /hr/daily-workers?siteId=&status=`
- `POST /hr/daily-workers` — `{ name, phone?, gender, siteId, trade, dailyWageRate, photos: Blob[]
  (3–5), consentAttested: true }`.
- `PATCH /hr/daily-workers/:id` / `POST /hr/daily-workers/:id/deactivate`
- `POST /hr/daily-workers/:id/convert` — creates a full `Employee` + `FaceEnrolment` (research.md
  §9).
- `POST /hr/daily-worker-attendance` — `{ dailyWorkerId, siteId, photo?, latitude?, longitude?,
  markingMethod: 'face_match' | 'manual' }` (face-match variant may omit `dailyWorkerId`,
  resolving it from the match instead).
- `GET /hr/daily-worker-attendance?date=&siteId=`
- `GET /hr/daily-workers/wage-summary?siteId=&period=` — payout summary (FR-028), explicitly
  separate from `/hr/payroll/*`.

## Biometric Re-enrolment Requests (admin queue) — `/hr/re-enrolment-requests` (permission:
`EMPLOYEES`)

- `GET /hr/re-enrolment-requests?status=` — lists 003's `ReEnrolmentRequest` rows with employee/
  site/reason/requested-on; approve/reject continue to use 003's existing endpoints unchanged
  (FR-029).

## Offboarding & F&F — `/hr/employees/:id/*` (permission: `EMPLOYEES`)

- `POST /hr/employees/:id/exit` — `{ lastWorkingDay, reason, remarks? }` → creates an
  `ExitRecord` (FR-031).
- `GET /hr/employees/:id/fnf` — F&F computation: pending salary, EL encashment, loan recovery, net
  payable (FR-032).
- `POST /hr/employees/:id/fnf/process` — creates an F&F-flagged `PayrollRun`, follows the standard
  Draft → Processed → Paid lock lifecycle (FR-033); on processing past `lastWorkingDay`, sets
  `Employee.status = Inactive` and revokes the linked `User`'s access (FR-034).

## Reimbursements (admin) — `/hr/reimbursements` (permission: `EMPLOYEES`)

- `GET /hr/reimbursements?status=&employeeId=&companyId=&page=` — paginated list (FR-036).
- `PATCH /hr/reimbursements/:id/approve` — `{ remarks? }` (FR-037).
- `PATCH /hr/reimbursements/:id/reject` — `{ remarks }` (mandatory) (FR-037).
- `PATCH /hr/reimbursements/:id/pay` — `{ paymentMode: 'direct', paymentDate, paymentReference }`
  or `{ paymentMode: 'payroll' }` (queues for next run) (FR-038).
- `GET /hr/reimbursements/register?status=&company=&dateRange=` — register view with summary
  totals by status (FR-039).

## Reimbursement Categories — `/settings/reimbursement-categories` (permission: `EMPLOYEES`)

Same CRUD shape as 002's Department/Designation/Document Type/Shift masters (FR-045):

- `GET /settings/reimbursement-categories`
- `POST /settings/reimbursement-categories` — `{ name, receiptRequired, maxAmount? }`
- `PATCH /settings/reimbursement-categories/:id`

## Bulk Attendance Import — `/hr/attendance/import/*` (permission: `ATTENDANCE`)

- `GET /hr/attendance/import/template` — CSV template (Employee Code, Date, Punch In, Punch Out)
  (FR-041).
- `POST /hr/attendance/import/validate` — CSV upload → row-level error report, no writes (FR-042).
- `POST /hr/attendance/import/commit` — commits only previously-validated rows via US3's existing
  Mark/Edit write path (FR-043, FR-044).

## Audit logging (cross-cutting)

Every create/update/delete across this contract writes one `AuditLogEntry` (shared
`AuditLogService`, entityType values: `EMPLOYEE`, `EMPLOYEE_DOCUMENT`, `EMPLOYEE_TRANSFER`,
`ATTENDANCE`, `HOLIDAY`, `PAYROLL_RUN`, `LOAN`, `DAILY_WORKER`, `DAILY_WORKER_ATTENDANCE`,
`EXIT_RECORD`, `REIMBURSEMENT_CLAIM`) — FR-030.
