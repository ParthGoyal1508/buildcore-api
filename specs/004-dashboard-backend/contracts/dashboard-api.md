# Contract: `/dashboard`, `/group`, `/site-dashboard`, `/notifications`, `/activity-log`, `/reports`

All endpoints require authentication (`JwtAuthGuard`) plus the `DASHBOARD` or `REPORTS` permission
per research.md §... / spec FR-022 (clarification: no new permission values). Every list response
follows the self-describing widget/notification/report envelope from data-model.md.

## `GET /dashboard/widgets`

**Response — 200**: `WidgetResult[]` — every registered widget, in registration order, each either
resolved (`value`) or `unavailable`. Includes: Total Employees, Present Today, Absent, On Leave,
Monthly Expenses (unavailable), Pending Approvals (KPI section); Active Projects, Total Machinery
(unavailable, KPI section); Contract Value, Materials Cost, Fuel Cost, Hire Bills (unavailable,
sidebar section); Employees on Muster (sidebar, available); Alerts & Reminders (unavailable, alerts
section — Machinery/document-expiry dependent); Today's Attendance, Recent Leaves (table section,
available).

## `GET /group/companies`

**Response — 200**: `WidgetResult[]` — one Company Card widget per accessible company (Headcount
available; Payroll Cost/PF-ESIC Pending/Loans Outstanding/Docs Pending unavailable) plus one Group
Total widget aggregating them.

## `GET /group/statutory-calendar?financialYear=`

**Response — 200**: single `WidgetResult` with `unavailable: { reason: 'module_pending', module:
'challans' }` (Challans module not built).

## `GET /group/employees/search?q=`

**Response — 200**: `Employee[]` (name, code, company) matching `q` against name/code/Aadhaar-
last-4, scoped to accessible companies.

**Response — 400**: `q` shorter than 2 characters.

## `GET /site-dashboard/sites`

**Response — 200**: `{ id, name }[]` — the caller's company's sites.

## `GET /site-dashboard/widgets?siteId=`

**Response — 200**: `WidgetResult[]` — Workers Today, Today's Attendance table (available);
Machinery Deployed, Fuel Consumed This Month, Material Stock Value, Machinery at Site table, Fuel
Consumption table, Material Stock table, Recent Expenses table (all unavailable).

**Response — 403**: `siteId` outside the caller's company access.

## `GET /notifications`

**Response — 200**: `NotificationRow[]` — currently active only (Pending Leave Approvals,
Biometric Re-enrolment Requests, Payroll Pending, and "Export Ready" per research.md §6); other
PRD-named types are simply absent (not present as unavailable rows — notifications differ from
widgets/reports in this respect, since a notification list's job is to show what's *active*, and an
inert type has nothing to be active).

## `GET /notifications/count`

**Response — 200**: `{ count: number }`.

## `GET /activity-log?module=&timeRange=&page=`

**Response — 200**: `{ entries: [{ id, actor, action, module, target, timestamp }], hasMore:
boolean }` — newest first, module-bucket-mapped (data-model.md), company-scoped.

## `GET /activity-log/export?module=&timeRange=`

**Response — 200**: `text/csv` stream, columns Timestamp/User/Action/Module/Entity/Before/After,
same filters and company scoping as the feed endpoint above (master PRD §7.2.5, spec FR-024).

## `GET /reports/types`

**Response — 200**: `{ id, name, isAvailable, filters: FilterSpec[] }[]` — all 9 (8 PRD-named +
Equipment Utilization); Attendance and Employee flagged `isAvailable: true`, the rest `false`.

## `POST /reports/:type/run`

**Request**: `{ fromDate, toDate, filters: {...} }` (per that type's `FilterSpec[]`).

**Response — 200** (available type): `{ columns, rows }`.

**Response — 200** (unavailable type): `{ unavailable: { reason: 'module_pending', module:
string } }` — not an error status, since requesting an inert-but-registered report type is a valid,
expected call per this feature's own framework contract.

## `POST /reports/:type/export`

**Request**: `{ fromDate, toDate, filters, format: 'pdf' | 'excel' }`.

**Response — 200** (row count ≤ async threshold): the file directly (`application/pdf` or
`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`).

**Response — 202** (row count > async threshold): `{ exportJobId, status: 'pending' }` — poll
`GET /reports/exports/:id` or wait for the "Export Ready" notification.

## `GET /reports/exports/:id`

**Response — 200**: `{ status: 'pending' | 'processing' | 'ready' | 'failed', downloadUrl:
string | null, failureReason: string | null }`.

## Audit logging (cross-cutting)

This feature is read-mostly (Activity Log, widgets, notifications, reports are all reads); the one
write path (`ExportJob` creation/completion) is logged via the shared `AuditLogService`, same
pattern as every prior feature — `entityType: 'REPORT_EXPORT'`.
