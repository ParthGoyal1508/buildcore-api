# Data Model: Plant & Machinery Backend

All tables in the `plant` schema. See research.md for design decisions.

## EquipmentCategory (`plant` schema — new)

```
{ id, companyId, name (unique per company), meterType: 'hours' | 'km',
  fuelBenchmark (decimal?), targetHoursPerMonth (integer, default 176), createdAt }
```

## Equipment (`plant` schema — new)

```
{ id, companyId, code (auto-gen or manual), name, categoryId FK→EquipmentCategory,
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
{ id, equipmentId FK→Equipment,
  documentType: 'rc' | 'insurance' | 'puc' | 'fitness' | 'permit' | 'road_tax' | 'calibration',
  fileRef (encrypted object-storage reference), expiresAt?, uploadedByUserId, uploadedAt }
```

Derived (service-layer): `expiryAlert = expiresAt != null && expiresAt <= today + 30 days`.

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
  vendorId (UUID), billedHours (decimal), rate (decimal),
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
| P&L machinery cost | Not stored | `PlantService.getMachineryCostByProject()` on demand |
| P&L fuel cost | Not stored | `PlantService.getFuelCostByProject()` on demand |
