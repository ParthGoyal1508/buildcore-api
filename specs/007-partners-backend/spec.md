# Feature Specification: Partners Backend (Vendors, Contractor Vault, Compliance, RAG Matrix, BOCW Cess)

**Feature Branch**: `007-partners-backend`

**Created**: 2026-08-28

**Status**: Draft

**Input**: User description: "Partners Module (Vendors, Vendor Categories, Contractor Vault,
Monthly Compliance, RAG Matrix, BOCW Cess) for the BuildCore API backend, per the PRD at
/Users/p0g02o7/Personal/ERP-Demo/docs/prd/06-partners.prd.md. This is the `partners` schema —
all vendor/contractor management surfaces, from TDS-tracked vendor records and multi-contact forms
to monthly PF/ESIC compliance tracking with a RAG matrix and BOCW cess calculation per project.
This feature also implements `PartnersService.getSubcontractorCostByProject()` — the cross-module
method feature 008 (Projects P&L) stubs and waits on. BOCW cess liability is derived from
Projects module's contract values via `ProjectsService`. Vendor/contractor documents use the same
object-storage pattern as features 005 and 008."

## Clarifications

### Session 2026-08-28

- Q: Is `Contractor` a separate entity or a specialized view of a `Vendor` with
  `type = subcontractor`? → A: A `Contractor` is a 1:1 extension of a `Vendor` record — every
  contractor is first a Vendor (with `type = 'subcontractor'` or `type = 'labour_contractor'`);
  the `ContractorProfile` table adds compliance-specific fields (licence number, PF/ESIC
  registration numbers, BOCW registration) linked to the `Vendor` by `vendorId`. This avoids
  duplicating contact/address/GST data across two separate master tables.
- Q: How are statutory compliance rates (PF %, ESIC %, BOCW cess %) configured — per company
  in Settings, or hardcoded? → A: Per company in Settings, consistent with how PF/ESIC employer
  rates are already configured there (features 002/005). BOCW cess rate defaults to 1% (statutory)
  but is company-configurable. The `partners` module reads these rates via `SettingsService`
  exported methods — never hardcoded.
- Q: How is Contractor compliance status derived — computed on-demand from `MonthlyCompliance`
  rows, or stored and updated on each record change? → A: Stored on the `ContractorProfile`
  table and recomputed/written whenever a `MonthlyCompliance` record is created, updated, or
  verified. The recomputation looks at the last 3 months: all verified → Compliant; any missing
  → Non-compliant; at least one partial → Partially compliant. This avoids repeated aggregation
  on every Contractor list read.
- Q: Does `getSubcontractorCostByProject(projectId, dateRange)` sum `WorkOrder` amounts from the
  `projects` schema, or does it sum `MonthlyCompliance` payment amounts, or contractor billing
  records? → A: It sums Work Order amounts from the `projects` schema via
  `ProjectsService.getWorkOrderTotalByProject(projectId, dateRange)` — an exported method that
  returns the sum of `WorkOrder.labourAmount + WorkOrder.materialAmount` for the given project
  and date range. This resolves the H-002 ambiguity from the 008 analyze report: Partners reads
  from Projects (not the other way around for this call).
- Q: For the RAG matrix, what exact financial year boundary defines the columns (Apr → Mar)?
  → A: Apr 1 → Mar 31 of the selected financial year (Indian FY convention). The FY selector
  is year-based (e.g., "FY 2025-26" = Apr 2025 → Mar 2026). Columns are always 12 months.
  Future months beyond today show Gray dots.
- Q: Who owns adding `ProjectsService.getWorkOrderTotalByProject()` to the Projects module?
  → A: Stub pattern — same as 008's four P&L stubs. Partners defines the interface contract
  and uses a stub returning 0; feature 008 (Projects) ships the real method in a separate
  task (TODO added to 008's plan.md). Partners can ship independently without blocking on 008.
- Q: When a contractor has fewer than 3 months of history, how is `complianceStatus` computed?
  → A: Missing months always count as "missing" — a new contractor with no compliance records
  has all 3 look-back months as missing, so `complianceStatus = 'non_compliant'` from day one.
  No grace period, no `not_started` status. Consistent with the PRD's 100%-tracked-monthly goal.
- Q: If a Vendor with a linked ContractorProfile is set to `active: false`, does that contractor
  appear in the RAG Matrix and new compliance recording? → A: No — inactive vendors are excluded
  from the RAG Matrix rows and from the Contractor dropdown in new compliance entries. Their
  historical `MonthlyCompliance` records remain readable via `GET /partners/compliance?
  contractorId=` (which accepts any contractorId, active or not). FR-007 updated to reflect this.
- Q: Who owns the migration adding `bocwCessRate` to `settings.Company`? → A: Feature 007 owns
  the migration — same pattern as 005 adding `otMultiplier`. This feature adds `bocwCessRate`
  (decimal, default 0.01) to `settings.Company` via an additive migration in 007's migration
  set; `SettingsService` exports a method to read it; `PartnersModule` reads via that method.
- Q: Should the month-end compliance notification cron check last month only or the full FY?
  → A: Last month only — the cron runs on the 1st–5th of each month and checks only the most
  recently concluded calendar month for active contractors with no `MonthlyCompliance` record.
  The RAG Matrix already gives admins full-year gap visibility without generating notification
  spam for legitimately-absent early-FY months.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Manage Vendor Categories (Priority: P1)

An admin creates, edits, and deletes vendor category tags; categories populate the "Deals In"
multi-select in Vendor forms and filter dropdowns across the module.

**Why this priority**: No dependency; required before any vendor can be created with category
tags. Ships with 6 seeded default categories (Material, Fuel, Hire, Service, Transport,
Subcontractor).

**Independent Test**: Create a category, verify it appears in the list and in the Vendor form's
"Deals In" dropdown, edit it, delete it (if no linked vendors) — independent of any vendor or
contractor data.

**Acceptance Scenarios**:

1. **Given** a valid admin session, **When** `POST /partners/vendor-categories` is called with
   Name and optional Description, **Then** the category is created and returned with its `id`.
2. **Given** an existing category, **When** `PATCH /partners/vendor-categories/:id` is called,
   **Then** the record updates.
3. **Given** a category with no linked vendors, **When** `DELETE /partners/vendor-categories/:id`
   is called, **Then** the category is deleted.
4. **Given** a category linked to one or more vendors, **When** `DELETE` is attempted, **Then**
   `409 Conflict` is returned — linked categories cannot be deleted.
5. **Given** the category list, **When** `GET /partners/vendor-categories` is called, **Then**
   it returns all categories with `vendorCount` per category.

---

### User Story 2 - Manage Vendors (Priority: P1)

An admin creates and edits vendor records across four tabs (Details, Address, Contacts, Work
Detail for subcontractors), with TDS section/rate, multi-category "Deals In" tags, and multiple
contacts per vendor.

**Why this priority**: Vendors feed dropdown selectors in Inventory, Machinery, and Projects
modules; foundational master data.

**Independent Test**: Create a vendor with 2 contacts and 3 category tags, edit its TDS rate,
add a third contact, verify the updated vendor is returned with all contacts and tags — without
any inventory or machinery data needed.

**Acceptance Scenarios**:

1. **Given** a valid admin session, **When** `POST /partners/vendors` is called with Name, Type,
   Deals In (category IDs), GSTIN, PAN, TDS Section, TDS Rate, Address, and at least one
   Contact, **Then** the vendor is created with an auto-generated code and all contacts/tags
   stored.
2. **Given** a vendor, **When** `GET /partners/vendors/:id` is called, **Then** the response
   includes all four tabs' data: details (GSTIN, PAN, TDS), address, contacts (array), and
   work detail (for subcontractor types).
3. **Given** the vendor list, **When** `GET /partners/vendors?search=&type=&active=&page=` is
   called, **Then** results are paginated and filterable by name/city search, type, and
   active/inactive status.
4. **Given** a vendor, **When** `PATCH /partners/vendors/:id` updates any field, **Then** only
   the provided fields change; existing contacts and category tags are not dropped unless
   explicitly replaced.
5. **Given** a vendor of type `subcontractor` or `labour_contractor`, **When** the Work Detail
   payload is included in `POST`/`PATCH`, **Then** hire details (type, contract code, period,
   machine category, charges) are stored as part of the vendor record.
6. **Given** a vendor with active=false, **When** `GET /partners/vendors?active=true` is called,
   **Then** the inactive vendor is excluded from results.
7. **Given** a vendor, **When** `GET /partners/vendors/:id/tds` is called, **Then** it returns
   `{ tdsSection, tdsRate }` — the minimal payload other modules (Inventory, Machinery) need to
   compute TDS deductions.

---

### User Story 3 - Manage Contractor Vault (Priority: P2)

An admin creates and maintains contractor profiles (licence numbers, PF/ESIC/BOCW registrations)
linked to their vendor records, uploads compliance documents with expiry dates, and views the
derived compliance status (Compliant/Non-compliant/Partially compliant).

**Why this priority**: Contractor compliance tracking (US4) depends on contractor profiles
existing. Documents with expiry dates feed the Notifications system.

**Independent Test**: Create a contractor profile linked to a subcontractor-type vendor, upload
a Labour License with an expiry 30 days out, confirm the profile appears in the Contractor list
with the correct compliance status (Non-compliant for a new contractor with no Monthly Compliance
records) — independent of compliance recording.

**Acceptance Scenarios**:

1. **Given** a vendor of type `subcontractor` or `labour_contractor`, **When** `POST
   /partners/contractors` is called with `vendorId`, `licenceNumber`, `pfRegistration`,
   `esicRegistration`, `bocwRegistration?`, and `insurancePolicyNumber?`, **Then** a
   `ContractorProfile` is created with `complianceStatus: 'non_compliant'` (default for new
   profiles with no Monthly Compliance history).
2. **Given** a contractor profile, **When** `POST /partners/contractors/:id/documents` is called
   with a document type (Labour License / PF Registration / ESIC Registration / Insurance /
   BOCW Registration) and file, **Then** the document is stored with an encrypted file reference
   and optional `expiresAt`.
3. **Given** a document within 30 days of expiry or past expiry, **When** the contractor detail
   is fetched, **Then** the document entry includes an `expiryWarning: true` flag.
4. **Given** the contractor list, **When** `GET /partners/contractors?complianceStatus=&page=`
   is called, **Then** it returns contractors with their derived `complianceStatus` and key
   registration fields.
5. **Given** a contractor profile, **When** monthly compliance records are added/updated for the
   last 3 months (via US4), **Then** `ContractorProfile.complianceStatus` is recomputed and
   stored: all-verified → `compliant`; any missing → `non_compliant`; mixed partial →
   `partially_compliant`.

---

### User Story 4 - Monthly Compliance Recording (Priority: P2)

An admin records PF and ESIC challan details for a contractor and month; the system auto-derives
the submission status (Submitted/Partial/Missing); an admin can verify a submitted record.

**Why this priority**: Core compliance capture workflow; feeds RAG Matrix (US5) and contractor
compliance status (US3).

**Independent Test**: Record a compliance entry with only PF details (→ Partial), add ESIC
details (→ Submitted), verify it (→ Verified); confirm the contractor's `complianceStatus`
updates; confirm the RAG Matrix dot for that contractor/month changes — independent of BOCW or
vendor data.

**Acceptance Scenarios**:

1. **Given** a contractor, **When** `POST /partners/compliance` is called with `contractorId`,
   `month` (YYYY-MM), PF Challan Number, PF Amount, PF Date, **Then** a compliance record is
   created with `status: 'partial'` (ESIC not yet provided).
2. **Given** a Partial compliance record, **When** `PATCH /partners/compliance/:id` adds ESIC
   Challan Number, ESIC Amount, and ESIC Date, **Then** `status` auto-updates to `'submitted'`.
3. **Given** a compliance record with no PF or ESIC data, **Then** `status: 'missing'`.
4. **Given** a Submitted compliance record, **When** `PATCH /partners/compliance/:id/verify` is
   called, **Then** `status` moves to `'verified'`, and `verifiedByUserId` + `verifiedAt` are
   set.
5. **Given** a compliance record, **When** status changes, **Then** `ContractorProfile.
   complianceStatus` for that contractor is recomputed based on the last 3 months' records.
6. **Given** the compliance list, **When** `GET /partners/compliance?contractorId=&month=&
   status=&page=` is called, **Then** results are paginated and filterable.
7. **Given** month-end (end of current or previous month) passes with no compliance record for
   an active contractor, **Then** a notification is queued (via the event bus) for the
   Dashboard/Notifications feature — spec FR-010.

---

### User Story 5 - RAG Matrix (Priority: P2)

The compliance RAG matrix is a read-only aggregated view showing all contractors × 12 months
for a selected financial year, with colour-coded status dots.

**Why this priority**: Depends on Monthly Compliance data (US4) existing. This is the primary
tool for compliance oversight — built after data capture is working.

**Independent Test**: Seed 2 contractors with compliance records across 6 months; call `GET
/partners/rag?fy=2025-26`; verify the response matrix has correct status dots for each
contractor/month pair, Gray for future months, and correct row/column structure.

**Acceptance Scenarios**:

1. **Given** contractors and compliance records for a financial year, **When** `GET
   /partners/rag?fy=2025-26` is called, **Then** the response is a matrix: rows = active
   contractors, columns = 12 months (Apr → Mar), each cell = `{ status: 'verified' | 'submitted'
   | 'partial' | 'missing' | 'gray' }`.
2. **Given** a month that hasn't yet occurred (future month in the selected FY), **When** the
   matrix is built, **Then** that cell shows `status: 'gray'` regardless of compliance record
   presence.
3. **Given** a verified compliance record for contractor C and month M, **When** the matrix
   is fetched, **Then** cell `[C][M]` = `verified` (green).
4. **Given** a cell in the matrix, **When** a client-side click on it (frontend), **Then** the
   backend response includes `complianceId` per cell (nullable for gray/missing) to enable
   navigation to the compliance detail.

---

### User Story 6 - BOCW Cess (Priority: P3)

An admin views BOCW cess liability per project (derived from project contract values via the
Projects module), records payments against a project's cess balance, and tracks payment status.

**Why this priority**: Depends on Projects (008) being available to provide contract values.
Financial compliance feature; lower urgency than core vendor/contractor operations.

**Independent Test**: Seed a project with Contract Value ₹50,00,000; call `GET /partners/bocw`;
verify the Cess Liability = ₹50,000 (1% of contract value); record a payment of ₹30,000; verify
Balance = ₹20,000 and Status = Partial.

**Acceptance Scenarios**:

1. **Given** a project with a Contract Value, **When** `GET /partners/bocw` is called, **Then**
   each project appears with `cessLiability = contractValue × cessRate` (read from Settings),
   `totalPaid`, `balance = cessLiability − totalPaid`, and `status` (pending/partial/paid).
2. **Given** a project's BOCW entry, **When** `POST /partners/bocw/:projectId/payments` is
   called with `amountPaid`, `paymentDate`, `referenceNumber`, and `remarks?`, **Then** the
   payment is recorded and the project's `balance` and `status` recompute.
3. **Given** `balance = 0` after a payment, **Then** `status` becomes `paid`.
4. **Given** `balance > 0` with at least one payment, **Then** `status = partial`.
5. **Given** no payments recorded, **Then** `status = pending`.
6. **Given** the BOCW cess rate configured in Settings, **When** it changes, **Then** all
   projects' `cessLiability` recomputes on next `GET /partners/bocw` call (not stored — derived
   on demand).

---

### User Story 7 - Subcontractor Cost for Projects P&L (Priority: P3)

The Partners module implements `getSubcontractorCostByProject(projectId, dateRange)` — the
exported service method that feature 008's P&L engine calls via its `PartnersService` interface.

**Why this priority**: Unblocks the Projects P&L's Subcontractors cost line from returning a
stub-zero. Depends on Work Order data existing in the `projects` schema.

**Independent Test**: Seed a project with two Work Orders (labourAmount=₹50k, materialAmount=₹30k
and labourAmount=₹20k, materialAmount=₹10k within the date range); call
`getSubcontractorCostByProject(projectId, range)`; verify return = ₹1,10,000.

**Acceptance Scenarios**:

1. **Given** a project with Work Orders within the date range, **When**
   `PartnersService.getSubcontractorCostByProject(projectId, dateRange)` is called (in-process),
   **Then** it calls `ProjectsService.getWorkOrderTotalByProject(projectId, dateRange)` and
   returns the summed amount.
2. **Given** a project with no Work Orders, **When** the method is called, **Then** it returns 0.
3. **Given** the Projects module is unavailable (exception thrown by ProjectsService), **When**
   the method is called, **Then** it returns 0 and logs the failure — consistent with the
   `unavailableModules` contract in 008's P&L response.

---

### Edge Cases

- What happens when a vendor has both `type: subcontractor` and no `ContractorProfile`? →
  Allowed — the profile is created separately via `POST /partners/contractors`; a vendor of
  subcontractor type without a profile does not appear in the Contractor Vault list.
- What if a contractor has no Monthly Compliance records for any of the last 3 months? → All
  three are effectively "missing"; `complianceStatus = 'non_compliant'`.
- What if a compliance record is verified for a future month (admin error)? → Backend allows it
  (no validation on future months for Verify action); the RAG Matrix shows it as `gray` (future)
  regardless of verified status — gray takes precedence for future months.
- What if the Projects module is unavailable when `GET /partners/bocw` is called? → BOCW endpoint
  returns the list with `contractValue: null` and `cessLiability: null` per affected project,
  with a top-level `unavailableModules: ['projects']` flag — same fallback pattern as 008.
- What happens when `DELETE /partners/vendor-categories/:id` is called for a seeded default
  category? → No special protection — seeded categories are admin-editable/deletable.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: All `partners` schema tables MUST carry `companyId` with RLS enforcing tenant
  isolation — Constitution Principle IV.
- **FR-002**: Vendor TDS section and rate MUST be returned by `GET /partners/vendors/:id/tds`
  for consumption by Inventory and Machinery modules without those modules querying `partners`
  schema directly (Principle I).
- **FR-003**: A Vendor contact list MUST support multiple contacts per vendor stored in a
  dedicated `VendorContact` table; contacts are always replaced atomically on update (no
  partial contact patch).
- **FR-004**: Vendor "Deals In" categories MUST be stored via a `VendorDealsIn` join table
  linking `Vendor` ↔ `VendorCategory`; the join is fully replaced on vendor update.
- **FR-005**: `ContractorProfile.complianceStatus` MUST be recomputed and persisted whenever a
  `MonthlyCompliance` record is created, updated, or verified — never lazy-read at list time.
- **FR-006**: Monthly compliance `status` MUST be auto-derived from PF/ESIC data presence:
  both present → `submitted`; one present → `partial`; neither → `missing`. `verified` is a
  manually triggered state transition (separate PATCH endpoint), not auto-derived.
- **FR-007**: The RAG Matrix endpoint MUST compute status cells on-demand from `MonthlyCompliance`
  rows; future months (beyond today's date) MUST always return `gray`, overriding any record.
  Only contractors linked to **active** vendors (`Vendor.active = true`) are included as rows;
  inactive vendors' contractors are excluded from the matrix but their compliance history
  remains accessible via the compliance list endpoint.
- **FR-008**: BOCW cess liability MUST be computed on-demand as `contractValue × cessRate` where
  `cessRate` is read from Settings per company — never stored as a static column.
- **FR-009**: `PartnersService.getSubcontractorCostByProject(projectId, dateRange)` MUST be
  exported from `PartnersModule` so `ProjectsModule` can inject it without circular dependency —
  resolving 008's P&L stub.
- **FR-010**: When a month-end passes with no `MonthlyCompliance` record for an active contractor,
  the backend MUST emit an event via `@nestjs/event-emitter` for the Notifications feature to
  consume — not a direct notification write (Principle I event-bus pattern).
- **FR-011**: Contractor document uploads MUST use encrypted object-storage references (same
  pattern as 005/008); documents with `expiresAt` within 30 days or past MUST include
  `expiryWarning: true` in responses.
- **FR-012**: Statutory rates (BOCW cess %, PF %, ESIC %) MUST be read via `SettingsService`
  exported methods — never hardcoded — Constitution Principle III.
- **FR-013**: All write operations on Vendor, ContractorProfile, MonthlyCompliance (create/
  verify), and BOCW payments MUST be written to the audit log.
- **FR-014**: `DELETE /partners/vendor-categories/:id` MUST return `409` if any vendors
  reference that category via `VendorDealsIn`.
- **FR-015**: Every endpoint MUST be gated by `JwtAuthGuard` + `@RequirePermission()` using
  enum values added to Settings' existing `Permission` enum: `VENDORS` (vendor CRUD + categories),
  `CONTRACTORS` (contractor vault + compliance + RAG), `BOCW` (BOCW cess).

### Key Entities

- **VendorCategory** (`partners` schema): `id`, `companyId`, `name`, `description?`, `isDefault`
  (boolean — seeded defaults), `createdAt`.
- **Vendor** (`partners` schema): `id`, `companyId`, `code` (auto-generated), `name`,
  `type` (material | fuel | hire | service | subcontractor | labour_contractor), `gstin?`,
  `pan?`, `tdsSection?`, `tdsRate?` (decimal), `active` (boolean, default true), `address?`,
  `city?`, `state?`, `pinCode?`, `vendorCurrency` (default INR), `exchangeRate` (default 1.0),
  `createdAt`, `updatedAt`.
- **VendorContact** (`partners` schema): `id`, `vendorId` FK→Vendor, `name`, `phone?`, `email?`.
- **VendorDealsIn** (`partners` schema — join): `vendorId` FK, `categoryId` FK.
- **VendorHireDetail** (`partners` schema — for subcontractor/hire types): `id`, `vendorId` FK,
  `hireType` (taken | given), `contractCode?`, `periodFrom?`, `periodTo?`, `machineCategory?`,
  `machineName?`, `requiredAvg?`, `chargesBase` (monthly | daily), `rate?`,
  `minWorkingDays?`, `allowBdDays` (boolean), `allowIdleDays` (boolean), `operatorCharges?`,
  `helperCharges?`, `maintenanceCharges?`, `fuelCharges?`, `termsAndConditions?`,
  `requirements?`.
- **ContractorProfile** (`partners` schema): `id`, `companyId`, `vendorId` FK→Vendor (1:1),
  `licenceNumber?`, `pfRegistration?`, `esicRegistration?`, `bocwRegistration?`,
  `insurancePolicyNumber?`, `complianceStatus` (compliant | non_compliant | partially_compliant,
  default non_compliant), `createdAt`, `updatedAt`.
- **ContractorDocument** (`partners` schema): `id`, `contractorProfileId` FK, `documentType`
  (labour_license | pf_registration | esic_registration | insurance | bocw_registration),
  `fileRef` (encrypted), `expiresAt?`, `uploadedByUserId`, `uploadedAt`.
- **MonthlyCompliance** (`partners` schema): `id`, `companyId`, `contractorProfileId` FK,
  `month` (YYYY-MM string, unique per contractor), `pfChallanNumber?`, `pfAmount?`,
  `pfDate?`, `esicChallanNumber?`, `esicAmount?`, `esicDate?`,
  `status` (missing | partial | submitted | verified), `verifiedByUserId?`, `verifiedAt?`,
  `createdAt`, `updatedAt`. UNIQUE: `(contractorProfileId, month)`.
- **BOCWPayment** (`partners` schema): `id`, `companyId`, `projectId` (UUID, plain cross-schema
  ref), `amountPaid`, `paymentDate`, `referenceNumber`, `remarks?`, `recordedByUserId`,
  `createdAt`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of active contractors tracked monthly — `GET /partners/rag` returns a cell
  for every active contractor × every past month in the selected FY.
- **SC-002**: Missing compliance flagged within 5 days of month-end — the event-bus notification
  (FR-010) is emitted no later than the 5th of the following month for any missing record.
- **SC-003**: RAG Matrix covers all active contractors × 12 months — the matrix endpoint returns
  exactly `contractorCount × 12` cells for any selected FY.
- **SC-004**: Vendor TDS accuracy — `GET /partners/vendors/:id/tds` returns `tdsSection` and
  `tdsRate` for 100% of vendors where these fields are populated.
- **SC-005**: BOCW cess balance is always current — `balance` shown in `GET /partners/bocw`
  reflects all payments recorded up to the moment of the request.
- **SC-006**: `getSubcontractorCostByProject()` responds within 500ms for a project with up to
  100 Work Orders (the sum query is a single aggregation on the `projects.WorkOrder` table).

## Assumptions

- Settings (002) already has the `Permission` enum infrastructure; this feature adds `VENDORS`,
  `CONTRACTORS`, and `BOCW` to it.
- Settings (002) does not yet have BOCW cess rate as a company field; this feature adds
  `bocwCessRate` (decimal, default 0.01) to `settings.Company` via an additive migration, owned
  by the `settings` module (consistent with how 005 added `otMultiplier`).
- `ProjectsService.getWorkOrderTotalByProject(projectId, dateRange)` will be added to
  `ProjectsModule`'s exported interface by feature 008 — Partners reads via that method, not
  by querying `projects.WorkOrder` directly.
- The month-end compliance check (FR-010) runs via a scheduled NestJS `@Cron` job on the
  1st–5th of each month, checking only the most recently concluded calendar month for active
  contractors with no `MonthlyCompliance` record; the cron emits events, the Dashboard
  Notifications feature consumes them.
- Vendor auto-generated codes use Settings' CodeSeriesService with a `VENDORS` series (same
  pattern as Projects/Employees).
- The document expiry warning window default (30 days) is configurable via `@nestjs/config`,
  consistent with the 005 pattern for the same concept.
