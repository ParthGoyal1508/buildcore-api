# Feature Specification: Dashboard & General Backend (Widgets, Notifications, Activity Log, Reports)

**Feature Branch**: `004-dashboard-backend`

**Created**: 2026-08-27

**Status**: Draft

## Clarifications

### Session 2026-08-27

- Q: FR-022 requires each endpoint be gated by "the Dashboard/Reports-area permission appropriate
  to it," but the existing `Permission` enum (Settings feature) only has `DASHBOARD` and `REPORTS`
  — how should Group Dashboard, Site Dashboard, Notifications, and Activity Log be gated? → A:
  Reuse `DASHBOARD` for all four — no new permission enum values needed; Reports keeps its own
  existing `REPORTS` permission.

**Input**: User description: "Dashboard & General Module (Dashboard, Group Dashboard, Site
Dashboard, Notifications, Activity Log, Reports) for the BuildCore API backend, per the PRD at
/Users/parthgoyal/Projects/ERP-Demo/docs/prd/02-dashboard.prd.md. Scope decisions already
confirmed: (1) build a generic, backend-driven, extensible widget/tile registry framework — the
frontend must hold minimal logic and simply render whatever the backend returns; real computed
data for tiles/notifications/reports backed by already-specced entities (My Workspace's Employee/
Attendance/Leave/Face Enrolment, Settings' Company/Role, Login's User); tiles needing an unbuilt
module (Machinery, Projects, Inventory, Partners, Payroll figures, Fuel, Compliance, Challans)
registered in the same framework but returning an explicit 'module not available yet' placeholder.
(2) Excel export via exceljs, PDF export reuses pdfkit. This feature also builds the read/query
side of the Activity Log, deferred by every prior feature."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Extensible widget aggregation framework (Priority: P1)

An admin opens the Dashboard and receives a list of widgets from a single endpoint — each with its
own type, title, section placement, and either a computed value or an explicit "not available yet"
state — without the caller needing any prior knowledge of which widgets exist.

**Why this priority**: This is the architectural requirement the whole feature is built around
(explicitly confirmed scope decision): the frontend must stay dumb and render whatever the backend
returns, so new widgets can be added later without a frontend change. Every other user story
registers into this framework rather than exposing its own bespoke shape.

**Independent Test**: Can be fully tested by calling the widget endpoint and confirming the
response is a self-describing list (each item carrying its own render hints — type, title, section,
value or unavailable-state) with no caller-side knowledge required beyond generic list iteration;
separately, confirming a widget backed by an unbuilt module returns the placeholder shape rather
than an error or a fabricated zero value.

**Acceptance Scenarios**:

1. **Given** the widget endpoint, **When** called, **Then** it returns a list where each entry
   carries an identifier, a display type (e.g. KPI number, table, list), a title, a section/
   placement hint, and either a `value` or an `unavailable: { reason: "module_pending",
   module: "machinery" }`-shaped state — never a raw untyped blob requiring the caller to know
   what to do with it beyond that shared shape.
2. **Given** a widget whose underlying module (e.g. Machinery) doesn't exist yet, **When** it's
   requested, **Then** it returns the unavailable state, never a fabricated zero, empty, or
   hardcoded placeholder value presented as if it were real data.
3. **Given** a widget backed by already-specced data (e.g. Total Employees), **When** requested,
   **Then** it returns a freshly computed value from the current operational data — never a value
   cached beyond a short, documented interval.
4. **Given** a new widget is registered in the backend after this feature ships, **When** the same
   endpoint is called again, **Then** it appears in the response automatically — no contract change
   is required for existing callers to keep working.
5. **Given** a request for widgets from a user lacking the Dashboard-area permission, **When**
   made, **Then** it is rejected before any widget is computed.

---

### User Story 2 - Company Dashboard KPIs and tables (Priority: P1)

An admin viewing the main Dashboard sees company-wide KPI cards (employee counts, attendance,
leave, pending approvals) and two supporting tables (today's attendance, recent leaves), all
registered as widgets under User Story 1's framework and all scoped to the caller's own company.

**Why this priority**: The PRD's primary landing screen; delivers the bulk of this feature's
day-one value using only already-specced data.

**Independent Test**: Can be fully tested by requesting the Dashboard's widget set for a company
with seeded employees/attendance/leave and confirming each KPI/table widget's value matches what
that data implies.

**Acceptance Scenarios**:

1. **Given** a company's employee/attendance/leave data for today, **When** the Dashboard widgets
   are requested, **Then** Total Employees, Present Today, Absent, and On Leave each reflect the
   current count, and Pending Approvals reflects the sum of pending leave applications, open
   maintenance jobs, and submitted reimbursement claims (FR-005) — never attendance exceptions,
   which are a separate concern.
2. **Given** the Active Projects and Total Machinery KPI widgets and the Monthly Expenses widget,
   **When** requested, **Then** each returns the unavailable state (Projects/Machinery/expense
   figures are not yet computable modules), per User Story 1's contract.
3. **Given** today's attendance records, **When** the Today's Attendance table widget is requested,
   **Then** it returns the first 8 records (employee, department placeholder pending an HR module,
   status) ordered consistently.
4. **Given** recent leave applications, **When** the Recent Leaves table widget is requested,
   **Then** it returns the most recent applications (type, days, status) for the caller's company.
5. **Given** the Quick Stats Sidebar's Employees on Muster figure, **When** requested, **Then** it
   returns present/total counts from already-specced attendance data; Contract Value, Materials
   Cost, Fuel Cost, and Hire Bills return the unavailable state.

---

### User Story 3 - Query the Activity Log (Priority: P1)

An admin views a chronological feed of recorded actions, filterable by module and time range.

**Why this priority**: Every prior feature (Login, Settings, My Workspace) has been writing to the
shared audit log and explicitly deferring the read side to this feature — this is the point where
that investment starts paying off, and it needs no new/unbuilt data source at all.

**Independent Test**: Can be fully tested by performing a handful of already-audited actions
(e.g., a Settings company edit, a My Workspace leave application) and confirming they appear in the
feed, newest first, correctly filterable by module and time range.

**Acceptance Scenarios**:

1. **Given** audit log entries spanning multiple modules and times, **When** the feed is requested
   with no filters, **Then** it returns entries newest-first, each formatted as actor, action,
   target, and timestamp.
2. **Given** the same data, **When** filtered by a specific module (e.g. Settings), **Then** only
   that module's entries are returned; **When** filtered by a time range (Today / 7 days / 30
   days), **Then** only entries within that window are returned; the two filters combine.
3. **Given** a module named in the PRD's filter list for which no entries exist yet because that
   module isn't built (e.g. Machinery, Payroll beyond what's already audited), **When** selected as
   a filter, **Then** it returns an empty result, not an error.
4. **Given** the feed, **When** requested by a caller scoped to one company, **Then** only that
   company's entries are returned (or all companies', for a cross-company Super Admin).
5. **Given** any entry, **When** inspected, **Then** it is exactly what was originally written —
   this feature is read-only against the log and never modifies or deletes an entry.
6. **Given** the feed with any combination of module/time-range filters applied, **When**
   `GET /dashboard/activity-log/export` is called, **Then** a CSV is returned with the same
   columns as the feed (Timestamp, User, Action, Module, Entity, Before, After) and the same
   filters and company scoping applied — matching master PRD §7.2.5's "Export: CSV" requirement.
   Found missing during the master-PRD alignment audit: the original scope built the feed
   read-side but never the export.

---

### User Story 4 - Notifications Center (Priority: P2)

An admin sees a list of system-generated notifications (no manual creation), with a bell-badge
count, where notifications automatically disappear once their underlying condition resolves.

**Why this priority**: Builds on User Story 1's extensibility pattern for a second, notification-
shaped registry; valuable but not the primary landing screen.

**Independent Test**: Can be fully tested by creating a pending leave application and a pending
re-enrolment request, confirming both appear as notifications with the bell count incremented, then
resolving one (approve the leave) and confirming it disappears without any manual dismiss action.

**Acceptance Scenarios**:

1. **Given** a pending leave application, a pending biometric re-enrolment request, and a company
   with a period that has never had a payroll run marked processed, **When** notifications are
   requested, **Then** all three appear with their documented icon color, title, and subtitle.
2. **Given** notification types requiring an unbuilt module (Document Expiry, Maintenance Due, Fuel
   Variance, Contractor Compliance), **When** requested, **Then** they are simply absent from the
   list (not errored, not shown as empty placeholder rows) — consistent with them being registered
   but inert until their module lands.
3. **Given** a pending leave application that is subsequently approved, **When** notifications are
   next requested, **Then** it no longer appears — no manual dismiss action exists or is needed.
4. **Given** the notification list, **When** the bell-badge count is requested, **Then** it equals
   the count of currently active notifications for the caller's scope.
5. **Given** a request for notifications from a caller scoped to one company, **When** made,
   **Then** only that company's notifications are included.

---

### User Story 5 - Site Dashboard (Priority: P2)

An admin selects a site and sees site-scoped KPIs and tables, refreshing when the selection
changes.

**Why this priority**: Reuses the same widget framework and already-specced Site/Attendance data,
valuable for site-level oversight but secondary to the main Dashboard.

**Independent Test**: Can be fully tested by selecting a seeded site and confirming Workers Today
and the Today's Attendance table reflect only that site's employees, while Machinery
Deployed/Fuel Consumed/Material Stock Value widgets return the unavailable state.

**Acceptance Scenarios**:

1. **Given** a company's sites, **When** the site selector list is requested, **Then** it returns
   the caller's company's sites (name and id) for selection.
2. **Given** a selected site with employees who punched in today, **When** the Workers Today widget
   is requested, **Then** it returns the count of that site's employees currently marked present.
3. **Given** the same site, **When** the Today's Attendance table widget is requested, **Then** it
   returns only that site's employees' records.
4. **Given** Machinery Deployed, Fuel Consumed This Month, Material Stock Value, and the Machinery/
   Fuel/Material Stock/Recent Expenses table widgets, **When** requested for any site, **Then**
   each returns the unavailable state.
5. **Given** a site belonging to a different company than the caller's, **When** requested,
   **Then** it is rejected — site selection never crosses company boundaries (except for a
   cross-company Super Admin).

---

### User Story 6 - Group Dashboard and cross-company employee search (Priority: P2)

A cross-company (or single-company) user views per-company summary cards and a Group Total, plus a
search across employees by name/code/Aadhaar-last-4, scoped to whatever companies they can access.

**Why this priority**: Reuses already-specced Company/Employee data for the search and headcount
figures; the remaining figures (Payroll Cost, PF/ESIC Pending, Loans, Docs Pending) and the
Statutory Calendar depend on unbuilt modules.

**Independent Test**: Can be fully tested by requesting company cards for a multi-company group as
a cross-company Super Admin and confirming headcount is correct per company and in the Group Total,
then searching for a known employee by a 2+ character fragment of their name.

**Acceptance Scenarios**:

1. **Given** a cross-company Super Admin, **When** company cards are requested, **Then** one card
   per accessible company is returned with a correct Headcount, plus a Group Total card aggregating
   all of them; Payroll Cost, PF/ESIC Pending, Loans Outstanding, and Docs Pending each return the
   unavailable state.
2. **Given** a single-company-scoped user, **When** company cards are requested, **Then** only
   their own company's card (and a Group Total equal to it) is returned — no other company's data
   is exposed.
3. **Given** the Statutory Calendar widget, **When** requested by anyone, **Then** it returns the
   unavailable state (Challans module not yet built).
4. **Given** a search term of at least 2 characters, **When** the employee search is called,
   **Then** it matches against name, employee code, or Aadhaar last-4 digits across every company
   the caller can access, and rejects a shorter term before searching.
5. **Given** a search term shorter than 2 characters, **When** submitted, **Then** the request is
   rejected before any query runs.

---

### User Story 7 - Reports and export (Priority: P3)

An admin selects a report type, applies filters and a date range, views tabular results, and
exports to PDF or Excel — large exports complete asynchronously with a ready-to-download signal.

**Why this priority**: The least time-critical of this feature's areas, and most of the 8 named
report types depend on unbuilt modules — this story delivers the report-type registry and export
mechanism, with only Attendance and Employee reports actually computable today.

**Independent Test**: Can be fully tested by requesting the report-type list (confirming
availability flags), running the Attendance report for a date range, and exporting it to both PDF
and Excel; separately, confirming Machinery/Fuel/Project Cost/Expense/P&L report types return the
unavailable state when run.

**Acceptance Scenarios**:

1. **Given** the report-type list, **When** requested, **Then** it returns all 8 named types (plus
   Equipment Utilization) each flagged available or not-yet-available, with their supported
   filters for the available ones.
2. **Given** the Attendance or Employee report with a date range and applicable filters, **When**
   run, **Then** it returns tabular data computed from current data — never a cached or
   hardcoded result.
3. **Given** a not-yet-available report type (Payroll, Machinery, Fuel, Project Cost, Expense,
   P&L, Equipment Utilization), **When** run, **Then** it returns the unavailable state rather than
   fabricated or empty-but-implied-real data.
4. **Given** an available report's result, **When** export to PDF or Excel is requested, **Then** a
   real, correctly-formatted file matching the on-screen data is produced.
5. **Given** a report result whose row count exceeds the configured synchronous-export threshold,
   **When** export is requested, **Then** it is generated asynchronously and the caller receives a
   way to know when it's ready (polled status or a "Export Ready" notification, per User Story 4's
   framework) rather than the request hanging until completion.

---

### Edge Cases

- What happens when a widget's underlying computation throws an unexpected error (not simply
  "module not built")? It is reported as that specific widget's own failure state, distinct from
  the "module not available" state, and does not prevent the rest of the widget list from being
  returned.
- What happens when the Dashboard widget list is requested for a company with zero employees yet
  (freshly onboarded)? Computable widgets return real zero values (e.g., Total Employees: 0), not
  the unavailable state — "zero" and "not available" are distinct, never conflated.
- What happens to Activity Log entries for a company that's since been deactivated (Settings
  feature)? They remain fully queryable — deactivating a company doesn't affect audit history.
- What happens if two module filters that both have zero real entries are combined in Activity Log
  (e.g. Machinery + a time range with no data)? An empty result, not an error, consistent with User
  Story 3's Acceptance Scenario 3.
- What happens when an async export job fails partway through? The caller's ready-check/
  notification reflects a failed state with a reason, not silence or an infinite pending state.
- What happens when the same widget/report/notification type is requested extremely frequently
  (e.g., a misbehaving client polling every second)? Standard rate limiting applies at the API
  layer, consistent with this repo's existing throttling posture, rather than this feature building
  its own separate limiter.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST expose a single widget-list endpoint returning a self-describing
  array — each entry carrying an id, display type, title, section placement, and either a computed
  `value` or an `unavailable` state with a machine-readable reason — requiring no caller-side
  knowledge of individual widget shapes beyond this shared envelope.
- **FR-002**: The system MUST provide a widget registration mechanism such that adding a new
  widget requires no change to the endpoint's response contract for existing widgets, and MUST NOT
  require a version bump or breaking change to add one.
- **FR-003**: For any widget whose data depends on a module not yet implemented in this codebase
  (Machinery, Projects, Inventory, Partners, Payroll figures, Fuel, Compliance, Challans), the
  system MUST return the `unavailable` state rather than a fabricated, hardcoded, or zero value
  presented as real.
- **FR-004**: The system MUST compute every available widget's value fresh from current data on
  each request (or from a cache no older than a short, documented interval — target 30 seconds),
  never a hardcoded or indefinitely-stale value.
- **FR-005**: The system MUST compute company-wide KPIs (Total Employees, Present Today, Absent, On
  Leave, and Pending Approvals) from already-specced Employee/Attendance/Leave data, scoped to the
  caller's company. **Pending Approvals** is the sum of Pending leave applications (`/hr/leave`,
  always available since feature 003/005) plus, once each source module exists, Open maintenance
  jobs (`/machinery/maintenance`, feature 006) and Submitted reimbursement claims
  (`/hr/reimbursements`, feature 005 US12) — matching the master PRD's §7.2.1 formula exactly.
  Each additional source is read via that module's own exported service (never a direct
  cross-schema query, Principle I); a source module that doesn't exist yet is simply omitted from
  the sum, not treated as zero-and-final — this widget's computation is expected to pick up each
  new source automatically once specced, without a version bump (per FR-002's registry contract).
- **FR-006**: The system MUST provide a Today's Attendance table widget (first 8 records) and a
  Recent Leaves table widget, each scoped to the caller's company.
- **FR-007**: The system MUST provide a read/query endpoint over the existing shared audit log,
  supporting a module filter and a time-range filter (Today / 7 days / 30 days), returning entries
  newest-first with actor, action, target, module, and timestamp — this is strictly read-only; it
  MUST NOT modify, delete, or truncate any entry.
- **FR-008**: The system MUST scope Activity Log results to the caller's company, except for a
  cross-company Super Admin.
- **FR-009**: The system MUST provide a notifications endpoint returning currently-active,
  system-generated notifications (never manually created), computed fresh from underlying
  condition state rather than a stored "created" notification that must be separately dismissed —
  a notification simply stops appearing once its condition no longer holds.
- **FR-010**: The system MUST compute Pending Leave Approvals, Payroll Pending (months with no
  processed payroll run), and Biometric Re-enrolment Requests notification types from
  already-specced data; other named types (Document Expiry, Maintenance Due, Fuel Variance,
  Contractor Compliance) MUST be simply absent from the list until their underlying module exists,
  not shown as errored or placeholder rows.
- **FR-011**: The system MUST provide a notification count endpoint reflecting the current number
  of active notifications for the caller's scope.
- **FR-012**: The system MUST provide a site-selector endpoint listing the caller's company's
  sites, and site-scoped KPI/table widgets (Workers Today, Today's Attendance) computed from
  already-specced Site/Employee/Attendance data; Machinery/Fuel/Material-Stock-related widgets MUST
  return the unavailable state.
- **FR-013**: The system MUST reject a site-scoped request for a site outside the caller's company
  access, except for a cross-company Super Admin.
- **FR-014**: The system MUST provide per-company summary cards (Headcount from already-specced
  Employee data, computed fresh) plus a Group Total aggregating all companies the caller can
  access; Payroll Cost, PF/ESIC Pending, Loans Outstanding, and Docs Pending MUST return the
  unavailable state until their modules exist.
- **FR-015**: The system MUST scope Group Dashboard company cards strictly to companies the caller
  can access — a single-company user sees only their own company's card and a Group Total equal to
  it; only a cross-company Super Admin sees multiple.
- **FR-016**: The system MUST provide a cross-company employee search matching name, employee
  code, or Aadhaar-last-4-digits, requiring a minimum 2-character search term (rejecting shorter
  terms before querying), scoped to the companies the caller can access.
- **FR-017**: The system MUST return the unavailable state for the Statutory Calendar widget
  (Challans module not yet built).
- **FR-018**: The system MUST provide a report-type listing (all 8 PRD-named types plus Equipment
  Utilization) each flagged available or not-yet-available, with the available ones' supported
  filters described.
- **FR-019**: The system MUST compute the Attendance and Employee report types from already-specced
  data for a given date range and filters, fresh on each run; all other named report types MUST
  return the unavailable state when run rather than fabricated data.
- **FR-020**: The system MUST export an available report's result to a real PDF (via `pdfkit`) or
  Excel (via `exceljs`) file matching the on-screen tabular data.
- **FR-021**: The system MUST generate a report export asynchronously (via a background job) when
  its row count exceeds a configured threshold, and MUST provide the caller a way to detect
  readiness (status check or a notification, per FR-009's framework) rather than blocking the
  request until completion.
- **FR-022**: Every endpoint in this feature MUST be reachable only by a caller holding the
  required permission, checked before any computation occurs: the existing `DASHBOARD` permission
  gates the main Dashboard, Group Dashboard, Site Dashboard, Notifications, and Activity Log
  endpoints; the existing `REPORTS` permission gates Reports endpoints — no new permission values
  are introduced (per clarification).
- **FR-023**: Every endpoint in this feature MUST accept and return validated, typed request/
  response structures, consistent with this repo's existing DTO contract pattern.
- **FR-024**: The system MUST provide `GET /dashboard/activity-log/export`, streaming a CSV of the
  Activity Log feed (Timestamp, User, Action, Module, Entity, Before, After columns) honoring the
  same module/time-range filters and company scoping as the feed endpoint (FR from US3) — master
  PRD §7.2.5. Added during the master-PRD alignment audit; the original scope built only the
  feed's read side, not its export.

### Key Entities

- **Widget Definition**: A registered, backend-owned description of one dashboard tile — id,
  display type, title, section placement, and the function that computes its current value or
  unavailable state; not itself a persisted database row, but code-level registration metadata
  (parallel to how the Role/Permission Requirement pattern from earlier features is metadata, not a
  table).
- **Widget Result**: The per-request computed output of one Widget Definition — either a value
  payload or an `unavailable` marker with a reason (e.g. `module_pending`).
- **Notification Definition**: The same registration pattern as Widget Definition, but for
  notification types — a condition-check function and rendering metadata (icon color, title/
  subtitle template, action link).
- **Report Definition**: The same registration pattern again, for report types — availability flag,
  supported filters, and (for available ones) the query/compute function plus PDF/Excel rendering.
- **Export Job**: A tracked async report-export request — report type, filters, requesting user,
  status (pending/processing/ready/failed), and a download reference once ready.
- **Activity Log Entry (read side)**: The existing `AuditLogEntry` table (owned/written by prior
  features); this feature adds the first read/query surface over it — module filter, time-range
  filter, pagination — without altering its write path or schema ownership.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The Dashboard widget list for a company with existing data loads (all computable
  widgets resolved) in under 3 seconds under normal load (up to 500 employees), per the PRD's own
  performance NFR.
- **SC-002**: Across all testing, zero widgets/notifications/reports backed by an unbuilt module
  ever return a value presented as real data — 100% return the explicit unavailable state.
- **SC-003**: Across all testing, adding a new widget/notification/report-type registration never
  requires changing the shape of an existing, already-registered one's response.
- **SC-004**: Across all testing, no Activity Log query ever returns another company's entries to a
  non-cross-company caller.
- **SC-005**: Across all testing, zero notifications remain visible after their underlying
  condition has resolved, without any manual dismiss action.
- **SC-006**: 100% of available report exports (PDF and Excel) produce a file whose data matches
  the on-screen report result exactly.
- **SC-007**: Across all testing, an export whose row count exceeds the async threshold never blocks
  the requesting call until completion — a readiness signal is always available instead.
- **SC-008**: Across all testing, zero widget/notification/report/search results are returned to a
  caller lacking the required permission or company/group access.

## Assumptions

- Per the confirmed scope decision, this feature builds a generic, extensible registration
  framework (widgets, notifications, report types) and wires real computation only for data already
  specced by prior features (Login, Settings, My Workspace); everything else registers with an
  explicit "not available yet" state rather than being stubbed with fabricated data or omitted
  entirely from the registry.
- "Short refresh interval" (PRD's own wording for live-data caching) is fixed at 30 seconds for
  this spec's purposes, matching SC-001's performance target's spirit; this is a planning-level
  default, not a hard business requirement, and may be tuned during implementation.
- The row-count threshold that triggers asynchronous report export (FR-021) is a planning-level
  configuration value, not fixed by this spec; a reasonable starting default (e.g., 1,000 rows) is
  expected, centrally configured per Constitution Principle III.
- Emailing an export (PRD: "can optionally be emailed") is explicitly out of scope for this
  feature — the PRD's own wording ("optionally") signals it's not core, and no email-delivery
  infrastructure exists yet in this repo's stack; the download mechanism itself is fully in scope.
  Adding email delivery is a natural, separate future enhancement once such infrastructure exists.
- Group Dashboard access is not restricted to Super Admin specifically — any authenticated caller
  with the Dashboard permission sees company cards scoped to whatever companies they can access
  (one company for a normal user, all of them for a cross-company Super Admin), per FR-015 —
  matching the PRD's own "scoped to the requesting user's group-level access" wording rather than
  an outright block for non-Super-Admins.
- Equipment Utilization Report (PRD section 7) is folded into the Reports framework (User Story 7)
  as one more registered-but-unavailable report type rather than a bespoke feature area, since 100%
  of its content depends on the not-yet-built Machinery module; it becomes real once that module's
  own feature lands, without requiring rework of this feature's framework.
- "Push update" for the notification bell badge (PRD's alternative to polling) is not built in this
  feature — polling is the mechanism, consistent with no real-time/push infrastructure existing
  anywhere else in this repo's stack; a push mechanism can be added later as a transport-level
  enhancement without changing this feature's notification-computation contract.
