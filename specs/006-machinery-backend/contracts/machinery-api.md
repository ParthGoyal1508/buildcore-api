# Contract: `/machinery/*` endpoints

All endpoints require `JwtAuthGuard` plus the matching `Permission` (extending 002's enum,
research.md §6): `ASSET_REGISTER`, `LOGBOOK`, `FUEL`, `MAINTENANCE`, `HIRE_BILLS`, or
`MACHINERY_SETTINGS`. Every create/update/status-transition writes to the shared audit log
(research.md §11).

## Asset Register — `/machinery` (permission: `ASSET_REGISTER`)

- `GET /machinery?search=&categoryId=&ownership=&status=&siteId=&page=` — paginated list, includes
  `flagsCount` (research.md-derived) and cached `utilizationPercent` (research.md §10).
- `POST /machinery` / `PATCH /machinery/:id` — create/update (FR-001, FR-002).
- `GET /machinery/:id` — detail, including documents summary and open maintenance jobs.
- `POST /machinery/:id/documents` — `{ docTypeId, file, documentNumber?, expiresAt? }` (FR-005).
- `GET /machinery/:id/documents` — list with derived status (FR-006).

## Logbook — `/machinery/logbook` (permission: `LOGBOOK`)

- `GET /machinery/logbook?equipmentId=&siteId=&dateRange=` — list.
- `POST /machinery/logbook` — `{ equipmentId, date, siteId, operatorId, openingReading,
  closingReading, fuelConsumedLiters?, remarks?, isMeterResetOverride? }`; `openingReading` is
  server-suggested (FR-009) but client-submitted, validated against the prior closing reading
  unless `isMeterResetOverride` is set (FR-012).
- `PATCH /machinery/logbook/:id` / `DELETE /machinery/logbook/:id`.

## Fuel — `/machinery/fuel` (permission: `FUEL`)

- `GET /machinery/fuel?equipmentId=&siteId=&dateRange=` — list with `totals: { totalLiters,
  totalCost, averageConsumption }` (FR-015).
- `POST /machinery/fuel` / `PATCH /machinery/fuel/:id` / `DELETE /machinery/fuel/:id` (FR-013,
  FR-014).

## Maintenance — `/machinery/maintenance` (permission: `MAINTENANCE`)

- `GET /machinery/maintenance/due-services?equipmentId=` — Remaining-units view (FR-018).
- `GET/POST /machinery/maintenance/service-schedules` — CRUD (FR-017).
- `GET /machinery/maintenance/jobs?status=&equipmentId=` — list.
- `POST /machinery/maintenance/jobs` — opens a job, sets Equipment status to `under_maintenance`
  (FR-019).
- `POST /machinery/maintenance/jobs/:id/close` — `{ totalCost }`; resets Equipment status to
  `active`, updates the linked schedule if any (FR-020, FR-021).

## Hire Bills — `/machinery/hire-bills` (permission: `HIRE_BILLS`)

- `GET /machinery/hire-bills?vendorId=&equipmentId=&status=` — list.
- `POST /machinery/hire-bills` — `{ vendorId, equipmentId, periodFrom, periodTo, billedHours,
  partyBillNumber? }`; rejects if `equipmentId`'s `ownership !== 'hired'` (FR-023); `rate` defaults
  from the effective `HireRate` for the bill's period start (FR-024).
- `POST /machinery/hire-bills/:id/verify` — sums logbook hours for the period, computes variance,
  transitions to `verified` if within the category's `hireBillVarianceThresholdPercent` (FR-025).
- `POST /machinery/hire-bills/:id/mark-paid` — computes TDS/net payable from the vendor record,
  transitions to `paid` (FR-026); `409` if not currently `verified`.

## Equipment Categories — `/machinery/categories` (permission: `MACHINERY_SETTINGS`)

- `GET/POST /machinery/categories`, `PATCH /machinery/categories/:id` — Name, Class, Meter Type,
  Fuel Benchmark, `fuelVarianceThresholdPercent`, `hireBillVarianceThresholdPercent`, Sort Order,
  Active (FR-027).

## Equipment Doc Types — `/machinery/doc-types` (permission: `MACHINERY_SETTINGS`)

- `GET/POST /machinery/doc-types`, `PATCH /machinery/doc-types/:id` — Code, Name, Default Remind
  Days, Sort Order, Has Expiry Date, Needs Document Number, Active (FR-028).

## Hire Rates — `/machinery/rates` (permission: `MACHINERY_SETTINGS`)

- `GET /machinery/rates?categoryId=` — effective-dated history.
- `POST /machinery/rates` — `{ categoryId, ratePerUnit, effectiveFrom, effectiveTo? }`; closes the
  prior "current" rate's `effectiveTo` automatically (FR-029).

## Internal — background jobs (no HTTP surface)

- Daily document-expiry scan (BullMQ repeatable job, research.md §4) — recomputes
  `EquipmentDocument.status`, raises Dashboard/Notification entries for newly Expiring/Expired
  documents (FR-006, FR-007), and refreshes cached `utilizationPercent` (research.md §10).
- Fuel-variance detection job (BullMQ repeatable job) — compares recent consumption to benchmark,
  raises alerts exceeding the category threshold (FR-016).

## Dashboard/Notification provider registrations (extends 004, no new HTTP surface)

- Widget providers: Machinery Cost, Fuel Cost, Hire Bills (feed Dashboard Quick Stats Sidebar and
  Group Dashboard company cards).
- Notification providers: Document Expiry, Fuel Variance, Maintenance Due (FR-034,
  research.md §7).
