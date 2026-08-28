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
  `PROJECT_FINANCIALS` (revenue/RA bills/P&L). These are added to 002's existing `Permission` enum
  alongside EMPLOYEES/ATTENDANCE/PAYROLL/CHALLANS/LOANS/DAILY_WORKER_REGISTRY.
- Q: Should the `Site` entity be owned by the `projects` schema or the `hr` schema? → A: `projects`
  schema owns the full `Site` entity (replacing 003's placeholder). HR's attendance module reads
  geofence data via `ProjectsService.getSiteById()` — an exported service call, never a direct
  cross-schema query. The migration that adds geofence columns (Latitude, Longitude, GeofenceRadius)
  belongs to this feature's migration set.
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
to it, importing a five-row Excel BOQ (with one deliberately malformed row), confirming the four
valid rows are imported and the error report identifies the bad row — independent of DWR or P&L.

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
   /projects/:id/boq/import` is called, **Then** valid rows are created and any rows with missing
   or non-parseable required columns are rejected with a downloadable error report (CSV) listing
   the row number, column name, and error reason.
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
Density), confirming the BOQ item's Done Qty increments on submission, and confirming an approval
action moves the DWR from Submitted to Approved — independent of revenue or P&L.

**Acceptance Scenarios**:

1. **Given** a project and BOQ item, **When** `POST /projects/dwr` is called with Project, Work
   Date, Supervisor, Task Group, Task, measurement fields, Worker Count, Machinery Count,
   Progress %, and Weather, **Then** the DWR is created with status `draft` and the DPR Number
   auto-generated as `{siteCode}-{sequence}`.
2. **Given** a draft DWR, **When** `PATCH /projects/dwr/:id` sets `status: 'submitted'`, **Then**
   the BOQ item's `doneQty` increments by the DWR's Actual Qty and the pending/remaining fields
   recompute.
3. **Given** a submitted DWR, **When** `PATCH /projects/dwr/:id/approve` is called by an admin,
   **Then** the DWR moves to `approved` status and the approval is recorded with actor and
   timestamp.
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
- **FR-004**: System MUST validate BOQ Excel imports against the required column schema; invalid
  rows MUST be rejected with a downloadable error report (CSV with row number, column, error
  reason) — partial application (valid rows committed, invalid rows reported) is the required
  behaviour.
- **FR-005**: System MUST compute DWR Actual Qty server-side from the submitted measurement
  formula fields (Nos × Nos × Length × Breadth × Depth × Density) — the client submits the raw
  components, the server computes the total.
- **FR-006**: System MUST update BOQ item `doneQty`, `pendingQty`, `avgQtyPerDay`, and
  `daysToComplete` in response to DWR submissions against that BOQ item.
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
- **FR-012**: `projects` schema owns `Site`; HR's attendance module MUST read site/geofence data
  via `ProjectsService.getSiteById()` — never a direct `hr` → `projects` cross-schema query
  (Constitution Principle I). The geofence columns (Latitude, Longitude, GeofenceRadius) are added
  to `Site` by this feature's migration, replacing 003's placeholder.
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
- **Site** (`projects` schema — replaces 003's minimal `Site`): Name, `projectId`, Address,
  Latitude, Longitude, GeofenceRadius (meters), Status (active/inactive), `companyId`.
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
  approved-or-submitted DWR task quantities for that item, within floating-point tolerance.
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
- HR's payroll module exposes a `getLabourCostByProject(projectId, period)` service method that
  aggregates `PayrollLineItem` amounts for employees whose `projectId` matches — same fallback.
- 003's minimal `Site` (siteId, name, companyId) is extended in-place by this feature; no data
  migration is needed for the existing Site rows (new geofence columns are nullable and default
  to permissive values until explicitly set).
- File attachments (DWR, BOQ error reports) use the same object-storage reference pattern
  established in 005 (EmployeeDocument) — no new storage infrastructure.
- BOQ import is synchronous for files up to 1,000 rows; larger files are out of scope for this
  version.
