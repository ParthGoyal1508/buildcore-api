# Data Model: Machinery Module Backend

All entities below are new. Unless noted, every table carries `id`, `companyId` (FK
`settings.Company.id`), `createdAt`, `updatedAt`, and is subject to the same Row-Level Security
tenant-isolation policy (Principle IV) as every existing table.

## Equipment (`plant` schema — new)

`{ id, companyId, code, name, categoryId (FK EquipmentCategory), ownership: 'owned' | 'hired',
class: 'equipment' | 'tool' | 'plant' | 'vehicle', powerSource: 'diesel' | 'petrol' | 'electric' |
'manual', status: 'active' | 'inactive' | 'under_maintenance', siteId (FK projects.Site, nullable),
make?, model?, manufacturingYear?, registrationNumber?, chassisNumber?, engineNumber?,
currentReading: decimal, fuelBenchmarkOverride?: decimal, purchaseDate?, purchaseCost?: decimal,
depreciationMethod?: 'wdv' | 'slm', depreciationRate?: decimal }`.

`utilizationPercent` is not a stored column — computed by the utilization service (research.md
§10) and cached on the same monthly refresh pass as document-expiry status; exposed via the list/
detail read paths only.

## EquipmentDocument (`plant` schema — new)

`{ id, equipmentId (FK Equipment), docTypeId (FK EquipmentDocType), documentNumber?, expiresAt?,
fileRef: string (encrypted object-storage reference, research.md §5), status:
'valid' | 'expiring_soon' | 'expired', uploadedAt }`. `status` is recomputed daily by the
document-expiry scan job (research.md §4), not solely on read.

## EquipmentCategory (`plant` schema — new)

`{ id, companyId, name, class: 'equipment' | 'tool' | 'plant' | 'vehicle', meterType: 'hours' |
'km', fuelBenchmark: decimal, fuelVarianceThresholdPercent: decimal (default 15),
hireBillVarianceThresholdPercent: decimal (default 5, research.md §9), sortOrder: int, active:
boolean }`. Seeded with the PRD's 10 named defaults (research.md §8).

## EquipmentDocType (`plant` schema — new)

`{ id, companyId, code, name, defaultRemindDays: int, sortOrder: int, hasExpiryDate: boolean,
needsDocumentNumber: boolean, active: boolean }`. Seeded with the PRD's 10 named defaults
(research.md §8).

## LogbookEntry (`plant` schema — new)

`{ id, companyId, equipmentId (FK Equipment), date, siteId (FK projects.Site), operatorId (FK
hr.Employee), openingReading: decimal, closingReading: decimal, totalUnits: decimal (computed:
closingReading − openingReading), fuelConsumedLiters?: decimal, remarks?, isMeterResetOverride:
boolean (default false, FR-012) }`.

## FuelEntry (`plant` schema — new)

`{ id, companyId, equipmentId (FK Equipment), date, siteId (FK projects.Site), quantityLiters:
decimal, ratePerLiter: decimal, amount: decimal (computed: quantity × rate), readingAtFill:
decimal, vendorId (FK partners.Vendor, type='fuel') }`.

## ServiceSchedule (`plant` schema — new)

`{ id, companyId, equipmentId (FK Equipment), serviceName, intervalUnits: decimal, lastDoneReading:
decimal, lastDoneDate }`. `remainingUnits` is computed (interval − (equipment.currentReading −
lastDoneReading)), not stored.

## MaintenanceJob (`plant` schema — new)

`{ id, companyId, equipmentId (FK Equipment), openedAt, jobType: 'breakdown' | 'scheduled',
linkedServiceScheduleId? (FK ServiceSchedule), readingAtService: decimal, problemDescription,
totalCost?: decimal, status: 'open' | 'in_progress' | 'closed', closedAt? }`.

## HireBill (`plant` schema — new)

`{ id, companyId, vendorId (FK partners.Vendor), equipmentId (FK Equipment, ownership must be
'hired'), periodFrom, periodTo, billedHours: decimal, logbookHours?: decimal (populated on
Verify), varianceHours?: decimal (computed: billed − logbook), rate: decimal, amount: decimal,
tdsAmount?: decimal, netPayable?: decimal, partyBillNumber?, status: 'pending_verification' |
'verified' | 'paid' }`.

## HireRate (`plant` schema — new)

`{ id, companyId, categoryId (FK EquipmentCategory), ratePerUnit: decimal, effectiveFrom,
effectiveTo?: date | null (null = current) }`. Non-overlapping per category — creating a new
"current" rate sets the prior current rate's `effectiveTo` to the day before the new rate's
`effectiveFrom` (research.md, FR-029).

## Vendor (`partners` schema — new, minimal)

`{ id, companyId, name, type: 'fuel' | 'hire' | 'other', tdsSection?: string, tdsRatePercent?:
decimal, active: boolean }`. Minimal version created by this feature (research.md §2) — a future
Partners feature extends this record's field set (address, GSTIN, bank details) without
restructuring it, the same way feature 005 extended feature 003's minimal `Employee`.

## Relationships

| Field | Relationship |
|---|---|
| `Equipment.categoryId` | FK to `EquipmentCategory.id` (own schema) |
| `Equipment.siteId`, `LogbookEntry.siteId`, `FuelEntry.siteId` | FK to `projects.Site.id` (003), read-only cross-schema reference (research.md §3) |
| `LogbookEntry.operatorId` | FK to `hr.Employee.id` (003/005), read-only cross-schema reference |
| `FuelEntry.vendorId`, `HireBill.vendorId` | FK to `partners.Vendor.id` (new, this feature) |
| `EquipmentDocument.docTypeId` | FK to `EquipmentDocType.id` (own schema) |
| `HireBill.equipmentId` | FK to `Equipment.id`; creation blocked unless `Equipment.ownership = 'hired'` (FR-023) |
| `HireRate.categoryId` | FK to `EquipmentCategory.id` (own schema) |
| every table's `companyId` | FK to `settings.Company.id` (002) |

## Cross-reference to prior features

| Concept | Relationship |
|---|---|
| `projects.Site` | Reused unchanged from feature 003; this feature does not modify it |
| `hr.Employee` | Reused unchanged from features 003/005; this feature does not modify it |
| `settings.Permission` enum | Extended with `ASSET_REGISTER`/`LOGBOOK`/`FUEL`/`MAINTENANCE`/`HIRE_BILLS`/`MACHINERY_SETTINGS` (research.md §6) |
| `shared.AuditLogEntry` | Extended `entityType` enum values only (research.md §11) |
| Dashboard `WIDGET_PROVIDERS`/`NOTIFICATION_PROVIDERS` (004) | New provider registrations, no shape change (research.md §7) |
