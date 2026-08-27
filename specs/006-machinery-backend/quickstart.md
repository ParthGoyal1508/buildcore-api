# Quickstart: Validating the Machinery Backend

## Prerequisites

- Seeded company (002), at least one Site (003), a Vendor of type `fuel` and one of another type
  (new minimal `partners.Vendor`, this feature), a Super Admin session.
- Local Postgres migrations applied (all `plant` schema tables, `partners.Vendor`, seeded
  `EquipmentCategory`/`EquipmentDocType` defaults).

## Scenario 1 — Equipment + documents (User Story 1)

1. `POST /machinery` with name/category/ownership/class/power source/site. **Expected**: 201, an
   auto-generated Code, Status `active`.
2. `POST /machinery/:id/documents` with a doc type that has `hasExpiryDate: true` but no
   `expiresAt`. **Expected**: rejected.
3. Retry with `expiresAt` 10 days out. **Expected**: 201, `status: 'expiring_soon'` once the
   expiry-scan job runs (or immediately if within its remind-days window on creation).
4. `GET /machinery?categoryId=&ownership=&status=&siteId=`. **Expected**: correctly filtered list,
   each row's `flagsCount` reflecting the expiring document.

## Scenario 2 — Logbook drives Current Reading (User Story 2)

1. `POST /machinery/logbook` for a machine with `openingReading` matching its current reading and
   a higher `closingReading`. **Expected**: 201; `GET /machinery/:id` now shows `currentReading`
   equal to the entry's `closingReading`.
2. `POST /machinery/logbook` again for the same machine. **Expected**: response/next-entry-default
   suggests `openingReading` equal to the prior entry's `closingReading`.
3. Submit a `closingReading` lower than `openingReading` without `isMeterResetOverride`.
   **Expected**: rejected. Retry with `isMeterResetOverride: true`. **Expected**: 201.
4. Submit with a non-existent `operatorId`. **Expected**: rejected.

## Scenario 3 — Fuel entries and variance alert (User Story 3)

1. `POST /machinery/fuel` with Quantity/Rate for a machine. **Expected**: 201, `amount` computed
   correctly, Vendor validated as `type: 'fuel'`.
2. Record enough fuel entries relative to that machine's recent Logbook hours to exceed the
   category's `fuelVarianceThresholdPercent`. Run (or wait for) the fuel-variance job. **Expected**:
   an alert appears in the Machinery Flags for that machine and would be visible via the Dashboard/
   Notifications provider registry (004).
3. `GET /machinery/fuel?dateRange=&machineId=`. **Expected**: `totals` block matches the filtered
   entries.

## Scenario 4 — Maintenance lifecycle (User Story 4)

1. `POST /machinery/maintenance/service-schedules` for a machine (e.g., "Engine Oil Change", 250
   hour interval).
2. `GET /machinery/maintenance/due-services`. **Expected**: shows Remaining units, turning red
   (flagged) once the machine's `currentReading` brings Remaining below 10% of the interval.
3. `POST /machinery/maintenance/jobs` linked to that schedule. **Expected**: 201; `GET
   /machinery/:id` shows Status `under_maintenance`.
4. `POST /machinery/maintenance/jobs/:id/close` with `totalCost`. **Expected**: Status reverts to
   `active`; the linked schedule's `lastDoneReading`/`lastDoneDate` update and Remaining resets.

## Scenario 5 — Hire bill verification (User Story 5)

1. Attempt `POST /machinery/hire-bills` against an `ownership: 'owned'` machine. **Expected**:
   rejected.
2. `POST /machinery/hire-bills` against a `hired` machine for a period with logbook entries whose
   summed hours differ from `billedHours`. **Expected**: 201, Status `pending_verification`, `rate`
   defaulted from the category's effective Hire Rate for the period.
3. `POST /machinery/hire-bills/:id/verify`. **Expected**: `varianceHours` computed; Status becomes
   `verified` only if the variance is within the category's `hireBillVarianceThresholdPercent`.
4. On a `verified` bill, `POST /machinery/hire-bills/:id/mark-paid`. **Expected**: `tdsAmount`/
   `netPayable` computed from the vendor's TDS fields; Status becomes `paid`.
5. Attempt `mark-paid` on a `pending_verification` bill. **Expected**: 409.

## Scenario 6 — Reference-data masters and effective-dated rates (User Story 6)

1. `GET /machinery/categories`. **Expected**: the 10 seeded PRD defaults are present.
2. `PATCH /machinery/categories/:id` changing `fuelBenchmark`. **Expected**: a subsequent Fuel
   entry (Scenario 3) uses the updated benchmark.
3. `POST /machinery/rates` for a category with an existing open-ended ("current") rate.
   **Expected**: 201; `GET /machinery/rates?categoryId=` shows the prior rate's `effectiveTo` now
   set to the day before the new rate's `effectiveFrom`.
4. Re-run Scenario 5 step 2 for a period predating the new rate. **Expected**: the bill still
   resolves to the rate that was effective during its own period, not the newer one.

## Scenario 7 — Cross-cutting checks

1. Attempt each endpoint group without its corresponding permission. **Expected**: 403 for each of
   the six permission areas independently.
2. Confirm every create/update/status-transition across this feature produced a corresponding
   `AuditLogEntry`.
3. Confirm all `plant`/`partners` table rows carry `companyId` and are inaccessible cross-tenant
   (RLS).
