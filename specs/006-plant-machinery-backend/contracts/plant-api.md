# Contract: `/plant/*` endpoints

All endpoints require `JwtAuthGuard` + `@RequirePermission()` — reusing Settings' existing
`MACHINERY`/`LOGBOOK`/`FUEL`/`SETTINGS` values verbatim, plus two genuinely new ones this feature
adds (`MAINTENANCE`, `HIRE_BILLS`) — per research.md §7 (corrected during reconciliation).

---

## Equipment Categories, Doc Types, Hire Rates — `settings` schema (research.md §1, §10)

Routes stay under `/plant/*` (matching the master PRD's own module grouping); each controller
action is a thin call into `SettingsService`'s exported methods — no direct query against the
`settings` schema tables (Principle I).

## Equipment Categories — `/plant/categories` (permission: `SETTINGS`, via `SettingsService`)

- `GET /plant/categories` — list with `equipmentCount`.
- `POST /plant/categories` — `{ name, meterType, fuelBenchmark?, fuelVarianceThresholdPercent?,
  targetHoursPerMonth? }` → 201.
- `PATCH /plant/categories/:id` — partial update.
- `DELETE /plant/categories/:id` — `409` if linked equipment.

## Equipment Doc Types — `/plant/doc-types` (permission: `SETTINGS`, via `SettingsService`)

- `GET /plant/doc-types` — list.
- `POST /plant/doc-types` — `{ name, alertDays }` → 201.
- `PATCH /plant/doc-types/:id` — partial update.

## Hire Rates — `/plant/rates` (permission: `SETTINGS`, via `SettingsService`)

- `GET /plant/rates?categoryId=` — effective-dated history.
- `POST /plant/rates` — `{ categoryId, ratePerUnit, effectiveFrom, effectiveTo? }`; closes the
  prior "current" rate's `effectiveTo` automatically (spec FR-014).

---

## Equipment — `/plant/equipment` (permission: `MACHINERY`)

- `GET /plant/equipment?categoryId=&siteId=&status=&ownership=&page=` — paginated list.
  Response includes `expiryAlert` (boolean) and `alertDocumentTypes` array per equipment.
- `POST /plant/equipment` — `{ code?, name, categoryId, ownership, vendorId?, powerSource,
  purchaseDate?, purchaseCost?, depreciationRate?, deployedSiteId? }` → 201.
- `GET /plant/equipment/:id` — full detail including documents and service schedules.
- `PATCH /plant/equipment/:id` — partial update. `status` cannot be set to `under_maintenance`
  manually (FR-002). Audit-logged.
- `POST /plant/equipment/:id/documents` — `multipart/form-data`: `docTypeId`, `file`,
  `expiresAt?` → 201.
- `DELETE /plant/equipment/:id/documents/:docId` — removes document.

---

## Logbook — `/plant/logbook` (permission: `LOGBOOK`)

- `GET /plant/logbook?equipmentId=&projectId=&dateFrom=&dateTo=&page=`
- `POST /plant/logbook` — `{ equipmentId, date, openingReading, closingReading, fuelConsumed?,
  operatorId?, projectId?, remarks? }`. `400` if `closing < opening`. `409` if entry exists
  for `(equipmentId, date)`. Updates `equipment.currentReading` and `utilizationPercent`.
  Audit-logged. → 201.
- `PATCH /plant/logbook/:id` — update remarks or fuelConsumed only (readings immutable once set).
- `DELETE /plant/logbook/:id` — reverses `currentReading` and `utilizationPercent` update.

---

## Fuel — `/plant/fuel` (permission: `FUEL`)

- `GET /plant/fuel?equipmentId=&dateFrom=&dateTo=&page=`
- `POST /plant/fuel` — `{ equipmentId, date, quantity, rate, vendorId? }`. Computes `amount`,
  `variancePercent` (against the equipment category's configured threshold), `varianceAlert`;
  emits `fuel_variance` event if alert. Audit-logged. → 201.
- `GET /plant/fuel/summary?month=YYYY-MM&companyId=` — per-equipment totals.

---

## Service Schedules — `/plant/services` (permission: `MAINTENANCE`)

- `GET /plant/services?equipmentId=&status=&page=` — computed `status` per schedule.
- `POST /plant/services` — `{ equipmentId, serviceType, intervalHours?, intervalKm?,
  lastDoneReading }` → 201.
- `PATCH /plant/services/:id` — update schedule fields.

---

## Maintenance — `/plant/maintenance` (permission: `MAINTENANCE`)

- `GET /plant/maintenance?equipmentId=&status=&page=`
- `POST /plant/maintenance` — `{ equipmentId, type, description, linkedServiceScheduleId? }`.
  Auto-sets `equipment.status → 'under_maintenance'`. `409` if equipment has open job. → 201.
- `PATCH /plant/maintenance/:id` — update `partsDescription`, `labourCost`, `totalCost`.
- `PATCH /plant/maintenance/:id/close` — `{ closedAt, closingReading }`. Auto-sets
  `equipment.status → 'active'`; updates linked service schedule if present.

---

## Hire Bills — `/plant/hire-bills` (permission: `HIRE_BILLS`)

- `GET /plant/hire-bills?equipmentId=&vendorId=&status=&page=`
- `POST /plant/hire-bills` — `{ equipmentId, vendorId, billedHours, rate?, billingPeriodFrom,
  billingPeriodTo }`. `rate` defaults from the effective `HireRate` for the equipment's category
  on `billingPeriodFrom` if omitted (spec FR-014). Fetches `logbookHours` from logbook entries in
  period; fetches `tdsRate` via `PartnersService.getVendorTds(vendorId)`; computes all financial
  fields. → 201.
- `PATCH /plant/hire-bills/:id/verify` — `pending_verification → verified`. Audit-logged.
- `PATCH /plant/hire-bills/:id/pay` — `{ paymentDate, paymentReference }`. `verified → paid`.

---

## Exported service methods (for ProjectsModule P&L)

```typescript
class PlantService {
  async getMachineryCostByProject(projectId: string, dateRange: { from: Date; to: Date }): Promise<number>
  // Hired: SUM(verified HireBill.netPayable for project's sites in range)
  // Owned: SUM(monthly depreciation for owned equipment at project's sites in range)

  async getFuelCostByProject(projectId: string, dateRange: { from: Date; to: Date }): Promise<number>
  // SUM(FuelEntry.amount for project's site-deployed equipment in range)
}
```

---

## Audit logging (updated set)

Extends `shared.AuditLogEntry.entityType` with: `EQUIPMENT`, `EQUIPMENT_DOCUMENT`,
`LOGBOOK_ENTRY`, `FUEL_ENTRY`, `MAINTENANCE_JOB`, `SERVICE_SCHEDULE`, `HIRE_BILL`,
`EQUIPMENT_CATEGORY`, `EQUIPMENT_DOC_TYPE`, `HIRE_RATE`.
