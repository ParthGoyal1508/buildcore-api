# Feature Specification: Projects Backend (Portfolio, Clients, Sites, BOQ, DWR, Revenue, P&L)

**Feature Branch**: `008-projects-backend`

**Created**: 2026-08-27

**Status**: Draft

**Input**: User description: "Projects Module (Portfolio, Clients, Sites, BOQ, Daily Work Reports,
Revenue & Billing, Project P&L) for the BuildCore API backend, per the PRD at
/Users/p0g02o7/Personal/ERP-Demo/docs/prd/05-projects.prd.md. This is the `projects` schema — all
project-management surfaces from portfolio tracking and BOQ-linked daily progress reporting to
dynamic P&L (pulling from hr/payroll, inventory, plant, and partners via their exported services).
Sites defined here are the geographic entities HR's geofencing already references (003's minimal
`Site` is the placeholder this feature replaces with the full Site master including geofence
radius). Clients are a new master record type owned exclusively by this module."

## Clarifications

### Session 2026-08-27

- Q: How should Project P&L be recalculated — on-demand per request or via a scheduled background
  job? → A: On-demand — the backend recalculates P&L figures when the `/projects/:id/pnl` endpoint
  is called, pulling live data from the source modules via their exported services; no background
  job or materialized snapshot is maintained in this pass (the PRD's "within minutes" target is
  achievable with on-demand reads given the expected project scale).
- Q: Can a project have multiple sites, or is it a 1:1 relationship? → A: One project can have
  multiple sites (a large highway project may span multiple toll plazas / work fronts); the Site
  belongs to a Project via a `projectId` FK, and the HR attendance module filters by `siteId`.
- Q: What exactly is blocked when a project is marked `Is Locked`? → A: All transactional writes
  against that project are rejected: DWR creation/updates, Revenue entries, Bill/Expense entries,
  BOQ quantity updates. Read operations are never blocked. The lock is enforced by the backend on
  every write endpoint for project-scoped transactions, independent of client-side UI state.
- Q: What is the RA Bill approval workflow — is there a submission → verification → payment state
  machine? → A: Three-state: Draft → Submitted → Approved (with optional Rejected path back to
  Draft). Approved RA bills contribute to Revenue Booked in the P&L. The PRD does not specify a
  payment processing flow, so the Approved state is the terminal "revenue recognized" state for
  this version.
- Q: What exact columns are required for BOQ Excel import validation? → A: BOQ No., Task Group,
  Task Name, Unit, Scope Qty, Start Date, Finish Date, Duration, Per Day Qty. Missing or
  non-parseable values in any of these columns cause that row to fail validation and appear in the
  downloadable error report. Rows with all optional columns missing but required ones present are
  accepted with defaults.
- Q: What `Permission` enum values should gate the `projects` module endpoints? → A: Three focused
  permissions — `PROJECTS` (portfolio/clients/sites/BOQ), `DWR` (daily work reports),
  `PROJECT_FINANCIALS` (revenue/RA bills/P&L). `PROJECTS` already exists in 002's pre-built enum;
  `DWR` and `PROJECT_FINANCIALS` are genuinely new (002 did not anticipate this module needing two
  finer-grained permissions) and have been reconciled into 002's own data-model.md/tasks.md as the
  canonical source of truth for the enum, not just declared here (master-PRD alignment audit).
- Q: Should the `Site` entity be owned by the `projects` schema or the `hr` schema? → A: `projects`
  schema already owns `Site` — feature 003 built it there directly (not in `hr`), anticipating this
  feature's needs, with geofence fields (`latitude`, `longitude`, `geofenceRadiusMeters`) and
  `weeklyOffDay`/`holidays` already in place. This feature does not move or re-add geofence columns;
  it extends the existing `Site` table with the fields it's still missing (`projectId` FK, `Address`,
  `Status`) via an additive migration. HR's attendance module continues reading geofence/holiday
  data via 003's existing exported methods — `SitesService.getGeofence(siteId)`,
  `.getHolidayCalendar(siteId)`, `.getWeeklyOffDay(siteId)` — unchanged. This feature adds a new,
  separate `getSiteById(siteId)` export (full Site row, not just geofence fields) for its own
  DWR/BOQ/project-detail consumers; HR does not switch to it (research.md §2).
- Q: Where do the per-category Budget figures in the P&L Cost Breakdown table come from? → A:
  Manually entered — an admin enters a Budget amount per P&L category per project, stored as a
  `ProjectBudget` table (`projectId`, `category`, `amount`, `companyId`). Budget entry is its own
  endpoint (`PUT /projects/:id/budget`) gated by `PROJECT_FINANCIALS` permission. The Cost
  Breakdown table compares these stored budgets against dynamically computed actuals.
- Q: Should the PRD's per-site Project Documents grid be in scope for this feature? → A: Yes,
  in scope as P3. A `ProjectDocument` entity stores per-project file uploads against a document
  type dropdown (Name, File, Path, Remark). Endpoint: `POST /projects/:id/documents` (upload),
  `GET /projects/:id/documents` (list), `DELETE /projects/:id/documents/:docId` (remove row).
  Gated by `PROJECTS` permission. Uses the same object-storage reference pattern as 005.
- Q: Should BOQ item `doneQty` count Submitted or only Approved DWR quantities? → A: Only
  **Approved** DWRs count toward BOQ progress (master PRD §7.5.3: "Only Approved DWRs count toward
  project progress % calculation"). Submitting a DWR does not move `doneQty`; approving it does.
  This corrects the original draft's US5 AC2/FR-006, which incremented `doneQty` on submission.
- Q: Is BOQ Excel import a single-step commit or a validate-then-confirm two-step flow? → A:
  Two-step, matching master PRD §7.5.3 ("Errors displayed per row before import confirmed") and
  §11's cross-cutting import pattern. `POST /projects/:id/boq/import/validate` uploads the file and
  returns a per-row validation report (valid rows + errors) without writing anything; a separate
  `POST /projects/:id/boq/import/confirm` (referencing the validated batch) commits the valid rows.
  This corrects the original draft's single-endpoint blind commit.
- Q: Should the P&L report "Machinery & Fuel" as a single combined cost line or two separate
  lines? → A: **Two separate lines** — Machinery Cost and Fuel Cost are distinct P&L categories
  matching the master PRD §7.5.4. Machinery Cost comes from `PlantService.getMachineryCostByProject()`
  (logbook hours × hire rate + owned depreciation); Fuel Cost comes from `PlantService.getFuelCostByProject()`
  (fuel entries for the project). Both are separate `ProjectBudget` rows with categories
  `machinery` and `fuel`.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Manage Clients master (Priority: P1)

An admin creates, edits, and deactivates client records; the client dropdown in project forms
populates from this master.

**Why this priority**: Every project requires a Client FK — this master must exist before any
project can be created. It has no dependencies of its own.

**Independent Test**: Can be fully tested by creating a client, confirming it appears in the list,
editing its GSTIN, and soft-deleting it (status toggle) — independent of projects or sites existing.

**Acceptance Scenarios**:

1. **Given** a valid admin session, **When** `POST /projects/clients` is called with Name, Contact
   Person, Phone, Email, Address, GSTIN, and Status, **Then** the client is created and returned
   with its generated `id`.
2. **Given** an existing client, **When** `PATCH /projects/clients/:id` is called, **Then** the
   record is updated and the change is written to the audit log.
3. **Given** the client list, **When** `GET /projects/clients?search=&status=` is called, **Then**
   it returns paginated results filterable by name/contact search and active/inactive status.
4. **Given** a client linked to one or more projects, **When** soft-delete (status toggle to
   Inactive) is attempted, **Then** the client becomes Inactive but is not deleted; existing
   project FKs remain intact.
5. **Given** a duplicate GSTIN, **When** `POST /projects/clients` is called, **Then** a 409 is
   returned with a descriptive error — GSTINs must be unique per company.

---

### User Story 2 - Manage Sites master (Priority: P1)

An admin creates and manages site records with geofencing data (lat/lng, radius); these are the
same `Site` entities HR's attendance geofencing already reads.

**Why this priority**: Sites are referenced by HR attendance (003), project assignment, and
machinery deployment. Building the full Site master (replacing 003's placeholder `Site`) enables
HR's geofence validation to use real radius values, and allows project detail views to list their
sites.

**Independent Test**: Can be fully tested by creating a site with coordinates and a geofence
radius, confirming `GET /projects/sites/:id` returns it, and confirming HR's attendance endpoint
for a punch outside the radius now flags it correctly — independent of project portfolio or DWR
existing.

**Acceptance Scenarios**:

1. **Given** a valid project, **When** `POST /projects/sites` is called with Site Name, `projectId`,
   Location address, Latitude, Longitude, Geofence Radius (meters), and Status, **Then** the site
   is created and linked to the project.
2. **Given** a site record, **When** `PATCH /projects/sites/:id` updates the geofence radius,
   **Then** HR's attendance punch validation immediately uses the new radius (no cache invalidation
   required — on-demand read).
3. **Given** the sites list, **When** `GET /projects/sites?projectId=&status=` is called, **Then**
   it returns sites filtered by project and status.
4. **Given** an inactive site, **When** `PATCH /projects/sites/:id` sets `status: 'inactive'`,
   **Then** HR's attendance punch endpoint returns a "site inactive" rejection for that `siteId`.
5. **Given** a site, **When** `GET /projects/sites/:id` is called, **Then** it includes the
   geofence coordinates used by HR's attendance module.

---

### User Story 3 - Manage Project Portfolio (Priority: P1)

An admin creates, edits, locks, and views projects; the project detail endpoint aggregates data
from the seven detail tabs (Employees, Machinery, Materials/Inventory, DWRs, Bills/Expenses,
Revenue, Costing).

**Why this priority**: The core entity of the module — everything else (BOQ, DWR, revenue, P&L)
hangs off a `projectId`. Depends on Clients (US1) and Sites (US2) existing.

**Independent Test**: Can be fully tested by creating a project (with a seeded client), confirming
it appears in the portfolio list with correct filters, opening its detail endpoint, and verifying
each tab section returns data (even if empty arrays initially) — independent of BOQ/DWR/P&L.

**Acceptance Scenarios**:

1. **Given** a valid client and admin session, **When** `POST /projects` is called with all
   required fields (Code, Name, `clientId`, Location, Contract Value, Start Date, Status, Project
   Manager, Division), **Then** the project is created with an auto-generated Code if not supplied
   (using Settings' code-series service) and returned with its `id`.
2. **Given** the project list, **When** `GET /projects?search=&status=&clientId=&page=` is called,
   **Then** results are paginated and filterable by status, client, and free-text search on name/
   code.
3. **Given** a project, **When** `GET /projects/:id` is called, **Then** the response includes
   the core project fields plus aggregated tab data: assigned employees (from `hr` via HR service),
   deployed machinery (from `plant` via Plant service), inventory items at the project store (from
   `inventory` via Inventory service), DWR count and latest date, bill/expense summary, revenue
   summary, and costing breakdown — all read via exported service calls, never direct cross-schema
   queries.
4. **Given** a project, **When** `PATCH /projects/:id` sets `isLocked: true`, **Then** all
   subsequent DWR, Revenue, Bill, Expense, and BOQ-quantity write endpoints for that project return
   `423 Locked`, and the lock is enforced server-side regardless of client state.
5. **Given** a locked project, **When** `PATCH /projects/:id` sets `isLocked: false`, **Then**
   write operations for that project resume normally.
6. **Given** a project, **When** `DELETE /projects/:id` is attempted while the project has linked
   DWRs, revenue, or bills, **Then** a `409 Conflict` is returned; delete is only permitted for
   projects with no transactional records.

---

### User Story 4 - Manage BOQ (Bill of Quantities) (Priority: P2)

An admin creates BOQ task groups and individual task items for a project, imports BOQ data from
Excel with row-level validation, and tracks BOQ quantities as DWRs are submitted against them.

**Why this priority**: BOQ is the target-quantity reference that makes DWRs meaningful — without
it, DWR entries have no baseline to measure progress against. Depends on Project (US3).

**Independent Test**: Can be fully tested by creating a BOQ task group, adding three task items
to it, validating a five-row Excel BOQ (with one deliberately malformed row) via the
`validate` endpoint, confirming the report identifies the bad row and shows four valid rows, then
calling `confirm` and confirming exactly those four rows are created — independent of DWR or P&L.

**Acceptance Scenarios**:

1. **Given** a project, **When** `POST /projects/:id/boq/groups` is called with BOQ No., Task
   Group Name, Start Date, Finish Date, and Scope Qty, **Then** the group is created and linked to
   the project.
2. **Given** a BOQ group, **When** `POST /projects/:id/boq/items` is called with BOQ No., Task
   Name, Unit, Scope Qty, Start Date, Finish Date, Duration, and Per Day Qty, **Then** the item is
   created and its Pending Qty initialised to Scope Qty.
3. **Given** a BOQ item, **When** DWRs are submitted against it, **Then** `GET /projects/:id/boq`
   returns the item with updated Done Qty, Pending Qty, Avg Qty Per Day, and Days to Complete
   — computed from submitted DWR entries.
4. **Given** an Excel file with the required BOQ columns (BOQ No., Task Group, Task Name, Unit,
   Scope Qty, Start Date, Finish Date, Duration, Per Day Qty), **When** `POST
   /projects/:id/boq/import/validate` is called, **Then** it returns a per-row validation report
   (valid rows + rows with missing/non-parseable required columns, each with row number, column
   name, and error reason) without writing anything, downloadable as CSV; **When** `POST
   /projects/:id/boq/import/confirm` is then called referencing that validated batch, **Then** only
   the valid rows are created.
5. **Given** a locked project, **When** any BOQ write endpoint is called, **Then** `423 Locked` is
   returned.
6. **Given** a BOQ Estimate Excel file, **When** `POST /projects/:id/boq/estimate-import` is
   called, **Then** the same validation pipeline applies and estimates are stored as a separate
   `isEstimate: true` variant on the BOQ items.

---

### User Story 5 - Daily Work Reports (DWR) (Priority: P2)

A site supervisor creates and submits DWRs for a project day; the DWR captures task-level
measurement data (Chainage, Layer, Qty formula) linked to BOQ items, along with worker counts,
machinery deployment, weather, and attachments. An admin reviews and approves submitted DWRs.

**Why this priority**: DWR submission is the PRD's primary daily operational flow; it feeds BOQ
progress tracking and the P&L's activity level. Depends on BOQ (US4) and Sites (US2).

**Independent Test**: Can be fully tested by creating a DWR for a seeded project/BOQ item,
computing Actual Qty from the measurement formula (Nos × Nos × Length × Breadth × Depth ×
Density), submitting it and confirming the BOQ item's Done Qty does **not** change yet, then
approving it and confirming Done Qty increments at that point — independent of revenue or P&L.

**Acceptance Scenarios**:

1. **Given** a project and BOQ item, **When** `POST /projects/dwr` is called with Project, Work
   Date, Supervisor, Task Group, Task, measurement fields, Worker Count, Machinery Count,
   Progress %, and Weather, **Then** the DWR is created with status `draft` and the DPR Number
   auto-generated as `{siteCode}-{sequence}`.
2. **Given** a draft DWR, **When** `PATCH /projects/dwr/:id` sets `status: 'submitted'`, **Then**
   the DWR moves to `submitted` status; the BOQ item's `doneQty` does **not** change yet (master PRD
   §7.5.3 — only Approved DWRs count toward progress).
3. **Given** a submitted DWR, **When** `PATCH /projects/dwr/:id/approve` is called by an admin,
   **Then** the DWR moves to `approved` status, the approval is recorded with actor and timestamp,
   and the BOQ item's `doneQty` increments by the DWR's Actual Qty (pending/remaining fields
   recompute at this point, not at submission).
4. **Given** the DWR list, **When** `GET /projects/dwr?projectId=&dateFrom=&dateTo=&status=` is
   called, **Then** results are filterable by project, date range, and status, server-side
   paginated.
5. **Given** a DWR, **When** `GET /projects/dwr/:id` is called, **Then** the response includes
   all fields, the computed Actual Qty, and the BOQ item's current progress state (Total Scope,
   Done, Pending, Target Qty).
6. **Given** a locked project, **When** `POST /projects/dwr` is called against it, **Then** `423
   Locked` is returned.
7. **Given** a DWR, **When** a file is attached via `POST /projects/dwr/:id/attachments`, **Then**
   the file is stored (object storage reference) and linked to the DWR record.

---

### User Story 6 - Revenue, RA Bills & Work Orders (Priority: P3)

An admin records revenue entries and Running Account (RA) bills against a project; approved RA
bills contribute to Revenue Booked in the P&L. Work orders track subcontractor engagement.

**Why this priority**: Revenue tracking is needed for a meaningful P&L; work orders track the
subcontractor cost side. Depends on Project (US3).

**Independent Test**: Can be fully tested by creating a revenue entry, creating an RA bill, moving
it through Draft → Submitted → Approved, and confirming the approved RA bill's amount is reflected
in the P&L's Revenue Booked total — independent of DWR or BOQ.

**Acceptance Scenarios**:

1. **Given** a project, **When** `POST /projects/:id/revenue` is called with Description, Amount,
   Date, and Status (`received` | `pending`), **Then** the entry is created and linked to the
   project.
2. **Given** a project, **When** `POST /projects/:id/ra-bills` is called with billing details,
   **Then** the RA bill is created with status `draft`.
3. **Given** a Draft RA bill, **When** `PATCH /projects/:id/ra-bills/:billId/submit` is called,
   **Then** status moves to `submitted`.
4. **Given** a Submitted RA bill, **When** `PATCH /projects/:id/ra-bills/:billId/approve` is
   called, **Then** status moves to `approved` and its Amount is now included in Revenue Booked
   for P&L.
5. **Given** a Submitted RA bill, **When** `PATCH /projects/:id/ra-bills/:billId/reject` is
   called with mandatory remarks, **Then** status reverts to `draft` for revision.
6. **Given** a locked project, **When** revenue or RA bill write operations are attempted, **Then**
   `423 Locked` is returned.
7. **Given** a project, **When** `POST /projects/:id/work-orders` is called with vendor,
   Subcontractor, Work Detail, Terms, Labour/Material breakdowns, **Then** the work order is
   created and contributes to the Subcontractors cost line in P&L.

---

### User Story 7 - Project P&L (Priority: P3)

The P&L endpoint computes a live, cross-module project P&L — pulling Labour cost from payroll,
Material cost from inventory purchases, Machinery cost and Fuel cost separately from the plant
module, Subcontractor costs from partners billing, and Revenue Booked from approved RA bills and
direct revenue entries.

**Why this priority**: The PRD's flagship "no cost overrun surprises" outcome; depends on all
other stories plus cross-module data in hr/payroll, inventory, plant, and partners. Deliberately
last because it's a read-only aggregation over the other stories' data.

**Independent Test**: Can be fully tested (with seeded cross-module data) by calling
`GET /projects/:id/pnl?period=cumulative` and verifying each line (Labour, Materials, Machinery,
Fuel, Subcontractors, Overheads, Revenue Booked, Gross Profit, Margin %) matches the sum of the
underlying source records — independent of the frontend existing.

**Acceptance Scenarios**:

1. **Given** a project with cross-module transactional data, **When** `GET /projects/:id/pnl` is
   called, **Then** Labour cost equals the sum of `PayrollLineItem`s for employees assigned to
   this project (from `hr` via exported service), Material cost equals inventory purchase entries
   for this project's stores (from `inventory` via exported service), Machinery cost equals
   logbook-hours × hire rate + owned depreciation for this project's sites (from `plant` via
   `PlantService.getMachineryCostByProject()`), Fuel cost equals fuel entries for this project
   (from `plant` via `PlantService.getFuelCostByProject()`), and Subcontractors equals contractor
   billing for this project (from `partners` via exported
   service).
2. **Given** a period filter, **When** `?period=monthly|quarterly|yearly|cumulative` is passed,
   **Then** only the relevant date-range records are included in each line's computation.
3. **Given** the P&L endpoint, **When** any category's Actual cost exceeds its Budget by more than
   10%, **Then** that category's response includes a `costOverrunAlert: true` flag (the PRD's
   "cost overrun detection" success metric).
4. **Given** the P&L endpoint, **When** called, **Then** Gross Profit = Revenue Booked − Labour −
   Materials − Machinery & Fuel − Subcontractors − Overheads, and Margin % = Gross Profit /
   Revenue Booked × 100, both computed server-side.
5. **Given** no payroll/inventory/plant/partners data yet for a project, **When** P&L is called,
   **Then** it returns zero-value rows for all cost categories rather than a 404 or error.

---

### User Story 8 - Project Documents (Priority: P3)

An admin uploads and manages documents against a project (Address Details, Tax Details, GST docs,
and other file types from a configurable dropdown), each with an optional file path and remark.

**Why this priority**: Bounded addition completing the PRD's project detail page; depends only on
Project (US3) existing.

**Independent Test**: Can be fully tested by uploading two documents against a project with
different document types, confirming both appear in `GET /projects/:id/documents`, then deleting
one and confirming it no longer appears.

**Acceptance Scenarios**:

1. **Given** a project, **When** `POST /projects/:id/documents` is called with `documentType`,
   `file`, optional `filePath`, and optional `remark`, **Then** the document is stored (object-
   storage reference) and returned with its `id`.
2. **Given** the document list, **When** `GET /projects/:id/documents` is called, **Then** it
   returns all documents for that project grouped or ordered by `documentType`.
3. **Given** an existing document, **When** `DELETE /projects/:id/documents/:docId` is called,
   **Then** the record is removed and the object-storage reference is scheduled for cleanup.
4. **Given** a locked project, **When** `POST /projects/:id/documents` is attempted, **Then**
   `423 Locked` is returned.
5. **Given** an invalid `documentType` value, **When** `POST /projects/:id/documents` is called,
   **Then** a `400` with a descriptive validation error is returned.

---

### Edge Cases

- What happens when a BOQ item is imported via Excel but its Task Group doesn't exist yet? → The
  import creates the group on first reference (group name is the key).
- How does the system handle a DWR Actual Qty that would exceed the BOQ Scope Qty? → Accepted with
  a warning flag (`exceedsScope: true`) on the DWR record; not blocked, as physical overrun is a
  real site scenario.
- What if a cross-module service (payroll, inventory, plant, partners) is unavailable during a P&L
  call? → The P&L endpoint returns partial data for the available modules with an
  `unavailableModules: ['inventory']` array in the response rather than failing the entire request.
- What if a project has no sites? → Allowed (project can be in Planning status before sites are
  assigned); the Sites tab returns an empty array.
- What if `DELETE /projects/clients/:id` is called for a client with active projects? → Rejected
  with `409 Conflict`; only projects with no linked clients can be deleted.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST enforce `companyId` scoping on all `projects` schema tables — every
  project, client, site, BOQ item, DWR, revenue entry, and RA bill is tenant-isolated per
  Constitution Principle IV.
- **FR-002**: System MUST auto-generate Project Code via Settings' existing code-series service
  when none is provided, following the same pattern as Employee Code generation (005).
- **FR-003**: System MUST enforce the `Is Locked` flag server-side: any write operation (DWR,
  Revenue, Bills, BOQ quantity update) against a locked project MUST return `423 Locked`.
- **FR-004**: System MUST validate BOQ Excel imports in two steps: `POST
  /projects/:id/boq/import/validate` checks the required column schema and returns a per-row
  report (valid rows + invalid rows with row number, column, error reason, downloadable as CSV)
  without writing anything; `POST /projects/:id/boq/import/confirm` then commits only the valid
  rows from that validated batch (master PRD §7.5.3 — "errors displayed per row before import
  confirmed").
- **FR-005**: System MUST compute DWR Actual Qty server-side from the submitted measurement
  formula fields (Nos × Nos × Length × Breadth × Depth × Density) — the client submits the raw
  components, the server computes the total.
- **FR-006**: System MUST update BOQ item `doneQty`, `pendingQty`, `avgQtyPerDay`, and
  `daysToComplete` when a DWR against that BOQ item is **approved** — not on submission (master PRD
  §7.5.3: "Only Approved DWRs count toward project progress % calculation").
- **FR-007**: System MUST enforce RA Bill state transitions (Draft → Submitted → Approved /
  Draft ← Submitted via Reject) and reject out-of-order transitions with `409`.
- **FR-008**: System MUST compute Project P&L on-demand from live cross-module data via the source
  modules' exported service methods — never via direct `projects` → `hr`/`inventory`/`plant`/
  `partners` schema queries.
- **FR-009**: System MUST flag any P&L cost category where Actual > Budget by more than 10% with
  a `costOverrunAlert: true` field in the response.
- **FR-010**: System MUST support a period filter (`monthly | quarterly | yearly | cumulative`) on
  the P&L endpoint, restricting all cost/revenue aggregations to the selected date range.
- **FR-011**: System MUST auto-generate DPR Number as `{siteCode}-{sequence}` when a DWR is
  created.
- **FR-012**: `projects` schema already owns `Site` (built there by feature 003). This feature
  extends `Site` additively with `projectId`, `Address`, `Status` — it does not touch the existing
  geofence columns. HR's attendance module continues reading geofence/holiday data via 003's
  existing exported methods (`SitesService.getGeofence()`/`.getHolidayCalendar()`/
  `.getWeeklyOffDay()`), unchanged. This feature adds a separate `getSiteById()` export for its own
  consumers (Constitution Principle I — no direct cross-schema queries either way).
- **FR-013**: Approved RA bills MUST contribute to `revenueBooked` in the P&L calculation
  alongside direct `revenue` entries.
- **FR-014**: System MUST write audit log entries for: project create/edit/lock/unlock, client
  create/edit/delete, site create/edit, BOQ import, DWR approval, RA bill state transitions,
  revenue entries.
- **FR-015**: `DELETE /projects/:id` MUST be rejected with `409` if the project has any linked
  DWRs, revenue entries, RA bills, or BOQ items.
- **FR-018**: System MUST support project document upload via `POST /projects/:id/documents`,
  storing a file reference (object-storage, same pattern as 005) with `documentType`, optional
  `filePath`, and optional `remark`. `GET` lists all documents; `DELETE` removes a specific row.
  All three endpoints gated by `PROJECTS` permission and subject to the project lock check.
- **FR-017**: System MUST store per-project, per-category budget figures in a `ProjectBudget`
  table (`projectId`, `category` enum matching the five P&L cost lines, `amount`, `companyId`).
  `PUT /projects/:id/budget` MUST accept an array of category/amount pairs and upsert them;
  `GET /projects/:id/pnl` MUST include these stored budgets as the `budget` column in the Cost
  Breakdown rows.
- **FR-016**: Every controller endpoint in this feature MUST be gated by `JwtAuthGuard` plus one
  of three `@RequirePermission()` values added to 002's existing enum: `PROJECTS` (portfolio,
  clients, sites, BOQ), `DWR` (daily work reports), `PROJECT_FINANCIALS` (revenue, RA bills, P&L).
  No new Permission enum values beyond these three are introduced.

### Key Entities

- **Client** (`projects` schema): Name, ContactPerson, Phone, Email, Address, GSTIN (unique per
  company), Status (active/inactive), `companyId`.
- **Project** (`projects` schema): Code, Name, `clientId`, Location, ContractValue, StartDate,
  ExpectedEndDate, Status (planning/ongoing/on_hold/completed), ProjectManagerEmployeeId, Division,
  SiteType, IsHO, IsLocked, DepartmentType, ProjectType, PurchaseLimit, OrderNumber, Description,
  `companyId`.
- **Site** (`projects` schema — extends 003's existing `Site` in place, not a replacement):
  Name, `latitude`/`longitude`/`geofenceRadiusMeters`/`weeklyOffDay`/`holidays` (already present
  from 003), plus this feature's additions — `projectId` (FK), `Address`, `Status`
  (active/inactive) — `companyId`.
- **BOQTaskGroup** (`projects` schema): BOQNo, Name, `projectId`, StartDate, FinishDate,
  ScopeQty, `companyId`.
- **BOQTaskItem** (`projects` schema): BOQNo, `groupId`, TaskName, Unit, ScopeQty, StartDate,
  FinishDate, Duration, PerDayQty, DoneQty (running total from DWRs), IsEstimate, `companyId`.
- **DailyWorkReport** (`projects` schema): `projectId`, WorkDate, DPRNumber, `supervisorEmployeeId`,
  Weather, Status (draft/submitted/approved), WorkerCount, MachineryCount, Progress, Location,
  Description, `companyId`.
- **DWRTask** (`projects` schema): `dwrId`, `boqItemId`, Layer, ChainageFrom, ChainateTo,
  RoadSide, PaymentMode, Nos1, Nos2, Length, Breadth, Depth, Density, ActualQty (computed),
  ExceedsScope (boolean), Remarks.
- **Revenue** (`projects` schema): `projectId`, Description, Amount, Date, Status
  (received/pending), `companyId`.
- **RABill** (`projects` schema): `projectId`, BillNumber, Description, Amount, BillingDate,
  Status (draft/submitted/approved), ApprovedByUserId, `companyId`.
- **WorkOrder** (`projects` schema): `projectId`, `partnerId`, WorkDetail, Terms, LabourAmount,
  MaterialAmount, Status, `companyId`.
- **ProjectBudget** (`projects` schema): `projectId`, `category` (enum: labour | materials |
  machinery | fuel | subcontractors | overheads), `amount` (decimal), `companyId`. One row per
  category per project; upserted via `PUT /projects/:id/budget`.
- **ProjectDocument** (`projects` schema): `projectId`, `documentType` (string — from a
  configurable list: Address Details, Tax Details, Other Details, GST, Document), `fileRef`
  (encrypted object-storage reference), `filePath` (optional string), `remark` (optional string),
  `uploadedByUserId`, `uploadedAt`, `companyId`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: P&L data is fresh — values returned by `GET /projects/:id/pnl` reflect records
  created or updated in the last minute across all source modules.
- **SC-002**: Cost overrun detection — any category exceeding its budget by >10% is flagged within
  the same P&L API response (no separate polling required).
- **SC-003**: BOQ progress accuracy — `doneQty` on a BOQ item equals the arithmetic sum of all
  **approved** DWR task quantities for that item (submitted-but-unapproved DWRs are excluded),
  within floating-point tolerance.
- **SC-004**: BOQ import — a 100-row Excel import completes (including error report generation) in
  under 5 seconds.
- **SC-005**: Project lock is enforced within a single API request — a write to a locked project
  returns `423` without partially applying the change.
- **SC-006**: RA Bill processing — the state transition from Submitted to Approved is achievable
  in under 2 days from submission (the PRD metric), supported by the API's explicit
  `submit`/`approve` endpoints.
- **SC-007**: All active projects have complete detail data — `GET /projects/:id` returns
  non-null values for all tab sections (returning empty arrays is valid; returning `null` is not).

## Assumptions

- Settings' code-series service (002) supports a `PROJECTS` series type with the same interface
  used for Employee Code generation; if it does not, a projects-specific code generator is built
  within the `projects` module.
- The `plant` module (machinery) exposes `getMachineryCostByProject(projectId, period)` and
  `getFuelCostByProject(projectId, period)` as **two separate** service methods for P&L —
  if they do not yet exist, each P&L line returns zero with an `unavailableModules` flag.
- The `partners` module exposes a `getSubcontractorCostByProject(projectId, period)` service
  method for P&L — same fallback applies.
- The `inventory` module exposes a `getMaterialCostByProject(projectId, period)` service method
  for P&L — same fallback applies.
- HR's payroll module does **not yet** expose a `getLabourCostByProject(projectId, period)` method
  as of 005's current spec, and `PayrollLineItem` does not yet carry a `projectId` field — both are
  required for this P&L line and are added by amending 005's spec/data-model/tasks as part of this
  feature's build-out (research.md §X), not assumed pre-existing. Until that lands, the Labour P&L
  line returns zero with `unavailableModules: ['hr']`, same as the other cross-module fallbacks.
- 003's `Site` (id, companyId, name, latitude, longitude, geofenceRadiusMeters, weeklyOffDay,
  holidays) already exists in the `projects` schema; this feature extends it in-place with
  `projectId`, `Address`, `Status` via an additive migration — no data migration needed, and no
  geofence columns are re-added (they already exist from 003).
- File attachments (DWR, BOQ error reports) use the same object-storage reference pattern
  established in 005 (EmployeeDocument) — no new storage infrastructure.
- BOQ import is synchronous for files up to 1,000 rows; larger files are out of scope for this
  version.

---

## Amendment 2026-09-01 — Project Planning & Target-vs-Actual Reporting

**Reason**: A gap audit against the module/submodule matrix found two uncovered items. Row 25
("Projects Portfolio: ... **Project Planning** ...") names a planning surface this spec does not
have: a project currently has a start and end date and a BOQ, but no decomposition into phases,
activities, or milestones, no baseline schedule, and therefore no notion of whether it is running
late. Row 26 ("Daily Progress Report: ... **Monthly Report Chart and Target report** ...") names a
target-versus-actual comparison this spec cannot produce, because there is no target to compare
actuals against — DWR (US5) records what was done, and BOQ (US4) records what is contracted, but
nothing records what was *planned* for a given period. This amendment adds the plan and the
comparison. Everything already specified above is unchanged.

### User Story 9 - Build a project schedule of activities and milestones (Priority: P2)

A planning engineer decomposes a project into phases and activities, each with a planned start and
finish, a planned quantity drawn from the BOQ, a dependency on preceding activities, and an assigned
responsible party. Key dates are marked as milestones. The saved schedule becomes the project's
baseline.

**Why this priority**: The plan is the reference every subsequent comparison needs. It depends on
the project and BOQ existing (US3, US4) but nothing depends on it except the reporting stories.

**Independent Test**: Create a two-phase schedule with four activities and one milestone, baseline
it, and confirm the computed project finish date matches the latest activity finish — without any
DWR existing.

**Acceptance Scenarios**:

1. **Given** a project, **When** `POST /projects/:id/phases` is called with `name`, `sequence`, and
   optional `description`, **Then** the phase is created.
2. **Given** a phase, **When** `POST /projects/phases/:id/activities` is called with `name`,
   `plannedStart`, `plannedFinish`, optional `boqItemId`, optional `plannedQuantity`,
   `weightagePercent`, and optional `responsibleEmployeeId`, **Then** the activity is created.
3. **Given** an activity with `plannedFinish` before `plannedStart`, **When** creation is attempted,
   **Then** `400 Bad Request`.
4. **Given** activities in a project, **When** their `weightagePercent` values sum to something
   other than 100, **Then** the schedule may be saved but MUST NOT be baselined, and the attempt to
   baseline reports the actual sum.
5. **Given** two activities, **When** `POST /projects/activities/:id/dependencies` is called with a
   `predecessorActivityId` and a `dependencyType` (finish_to_start|start_to_start|finish_to_finish),
   **Then** the dependency is created.
6. **Given** a dependency that would create a cycle, **When** it is created, **Then**
   `400 Bad Request` naming the cycle path.
7. **Given** an activity whose `plannedStart` precedes a finish-to-start predecessor's
   `plannedFinish`, **When** it is saved, **Then** it is flagged `dependencyViolation` rather than
   blocked, so a plan may be saved mid-edit.
8. **Given** an activity, **When** `PATCH /projects/activities/:id` sets `isMilestone: true` with a
   `milestoneName`, **Then** it appears in the project's milestone list.
9. **Given** a complete schedule, **When** `POST /projects/:id/schedule/baseline` is called by a
   holder of `PROJECTS`, **Then** the current planned dates and quantities are frozen as
   `baselineStart`, `baselineFinish`, and `baselineQuantity` on every activity, and the baseline
   version increments.
10. **Given** a baselined schedule, **When** planned dates are edited, **Then** the edit is
    permitted and the variance against the baseline is recomputed — the baseline itself is
    immutable and only a new baseline supersedes it.
11. **Given** a project whose `isLocked` flag is set, **When** any schedule write is attempted,
    **Then** it is rejected by the existing lock rule (FR-003), which this amendment extends to
    cover schedule entities.

### User Story 10 - Set and track periodic targets (Priority: P2)

A project manager sets monthly (or weekly) targets per activity or BOQ item — a quantity to be
achieved in the period — and the system compares them against the actual quantities the DWRs
recorded, producing the achievement percentage the matrix's "Target report" calls for.

**Why this priority**: This is the direct answer to the matrix's target report. It depends on the
schedule (US9) for activities and on the existing DWR flow (US5) for actuals.

**Independent Test**: Set a monthly target of 500 cum for an activity, record DWRs totalling 400 cum
in that month, and confirm the target report shows 80% achievement and a 100 cum shortfall.

**Acceptance Scenarios**:

1. **Given** a project activity or BOQ item, **When** `POST /projects/targets` is called with
   `projectId`, `periodType` (weekly|monthly), `periodStart`, `periodEnd`, and `lines[]` (each with
   an `activityId` or `boqItemId` and a `targetQuantity`), **Then** the target set is created.
2. **Given** an overlapping target set for the same project, period type, and activity, **When**
   creation is attempted, **Then** `409 Conflict`.
3. **Given** a target set, **When** `GET /projects/:id/reports/target-vs-actual?from=&to=&periodType=`,
   **Then** each line returns target quantity, actual quantity summed from approved DWR
   measurements in the period, achievement percentage, and variance, with a project-level rollup
   weighted by each activity's `weightagePercent`.
4. **Given** a period with no target set, **When** the report is read, **Then** actuals are still
   reported with the target shown as unset rather than zero, so achievement is not misreported as
   infinite or zero.
5. **Given** the monthly report request, **When**
   `GET /projects/:id/reports/monthly?year=&month=`, **Then** a period summary returns opening and
   closing cumulative progress, quantity achieved, target, achievement percentage, man-days,
   equipment hours, and material consumed, sourced through the existing cross-module service
   methods rather than direct cross-schema queries.
6. **Given** a series of months, **When**
   `GET /projects/:id/reports/progress-trend?from=&to=`, **Then** a per-period series of planned
   cumulative progress and actual cumulative progress is returned — the data behind the matrix's
   "Monthly Report Chart".
7. **Given** any of these reports, **When** `?format=xlsx` or `?format=pdf` is requested, **Then** a
   real file is produced using the project's existing export libraries, generated asynchronously
   above the configured row threshold.

### User Story 11 - Schedule variance and delay analysis (Priority: P3)

A project manager sees, per activity, whether it is ahead of, on, or behind its baseline, and sees
the project's overall planned-versus-actual progress with the critical delayed activities called
out.

**Why this priority**: The analytical layer over US9 and US10. Valuable but strictly derivative, so
it is delivered last.

**Independent Test**: With a baselined schedule where one activity's actual progress trails its
planned progress, read the variance report and confirm that activity is flagged `behind_schedule`
with the correct slippage in days.

**Acceptance Scenarios**:

1. **Given** a baselined schedule with recorded actuals, **When**
   `GET /projects/:id/reports/schedule-variance`, **Then** each activity returns baseline dates,
   current planned dates, actual start and finish (derived from the first and last DWR measurement
   against it), percent complete, and a status of `not_started`, `on_track`, `behind_schedule`, or
   `completed`.
2. **Given** an activity whose percent complete trails its time-elapsed percentage by more than a
   configurable tolerance, **When** the report is read, **Then** it is flagged `behind_schedule`
   with the slippage expressed in days.
3. **Given** the project, **When** the variance report is read, **Then** overall planned progress
   (weightage-weighted, time-elapsed) and actual progress (weightage-weighted, quantity-based) are
   returned along with the resulting schedule variance percentage.
4. **Given** activities on the longest dependency chain, **When** the variance report is read,
   **Then** those activities are marked `isCritical` and a delay on any of them is reported as
   affecting the project finish date.
5. **Given** a project with no baseline, **When** the variance report is requested, **Then** the
   response reports that no baseline exists rather than comparing against unset values.
6. **Given** an activity with no linked BOQ item and no recorded quantity, **When** percent complete
   is computed, **Then** it falls back to the manually entered `percentComplete` on the activity,
   and the report marks the source so the two are not conflated.

### Additional Edge Cases

- A BOQ item's quantity is revised after targets referencing it were set → the targets keep their
  original quantities; the report shows both so the revision is visible rather than silently
  restating history.
- An activity is deleted after DWRs recorded actuals against it → deletion is rejected with `409`;
  activities with actuals may only be marked cancelled.
- A dependency cycle is introduced across phases → rejected with the cycle path named, the same as
  within a phase.
- A target is set for a period that has already fully elapsed → permitted; a target may legitimately
  be recorded retrospectively, and the report immediately shows the achieved percentage.
- The project's `isLocked` flag is set mid-period → schedule and target writes are rejected by the
  existing lock rule, while the reports remain readable.
- An activity's weightages are edited after baselining → permitted, but the project-level rollup
  reports both baseline and current weightage sums so the comparison basis is explicit.

### Additional Functional Requirements

- **FR-019**: The system MUST support decomposing a project into ordered Phases, each containing
  Activities with planned start/finish, optional BOQ item linkage, optional planned quantity, a
  weightage percent, an optional responsible employee, and an optional milestone marker.
- **FR-020**: Activity dependencies MUST support finish-to-start, start-to-start, and
  finish-to-finish types, and the system MUST reject any dependency that would create a cycle with
  `400 Bad Request` naming the cycle path.
- **FR-021**: A dependency violation in the planned dates (an activity starting before its
  finish-to-start predecessor finishes) MUST be flagged rather than blocked, so a partially edited
  plan can be saved.
- **FR-022**: A schedule MUST NOT be baselinable while its activities' `weightagePercent` values do
  not sum to 100; the rejection MUST report the actual sum.
- **FR-023**: Baselining MUST freeze each activity's current planned dates and quantities as
  immutable baseline values and increment a baseline version; subsequent planned-date edits MUST be
  permitted and MUST recompute variance against the frozen baseline rather than altering it.
- **FR-024**: The existing project-lock rule (FR-003) MUST extend to all schedule, activity,
  dependency, and target write operations.
- **FR-025**: An activity with recorded actuals MUST NOT be deletable (`409 Conflict`); it may only
  be marked cancelled.
- **FR-026**: The system MUST support periodic (weekly or monthly) Target sets per project, with
  lines targeting an activity or a BOQ item; overlapping target sets for the same project, period
  type, and target entity MUST be rejected with `409 Conflict`.
- **FR-027**: Actual quantity for target comparison MUST be summed from approved DWR measurements
  in the period (US5, FR-005), never from a separately maintained figure, so target reporting and
  BOQ progress can never disagree.
- **FR-028**: A period with no target set MUST report actuals with the target explicitly unset;
  achievement percentage MUST NOT be computed against a zero or absent target.
- **FR-029**: Project-level achievement and progress rollups MUST be weighted by each activity's
  `weightagePercent`, and the report MUST state whether baseline or current weightages were used.
- **FR-030**: Activity percent complete MUST be derived from recorded quantity against planned
  quantity where a BOQ item or planned quantity exists, and MUST otherwise fall back to a manually
  entered value, with the report marking which source was used.
- **FR-031**: The schedule variance report MUST flag an activity `behind_schedule` when its percent
  complete trails its time-elapsed percentage by more than a configurable tolerance, expressing the
  slippage in days, and MUST mark activities on the longest dependency chain as `isCritical`.
- **FR-032**: The variance report MUST report the absence of a baseline explicitly rather than
  comparing against unset values.
- **FR-033**: The monthly report MUST source man-days, equipment hours, and material consumed
  through the existing cross-module service methods (`LabourService`, `PlantService`,
  `InventoryService`), never by direct cross-schema query — consistent with FR-008's rule for P&L.
- **FR-034**: All schedule and target write operations MUST be gated by `JwtAuthGuard` +
  `@RequirePermission(Permission.PROJECTS)` and reporting endpoints by the existing `REPORTS`
  permission, adding no new permission value; writes MUST be audit-logged with the new entity types
  `PROJECT_PHASE`, `PROJECT_ACTIVITY`, and `PROJECT_TARGET`.
- **FR-035**: Report exports MUST produce real XLSX/PDF files using the project's existing export
  libraries, generated asynchronously as a background job above the configured row threshold,
  matching 004 FR-021.

### Additional Key Entities

- **ProjectPhase**: An ordered grouping of activities within a project.
- **ProjectActivity**: A planned unit of work: planned and baseline start/finish, optional BOQ item
  link, planned and baseline quantity, weightage percent, responsible employee, milestone marker,
  criticality flag, and status.
- **ActivityDependency**: A typed precedence link between two activities.
- **ProjectTarget / ProjectTargetLine**: A periodic set of quantity targets per activity or BOQ
  item, against which approved DWR measurements are compared.

### Additional Success Criteria

- **SC-A01**: For any project period, target, actual, achievement percentage, and variance are
  reported consistently, and the actual figure always reconciles exactly with the sum of approved
  DWR measurements for that period.
- **SC-A02**: A baselined schedule's baseline values never change, verified by a test asserting they
  are unchanged after arbitrary planned-date edits.
- **SC-A03**: No dependency cycle can be persisted, verified by a test attempting cycles within and
  across phases.
