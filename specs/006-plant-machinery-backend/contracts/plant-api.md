# Contract: `/plant/*` endpoints

All endpoints require `JwtAuthGuard` + `@RequirePermission()` using one of three new values:
`PLANT_ASSETS`, `PLANT_OPERATIONS`, `PLANT_BILLING`.

---

## Equipment Categories — `/plant/categories` (permission: `PLANT_ASSETS`)

- `GET /plant/categories` — list with `equipmentCount`.
- `POST /plant/categories` — `{ name, meterType, fuelBenchmark?, targetHoursPerMonth? }` → 201.
- `PATCH /plant/categories/:id` — partial update.
- `DELETE /plant/categories/:id` — `409` if linked equipment.

---

## Equipment — `/plant/equipment` (permission: `PLANT_ASSETS`)

- `GET /plant/equipment?categoryId=&siteId=&status=&ownership=&page=` — paginated list.
  Response includes `expiryAlert` (boolean) and `alertDocumentTypes` array per equipment.
- `POST /plant/equipment` — `{ code?, name, categoryId, ownership, vendorId?, powerSource,
  purchaseDate?, purchaseCost?, depreciationRate?, deployedSiteId? }` → 201.
- `GET /plant/equipment/:id` — full detail including documents and service schedules.
- `PATCH /plant/equipment/:id` — partial update. `status` cannot be set to `under_maintenance`
  manually (FR-002). Audit-logged.
- `POST /plant/equipment/:id/documents` — `multipart/form-data`: `documentType`, `file`,
  `expiresAt?` → 201.
- `DELETE /plant/equipment/:id/documents/:docId` — removes document.

---

## Logbook — `/plant/logbook` (permission: `PLANT_OPERATIONS`)

- `GET /plant/logbook?equipmentId=&projectId=&dateFrom=&dateTo=&page=`
- `POST /plant/logbook` — `{ equipmentId, date, openingReading, closingReading, fuelConsumed?,
  operatorId?, projectId?, remarks? }`. `400` if `closing < opening`. `409` if entry exists
  for `(equipmentId, date)`. Updates `equipment.currentReading` and `utilizationPercent`.
  Audit-logged. → 201.
- `PATCH /plant/logbook/:id` — update remarks or fuelConsumed only (readings immutable once set).
- `DELETE /plant/logbook/:id` — reverses `currentReading` and `utilizationPercent` update.

---

## Fuel — `/plant/fuel` (permission: `PLANT_OPERATIONS`)

- `GET /plant/fuel?equipmentId=&dateFrom=&dateTo=&page=`
- `POST /plant/fuel` — `{ equipmentId, date, quantity, rate, vendorId? }`. Computes `amount`,
  `variancePercent`, `varianceAlert`; emits `fuel_variance` event if alert. Audit-logged. → 201.
- `GET /plant/fuel/summary?month=YYYY-MM&companyId=` — per-equipment totals.

---

## Service Schedules — `/plant/services` (permission: `PLANT_ASSETS`)

- `GET /plant/services?equipmentId=&status=&page=` — computed `status` per schedule.
- `POST /plant/services` — `{ equipmentId, serviceType, intervalHours?, intervalKm?,
  lastDoneReading }` → 201.
- `PATCH /plant/services/:id` — update schedule fields.

---

## Maintenance — `/plant/maintenance` (permission: `PLANT_OPERATIONS`)

- `GET /plant/maintenance?equipmentId=&status=&page=`
- `POST /plant/maintenance` — `{ equipmentId, type, description, linkedServiceScheduleId? }`.
  Auto-sets `equipment.status → 'under_maintenance'`. `409` if equipment has open job. → 201.
- `PATCH /plant/maintenance/:id` — update `partsDescription`, `labourCost`, `totalCost`.
- `PATCH /plant/maintenance/:id/close` — `{ closedAt, closingReading }`. Auto-sets
  `equipment.status → 'active'`; updates linked service schedule if present.

---

## Hire Bills — `/plant/hire-bills` (permission: `PLANT_BILLING`)

- `GET /plant/hire-bills?equipmentId=&vendorId=&status=&page=`
- `POST /plant/hire-bills` — `{ equipmentId, vendorId, billedHours, rate, billingPeriodFrom,
  billingPeriodTo }`. Fetches `logbookHours` from logbook entries in period; fetches `tdsRate`
  via `PartnersService.getVendorTds(vendorId)`; computes all financial fields. → 201.
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

## Audit logging

Extends `shared.AuditLogEntry.entityType` with: `EQUIPMENT`, `EQUIPMENT_DOCUMENT`,
`LOGBOOK_ENTRY`, `FUEL_ENTRY`, `MAINTENANCE_JOB`, `SERVICE_SCHEDULE`, `HIRE_BILL`.
