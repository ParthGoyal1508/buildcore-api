# Feature Specification: Plant & Machinery Backend (Asset Register, Logbook, Fuel, Maintenance, Hire Bills)

**Feature Branch**: `006-plant-machinery-backend`

**Created**: 2026-08-28

**Status**: Draft

**Input**: User description: "Plant & Machinery Module (Asset Register, Equipment Categories,
Equipment Documents, Logbook, Fuel Management, Maintenance Jobs, Service Schedules, Hire Bills)
for the BuildCore API backend, per the master PRD §7.4. This is the `plant` schema — all
equipment/machinery lifecycle surfaces from asset registration through daily logbook entries, fuel
tracking with variance alerts, maintenance scheduling, and hire-bill verification against logbook
hours. This feature also implements two cross-module P&L service methods that feature 008
(Projects) waits on: `getMachineryCostByProject(projectId, dateRange)` and
`getFuelCostByProject(projectId, dateRange)`."

## Clarifications

### Session 2026-08-28

- Q: How is equipment utilisation % calculated? → A: `utilisation = (totalHoursThisMonth /
  targetHoursThisMonth) × 100`. Target hours is configurable per Equipment Category (default:
  22 working days × 8 hours = 176 hours/month). Stored on the equipment record as
  `utilizationPercent` and recalculated on every logbook entry for that month.
- Q: When is equipment status set to "Under Maintenance" — automatically on maintenance job
  open, or manually? → A: Automatically when a Maintenance Job is opened
  (`POST /plant/maintenance`): equipment `status → 'under_maintenance'`. Automatically reverts
  to `'active'` when the job is closed (`PATCH /plant/maintenance/:id/close`).
- Q: For P&L: does `getMachineryCostByProject` use hire bills or logbook hours? → A: Both —
  for Hired equipment: sum of verified `HireBill.netPayable` for that project in the date range.
  For Owned equipment: sum of computed depreciation (purchaseCost × depreciationRate / 12 per
  month) for each owned equipment deployed at the project's sites in the date range.
- Q: For P&L: does `getFuelCostByProject` use fuel entries linked to the project? → A: Yes —
  sum of `FuelEntry.amount` where `FuelEntry.equipmentId` links to an equipment deployed at one
  of the project's sites AND `FuelEntry.date` is within the date range.
- Q: Should fuel variance alerts be real-time (per entry) or computed in batch? → A: Per entry —
  `variancePercent = ((actualConsumption − benchmark) / benchmark) × 100` is computed on save;
  if `variancePercent > 15`, a `fuel_variance` event is emitted via `@nestjs/event-emitter` for
  the Notifications feature to surface.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Manage Equipment Categories (Priority: P1)

An admin creates equipment categories (Excavator, Tipper, Concrete Mixer, etc.) with meter type
and fuel benchmark; categories populate equipment forms and drive utilisation/variance calculations.

**Why this priority**: Required before any equipment can be created. No dependencies.

**Independent Test**: Create a category with meter type "Hours" and fuel benchmark 8 litres/hr;
create an equipment under it; confirm the benchmark is used for fuel variance calculation.

**Acceptance Scenarios**:

1. **Given** an admin session, **When** `POST /plant/categories` is called with Name, Meter Type
   (hours|km), and optional Fuel Benchmark, **Then** the category is created.
2. **Given** a category with linked equipment, **When** `DELETE /plant/categories/:id` is
   attempted, **Then** `409 Conflict`.
3. **Given** the category list, **When** `GET /plant/categories`, **Then** all categories are
   returned with `equipmentCount`.

---

### User Story 2 - Manage Asset Register (Priority: P1)

An admin registers equipment (owned or hired) with documents, deploys it to a project site, and
views document expiry alerts; equipment documents use configurable alert windows.

**Why this priority**: Core master data; all other plant features reference equipment. Depends on
categories (US1) and Sites from Projects module.

**Independent Test**: Register an owned excavator, upload an Insurance document with expiry 15
days out, confirm it appears in the list with an expiry warning flag — without logbook or fuel
data.

**Acceptance Scenarios**:

1. **Given** a category, **When** `POST /plant/equipment` is called with Code, Name, Category,
   Ownership (owned|hired), Power Source, Vendor (if hired), Meter Type, Deployed Site, and
   Depreciation Rate (if owned), **Then** equipment is created with `status: 'active'`.
2. **Given** equipment, **When** `POST /plant/equipment/:id/documents` is called with document
   type and file, **Then** the document is stored with encrypted file reference and optional expiry.
3. **Given** a document within 30 days of expiry or past expiry, **When** equipment is listed,
   **Then** the equipment row includes an `expiryAlert` flag (Expiring Soon/Expired) and
   `alertDocumentTypes` listing which documents are affected.
4. **Given** equipment, **When** `PATCH /plant/equipment/:id` updates `deployedSiteId`,
   **Then** the equipment is reassigned; the old site no longer shows it in its site filter.
5. **Given** hired equipment, **When** `GET /plant/equipment/:id`, **Then** the vendor ID is
   included (resolved to vendor name via `PartnersService.getVendorById()`).

---

### User Story 3 - Logbook Entries (Priority: P1)

A site operator records daily logbook entries (opening/closing reading, fuel consumed, operator,
project) for each equipment; equipment's `currentReading` updates; one entry per equipment per
day is enforced.

**Why this priority**: Logbook is the source of truth for equipment utilisation and hire bill
verification.

**Independent Test**: Create a logbook entry for an excavator (opening 100 hrs, closing 108 hrs),
confirm total hours = 8, `currentReading` updates to 108, utilisation % recalculates; attempt
a second entry for the same equipment on the same date (→ 409).

**Acceptance Scenarios**:

1. **Given** equipment with a current reading, **When** `POST /plant/logbook` is called with
   `equipmentId`, `date`, `openingReading`, `closingReading`, `fuelConsumed`, `operatorId`,
   `projectId`, and optional `remarks`, **Then** the entry is created; `totalHours = closing −
   opening`; `equipment.currentReading` updates; `equipment.utilizationPercent` recalculates for
   the current month.
2. **Given** `closingReading < openingReading`, **When** attempted, **Then** `400 Bad Request`.
3. **Given** an existing logbook entry for an equipment+date, **When** a second `POST` for
   the same equipment+date is attempted, **Then** `409 Conflict`.
4. **Given** logbook entries, **When** `GET /plant/logbook?equipmentId=&projectId=&dateFrom=
   &dateTo=&page=`, **Then** paginated, filtered results.

---

### User Story 4 - Fuel Management (Priority: P2)

A store keeper records fuel issued to equipment; the system computes consumption variance against
the equipment category's benchmark and emits an alert if variance > 15%.

**Why this priority**: Fuel pilferage detection; depends on equipment (US2) existing.

**Independent Test**: Record a fuel entry for an excavator with benchmark 8 L/hr, entry 12 L/hr
(50% variance); confirm `variancePercent = 50`, `varianceAlert = true`, and a `fuel_variance`
event is emitted.

**Acceptance Scenarios**:

1. **Given** equipment, **When** `POST /plant/fuel` is called with `equipmentId`, `date`,
   `quantity`, `rate`, `vendorId?`, **Then** `amount = quantity × rate`; `variancePercent`
   computed vs. category benchmark; `varianceAlert = variancePercent > 15`; if alert, emits
   `fuel_variance` event via `@nestjs/event-emitter`.
2. **Given** the fuel list, **When** `GET /plant/fuel?equipmentId=&dateFrom=&dateTo=&page=`,
   **Then** paginated results with `varianceAlert` flag.
3. **Given** a monthly summary, **When** `GET /plant/fuel/summary?month=&companyId=`, **Then**
   per-equipment totals: quantity, cost, avg rate, variance status.

---

### User Story 5 - Maintenance Jobs (Priority: P2)

An admin opens a maintenance job (breakdown or scheduled) for equipment; equipment status
auto-sets to "Under Maintenance"; closing the job updates the linked service schedule and
reverts equipment status.

**Why this priority**: Equipment health tracking; depends on equipment (US2).

**Independent Test**: Open a breakdown job for an excavator (status → Under Maintenance); add
parts and cost; close the job (status → Active); confirm linked service schedule's "last done"
reading updates.

**Acceptance Scenarios**:

1. **Given** active equipment, **When** `POST /plant/maintenance` is called with `equipmentId`,
   `type` (breakdown|scheduled), `description`, and optional `linkedServiceScheduleId`, **Then**
   a `MaintenanceJob` is created; `equipment.status → 'under_maintenance'`.
2. **Given** an open maintenance job, **When** `PATCH /plant/maintenance/:id` updates `parts`,
   `labourCost`, `totalCost`, **Then** the record updates.
3. **Given** an open job, **When** `PATCH /plant/maintenance/:id/close` is called with
   `closedAt` and `closingReading`, **Then** `equipment.status → 'active'`; if
   `linkedServiceScheduleId`, that service's `lastDoneReading` updates and next due is
   recomputed.
4. **Given** the maintenance list, **When** `GET /plant/maintenance?equipmentId=&status=&page=`,
   **Then** paginated, filtered by equipment and status (open|closed).

---

### User Story 6 - Service Schedules (Priority: P2)

An admin configures per-equipment service schedules (type, interval in hours/km, last done
reading); the system computes next-due reading and flags schedules that are due or overdue.

**Why this priority**: Prevents missed maintenance; depends on equipment (US2).

**Independent Test**: Create a service schedule for an excavator (oil change, interval 250 hrs,
last done at 500 hrs); confirm next due = 750; advance `currentReading` to 760 via logbook;
confirm status = Overdue.

**Acceptance Scenarios**:

1. **Given** equipment, **When** `POST /plant/services` is called with `equipmentId`,
   `serviceType`, `intervalHours` (or `intervalKm`), `lastDoneReading`, **Then** the schedule
   is created with `nextDueReading = lastDoneReading + interval`.
2. **Given** a service schedule, **When** `equipment.currentReading >= nextDueReading`, **Then**
   `GET /plant/services/:id` returns `status: 'overdue'`.
3. **Given** `nextDueReading − currentReading ≤ 50` hours, **Then** `status: 'due_soon'`.
4. **Given** the service list, **When** `GET /plant/services?equipmentId=&status=&page=`,
   **Then** returns schedules with computed status.

---

### User Story 7 - Hire Bills (Priority: P3)

An admin records and verifies vendor hire bills against logbook hours; TDS is deducted at the
vendor's rate; the bill moves through Pending Verification → Verified → Paid.

**Why this priority**: Closes the hired-equipment payment loop; depends on logbook (US3) and
vendors (Partners 007).

**Independent Test**: Record a hire bill for 40 billed hours at ₹500/hr (= ₹20,000); verify
logbook shows 38 hours actually worked (2-hour variance); apply 2% TDS (= ₹400 deduction); net
payable = ₹19,600; verify status transitions to Verified.

**Acceptance Scenarios**:

1. **Given** hired equipment with logbook entries, **When** `POST /plant/hire-bills` is called
   with `equipmentId`, `vendorId`, `billedHours`, `rate`, `billingPeriod`, **Then** `grossAmount
   = billedHours × rate`; `logbookHours` fetched from logbook for the period; `variance =
   billedHours − logbookHours`; TDS deducted from vendor's TDS rate (via
   `PartnersService.getVendorTds(vendorId)`); `netPayable = grossAmount − tdsAmount`.
2. **Given** a hire bill, **When** `PATCH /plant/hire-bills/:id/verify` is called, **Then**
   `status → 'verified'`; audit-logged with admin identity.
3. **Given** a verified hire bill, **When** `PATCH /plant/hire-bills/:id/pay` is called with
   `paymentDate` and `paymentReference`, **Then** `status → 'paid'`.
4. **Given** the hire bill list, **When** `GET /plant/hire-bills?equipmentId=&vendorId=&status=
   &page=`, **Then** paginated results with variance, TDS, and net payable.

---

### User Story 8 - P&L Service Methods (Priority: P3)

The Plant module implements two exported service methods that feature 008 (Projects P&L) calls:
`getMachineryCostByProject(projectId, dateRange)` and `getFuelCostByProject(projectId, dateRange)`.

**Why this priority**: Resolves 008's P&L stub for both Machinery and Fuel lines.

**Independent Test**: Seed a hired equipment with a verified hire bill of ₹50,000 and an owned
equipment with depreciation ₹10,000 for a project in a date range; call
`getMachineryCostByProject(projectId, range)`; verify = ₹60,000.

**Acceptance Scenarios**:

1. **Given** hired and owned equipment deployed at a project's sites, **When**
   `PlantService.getMachineryCostByProject(projectId, dateRange)` is called, **Then** returns
   sum of verified `HireBill.netPayable` for hired equipment + sum of monthly depreciation for
   owned equipment, for the date range.
2. **Given** fuel entries for equipment at a project's sites, **When**
   `PlantService.getFuelCostByProject(projectId, dateRange)` is called, **Then** returns sum
   of `FuelEntry.amount` for that project's site-deployed equipment in the date range.
3. **Given** `ProjectsService` is unavailable, **When** either method is called, **Then** returns
   0 gracefully (same fallback pattern as other P&L stubs).

---

### Edge Cases

- What if an equipment has no logbook entries for a month? → `utilizationPercent = 0` for that
  month; no alert generated.
- What if closing reading equals opening reading in a logbook entry? → Accepted (zero-hours day);
  `totalHours = 0`.
- What if a Maintenance Job is opened for equipment already "Under Maintenance"? → `409` —
  only one open maintenance job per equipment at a time.
- What if hire bill billed hours exceed logbook hours by a large margin? → No block — the system
  records the variance; verification is an admin decision, not an automated gate.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: All `plant` schema tables MUST carry `companyId` with RLS enforcing tenant
  isolation.
- **FR-002**: `equipment.status` MUST automatically transition to `under_maintenance` on
  `POST /plant/maintenance` and back to `active` on job close — never manually settable to
  `under_maintenance` via `PATCH /plant/equipment`.
- **FR-003**: One logbook entry per equipment per date MUST be enforced at the database level
  (UNIQUE constraint on `(equipmentId, date)`).
- **FR-004**: Fuel variance MUST be computed server-side per entry (`variancePercent > 15` →
  emit `fuel_variance` event via `@nestjs/event-emitter`) — never stored as a stale column.
- **FR-005**: `HireBill.tdsAmount` and `HireBill.netPayable` MUST be computed server-side from
  vendor's TDS rate (via `PartnersService.getVendorTds()`) — never client-supplied.
- **FR-006**: Service schedule `status` (ok|due_soon|overdue) MUST be computed on every read
  by comparing `equipment.currentReading` against `nextDueReading` — not stored.
- **FR-007**: `equipment.utilizationPercent` MUST be recomputed on every logbook entry for
  the current month: `totalHoursThisMonth / categoryTargetHours × 100`.
- **FR-008**: `PlantService.getMachineryCostByProject()` and `PlantService.getFuelCostByProject()`
  MUST be exported from `PlantModule` for injection by `ProjectsModule` (resolves 008's P&L stubs).
- **FR-009**: Equipment and vendor cross-module reads MUST go via `ProjectsService.getSitesByProject()`
  and `PartnersService.getVendorById()`/`getVendorTds()` — no direct cross-schema queries.
- **FR-010**: All equipment document uploads MUST use encrypted object-storage references (same
  pattern as 005/007/008/009); documents with expiry within 30 days flag `expiryAlert`.
- **FR-011**: Every endpoint MUST be gated by `JwtAuthGuard` + `@RequirePermission()` using
  enum values: `PLANT_ASSETS` (equipment + categories + documents + services),
  `PLANT_OPERATIONS` (logbook + fuel + maintenance), `PLANT_BILLING` (hire bills).
- **FR-012**: All write operations MUST be written to the audit log with entity types:
  `EQUIPMENT`, `EQUIPMENT_DOCUMENT`, `LOGBOOK_ENTRY`, `FUEL_ENTRY`, `MAINTENANCE_JOB`,
  `SERVICE_SCHEDULE`, `HIRE_BILL`.

### Key Entities

- **EquipmentCategory** (`plant` schema): `id`, `companyId`, `name`, `meterType` (hours|km),
  `fuelBenchmark` (decimal?, litres/hr or litres/km), `targetHoursPerMonth` (integer, default 176).
- **Equipment** (`plant` schema): `id`, `companyId`, `code`, `name`, `categoryId` FK,
  `ownership` (owned|hired), `vendorId?` (UUID, cross-schema ref), `powerSource` (diesel|electric|
  manual|petrol), `purchaseDate?`, `purchaseCost?`, `depreciationRate?` (% per annum),
  `meterType` (from category), `currentReading` (decimal, default 0), `deployedSiteId?` (UUID),
  `status` (active|under_maintenance|inactive), `utilizationPercent` (decimal, default 0).
- **EquipmentDocument** (`plant` schema): `id`, `equipmentId` FK, `documentType` (rc|insurance|
  puc|fitness|permit|road_tax|calibration), `fileRef` (encrypted), `expiresAt?`, `uploadedByUserId`,
  `uploadedAt`. Alert window: 30 days before expiry.
- **LogbookEntry** (`plant` schema): `id`, `companyId`, `equipmentId` FK, `date` (unique per
  equipment), `openingReading`, `closingReading`, `totalHours` (computed: closing − opening),
  `fuelConsumed?`, `operatorId?` (UUID), `projectId?` (UUID), `remarks?`. UNIQUE: `(equipmentId, date)`.
- **FuelEntry** (`plant` schema): `id`, `companyId`, `equipmentId` FK, `date`, `quantity`,
  `rate`, `amount` (stored: qty × rate), `vendorId?` (UUID), `variancePercent` (computed on save),
  `varianceAlert` (boolean).
- **ServiceSchedule** (`plant` schema): `id`, `companyId`, `equipmentId` FK, `serviceType`,
  `intervalHours?`, `intervalKm?`, `lastDoneReading`, `nextDueReading` (computed: last + interval).
  Derived: `status` (ok|due_soon|overdue) computed on read from `equipment.currentReading`.
- **MaintenanceJob** (`plant` schema): `id`, `companyId`, `equipmentId` FK, `type` (breakdown|
  scheduled), `description`, `openedAt`, `closedAt?`, `closingReading?`, `partsDescription?`,
  `labourCost?`, `totalCost?`, `linkedServiceScheduleId?` FK→ServiceSchedule, `status`
  (open|closed).
- **HireBill** (`plant` schema): `id`, `companyId`, `equipmentId` FK, `vendorId` (UUID),
  `billedHours`, `rate`, `grossAmount`, `logbookHours` (fetched at creation), `variance`
  (billedHours − logbookHours), `tdsRate?`, `tdsAmount`, `netPayable`,
  `billingPeriodFrom`, `billingPeriodTo`, `status` (pending_verification|verified|paid),
  `verifiedByUserId?`, `verifiedAt?`, `paymentDate?`, `paymentReference?`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Equipment document expiry is detected and flagged within the same API response
  as the equipment list — no separate expiry-check call needed.
- **SC-002**: Fuel variance alerts are generated on every fuel entry where `variancePercent > 15%`
  — zero missed alerts in testing.
- **SC-003**: Hire bill `netPayable` always equals `grossAmount − tdsAmount` in all test cases.
- **SC-004**: `getMachineryCostByProject()` and `getFuelCostByProject()` return correct sums
  within 1 second for a project with up to 50 equipment items.
- **SC-005**: Service schedule status (ok/due_soon/overdue) always reflects current
  `equipment.currentReading` at the time of the request — no stale cached status.

## Assumptions

- `ProjectsService.getSitesByProject(projectId)` stub exists (added by feature 009); Plant reads
  site-to-project mapping via this method for P&L cost aggregation.
- `PartnersService.getVendorTds(vendorId)` returns `{ tdsSection, tdsRate }` — this method is
  already documented in 007's contracts as `GET /partners/vendors/:id/tds`; Plant calls it via
  the exported service, not the HTTP endpoint.
- Equipment category's `targetHoursPerMonth` defaults to 176 (22 days × 8 hours) if not
  explicitly set.
- Fuel benchmark variance is compared per logbook entry's fuel-per-hour (fuelConsumed /
  totalHours); if `totalHours = 0`, variance is not computed (no division by zero).
- Three new `Permission` enum values (`PLANT_ASSETS`, `PLANT_OPERATIONS`, `PLANT_BILLING`) are
  added to Settings' existing enum, same pattern as 007/008/009.
