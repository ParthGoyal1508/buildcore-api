# Research: Machinery Module Backend

## 1. Schema placement: `plant`

**Decision**: All new Machinery entities (Equipment, EquipmentDocument, EquipmentCategory,
EquipmentDocType, LogbookEntry, FuelEntry, ServiceSchedule, MaintenanceJob, HireBill, HireRate)
land in the `plant` schema.

**Rationale**: The constitution's named schema list (`hr`, `payroll`, `projects`, `plant`,
`inventory`, `partners`, `settings`, `shared`) already reserves `plant` — "plant and machinery" is
standard construction-industry terminology for exactly this equipment fleet, and this is the first
feature to claim that schema. No naming ambiguity with the PRD's own "Class: Plant" equipment
classification value, which is just an enum member inside `Equipment`, not a schema-level concern.

**Alternatives considered**: A new `machinery` schema — rejected because the constitution already
named and reserved `plant` for this exact purpose; introducing a second schema would fragment the
pre-planned module list for no benefit.

## 2. Minimal `Vendor` entity (`partners` schema, new)

**Decision**: This feature creates a minimal `Vendor` entity in the `partners` schema — the first
feature needing one (`{ id, companyId, name, type: 'fuel' | 'hire' | 'other', tdsSection?,
tdsRatePercent?, active }`) — since no Partners module has been specced yet. Fuel entries
reference vendors of type `fuel`; Hire Bills reference vendors of any type but read
`tdsSection`/`tdsRatePercent` from the same record for TDS calculation.

**Rationale**: Matches the exact precedent set by feature 003, which created a minimal `Site` in
the then-unspecced `projects` schema for its own needs. A future Partners feature extends this
`Vendor` record with its full field set (address, GSTIN, bank details, etc.) the same way feature
005 extended 003's minimal `Employee` — never redefining, only adding.

**Alternatives considered**: Embedding vendor name/TDS as free-text fields directly on FuelEntry/
HireBill — rejected; it would prevent per-vendor TDS-history integrity and duplicate data entry
across every bill from the same vendor, and blocks the eventual Partners feature from adopting
these records cleanly.

## 3. Cross-module reads: `Site` and `Employee`

**Decision**: Deployment Site (Equipment, LogbookEntry, FuelEntry) reads `projects.Site` (created
by 003) read-only via a `ProjectsService.getSiteById()`-shaped call. Operator (LogbookEntry) reads
`hr.Employee` read-only via `EmployeesService.getEmployeeById()`. Neither module queries the other
schema's tables directly (Principle I) — same in-process exported-service-call pattern used by
every prior feature's cross-schema reads.

**Rationale**: `Site` and `Employee` already exist; this feature only needs to validate references
against them, not extend their shape, so no data-model change is required in `projects`/`hr` beyond
what 003/005 already defined.

## 4. Scheduled jobs: BullMQ repeatable jobs

**Decision**: The daily document-expiry scan and the fuel-variance detection job both run as
BullMQ repeatable jobs (`@nestjs/bullmq`), the same background-job mechanism feature 004 already
introduced for report exports. No new dependency.

**Rationale**: The constitution pre-approves `@nestjs/bullmq` for background jobs generally, and it
is already wired by feature 004 — reusing the same queue infrastructure for a second job type is a
config addition, not an architectural one. A dedicated cron library (`@nestjs/schedule`) would be a
second, redundant scheduling mechanism for no added capability BullMQ's repeatable jobs don't
already cover.

**Alternatives considered**: `@nestjs/schedule` — rejected as a redundant second scheduling
mechanism once BullMQ repeatable jobs are available.

## 5. Document storage

**Decision**: `EquipmentDocument.fileRef` is an encrypted object-storage reference, the same
pattern as 003's `photoRefs` and 005's `EmployeeDocument.fileRef` — an opaque, encrypted reference
string, storage backend unspecified at the spec layer.

**Rationale**: Consistency with the two existing document/photo-upload features; no new decision
needed.

## 6. Permission enum extension

**Decision**: Six new values are added to the existing `Permission` enum (owned by `settings`,
feature 002): `ASSET_REGISTER`, `LOGBOOK`, `FUEL`, `MAINTENANCE`, `HIRE_BILLS`,
`MACHINERY_SETTINGS` (guards the three reference-data masters). Every Machinery endpoint is guarded
with `@RequirePermission()` using one of these six.

**Rationale**: Mirrors 005's precedent of adding new enum values for each functional area
(`EMPLOYEES`/`ATTENDANCE`/`PAYROLL`/`CHALLANS`/`LOANS`/`DAILY_WORKER_REGISTRY`) rather than reusing
a single coarse `MACHINERY` permission that would force an all-or-nothing grant across asset
management, financial verification (Hire Bills), and reference-data configuration — three areas
with meaningfully different trust levels.

## 7. Dashboard / Notifications integration

**Decision**: This feature registers new entries into 004's existing `WIDGET_PROVIDERS` and
`NOTIFICATION_PROVIDERS` multi-provider tokens: widget providers for Machinery Cost, Fuel Cost, and
Hire Bills (feeding the Dashboard's Quick Stats Sidebar and Group Dashboard aggregates);
notification providers for Document Expiry, Fuel Variance, and Maintenance Due. This is this
feature's own task — 004's placeholder `unavailable: { module: 'machinery' }` entries become real
once these providers land, with zero change to 004's registry shape or rendering logic.

**Rationale**: Directly continues the extensible-registry architecture 004 established
specifically so that "adding a real tile later requires zero frontend change" — Machinery is the
first module to make good on that promise for a previously-placeholder set of widgets/notifications.

## 8. Reference-data seeding

**Decision**: `EquipmentCategory` (10 PRD-named defaults) and `EquipmentDocType` (10 PRD-named
defaults) are seeded via migration, matching 002's seeded Settings reference-data pattern.
`HireRate` is not pre-seeded — the PRD is explicit that hire rates are inherently
company/region-specific with no sensible universal default.

**Rationale**: Lets User Stories 1–5 be independently testable without requiring an admin to first
populate reference data by hand, exactly as 002/005's own masters were seeded.

## 9. Hire Bill Variance Threshold

**Decision**: `EquipmentCategory` gains a `hireBillVarianceThresholdPercent` field, seeded at 5%,
admin-editable per category — resolving the spec's clarification (Billed-vs-Logbook Hours variance
gating the Pending Verification → Verified transition) the same way the PRD already makes Fuel
Variance Alert Threshold a per-category configurable field.

**Rationale**: User-selected during spec authoring (AskUserQuestion) as the option mirroring the
already-PRD-specified fuel-variance pattern, consistent with this project's established preference
for admin-configurable rates over hardcoded ones (see feature 005's OT multiplier).

## 10. Utilization % calculation

**Decision**: Utilization % is computed on read by a service method — not a stored column — as
total LogbookEntry hours/km within the reporting period ÷ a standard available-units benchmark (8
hours/day × working days in the period for hours-metered equipment; a category-configurable
expected-km/period benchmark for km-metered equipment), per the spec's documented formula
(Assumptions). The same monthly pass that refreshes document-expiry status also recomputes and
caches this value for the Equipment list's Utilization % column and the Equipment Utilization
Report, avoiding a client-side or per-request recomputation.

**Rationale**: Keeps the formula server-side and centrally defined (constitution Principle III —
no scattered magic numbers), while avoiding an expensive on-every-list-request aggregation.

## 11. Audit logging

**Decision**: Every create/update/status-transition across this feature's entities writes to the
shared `AuditLogEntry` via the existing `AuditLogService` (001/002), using this feature's own new
`entityType` enum values (`Equipment`, `LogbookEntry`, `FuelEntry`, `MaintenanceJob`, `HireBill`,
etc.) — extending, not restructuring, the existing audit log shape every prior feature has used.

**Rationale**: Consistent with every prior feature's audit-log integration; no new mechanism
needed.
