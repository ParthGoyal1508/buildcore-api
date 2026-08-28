# Data Model: Plant & Machinery Backend

Operational tables in `plant`; reference-data masters in `settings` (research.md §1, §10 —
corrected during reconciliation with a parallel spec). See research.md for design decisions.

## EquipmentCategory (`settings` schema — new)

```
{ id, companyId, name (unique per company), meterType: 'hours' | 'km',
  fuelBenchmark (decimal?), fuelVarianceThresholdPercent (decimal, default 15),
  targetHoursPerMonth (integer, default 176), active (boolean, default true), createdAt }
```

CRUD lives in `SettingsService` (`createEquipmentCategory()` etc.); this module's own controller
calls those exported methods rather than querying this table directly (Principle I).

## EquipmentDocType (`settings` schema — new)

```
{ id, companyId, name, alertDays (integer), active (boolean, default true), createdAt }
```

Same `SettingsService`-exported-methods pattern as EquipmentCategory.

## HireRate (`settings` schema — new)

```
{ id, companyId, categoryId FK→EquipmentCategory, ratePerUnit (decimal),
  effectiveFrom (date), effectiveTo (date?, null = current), createdAt }
```

Non-overlapping per category — creating a new "current" rate sets the prior current rate's
`effectiveTo` to the day before the new rate's `effectiveFrom` (spec FR-014). Same
`SettingsService`-exported-methods pattern; this module's Hire Bills rate-resolution logic calls
`SettingsService.getEffectiveHireRate()` rather than querying this table directly.

## Equipment (`plant` schema — new)

```
{ id, companyId, code (auto-gen or manual), name, categoryId FK→settings.EquipmentCategory,
  ownership: 'owned' | 'hired', vendorId? (UUID, cross-schema),
  powerSource: 'diesel' | 'electric' | 'manual' | 'petrol',
  purchaseDate?, purchaseCost (decimal?), depreciationRate (decimal?, % per annum),
  meterType (string, mirrors category), currentReading (decimal, default 0),
  deployedSiteId? (UUID, cross-schema → projects.Site),
  status: 'active' | 'under_maintenance' | 'inactive',
  utilizationPercent (decimal, default 0 — stored, recomputed on logbook write),
  createdAt, updatedAt }
```

UNIQUE: `(companyId, code)` where code is non-null.

## EquipmentDocument (`plant` schema — new)

```
{ id, equipmentId FK→Equipment, docTypeId FK→settings.EquipmentDocType,
  fileRef (encrypted object-storage reference), expiresAt?, uploadedByUserId, uploadedAt }
```

Derived (service-layer): `expiryAlert = expiresAt != null && expiresAt <= today +
docType.alertDays` — reads the referenced doc type's `alertDays` via
`SettingsService.getEquipmentDocType()`, never a hardcoded literal.

## LogbookEntry (`plant` schema — new)

```
{ id, companyId, equipmentId FK→Equipment, date (date),
  openingReading (decimal), closingReading (decimal),
  totalHours (decimal — stored: closingReading − openingReading),
  fuelConsumed (decimal?), operatorId? (UUID, cross-schema → hr.Employee),
  projectId? (UUID, cross-schema → projects.Project), remarks?,
  createdAt }
```

UNIQUE: `(equipmentId, date)` — one entry per equipment per day.

## FuelEntry (`plant` schema — new)

```
{ id, companyId, equipmentId FK→Equipment, date, quantity (decimal), rate (decimal),
  amount (decimal — stored: quantity × rate), vendorId? (UUID),
  variancePercent (decimal? — computed and stored on save),
  varianceAlert (boolean — variancePercent > 15), createdAt }
```

## ServiceSchedule (`plant` schema — new)

```
{ id, companyId, equipmentId FK→Equipment, serviceType (string),
  intervalHours (decimal?), intervalKm (decimal?),
  lastDoneReading (decimal), nextDueReading (decimal — lastDone + interval),
  createdAt, updatedAt }
```

Derived on read: `status: 'ok' | 'due_soon' | 'overdue'` from `equipment.currentReading`.

## MaintenanceJob (`plant` schema — new)

```
{ id, companyId, equipmentId FK→Equipment, type: 'breakdown' | 'scheduled',
  description (text), openedAt, closedAt?,
  closingReading (decimal?), partsDescription (text?),
  labourCost (decimal?), totalCost (decimal?),
  linkedServiceScheduleId? FK→ServiceSchedule,
  status: 'open' | 'closed', createdAt }
```

Constraint: at most one `status: 'open'` job per equipment (enforced in service layer).

## HireBill (`plant` schema — new)

```
{ id, companyId, equipmentId FK→Equipment (hired only),
  vendorId (UUID), billedHours (decimal),
  rate (decimal — defaults from settings.HireRate effective for the equipment's category on
  billingPeriodFrom via SettingsService.getEffectiveHireRate(), overridable),
  grossAmount (decimal — billedHours × rate, stored),
  billingPeriodFrom (date), billingPeriodTo (date),
  logbookHours (decimal — fetched at creation, stored snapshot),
  variance (decimal — billedHours − logbookHours, stored),
  tdsRate (decimal?), tdsAmount (decimal — stored),
  netPayable (decimal — grossAmount − tdsAmount, stored),
  status: 'pending_verification' | 'verified' | 'paid',
  verifiedByUserId?, verifiedAt?,
  paymentDate?, paymentReference?,
  createdAt }
```

## Cross-module references

| Reference | Stored as | Resolved via |
|---|---|---|
| `Equipment.vendorId` | Plain UUID | `PartnersService.getVendorById()` for name; `getVendorTds()` for hire bill TDS |
| `Equipment.deployedSiteId` | Plain UUID | `ProjectsService.getSiteById()` for site name |
| `LogbookEntry.operatorId` | Plain UUID | `HrService.getEmployeeById()` for name display |
| `Equipment.categoryId`, `EquipmentDocument.docTypeId`, `HireBill.rate` | FK/lookup into `settings` | `SettingsService.getEquipmentCategory()` / `.getEquipmentDocType()` / `.getEffectiveHireRate()` — never a direct cross-schema query (research.md §1, §10) |
| P&L machinery cost | Not stored | `PlantService.getMachineryCostByProject()` on demand |
| P&L fuel cost | Not stored | `PlantService.getFuelCostByProject()` on demand |
