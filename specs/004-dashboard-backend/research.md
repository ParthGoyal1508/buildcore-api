# Research: Dashboard & General Backend (Widgets, Notifications, Activity Log, Reports)

## 1. Registration pattern: NestJS multi-provider tokens

**Decision**: Three parallel registries — `WIDGET_PROVIDERS`, `NOTIFICATION_PROVIDERS`,
`REPORT_PROVIDERS` — each a NestJS multi-provider injection token (`{ provide: WIDGET_PROVIDERS,
useClass: X, multi: true }`, repeated per provider). Each provider implements a small interface:

```ts
interface WidgetProvider {
  id: string;
  displayType: 'kpi' | 'table' | 'list' | 'stat';
  title: string;
  section: 'kpi' | 'sidebar' | 'alerts' | 'table' | 'group' | 'site';
  isAvailable(): boolean; // false for a not-yet-built-module placeholder
  compute(ctx: RequestContext): Promise<WidgetValue>; // only called if isAvailable()
}
```

`NotificationProvider` and `ReportProvider` follow the same shape (condition-check +
compute/render function instead of a single `compute`). A `DashboardService` (in a new
`src/dashboard/` module) injects each token, iterates every registered provider, and assembles the
self-describing response array (spec FR-001).

**Rationale**: This is the constitution's own established pattern for declarative, extensible
registration (mirrors the Role/Permission Requirement "metadata, not a table" pattern from feature
002's data-model.md) — adding a widget is registering one more provider class, never touching
`DashboardService` or the response contract (spec FR-002, SC-003).

**Alternatives considered**: A database-driven widget-config table (rows describing each widget,
looked up at request time) — rejected: the actual *computation* logic still has to live in code
regardless (you can't compute "Present Today" from a config row), so a DB table would only
duplicate what the provider class already declares, adding a migration for zero behavioral gain.

## 2. Placeholder providers for not-yet-built modules

**Decision**: This feature itself registers a placeholder provider (returning `isAvailable():
false`) for every widget/notification/report the PRD names that depends on an unbuilt module
(Machinery, Projects, Inventory, Partners, real Payroll figures, Fuel, Compliance, Challans) —
nothing "auto-appears" later. When a future feature actually builds, say, the Machinery module, that
feature's own task list is expected to *replace* the specific placeholder provider(s) it makes real
(e.g. swap `MachineryCountWidgetProvider`'s stub for a real implementation calling the new
`MachineryService`), not add a brand-new one alongside it.

**Rationale**: Clarifies spec SC-003's "no change to existing ones" — that guarantee covers adding
genuinely *new* registrations, not the expected, one-time upgrade of a specific placeholder to real
once its module exists. Someone has to write the placeholder registration once; this feature is the
first (and only currently-possible) place to do it, since the widget/notification/report *response
contract* itself needs every PRD-named item enumerable today, even if inert.

**Alternatives considered**: Omit not-yet-computable items entirely and let each future module's own
feature add its own new provider when it lands — rejected: this is exactly the "Option B" the user
did not choose when confirming scope (framework + real data now, explicit placeholders for the
rest) — the PRD's own tile/notification/report inventory is meant to be visible (as "not available
yet") from day one, not silently absent until each dependent module ships.

## 3. Schema placement: no new Postgres schema

**Decision**: This feature introduces no new named Postgres schema. Its only persisted state is the
`ExportJob` tracking table, added to the existing `shared` schema (alongside `AuditLogEntry`,
`User`) — Dashboard/Notifications/Reports are a cross-cutting aggregation layer over other modules'
data (read via each owning module's exported service, per Principle I), not a data-owning business
module of their own the way `hr`/`payroll`/`settings` are.

**Rationale**: None of Principle I's seven named business-module schemas
(`hr`/`payroll`/`projects`/`plant`/`inventory`/`partners`/`settings`) fit "Dashboard & General" —
it's explicitly the cross-cutting concern `shared` exists for, the same reasoning feature 001 used
to place `AuditLogEntry` there.

**Alternatives considered**: A new `dashboard` schema — rejected: this feature owns exactly one
small tracking table; inventing an eighth named schema for that is disproportionate, and would also
imply (incorrectly) that Dashboard is a peer business module that "owns" KPI data, when it only
aggregates others'.

## 4. Activity Log read endpoint

**Decision**: A `GET /activity-log` endpoint in the new `src/dashboard/` module directly queries
`shared.AuditLogEntry` (same schema, same module boundary as `AuditLogService` itself — this is not
a cross-schema read, since `AuditLogEntry` already lives in `shared`, the same schema this
feature's own `ExportJob` table lives in) with `module`/`timeRange` filter params, `companyId`
scoping (feature 001's Super Admin exception honored), and pagination — ordered `createdAt DESC`.

**Rationale**: `AuditLogEntry.entityType` (extended across features 001–003) already distinguishes
enough to filter by "module" in spirit, though its granularity is per-entity-type not per
PRD-named-module (e.g. `PUNCH`/`LEAVE_APPLICATION`/`FACE_ENROLMENT` all map to the PRD's "HR"
filter bucket) — this feature adds a small mapping table (entityType → PRD module bucket) rather
than changing the stored `entityType` values themselves.

**Alternatives considered**: Add a literal `module` column to `AuditLogEntry` duplicating what
`entityType` already implies — rejected: redundant storage for a derivable mapping; the
entityType→module bucket mapping is a handful of static cases, cheap to compute at query time.

## 5. Notifications: computed fresh, not scheduled/stored

**Decision**: Every notification type is computed on-demand from current condition state at request
time (e.g., "pending leave applications" = a live query, not a materialized row) — no
`@nestjs/schedule` cron job pre-populates a notifications table. The bell-badge count endpoint runs
the same condition checks and returns just the count.

**Rationale**: The PRD's own "no manual dismiss — disappears when condition resolves" behavior falls
out for free from on-demand computation (there's no stored notification to un-dismiss); introducing
a scheduler + stored notifications table would add write-path complexity and a staleness window for
no behavioral benefit at this feature's data volumes. `@nestjs/schedule` isn't in the constitution's
pre-approved list at all — avoiding it here avoids a fourth dependency-amendment this session.

**Alternatives considered**: `@nestjs/schedule` cron job populating a notifications table, read at
request time — rejected per above; would also need its own amendment to this constitution's
pre-approved-package list, unlike the on-demand approach which needs no new dependency.

## 6. Async report export: `@nestjs/bullmq`

**Decision**: `@nestjs/bullmq` (already pre-approved, README explicitly earmarks it "for background
jobs... reports") backs the `ExportJob` queue. A report export whose row count exceeds a configured
threshold (`ReportsConfig.asyncExportRowThreshold`) enqueues a job; a worker renders the PDF/Excel
and updates `ExportJob.status`; the caller polls `GET /reports/exports/:id` or receives an "Export
Ready" notification (reusing §5's on-demand notification pattern — checking `ExportJob` rows with
`status: 'ready', notifiedAt: null` counts as one more notification provider). Requires adding a
Redis service to local/deploy infrastructure (not yet present in `docker-compose*.yml`) as BullMQ's
backing store.

**Rationale**: Directly satisfies spec FR-021/SC-007 (never block the request); reusing the
notification framework for "export ready" avoids inventing a second delivery mechanism.

**Alternatives considered**: A simple `setTimeout`/in-process async function without a real queue —
rejected: doesn't survive a server restart mid-export and isn't horizontally scalable, exactly what
a real job queue (already pre-approved for this purpose) exists to solve.

## 7. Reconciling with existing specs

**Decision**: Widget/report providers backed by already-specced data call each owning module's
already-exported service methods — `hr`'s `EmployeesService`/`AttendanceHistoryService`/
`LeaveService`, `settings`'s `CompaniesService`/`SitesService` (from `projects`, established by
feature 003) — never a direct cross-schema Prisma query from `src/dashboard/`.

**Rationale**: Same Principle I boundary every prior feature has followed; Dashboard is the module
most tempted to "just join everything" since it aggregates broadly, making this discipline more
important here, not less.

**Alternatives considered**: A dedicated read-replica/materialized-view layer joining across
schemas directly for performance — rejected as premature: no measured performance problem exists
yet to justify bypassing the service-call boundary; SC-001's 3-second budget is achievable through
each module's own indexed queries called in parallel (`Promise.all`), not a shared join.
