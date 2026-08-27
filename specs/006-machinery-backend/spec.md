# Feature Specification: Machinery Module Backend

**Feature Branch**: `006-machinery-backend`

**Created**: 2026-08-27

**Status**: Draft

**Input**: User description: "Machinery Module (Asset Register, Logbook, Fuel, Maintenance, Hire Bills, Equipment Categories, Equipment Doc Types, Hire Rates) backend for the BuildCore ERP API (buildcore-api), per the PRD at /Users/parthgoyal/Projects/ERP-Demo/docs/prd/04-machinery.prd.md."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Asset Register (Priority: P1)

An admin registers and maintains the company's fleet of owned and hired equipment — machines, tools, plant, and vehicles — as a single source of truth, including each machine's current reading and its compliance documents (RC, Insurance, PUC, Fitness, etc.), so that every other machinery workflow (logbook, fuel, maintenance, hire bills) has a machine record to attach to.

**Why this priority**: Every other feature in this module references an Equipment record. Nothing else can be built or tested without it.

**Independent Test**: Can be fully tested by creating an equipment record with a category, ownership type, and site, uploading a document with an expiry date, and confirming the record appears in the list with the correct auto-derived document status (Valid/Expiring Soon/Expired) and alert flag count.

**Acceptance Scenarios**:

1. **Given** an admin is creating a new machine, **When** they submit the required fields (name, category, ownership, class, power source) with a valid category from the Equipment Categories master, **Then** the system assigns an auto-generated Code (editable) and creates the record with Status defaulting to Active.
2. **Given** an existing machine, **When** an admin uploads a document of a type sourced from the Equipment Doc Types master with an expiry date, **Then** the system stores the document and derives its status as Valid (>30 days to expiry), Expiring Soon (within the doc type's configured remind-days window), or Expired (past expiry) — recomputed daily.
3. **Given** a machine has one expired document and one overdue maintenance service, **When** the equipment list is viewed, **Then** that machine's Flags count reflects both conditions.
4. **Given** an admin filters the equipment list by Category, Ownership, Status, or Site, **Then** only matching machines are returned.
5. **Given** a machine's document crosses into its "expiring soon" window or becomes expired, **When** the daily expiry-scan job runs, **Then** a corresponding alert/notification entry is generated for the Dashboard and Notifications Center (per the existing widget/notification-provider registry from the Dashboard module).

---

### User Story 2 - Logbook (Priority: P1)

A site supervisor or admin records a daily logbook entry per machine — operator, opening/closing reading, fuel consumed, remarks — so that the machine's current reading stays accurate and hours/km data is available to drive utilization and hire-bill verification.

**Why this priority**: Logbook data is the operational backbone the Fuel, Maintenance (utilization/remaining-interval), and Hire Bills (variance check) features all depend on. It must exist before those features can be verified end-to-end.

**Independent Test**: Can be fully tested by creating a logbook entry for a machine and confirming (a) the machine's Current Reading in the Asset Register updates to the entry's Closing Reading, and (b) the next new entry for that machine pre-populates Opening Reading from the prior Closing Reading.

**Acceptance Scenarios**:

1. **Given** a machine with an existing Current Reading, **When** an admin opens the Add Entry form for that machine, **Then** Opening Reading is pre-populated from the machine's last recorded Closing Reading (or its Asset Register reading if no entries exist yet).
2. **Given** a logbook entry is submitted with a Closing Reading greater than Opening Reading, **When** it is saved, **Then** Total Hours/Km is computed as Closing − Opening, the machine's Current Reading is updated to the new Closing Reading, and the entry is attributed to the specified Operator (an HR Employee reference) and Site (a Projects reference).
3. **Given** an operator or site is provided, **When** the entry is saved, **Then** the system validates the Operator against existing HR employee records and the Site against existing Project site records, rejecting the entry if either reference does not exist.

---

### User Story 3 - Fuel (Priority: P2)

An admin records fuel fill-ups per machine and the system automatically flags entries whose resulting consumption rate exceeds the machine's category (or override) fuel benchmark by more than the configured variance threshold, surfacing possible fuel theft or inefficiency without anyone having to manually cross-check numbers.

**Why this priority**: Builds directly on Logbook/Asset Register data (User Stories 1–2) and delivers one of the PRD's named anti-fraud goals; it is not required for the module to be minimally usable, so it follows the P1 stories.

**Independent Test**: Can be fully tested by recording a fuel entry whose Quantity, given the machine's recent logbook hours/km, computes a consumption rate exceeding the category benchmark by more than the threshold, and confirming a fuel-variance alert is raised and surfaced to the Dashboard/Notifications registry.

**Acceptance Scenarios**:

1. **Given** a fuel entry with Quantity and Rate, **When** it is saved, **Then** Amount is computed as Quantity × Rate and the Vendor is validated against Partners records flagged as Fuel vendors.
2. **Given** a machine's recent fuel-vs-hours consumption rate exceeds its effective benchmark (category default or machine-level override) by more than the category's configured variance threshold, **When** the scheduled variance-detection job runs, **Then** a fuel-variance alert is generated for that machine, surfaced in the Machinery module's own Flags and in the Dashboard/Notifications Center registry.
3. **Given** a date range, machine, or site filter, **When** the fuel entries list is queried, **Then** the response includes Total Fuel (L), Total Cost (₹), and Average Consumption summary totals for the filtered set.

---

### User Story 4 - Maintenance (Priority: P2)

An admin schedules preventive service intervals per machine and logs maintenance jobs (breakdown or scheduled), so the fleet's service due-dates and repair history are tracked centrally and machines are automatically marked unavailable while under repair.

**Why this priority**: Reduces breakdowns per the PRD's stated goal, and is independently valuable once Asset Register exists, but is not required to unlock any other feature — placed alongside Fuel at P2.

**Independent Test**: Can be fully tested by creating a service schedule for a machine, opening a maintenance job linked to that schedule, confirming the machine's Status becomes "Under Maintenance," then closing the job and confirming Status reverts to "Active" and the schedule's Last Done reading/date reset.

**Acceptance Scenarios**:

1. **Given** a service schedule (interval in hours or km) exists for a machine, **When** the machine's Current Reading approaches the interval, **Then** the Due Services view shows Remaining units until due, turning red when Remaining drops below 10% of the interval.
2. **Given** an admin opens a new maintenance job for a machine, **When** the job is created, **Then** the machine's Status changes to "Under Maintenance."
3. **Given** an open maintenance job linked to a service schedule, **When** the admin closes the job, **Then** the machine's Status resets to "Active," and the linked schedule's Last Done reading/date update to the job's closing reading/date, resetting its Remaining counter.
4. **Given** an open or overdue-due maintenance item exists, **Then** a corresponding notification is generated for the Dashboard/Notifications Center registry.

---

### User Story 5 - Hire Bills (Priority: P2)

An admin records hire bills from equipment vendors and verifies each bill's Billed Hours against the sum of that machine's Logbook Hours for the same period before authorizing payment, preventing overpayment on hired equipment.

**Why this priority**: Directly delivers the PRD's overpayment-prevention goal; depends on Logbook (US2) and Hire Rates (US8) data existing, so it is sequenced after the foundational stories at P2.

**Independent Test**: Can be fully tested by creating a hire bill with a Billed Hours value that differs from the sum of that machine's Logbook Hours for the billed period, running Verify, and confirming the system-computed Variance, TDS, and Net Payable are correct and the Status transitions follow the defined workflow.

**Acceptance Scenarios**:

1. **Given** a new hire bill is created for a Vendor/Machine/Period, **When** saved, **Then** its Rate defaults from the Hire Rates master entry effective for that machine's category during the billed period, and its Status is set to Pending Verification.
2. **Given** a hire bill with Status Pending Verification, **When** the admin clicks Verify, **Then** the system sums that machine's Logbook Hours across the bill's period, computes Variance as Billed − Logbook, and — if Variance is within the acceptable threshold — sets Status to Verified; otherwise the bill remains Pending Verification with the variance visibly flagged.
3. **Given** a Verified hire bill, **When** the admin clicks Mark Paid, **Then** the system computes TDS from the vendor's TDS section/rate (sourced from Partners) and Net Payable (Amount − TDS), and sets Status to Paid.
4. **Given** a hire bill references a machine and period, **When** the Hire Rate lookup occurs, **Then** the exact rate in force for that category on the bill's period start date is used, per the Hire Rates master's effective-dated history — never the currently active rate if it differs.

---

### User Story 6 - Equipment Categories, Doc Types & Hire Rates masters (Priority: P3)

An admin manages the module's own reference data — Equipment Categories (with fuel benchmark and variance threshold), Equipment Doc Types (with default remind-days), and Hire Rates (effective-dated per category) — so the fleet's classification and financial defaults reflect the company's actual equipment mix and market rates over time.

**Why this priority**: The module ships with sensible seeded defaults for all three masters (see Assumptions), so US1–US5 are independently testable without an admin having touched this screen first. This story covers the admin-facing CRUD for adjusting those defaults, which is valuable but not blocking.

**Independent Test**: Can be fully tested by editing a seeded Equipment Category's fuel benchmark and variance threshold and confirming a subsequent Fuel entry (US3) uses the updated values; and by adding a new effective-dated Hire Rate and confirming a Hire Bill (US5) billed within that rate's effective window picks it up.

**Acceptance Scenarios**:

1. **Given** the seeded default Equipment Categories, **When** an admin edits a category's fuel benchmark, meter type, or variance threshold, **Then** subsequent Fuel/Equipment calculations for machines in that category use the updated value.
2. **Given** the seeded default Equipment Doc Types, **When** an admin edits a doc type's Default Remind Days or toggles Has Expiry Date / Needs Document Number, **Then** subsequent document-status derivation for that type reflects the change.
3. **Given** a category with an existing "Current" (open-ended) Hire Rate, **When** an admin adds a new rate for that category with an Effective From date, **Then** the prior rate's Effective To is set to the day before the new rate's Effective From, preserving a continuous, non-overlapping effective-dated history.

---

### Edge Cases

- What happens when a logbook entry's Closing Reading is less than its Opening Reading (e.g., odometer/hour-meter replacement or reset)? The system MUST reject the entry unless the admin explicitly confirms a meter-reset override flag (FR-012).
- What happens when a hire bill is created for equipment with Ownership = Owned rather than Hired? The system MUST reject hire bill creation for non-Hired equipment.
- What happens when no Hire Rate is effective for a machine's category on the bill's period start date? The system MUST reject bill creation, consistent with FR-023's ownership check — never silently applying a rate from a different period.
- What happens when a document is uploaded without an expiry date for a doc type that has "Has Expiry Date" enabled? The system MUST reject the upload, since status derivation depends on the expiry date.
- What happens when an Equipment Category or Doc Type in use by existing records is deactivated? Existing records retain their reference; only new-record creation is blocked from selecting the deactivated entry.
- What happens when a maintenance job is closed without being linked to a service schedule? The machine's Status reverts to Active; no service schedule is updated (there is none to update).

## Requirements *(mandatory)*

### Functional Requirements

**Asset Register**

- **FR-001**: System MUST allow admins to create and edit Equipment records with an auto-generated (editable) Code, Name, Category (from Equipment Categories), Ownership (Owned/Hired), Class (Equipment/Tool/Plant/Vehicle), Power Source, Status, deployed Site, Make, Model, Manufacturing Year, Registration Number, Chassis Number, Engine Number, Current Reading, an optional Fuel Benchmark Override, Purchase Date, Purchase Cost, Depreciation Method, and Depreciation Rate.
- **FR-002**: System MUST validate a submitted Site reference against existing Project site records, rejecting the equipment record if the site does not exist.
- **FR-003**: System MUST support listing equipment with filters for Search (name/code), Category, Ownership, Status, and Site.
- **FR-004**: System MUST compute and expose, per machine, a Flags count combining the number of expiring/expired documents and the number of overdue maintenance services.
- **FR-005**: System MUST allow admins to attach documents to a machine, each with a Document Type (from Equipment Doc Types), an optional Document Number, an optional Expiry Date, and a file upload; document types configured with "Needs Document Number" or "Has Expiry Date" enforce those fields as required on upload.
- **FR-006**: System MUST derive each document's status as Valid, Expiring Soon (within that document type's configured remind-days window), or Expired, and MUST recompute this derivation via a daily scheduled job (not solely on-read) so that alerts fire consistently regardless of who is logged in.
- **FR-007**: System MUST generate an alert/notification entry (surfaced through the existing Dashboard alerts and Notifications Center provider registry) whenever a document crosses into Expiring Soon or Expired status.

**Logbook**

- **FR-008**: System MUST allow admins/supervisors to create logbook entries per machine with Date, Site, Operator, Opening Reading, Closing Reading, Fuel Consumed, and Remarks.
- **FR-009**: System MUST pre-populate a new entry's Opening Reading from the machine's most recent Closing Reading (or its current Asset Register reading if no prior entries exist).
- **FR-010**: System MUST compute Total Hours/Km as Closing Reading − Opening Reading and MUST update the machine's Current Reading in the Asset Register to the entry's Closing Reading upon save.
- **FR-011**: System MUST validate the Operator against existing HR employee records and reject the entry if the referenced employee does not exist.
- **FR-012**: System MUST reject a logbook entry whose Closing Reading is less than its Opening Reading, unless the admin explicitly submits a meter-reset override flag.

**Fuel**

- **FR-013**: System MUST allow admins to record fuel entries with Date, Machine, Site, Quantity, Rate, Reading at Fill, and Vendor, computing Amount as Quantity × Rate.
- **FR-014**: System MUST validate the Vendor against Partners vendor records flagged as Fuel-type vendors.
- **FR-015**: System MUST support listing fuel entries filtered by Date range, Machine, and Site, returning Total Fuel, Total Cost, and Average Consumption summary totals for the filtered set.
- **FR-016**: System MUST run a scheduled job that computes each machine's recent fuel consumption rate and compares it to the machine's effective fuel benchmark (its own override if set, otherwise its category default), raising a fuel-variance alert when consumption exceeds the benchmark by more than the category's configured variance threshold (default 15%).

**Maintenance**

- **FR-017**: System MUST allow admins to create service schedules per machine with Service Name, Interval (hours or km), Last Done Reading, and Last Done Date.
- **FR-018**: System MUST expose a Due Services view showing, per schedule, Remaining units until due, computed from the machine's Current Reading against the schedule's interval, and MUST flag schedules where Remaining is below 10% of the interval.
- **FR-019**: System MUST allow admins to open maintenance jobs with Machine, Job Type (Breakdown/Scheduled), an optional linked Service Schedule, Reading at Service, and Problem Description, and MUST set the machine's Status to "Under Maintenance" upon opening.
- **FR-020**: System MUST allow admins to close a maintenance job, recording Total Cost, and MUST reset the machine's Status to "Active" upon closing.
- **FR-021**: System MUST, when a closed job is linked to a service schedule, update that schedule's Last Done Reading and Last Done Date to the job's closing values and reset its Remaining counter.
- **FR-022**: System MUST generate a notification (surfaced through the Dashboard/Notifications Center registry) for open maintenance jobs and for due-services crossing the below-10%-remaining threshold.

**Hire Bills**

- **FR-023**: System MUST allow admins to create hire bills only for equipment with Ownership = Hired, with Vendor, Machine, Period From/To, Billed Hours, Rate, Amount, and Party Bill Number, defaulting to Status "Pending Verification."
- **FR-024**: System MUST default a new hire bill's Rate from the Hire Rate effective for the machine's category on the bill's period start date, per the Hire Rates master's effective-dated history.
- **FR-025**: System MUST, on admin-triggered verification, sum the machine's Logbook Hours across the bill's period, compute Variance as Billed − Logbook, and transition Status to "Verified" when Variance is within the machine category's admin-configurable Hire Bill Variance Threshold (an Equipment Categories field, seeded with a default of 5%, mirroring the Fuel Variance Alert Threshold pattern).
- **FR-026**: System MUST, on admin-triggered Mark Paid (available only once Verified), compute TDS from the vendor's TDS section and rate (sourced from Partners) and Net Payable as Amount − TDS, transitioning Status to "Paid."

**Reference Data (Equipment Categories, Doc Types, Hire Rates)**

- **FR-027**: System MUST allow admins to create and edit Equipment Categories with Name, Class, Meter Type (hrs/km), Fuel Benchmark, a configurable Fuel Variance Alert Threshold (default 15%), a configurable Hire Bill Variance Threshold (default 5%), and Sort Order, and MUST seed the module with the PRD's default category set on first migration.
- **FR-028**: System MUST allow admins to create and edit Equipment Doc Types with Code, Name, Default Remind Days, Sort Order, Has Expiry Date, Needs Document Number, and Active toggles, and MUST seed the module with the PRD's default doc type set on first migration.
- **FR-029**: System MUST allow admins to create Hire Rates per Category with Rate per Unit, Effective From, and an optional Effective To, and MUST maintain a full non-overlapping effective-dated history per category so that historical hire bills always resolve the rate in force at their billing period.
- **FR-030**: System MUST prevent selection of a deactivated Equipment Category or Doc Type on new records while preserving the reference on existing records that already use it.

**Cross-cutting**

- **FR-031**: System MUST scope all Machinery data (equipment, logbook, fuel, maintenance, hire bills, and reference data) per company, consistent with every other module in this system.
- **FR-032**: System MUST guard every Machinery endpoint with a permission check, following this module's own permission set (mirroring the per-functional-area permission pattern already established by the HR & Payroll module).
- **FR-033**: System MUST record every create/update/status-transition action across this module's entities to the shared audit log, consistent with every other module in this system.
- **FR-034**: System MUST expose Machinery Cost, Fuel Cost, and Hire Bills figures to the Dashboard module's existing widget-provider registry as new providers, and MUST expose document-expiry, fuel-variance, and maintenance-due alerts to the Dashboard's Alerts & Reminders and Notifications Center via the existing notification-provider registry — without building a separate alerting or dashboard system.

### Key Entities

- **Equipment**: A single machine/tool/plant/vehicle owned or hired by the company — identity, classification, current reading, deployment site, and depreciation metadata.
- **EquipmentDocument**: A compliance document attached to an Equipment record (RC, Insurance, PUC, etc.), with its derived Valid/Expiring/Expired status.
- **EquipmentCategory**: Reference data classifying equipment (class, meter type, fuel benchmark, variance threshold).
- **EquipmentDocType**: Reference data defining a document type's required fields and default reminder window.
- **LogbookEntry**: A daily operational record per machine — operator, site, opening/closing reading, fuel consumed.
- **FuelEntry**: A fuel fill-up record per machine — quantity, rate, vendor, reading at fill.
- **ServiceSchedule**: A preventive-maintenance interval definition per machine — service name, interval, last-done reading/date.
- **MaintenanceJob**: A breakdown or scheduled repair record per machine — optionally linked to a ServiceSchedule, with cost and status.
- **HireBill**: A vendor invoice for hired equipment usage — billed hours, verified logbook hours, variance, TDS, net payable, and status.
- **HireRate**: An effective-dated rate per equipment category used to default Hire Bill rates and TDS-period calculations.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Zero machines with an expired compliance document remain undetected — every expired document is reflected in that machine's Flags count and in an active Dashboard/Notification alert within 24 hours of expiry.
- **SC-002**: 100% of fuel entries whose consumption exceeds the applicable benchmark by more than the configured threshold are flagged within 24 hours of entry.
- **SC-003**: Zero hire bills reach Paid status without having first passed the Verify step against logbook data.
- **SC-004**: Every piece of equipment has a monthly utilization percentage available, computed from its logged hours/km against its available-hours benchmark, with no manual spreadsheet reconciliation required.
- **SC-005**: An admin can register a new machine and have it fully operational (with documents and an initial logbook entry) in under 5 minutes.
- **SC-006**: Historical hire bills, when re-queried, always resolve to the hire rate that was in force during their original billing period, even after newer rates are added for that category.

## Assumptions

- Utilization % is computed as: total hours (or km) logged via Logbook entries within the reporting period, divided by a standard available-hours-per-period benchmark (8 hours/day × working days in the period for hours-metered equipment; an equivalent category-configurable expected-km/period benchmark for km-metered equipment) — this is a documented calculation default, not a PRD-specified formula.
- Depreciation Method and Depreciation Rate are captured as equipment metadata only in this pass; this module does not compute or expose a depreciation schedule or current book value — that is left to a future Finance/Accounting module, consistent with the PRD listing them only as Add/Edit Equipment fields and never as a report or KPI output.
- Equipment Categories, Equipment Doc Types, and Hire Rates are seeded with the PRD's named defaults (10 categories, 10 doc types, no pre-seeded hire rates since those are inherently company/region-specific) via migration, so User Stories 1–5 are independently testable without requiring User Story 6's admin screens to be used first.
- Document files are stored using this system's existing file storage service (the same one already used for HR & Payroll employee documents), with no virus scanning in this pass — consistent with the equivalent decision already made for HR & Payroll.
- "Company" scoping and permission-guard conventions follow the same patterns already established across every other module (Settings, My Workspace, Dashboard, HR & Payroll) rather than introducing new mechanisms.
- The Dashboard/Notifications integration in FR-034 assumes the Dashboard module's widget-provider and notification-provider registries (specs/004-dashboard-backend) remain unchanged in shape; this module only registers new providers into them.
