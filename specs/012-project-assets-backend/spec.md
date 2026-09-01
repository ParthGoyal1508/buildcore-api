# Feature Specification: Project Assets Backend (Asset Register, Allocation, Custody, Requests, Reminders)

**Feature Branch**: `012-project-assets-backend`

**Created**: 2026-09-01

**Status**: Draft

**Input**: User description: "Project Assets module for the BuildCore API backend, closing the gap
identified by the module/submodule matrix row 36 ('Project Assets: Project Assets, New Assets,
Summary, Request, Stock, Reminders') under the Store & Inventory module. Feature 009 (Inventory)
covers *consumable* materials only — items that are purchased, issued to a work activity, and
consumed, tracked by running stock balance and weighted average rate. It has no concept of a
durable, individually-identified, returnable asset that is allocated to a project or a person,
carries documents with expiry, depreciates, and comes back. Feature 006 (Plant & Machinery) covers
heavy equipment with logbooks, fuel, and hire bills — far heavier machinery than the scaffolding,
shuttering, power tools, formwork, safety gear, IT assets, and site furniture this module tracks.
This feature owns the `assets` schema and fills the gap between the two."

**Scope note**: the boundary rule between this feature and its two neighbours is: if it is consumed
by use, it belongs to 009 (Inventory); if it needs a logbook, fuel tracking, or hire billing, it
belongs to 006 (Plant & Machinery); if it is durable, individually identified, allocated and
returned, it belongs here. A single asset is never simultaneously registered in two of the three.

## Clarifications

### Session 2026-09-01

- Q: Is an asset tracked individually or by quantity? → A: Both, by asset *type*. An asset category
  is configured as either `serialised` (each unit is its own asset record with a unique asset code —
  a laptop, a concrete vibrator) or `bulk` (units are fungible and tracked by quantity per location
  — scaffolding pipes, shuttering plates). Serialised assets support person-level custody; bulk
  assets support only location-level allocation with quantities.
- Q: Does an asset transfer between projects go through the same approval as an inventory transfer?
  → A: It is its own flow. An asset transfer has a dispatch step and a receipt step at the
  destination, and the asset is `in_transit` in between; unlike inventory transfers it must be
  acknowledged by the receiving site before the destination's stock reflects it.
- Q: How is depreciation handled here versus 006's equipment depreciation? → A: The same formula
  and rate configuration, computed on demand rather than posted as journal entries —
  `monthlyDepreciation = purchaseCost × depreciationRate / 12`, accumulated from the capitalisation
  date, with a floor at the configured salvage value. This feature does not do accounting postings.
- Q: What does "Request" in the matrix mean for assets — a purchase request or an allocation
  request? → A: An *allocation* request. A site raises a request for an asset or a quantity of a
  bulk asset; it is approved and then fulfilled either by allocating an existing idle asset or by
  flagging that a procurement is needed. Procurement itself remains feature 009's purchase flow.
- Q: What do asset "Reminders" cover? → A: Three due-date families — document expiry (insurance,
  calibration certificate, warranty), scheduled inspection/calibration due dates, and overdue
  returns (an asset allocated with an expected return date that has passed). All three are surfaced
  through the existing notification mechanism rather than a new delivery channel.
- Q: Can an asset be allocated to an employee who is not posted at the asset's current site? → A:
  No. Custody assignment requires the employee's active site to match the asset's current location,
  rejected otherwise, so custody and physical location never disagree.

### Session 2026-09-01 (ratification — gap-closure clarify pass)

- Q: Should project assets live in their own schema, extend feature 009's inventory, or fold into
  feature 006's equipment register? → A: Their own `assets` schema. Durable returnable assets have a
  different costing dimension, custody model, and return semantics than 009's consumables and 006's
  heavy equipment; a third stock location is accepted as the cost.
- Q: Should this feature evaluate its own reminders? → A: No — it registers its three reminder
  families (document expiry, inspection due, overdue return) with feature 004's centralized
  reminders engine.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Manage asset categories and reference masters (Priority: P1)

An admin configures asset categories (Scaffolding, Shuttering, Power Tools, Safety Equipment, IT
Assets, Site Furniture) with their tracking mode, default depreciation rate, useful life, whether
custody assignment is required, and whether periodic inspection applies. Asset document types and
condition grades are configured alongside.

**Why this priority**: No asset can be registered without a category, and the category's tracking
mode determines every downstream behaviour. No dependencies beyond Settings.

**Independent Test**: Create a `serialised` category "Power Tools" with a 15% depreciation rate and
custody required; create a `bulk` category "Scaffolding"; confirm registering an asset under each
enforces the corresponding tracking mode.

**Acceptance Scenarios**:

1. **Given** an admin session, **When** `POST /settings/asset-categories` is called with `name`,
   `trackingMode` (serialised|bulk), `depreciationRatePercent`, `usefulLifeYears`,
   `custodyRequired`, `inspectionRequired`, and optional `inspectionIntervalDays`, **Then** the
   category is created.
2. **Given** a category with `inspectionRequired: true` and no `inspectionIntervalDays`, **When**
   creation is attempted, **Then** `400 Bad Request`.
3. **Given** a category with registered assets, **When** its `trackingMode` is edited, **Then**
   `409 Conflict` — tracking mode is immutable once assets exist under it.
4. **Given** a category with registered assets, **When** `DELETE /settings/asset-categories/:id` is
   attempted, **Then** `409 Conflict`.
5. **Given** an admin session, **When** `POST /settings/asset-doc-types` is called with `name` and
   `alertDays`, **Then** the doc type is created and becomes selectable on asset document upload.
6. **Given** the category list, **When** `GET /settings/asset-categories`, **Then** every category
   is returned with its `assetCount` and `totalBookValue`.

---

### User Story 2 - Register assets (New Assets) (Priority: P1)

A store or project admin registers a new asset with its category, description, purchase details,
capitalisation date, initial location, and optional linkage to the inventory purchase that brought
it in. Serialised assets receive a unique asset code and optional manufacturer serial number; bulk
assets are registered with an opening quantity at a location.

**Why this priority**: The core record of the module. Everything else references an asset. Depends
on US1.

**Independent Test**: Register a serialised power tool with a purchase cost and capitalisation date,
confirm a unique asset code is generated, `status: 'idle'`, and current book value equals purchase
cost on the capitalisation date — without allocating it.

**Acceptance Scenarios**:

1. **Given** a serialised category, **When** `POST /assets` is called with `categoryId`, `name`,
   `manufacturer`, `modelNumber`, optional `serialNumber`, `purchaseDate`, `purchaseCost`,
   `capitalisationDate`, `salvageValue`, `currentSiteId`, optional `vendorId`, and optional
   `purchaseId`, **Then** the asset is created with `status: 'idle'` and an auto-generated
   `assetCode`.
2. **Given** a bulk category, **When** `POST /assets` is called with a `quantity` and
   `unitOfMeasure` instead of a serial number, **Then** a bulk asset record is created with an
   opening `AssetStock` row at the given site.
3. **Given** a serialised category, **When** creation is attempted with a `quantity` greater than 1,
   **Then** `400 Bad Request` directing the caller to register each unit separately.
4. **Given** an asset with a `serialNumber` already registered in the company, **When** creation is
   attempted, **Then** `409 Conflict`.
5. **Given** an asset, **When** `POST /assets/:id/documents` is called with an `docTypeId`, file, and
   optional `expiryDate`, **Then** the document is stored as an encrypted object-storage reference.
6. **Given** an asset whose `capitalisationDate` precedes its `purchaseDate`, **When** creation is
   attempted, **Then** `400 Bad Request`.
7. **Given** an asset created with a `purchaseId`, **When** the asset is read, **Then** the linked
   inventory purchase reference is returned so the acquisition is traceable to its bill.
8. **Given** the asset list, **When** `GET /assets?categoryId=&siteId=&status=&search=`, **Then**
   paginated results include current location, custodian, status, condition, and current book
   value.

---

### User Story 3 - Allocate assets to projects and assign custody (Priority: P1)

An asset is allocated from the idle pool to a project site for a period, and — for categories
requiring custody — assigned to a specific employee who is accountable for it. Allocation records
the expected return date that drives overdue-return reminders.

**Why this priority**: Allocation is what makes an asset register operationally useful; the matrix's
"Project Assets" view is fundamentally "which assets are at which project". Depends on US2.

**Independent Test**: Allocate an idle power tool to a project site with an expected return date and
assign custody to a site engineer, confirm the asset's status becomes `allocated`, its location and
custodian update, and it appears in that project's asset list — without returning it.

**Acceptance Scenarios**:

1. **Given** an idle serialised asset, **When** `POST /assets/:id/allocations` is called with
   `projectId`, `siteId`, `allocatedFrom`, `expectedReturnDate`, and optional
   `custodianEmployeeId`, **Then** an allocation is created, the asset's `status` becomes
   `allocated`, and `currentSiteId` and `currentCustodianId` update.
2. **Given** an already-allocated serialised asset, **When** a second allocation is attempted,
   **Then** `409 Conflict` naming the existing allocation.
3. **Given** a category with `custodyRequired: true`, **When** allocation is attempted without a
   `custodianEmployeeId`, **Then** `400 Bad Request`.
4. **Given** a custodian whose active site differs from the allocation's `siteId`, **When**
   allocation is attempted, **Then** `400 Bad Request` — custody requires the employee to be posted
   at the asset's location.
5. **Given** a bulk asset, **When** allocation is requested for a quantity exceeding the available
   quantity at the source site, **Then** `400 Bad Request` reporting the available quantity.
6. **Given** a bulk asset with sufficient quantity, **When** an allocation for a quantity is
   created, **Then** the source site's `AssetStock` decrements and the destination's allocated
   quantity increments atomically.
7. **Given** an allocated asset, **When** `PATCH /assets/allocations/:id/return` is called with an
   `actualReturnDate`, a `conditionOnReturn` grade, and optional `remarks`, **Then** the allocation
   closes, the asset's status returns to `idle`, custody clears, and the condition is recorded.
8. **Given** an asset returned in a condition grade configured as `damaged` or `scrap`, **When** the
   return is recorded, **Then** the asset's status becomes `under_repair` or `scrapped` rather than
   `idle`.
9. **Given** an allocation whose `expectedReturnDate` has passed with no return recorded, **When**
   the allocation list is read, **Then** it is flagged `overdue` with the day count.
10. **Given** an employee with assets in custody, **When** their exit is initiated in feature 005,
    **Then** the outstanding custody list is retrievable so recovery can be tracked at F&F.

---

### User Story 4 - Raise and fulfil asset requests (Priority: P2)

A site supervisor raises a request for an asset — by category, or for a specific asset, or for a
quantity of a bulk asset — with a justification and a required-by date. The request is approved,
then fulfilled by allocating an available asset, or marked as requiring procurement when nothing is
available.

**Why this priority**: The matrix names "Request" explicitly. It sits on top of allocation rather
than beside it, so allocation must exist first. Depends on US3.

**Independent Test**: Raise a request for one power tool at a site, approve it, fulfil it against an
idle asset, and confirm the resulting allocation exists and the request shows `fulfilled` — without
any procurement occurring.

**Acceptance Scenarios**:

1. **Given** a site session, **When** `POST /assets/requests` is called with `categoryId`, optional
   `assetId`, `quantity`, `projectId`, `siteId`, `requiredByDate`, and `justification`, **Then** the
   request is created with `status: 'pending'` and an auto-generated request number.
2. **Given** a pending request, **When** `PATCH /assets/requests/:id/approve` is called by a holder
   of `ASSETS_APPROVE`, **Then** status becomes `approved` and the request enters the fulfilment
   queue.
3. **Given** a pending request, **When** rejection is attempted without a `reason`, **Then**
   `400 Bad Request`.
4. **Given** an approved request, **When** `POST /assets/requests/:id/fulfil` is called with an
   `assetId` (or a quantity for bulk), **Then** an allocation is created for the request's project
   and site in the same transaction and the request becomes `fulfilled`.
5. **Given** an approved request fulfilled against an asset that is not `idle`, **When** fulfilment
   is attempted, **Then** `409 Conflict`.
6. **Given** an approved request with no idle asset of that category anywhere in the company,
   **When** `PATCH /assets/requests/:id/mark-procurement-needed` is called, **Then** the status
   becomes `procurement_pending` and the request appears in a procurement-needed report for the
   store team to act on through feature 009's purchase flow.
7. **Given** an approved request whose `requiredByDate` has passed unfulfilled, **When** the request
   list is read, **Then** it is flagged `overdue`.
8. **Given** a request list, **When** `GET /assets/requests?status=&projectId=&siteId=`, **Then**
   paginated, filtered results are returned with the requesting actor and age in days.

---

### User Story 5 - Transfer assets between sites with dispatch and receipt (Priority: P2)

An asset is moved from one project site to another through a two-step transfer: the source site
dispatches it, and the destination site acknowledges receipt. Between the two the asset is
`in_transit` and belongs to neither site's available pool.

**Why this priority**: Asset movement across projects is routine and the two-step acknowledgement is
what prevents assets going missing in transit. Depends on US3.

**Independent Test**: Dispatch an idle asset from site A to site B, confirm it is `in_transit` and
absent from both sites' available lists, then acknowledge receipt at site B and confirm it becomes
available there.

**Acceptance Scenarios**:

1. **Given** an idle asset at site A, **When** `POST /assets/:id/transfers` is called with
   `toSiteId`, `dispatchDate`, `transportMode`, and optional `vehicleNumber`, **Then** a transfer is
   created with `status: 'in_transit'` and the asset's status becomes `in_transit`.
2. **Given** an asset that is `allocated`, **When** a transfer is attempted, **Then** `409 Conflict`
   — the asset must be returned from its allocation first.
3. **Given** an in-transit transfer, **When** `PATCH /assets/transfers/:id/receive` is called at the
   destination with a `receivedDate` and `conditionOnReceipt`, **Then** the transfer closes, the
   asset's `currentSiteId` becomes the destination, and its status returns to `idle`.
4. **Given** an in-transit transfer, **When** receipt is attempted by a caller whose site is not the
   destination and who does not hold `ASSETS_APPROVE`, **Then** `403 Forbidden`.
5. **Given** an in-transit transfer received in a condition worse than its dispatch condition,
   **When** receipt is recorded, **Then** a `conditionDiscrepancy` flag is set on the transfer and
   the event is audit-logged.
6. **Given** an in-transit transfer whose dispatch date is older than a configurable threshold with
   no receipt, **When** the transfer list is read, **Then** it is flagged `transitOverdue`.
7. **Given** an in-transit transfer, **When** `PATCH /assets/transfers/:id/cancel` is called with a
   reason by a holder of `ASSETS_APPROVE`, **Then** the asset returns to the source site as `idle`.
8. **Given** a bulk asset transfer, **When** a partial quantity is received, **Then** the received
   quantity moves to the destination, the shortfall is recorded as a `transitShortage` on the
   transfer, and the transfer closes as `closed_with_shortage`.

---

### User Story 6 - Track condition, inspection, and repair (Priority: P2)

Assets in categories requiring inspection carry a next-inspection due date. Inspections record a
condition grade and either pass the asset or send it for repair; repairs record cost and downtime
and return the asset to service or condemn it.

**Why this priority**: Condition tracking is what makes the register trustworthy over time and it
feeds the inspection-due reminder family. Depends on US2.

**Independent Test**: Record an inspection for an asset in an inspection-required category, confirm
the next due date advances by the category's interval, then record a repair and confirm the asset
is `under_repair` until the repair closes.

**Acceptance Scenarios**:

1. **Given** an asset in an inspection-required category, **When** it is registered, **Then**
   `nextInspectionDue` is set to the capitalisation date plus the category's
   `inspectionIntervalDays`.
2. **Given** an asset due for inspection, **When** `POST /assets/:id/inspections` is called with an
   `inspectionDate`, `conditionGrade`, `outcome` (pass|repair_required|condemn), and `remarks`,
   **Then** the inspection is recorded and `nextInspectionDue` advances by the category interval
   from the inspection date.
3. **Given** an inspection with `outcome: 'repair_required'`, **When** it is recorded, **Then** the
   asset's status becomes `under_repair`.
4. **Given** an inspection with `outcome: 'condemn'`, **When** it is recorded by a holder of
   `ASSETS_APPROVE`, **Then** the asset's status becomes `scrapped`, its disposal date is set, and
   it leaves every available pool.
5. **Given** an asset `under_repair`, **When** `POST /assets/:id/repairs` is called with
   `repairDate`, `description`, `cost`, optional `vendorId`, and `expectedCompletionDate`, **Then**
   a repair record is created.
6. **Given** an open repair, **When** `PATCH /assets/repairs/:id/close` is called with an
   `actualCompletionDate` and resulting `conditionGrade`, **Then** the repair closes, downtime days
   are computed, and the asset returns to `idle`.
7. **Given** an asset with repair history, **When** the asset is read, **Then** `totalRepairCost` and
   `totalDowntimeDays` are returned.
8. **Given** an asset whose cumulative repair cost exceeds a configurable percentage of its purchase
   cost, **When** the asset is read, **Then** it is flagged `repairCostExceedsThreshold`.

---

### User Story 7 - Asset stock and summary views (Priority: P1)

A store manager views current asset stock — what is where, in what status, in whose custody — and a
summary rolling up counts and book values by category, by project, and by status.

**Why this priority**: The matrix names both "Stock" and "Summary". These are read surfaces over
records created by earlier stories but they are the module's primary daily view, so they are
delivered early.

**Independent Test**: With assets across two sites in mixed statuses, read the stock view filtered
by site and confirm counts match, then read the summary and confirm category totals reconcile with
the stock rows.

**Acceptance Scenarios**:

1. **Given** registered assets, **When** `GET /assets/stock?siteId=&categoryId=&status=`, **Then**
   serialised assets are listed individually with location, custodian, status, and condition, and
   bulk assets are aggregated per site with quantity on hand, allocated, and in transit.
2. **Given** the summary request, **When** `GET /assets/summary?groupBy=category|project|status`,
   **Then** counts, original cost, accumulated depreciation, and current book value are returned per
   group with a company total.
3. **Given** an asset past its useful life, **When** book value is computed, **Then** it is floored
   at the configured `salvageValue` and never goes negative.
4. **Given** a scrapped asset, **When** the summary is read, **Then** it is excluded from active
   counts and book value but included in a separate `scrapped` bucket.
5. **Given** a project, **When** `GET /assets/summary?groupBy=project&projectId=`, **Then** the
   assets currently allocated to that project's sites are rolled up with their book value, giving
   the matrix's "Project Assets" view.
6. **Given** the stock view, **When** `?format=xlsx` is requested, **Then** a real XLSX file is
   produced using the project's existing export library.
7. **Given** a caller from another company, **When** any stock or summary endpoint is called,
   **Then** no cross-company asset is visible, enforced by RLS.

---

### User Story 8 - Asset reminders (Priority: P2)

The system surfaces three families of asset due-dates as reminders: documents approaching or past
expiry, inspections coming due, and allocations past their expected return date.

**Why this priority**: The matrix names "Reminders" explicitly. It depends on documents (US2),
inspections (US6), and allocations (US3) all existing.

**Independent Test**: Register an asset with an insurance document expiring in 5 days and a category
alert window of 15 days, confirm the asset appears in the reminders list with the correct reminder
type and days-remaining — without any notification delivery being asserted.

**Acceptance Scenarios**:

1. **Given** an asset document within its doc type's `alertDays` of expiry or already expired,
   **When** `GET /assets/reminders`, **Then** a `document_expiry` reminder is returned with the
   asset, document type, expiry date, and days remaining (negative when overdue).
2. **Given** an asset whose `nextInspectionDue` falls within a configurable lead window, **When**
   reminders are read, **Then** an `inspection_due` reminder is returned.
3. **Given** an allocation past its `expectedReturnDate`, **When** reminders are read, **Then** an
   `overdue_return` reminder is returned with the custodian, project, and days overdue.
4. **Given** reminders exist, **When** `GET /assets/reminders?type=&siteId=&severity=`, **Then**
   results are filterable and sorted with overdue items first, then soonest-due.
5. **Given** any reminder becomes due, **When** it is first detected, **Then** an event is emitted
   for the existing notification mechanism to surface, using the same event-driven approach 006
   uses for fuel variance rather than a new delivery channel.
6. **Given** the same reminder condition persists across multiple evaluations, **When** events are
   emitted, **Then** the notification is not duplicated for an already-open reminder of the same
   type on the same asset.
7. **Given** a scrapped asset with an expired document, **When** reminders are read, **Then** it is
   excluded — reminders apply only to assets in active statuses.

---

### User Story 9 - Asset cost contribution to Project P&L (Priority: P3)

Feature 008's Project P&L calls into this module for the asset cost attributable to a project over a
date range, so asset depreciation and repair costs appear alongside material, machinery, labour, and
subcontractor costs.

**Why this priority**: A cross-module integration that mirrors the pattern 006, 007, and 009 already
follow. It depends on every cost-bearing record existing first.

**Independent Test**: With one asset allocated to a project for a full month, call the cost method
for that month and confirm the returned figure equals that asset's monthly depreciation plus any
repair cost closed in the range.

**Acceptance Scenarios**:

1. **Given** assets allocated to a project's sites in a date range, **When**
   `AssetsService.getAssetCostByProject(projectId, dateRange)` is called, **Then** it returns the
   sum of each allocated asset's depreciation for the days it was allocated to that project, plus
   repair costs for repairs closed in the range on those assets.
2. **Given** an asset allocated to a project for part of a month, **When** the cost is computed,
   **Then** depreciation is pro-rated by allocated days over days in the month.
3. **Given** an asset allocated to two projects in the same month, **When** costs are computed for
   both, **Then** the two pro-rated figures sum to at most that asset's full monthly depreciation —
   no double counting.
4. **Given** a project with no allocated assets in the range, **When** the cost is computed, **Then**
   zero is returned rather than an error.
5. **Given** the method is called, **When** it executes, **Then** it reads only through this
   feature's own service and returns a typed result, with no cross-schema query from feature 008.

---

### Edge Cases

- An asset is registered but never capitalised (capitalisation date in the future) → it is
  registered as `not_in_service`, excluded from allocation and from depreciation until its
  capitalisation date arrives.
- A bulk asset's quantity at a site is reduced below its currently allocated quantity → rejected;
  quantity adjustments must not create a negative available balance.
- An asset is scrapped while still allocated → rejected with `409`; it must be returned from its
  allocation first, so custody is always resolved before disposal.
- A custodian is transferred to another company under 005's employee-transfer flow while holding
  assets → the transfer proceeds but the outstanding-custody list flags the assets for recovery, and
  custody is cleared with an audit entry.
- Two sites acknowledge receipt of the same in-transit transfer concurrently → the receipt is
  applied under a row-level lock; the second request receives `409 Conflict`.
- An asset's category is changed after registration → allowed only between categories with the same
  `trackingMode`, and only by a holder of `ASSETS_APPROVE`, with the change audit-logged.
- Depreciation is requested for a date before the asset's capitalisation date → returns zero, never
  a negative accumulated depreciation.
- A repair's cost is recorded against a vendor that is later deactivated in feature 007 → the repair
  record keeps the vendor reference; reads resolve the name with an `inactive` marker.
- An asset document is uploaded with an expiry date in the past → accepted (historical records are
  legitimate) but immediately produces an expired-document reminder.
- The same physical item is mistakenly registered both here and in feature 006's equipment register
  → not detectable automatically; the boundary rule in the scope note is enforced by category
  configuration, and the duplicate-serial check (FR-008) catches it only within this module.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: All `assets` schema tables MUST carry `companyId` with RLS enforcing tenant isolation,
  following the constitution's multi-tenant isolation principle.
- **FR-002**: Asset Categories, Asset Document Types, and Condition Grades MUST live in the
  `settings` schema, not `assets` — matching how every other module's reference-data masters
  (Equipment Categories in 006, Item Categories in 009, Reimbursement Categories in 005) are
  Settings-owned in this project.
- **FR-003**: A category's `trackingMode` MUST be immutable once any asset exists under it,
  rejected with `409 Conflict`, because serialised and bulk assets have structurally different
  allocation and stock semantics.
- **FR-004**: A `serialised` asset MUST represent exactly one physical unit; the system MUST reject
  registration of a serialised asset with a quantity greater than 1.
- **FR-005**: A `bulk` asset's stock MUST be maintained as a per-site running balance updated
  in-transaction on every allocation, return, transfer, and adjustment, following the same
  running-balance approach 009 FR-002 uses for inventory stock rather than deriving it from
  movement history on read.
- **FR-006**: The system MUST auto-generate `assetCode` via Settings' existing code-series service,
  using the same mechanism that generates employee codes (002 FR-023) and requisition codes,
  rather than introducing a separate numbering scheme.
- **FR-007**: The system MUST enforce an explicit asset status machine — `not_in_service`, `idle`,
  `allocated`, `in_transit`, `under_repair`, `scrapped` — rejecting any transition outside it with
  `400 Bad Request` naming the permitted transitions.
- **FR-008**: A `serialNumber`, when supplied, MUST be unique per company; a duplicate MUST be
  rejected with `409 Conflict`.
- **FR-009**: A serialised asset MUST have at most one open allocation at a time; a second
  allocation attempt MUST be rejected with `409 Conflict` naming the existing allocation.
- **FR-010**: When a category sets `custodyRequired`, allocation MUST require a
  `custodianEmployeeId`, and the system MUST reject a custodian whose active site differs from the
  allocation's site so custody and physical location never disagree.
- **FR-011**: A bulk allocation or transfer MUST NOT reduce a site's available quantity below zero;
  the check MUST be enforced with the same transactional guarantee 009 FR-003 applies to issue and
  transfer quantities, not by an application-level read-then-write.
- **FR-012**: An asset transfer MUST be a two-step dispatch-then-receipt flow with an `in_transit`
  intermediate state in which the asset counts toward neither site's available pool; the
  destination's stock MUST change only on acknowledged receipt.
- **FR-013**: Transfer receipt MUST be applied under a row-level lock so concurrent receipts cannot
  both succeed; the losing request MUST receive `409 Conflict`.
- **FR-014**: A partially received bulk transfer MUST record the shortfall on the transfer as
  `transitShortage` and close as `closed_with_shortage`, never silently discarding the difference.
- **FR-015**: A return recorded with a condition grade configured as damaged or scrap MUST set the
  asset's status to `under_repair` or `scrapped` respectively rather than `idle`.
- **FR-016**: An asset MUST NOT be scrapped while it has an open allocation; the attempt MUST be
  rejected with `409 Conflict` directing the caller to record the return first.
- **FR-017**: `nextInspectionDue` MUST be set on registration for inspection-required categories and
  MUST advance by the category's `inspectionIntervalDays` from each recorded inspection date, not
  from the previous due date, so a late inspection does not compound the schedule.
- **FR-018**: Condemning an asset MUST require `ASSETS_APPROVE` and MUST set both the scrapped
  status and a disposal date, removing the asset from every available pool.
- **FR-019**: Current book value MUST be computed on demand as
  `purchaseCost − (monthlyDepreciation × months since capitalisation)` where
  `monthlyDepreciation = purchaseCost × depreciationRatePercent / 100 / 12`, floored at
  `salvageValue` and never negative, and MUST return zero depreciation for any date before the
  capitalisation date.
- **FR-020**: This feature MUST NOT post accounting journal entries; depreciation is a computed
  reporting figure only.
- **FR-021**: `AssetsService.getAssetCostByProject(projectId, dateRange)` MUST be exported for
  feature 008's Project P&L, returning pro-rated depreciation for the days each asset was allocated
  to that project plus repair costs closed in the range, and MUST be the only path by which 008
  reads asset data — no cross-schema query.
- **FR-022**: Pro-rated depreciation across concurrent or sequential allocations of the same asset
  in a period MUST never sum to more than that asset's full depreciation for the period.
- **FR-023**: An asset request MUST be fulfillable only against an asset whose status is `idle`;
  fulfilment MUST create the resulting allocation in the same transaction that marks the request
  fulfilled.
- **FR-024**: A request with no available asset MUST be markable `procurement_pending` and MUST
  appear in a procurement-needed report; this feature MUST NOT create purchase orders — procurement
  remains feature 009's purchase flow.
- **FR-025**: The system MUST expose reminders for three families — `document_expiry` (within the
  doc type's `alertDays` or past expiry), `inspection_due` (within the configured lead window), and
  `overdue_return` (allocation past `expectedReturnDate`) — computed on read rather than stored as
  a materialised list.
- **FR-026**: Reminder detection MUST emit an event for the existing notification mechanism using
  the same event-driven approach 006 uses for fuel variance, and MUST NOT emit a duplicate
  notification while a reminder of the same type on the same asset is already open.
- **FR-027**: Reminders MUST exclude assets in `scrapped` status.
- **FR-028**: All asset document uploads MUST use encrypted object-storage references, the same
  mechanism 006 FR-010 uses for equipment documents, and MUST refuse local-filesystem blob storage
  in production.
- **FR-029**: Site and project resolution MUST go through `ProjectsService.getSitesByProject()`, and
  vendor reads through `PartnersService.getVendorById()`, with no direct cross-schema query —
  matching 009 FR-011 and FR-012.
- **FR-030**: Employee and custodian reads MUST go through the HR module's exported service methods
  rather than a direct query against the `hr` schema.
- **FR-031**: Assets, allocations, transfers, and requests MUST NOT be hard-deleted; removal MUST be
  a soft-delete that preserves movement and custody history, matching 009 FR-004.
- **FR-032**: Every endpoint in this feature MUST be gated by `JwtAuthGuard` plus a
  `@RequirePermission()` check, using the new `ASSETS` and `ASSETS_APPROVE` permissions and the
  existing `REPORTS` permission for report endpoints.
- **FR-033**: The `Permission` enum MUST be extended with exactly two new values — `ASSETS` (register,
  allocate, transfer, inspect, request) and `ASSETS_APPROVE` (approve requests, condemn assets,
  cancel transfers, change categories, waive) — reusing existing values elsewhere.
- **FR-034**: All write operations MUST be written to the audit log with new entity types `ASSET`,
  `ASSET_ALLOCATION`, `ASSET_TRANSFER`, `ASSET_REQUEST`, `ASSET_INSPECTION`, and `ASSET_REPAIR`.
- **FR-035**: Every endpoint in this feature MUST accept and return validated, typed request/
  response DTOs per the constitution's validated-DTO-contracts principle.
- **FR-036**: The system MUST expose an outstanding-custody lookup for a given employee, so feature
  005's exit and F&F flow can surface assets to be recovered before settlement.
- **FR-037**: Stock and summary views MUST support XLSX export using the project's existing export
  library, generated asynchronously as a background job above the configured row threshold, matching
  004 FR-021.
- **FR-038**: An asset registered with a `purchaseId` MUST retain a resolvable link to the inventory
  purchase that acquired it, so acquisition cost is traceable to its bill.

### Key Entities

- **Asset**: A durable, individually identified or bulk-tracked item. Carries category,
  identification (asset code, serial, model, manufacturer), acquisition (purchase date, cost,
  vendor, linked purchase), capitalisation date, salvage value, current location, current
  custodian, status, condition, and next inspection due date.
- **AssetStock** *(bulk categories only)*: A per-asset, per-site running balance of quantity on
  hand, allocated, and in transit.
- **AssetAllocation**: An asset's assignment to a project site for a period, with optional
  custodian, expected and actual return dates, and condition on return.
- **AssetTransfer**: A two-step movement between sites: dispatch details, in-transit state, receipt
  details, condition discrepancy, and any transit shortage.
- **AssetRequest**: A site's request for an asset or quantity, with justification, required-by date,
  approval, and fulfilment linkage to the resulting allocation.
- **AssetInspection**: A dated condition assessment with grade, outcome, and remarks; drives the
  next inspection due date.
- **AssetRepair**: A repair episode with description, cost, vendor, expected and actual completion,
  and computed downtime.
- **AssetDocument**: An encrypted object-storage reference with a document type and optional expiry
  that drives expiry reminders.
- **AssetCategory / AssetDocType / ConditionGrade** *(settings schema)*: Reference masters
  configuring tracking mode, depreciation, useful life, custody and inspection policy, alert
  windows, and the condition vocabulary with its damaged/scrap semantics.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For any asset, its complete life history — registration, every allocation, custodian,
  transfer, inspection, and repair — is reconstructable in one read.
- **SC-002**: The sum of assets shown across all sites, plus in-transit, plus scrapped, always
  equals the total registered asset count, verified under concurrent transfer and allocation
  activity.
- **SC-003**: A bulk asset's available quantity at any site never goes negative, verified by a
  concurrency test issuing simultaneous allocations exceeding available stock.
- **SC-004**: Every asset physically at a project site is attributable to a named custodian or an
  explicit unassigned state — there is no asset whose location is unknown.
- **SC-005**: Project P&L asset cost recomputed from raw allocation and depreciation data matches
  the value returned by the exported service method exactly.
- **SC-006**: Every document expiry, inspection due date, and overdue return that meets its
  configured threshold appears in the reminders list, with no duplicate notification for an
  already-open reminder.
- **SC-007**: An employee's exit surfaces 100% of assets still in their custody before settlement is
  computed.
- **SC-008**: No asset's computed book value is ever negative or below its configured salvage value.

## Assumptions

- Barcode, QR, and RFID tagging of assets is out of scope; assets are identified by their generated
  asset code and optional manufacturer serial number. A future tagging feature would read these.
- Depreciation is straight-line only, matching feature 006's approach to owned-equipment
  depreciation. Written-down-value and other methods are out of scope.
- This feature does not produce statutory fixed-asset registers or integrate with any accounting
  system; the depreciation figures are for internal costing and P&L attribution.
- Asset insurance claims processing is out of scope; insurance is tracked only as a document with
  an expiry date.
- Physical stock verification / audit cycles are out of scope for this pass; the inspection surface
  covers condition assessment but not a periodic full-register physical count.
- The linkage to feature 009's purchase records depends on 009 being built; until then the
  `purchaseId` link is optional and inert, and assets are registered with their cost entered
  directly.
- The `ProjectsService.getSitesByProject()` and `PartnersService.getVendorById()` methods this
  feature depends on are already specified by features 008 and 007 respectively.
- Bulk asset units are assumed fungible within a site — this feature does not track which individual
  scaffolding pipe went where.
