# Data Model: Dashboard & General Backend (Widgets, Notifications, Activity Log, Reports)

This feature introduces exactly one new persisted table (`ExportJob`, in the existing `shared`
schema — research.md §3). Everything else is code-level registration metadata and computed
responses, not database rows.

## Export Job (`shared` schema — new)

| Field | Type | Notes |
|---|---|---|
| `id` | string | |
| `reportType` | string | One of the registered report-type ids |
| `filters` | JSON | The filter/date-range params the export was requested with |
| `requestedByUserId` | string | |
| `companyId` | string | RLS-protected |
| `format` | enum: `pdf` \| `excel` | |
| `status` | enum: `pending` \| `processing` \| `ready` \| `failed` | |
| `fileRef` | string \| null | Object-storage reference, set when `status = ready` |
| `failureReason` | string \| null | Set when `status = failed` |
| `notifiedAt` | timestamp \| null | Set once the "Export Ready" notification has been surfaced (research.md §6) |
| `createdAt` / `completedAt` | timestamp | |

## Widget Definition (code-level registration, not a table)

`{ id, displayType: 'kpi' | 'table' | 'list' | 'stat', title, section: 'kpi' | 'sidebar' |
'alerts' | 'table' | 'group' | 'site', isAvailable(): boolean, compute(ctx): Promise<WidgetValue>
}` — one class per widget, registered via the `WIDGET_PROVIDERS` multi-provider token
(research.md §1). Listed here for completeness per the spec's Key Entities section; has no
database row of its own.

## Widget Result (response shape, not stored)

`{ id, displayType, title, section, value: unknown } | { id, displayType, title, section,
unavailable: { reason: 'module_pending', module: string } }` — the per-request output every widget
provider resolves to (spec FR-001).

## Notification Definition / Notification Result (code-level, mirrors Widget)

Same registration pattern as Widget Definition, with a `checkActive(ctx): Promise<NotificationRow[]>`
function instead of a single value — each active condition instance becomes one row: `{ type,
severity: 'red' | 'yellow' | 'orange' | 'blue', title, subtitle, actionLink, occurredAt }`.

## Report Definition / Report Result (code-level, mirrors Widget)

`{ id, name, isAvailable(): boolean, filters: FilterSpec[], run(ctx, params): Promise<ReportRow[]>
}` registered via `REPORT_PROVIDERS`. `ReportResult` is `{ columns, rows }` for an available report,
or the same `unavailable` shape as Widget Result.

## Activity Log module-bucket mapping (code-level, research.md §4)

A static mapping from `AuditLogEntry.entityType` values (feature 001's login events, feature 002's
`COMPANY`/`ROLE`/`DEPARTMENT`/`DESIGNATION`/`DOCUMENT_TYPE`/`SHIFT`, feature 003's `PUNCH`/
`LEAVE_APPLICATION`/`FACE_ENROLMENT`/`RE_ENROLMENT_REQUEST`) to the PRD's module filter buckets
(HR / Settings — login events and HR events both map to "HR" per the PRD's own action list, Settings
entities map to "Settings"). Payroll/Machinery/Projects/Inventory/Partners buckets exist in the
filter list but currently match zero entries (no audited actions from those unbuilt modules yet) —
selecting them returns an empty result (spec Edge Cases), not an error.

## Cross-reference to features 001–003

| Concept | Relationship |
|---|---|
| `AuditLogEntry` (`shared`) | Read (not written) by this feature for the first time — Activity Log (research.md §4) |
| `Employee`, `PunchRecord`, `LeaveApplication`, attendance-status computation (`hr`, feature 003) | Read via `hr`'s exported services for Dashboard/Site Dashboard/Reports widgets |
| `Site` (`projects`, feature 003) | Read via `projects`' exported `SitesService` for the site selector and site-scoped widgets |
| `Company` (`settings`, feature 002) | Read via `settings`' exported `CompaniesService` for Group Dashboard company cards |
| `FaceEnrolment`/`ReEnrolmentRequest` (`hr`, feature 003) | Read for the Biometric Re-enrolment Requests notification type |
