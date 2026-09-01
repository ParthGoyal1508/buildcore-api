# Data Model: Project Assets Backend

**Feature**: `012-project-assets-backend` | **Date**: 2026-09-01

Schemas: `assets` (8 tables), `settings` (3 new reference-data tables — FR-002). Every table carries
`companyId` with RLS (FR-001), plus `createdAt`, `updatedAt`, `createdBy`, and — where soft-delete
applies (FR-031) — `deletedAt`, `deletedBy`.

## `settings` schema additions

### AssetCategory
| Field | Type | Notes |
|---|---|---|
| id, companyId | uuid | |
| name | string | unique per company |
| trackingMode | enum | serialised \| bulk — **immutable once assets exist** (FR-003) |
| depreciationRatePercent | decimal | straight-line |
| usefulLifeYears | int | |
| custodyRequired | bool | drives FR-010 |
| inspectionRequired | bool | |
| inspectionIntervalDays | int? | required when `inspectionRequired` |

### AssetDocType
`id`, `companyId`, `name`, `alertDays` — drives the `document_expiry` reminder rule (FR-025).

### ConditionGrade
`id`, `companyId`, `name`, `sequence`, `isDamaged`, `isScrap` — the damaged/scrap semantics drive
the return-status mapping in FR-015.

## `assets` schema

### Asset
| Field | Type | Notes |
|---|---|---|
| id, companyId | uuid | |
| assetCode | string | auto-generated via Settings code series (FR-006); unique per company |
| categoryId | uuid | → `settings` |
| name, manufacturer, modelNumber | string | |
| serialNumber | string? | **unique per company when present** (FR-008); serialised only |
| quantity, unitOfMeasure | | bulk only; serialised rejects quantity > 1 (FR-004) |
| purchaseDate, purchaseCost | | |
| capitalisationDate | date | must be ≥ `purchaseDate`; depreciation starts here (FR-019) |
| salvageValue | decimal | book-value floor (FR-019) |
| vendorId? | uuid | → `partners` via PartnersService |
| purchaseId? | uuid | → `inventory`; acquisition traceability (FR-038) |
| currentSiteId | uuid | → `projects` via ProjectsService |
| currentCustodianId? | uuid | → `hr` via HrService |
| status | enum | not_in_service \| idle \| allocated \| in_transit \| under_repair \| scrapped (FR-007) |
| currentConditionGradeId? | uuid | |
| nextInspectionDue? | date | advances from each inspection date, not the prior due date (FR-017) |
| disposalDate? | date | set on condemn (FR-018) |

### AssetStock (bulk categories only — FR-005)
`id`, `companyId`, `assetId`, `siteId`, `quantityOnHand`, `quantityAllocated`, `quantityInTransit`.
Running balances updated in-transaction; **never below zero** (FR-011). Unique on
`(assetId, siteId)`.

### AssetAllocation
`id`, `companyId`, `assetId`, `projectId`, `siteId`, `custodianEmployeeId?`, `quantity` (bulk),
`allocatedFrom`, `expectedReturnDate`, `actualReturnDate?`, `conditionOnReturnId?`, `remarks?`,
`status` (open|closed).

Constraints: at most one open allocation per serialised asset (FR-009); custodian's active site must
equal `siteId` (FR-010); `overdue` derived when `expectedReturnDate` has passed and
`actualReturnDate` is null.

### AssetTransfer (FR-012 to FR-014)
`id`, `companyId`, `assetId`, `fromSiteId`, `toSiteId`, `quantity` (bulk), `dispatchDate`,
`transportMode`, `vehicleNumber?`, `dispatchConditionId`, `receivedDate?`, `receivedQuantity?`,
`conditionOnReceiptId?`, `conditionDiscrepancy` (bool), `transitShortage?` (decimal),
`status` (in_transit|closed|closed_with_shortage|cancelled), `cancelReason?`.

Receipt applied under a row-level lock (FR-013).

### AssetRequest / AssetRequestLine
`id`, `companyId`, `requestNumber`, `categoryId`, `assetId?`, `quantity`, `projectId`, `siteId`,
`requiredByDate`, `justification`, `status` (pending|approved|rejected|fulfilled|
procurement_pending|cancelled), `approvedBy?`, `rejectionReason?`, `fulfilledAllocationId?`.

Fulfilment requires an `idle` asset and creates the allocation in the same transaction (FR-023).

### AssetInspection
`id`, `companyId`, `assetId`, `inspectionDate`, `conditionGradeId`, `outcome`
(pass|repair_required|condemn), `remarks`, `inspectedBy`.

### AssetRepair
`id`, `companyId`, `assetId`, `repairDate`, `description`, `cost`, `vendorId?`,
`expectedCompletionDate`, `actualCompletionDate?`, `resultingConditionGradeId?`,
`downtimeDays` (computed), `status` (open|closed).

### AssetDocument
`id`, `companyId`, `assetId`, `docTypeId`, `fileRef` (encrypted object storage — FR-028),
`documentNumber?`, `issueDate?`, `expiryDate?`.

## Computed, not stored

- **Book value** (FR-019): `purchaseCost − (purchaseCost × ratePercent/100/12 × monthsSinceCapitalisation)`,
  floored at `salvageValue`, zero depreciation before `capitalisationDate`, never negative.
- **Reminders** (FR-025): the three rule families are registered with feature 004's engine and
  evaluated there — nothing is materialised in this schema.

## Cross-module reads (no cross-schema queries — Principle I)

| Need | Path |
|---|---|
| Site / project resolution | `ProjectsService.getSitesByProject()` (FR-029) |
| Vendor name and status | `PartnersService.getVendorById()` (FR-029) |
| Employee / custodian | `HrService` (FR-030) |
| Kit-issue and purchase linkage | `InventoryService` |
| Reminder evaluation | feature 004's engine (FR-026) |

## Exported service methods

- `getAssetCostByProject(projectId, dateRange)` — consumed by 008's P&L (FR-021, FR-022).
- `getOutstandingCustody(employeeId)` — consumed by 005's exit/F&F flow (FR-036).
