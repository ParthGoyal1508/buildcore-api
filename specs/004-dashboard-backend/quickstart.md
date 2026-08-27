# Quickstart: Validating the Dashboard & General Backend

## Prerequisites

- Local Postgres + Redis (new for this feature, BullMQ backing store — research.md §6) running,
  migrations applied (`ExportJob` in `shared` schema).
- Seeded data from prior features: a company, several employees with today's punches (some
  present, some absent), a pending leave application, an approved leave application, a pending
  biometric re-enrolment request, a site with employees assigned.
- A Super Admin session and a single-company-scoped session for access-scoping checks.

## Scenario 1 — Widget framework (User Story 1)

1. `GET /dashboard/widgets` as a permitted user. **Expected**: 200, a list where every entry has
   `id`/`displayType`/`title`/`section` plus either `value` or `unavailable`.
2. Inspect the Total Machinery entry. **Expected**: `unavailable: { reason: 'module_pending',
   module: 'machinery' }`, not a zero or fabricated number.
3. Inspect the Total Employees entry. **Expected**: a real `value` matching the seeded employee
   count.
4. `GET /dashboard/widgets` as a user lacking `DASHBOARD` permission. **Expected**: 403, no
   computation performed (verify via absence of any side effect/log entry for the attempt beyond
   the rejection itself).

## Scenario 2 — Company Dashboard KPIs (User Story 2)

1. `GET /dashboard/widgets`. **Expected**: Present/Absent/On Leave counts match seeded punch/leave
   data; Pending Approvals equals the count of Pending leave applications only (not attendance
   exceptions).
2. Inspect the Today's Attendance table widget. **Expected**: first 8 records, employee + status.
3. Inspect the Recent Leaves table widget. **Expected**: most recent applications with type/days/
   status.
4. Inspect Contract Value, Materials Cost, Fuel Cost, Hire Bills. **Expected**: all `unavailable`.

## Scenario 3 — Activity Log (User Story 3)

1. Perform a Settings company edit and a My Workspace leave application (if not already seeded).
2. `GET /activity-log`. **Expected**: both appear, newest first, with actor/action/target/
   timestamp.
3. `GET /activity-log?module=settings`. **Expected**: only the company edit.
4. `GET /activity-log?module=machinery`. **Expected**: empty result, not an error.
5. `GET /activity-log?timeRange=today`. **Expected**: only today's entries.
6. As a single-company user, confirm no other company's entries ever appear.

## Scenario 4 — Notifications (User Story 4)

1. `GET /notifications`. **Expected**: the pending leave application and pending re-enrolment
   request both appear with correct icon color/title/subtitle; Document Expiry/Maintenance Due/
   Fuel Variance/Contractor Compliance types are simply absent.
2. `GET /notifications/count`. **Expected**: matches the list length.
3. Approve the pending leave application (My Workspace admin endpoint). Repeat step 1.
   **Expected**: it no longer appears — no dismiss action was called.

## Scenario 5 — Site Dashboard (User Story 5)

1. `GET /site-dashboard/sites`. **Expected**: the caller's company's sites.
2. `GET /site-dashboard/widgets?siteId=<seeded>`. **Expected**: Workers Today and Today's
   Attendance reflect only that site's employees; Machinery/Fuel/Material widgets are
   `unavailable`.
3. Request with a `siteId` from a different company. **Expected**: 403.

## Scenario 6 — Group Dashboard and search (User Story 6)

1. As Super Admin (cross-company), `GET /group/companies`. **Expected**: one card per company +
   Group Total, Headcount correct per card, other figures `unavailable`.
2. As a single-company user, repeat. **Expected**: only their own company's card + a matching
   Group Total.
3. `GET /group/statutory-calendar?financialYear=2026-27`. **Expected**: `unavailable`.
4. `GET /group/employees/search?q=jo`. **Expected**: matches across accessible companies.
5. `GET /group/employees/search?q=j`. **Expected**: 400.

## Scenario 7 — Reports (User Story 7)

1. `GET /reports/types`. **Expected**: 9 types, Attendance and Employee `isAvailable: true`, the
   rest `false`.
2. `POST /reports/attendance/run` with a date range. **Expected**: 200, tabular data matching
   seeded punches.
3. `POST /reports/payroll/run`. **Expected**: 200, `unavailable` body (not an error status).
4. `POST /reports/attendance/export` with `format: 'pdf'`, small date range (under async
   threshold). **Expected**: 200, a PDF file matching the on-screen data.
5. `POST /reports/attendance/export` with `format: 'excel'`, a date range whose row count exceeds
   the async threshold (seed enough punches, or lower the threshold in test config). **Expected**:
   202, `exportJobId`.
6. `GET /reports/exports/:id` repeatedly until `status: 'ready'`. **Expected**: `downloadUrl`
   present; confirm the "Export Ready" notification also appeared via `GET /notifications` in the
   interim.

## Scenario 8 — Audit logging (NFR)

1. Complete one export (Scenario 7). Inspect `AuditLogEntry` directly. **Expected**: one
   `REPORT_EXPORT` entry with the correct acting user, timestamp, and company.
