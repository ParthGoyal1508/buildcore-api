# Research: Plant & Machinery Backend (Asset Register, Logbook, Fuel, Maintenance, Hire Bills)

## 1. Schema placement

**Decision**: All 7 entities in a single new `plant` schema: `EquipmentCategory`, `Equipment`,
`EquipmentDocument`, `LogbookEntry`, `FuelEntry`, `ServiceSchedule`, `MaintenanceJob`, `HireBill`.
`plant` is a named schema in the constitution's canonical module list.

## 2. Equipment status machine — auto-managed by maintenance jobs

**Decision**: `equipment.status` has three values: `active`, `under_maintenance`, `inactive`.
`under_maintenance` is set/unset only by maintenance job lifecycle events — never manually via
`PATCH /plant/equipment`. `inactive` is a manual admin action (decommissioning). This prevents
inconsistency between maintenance jobs and the displayed status.

## 3. Fuel variance: per-entry computation with event emission

**Decision**: On every `FuelEntry` creation, `variancePercent = ((fuelConsumed/totalHours −
benchmark) / benchmark) × 100` is computed server-side. If `variancePercent > 15`, a
`fuel_variance` event is emitted via `@nestjs/event-emitter`. The variance is stored on
`FuelEntry.variancePercent` for list display; the alert flag `varianceAlert` is also stored.
If `totalHours = 0` for the referenced logbook entry, variance is skipped (spec assumption).

**Rationale**: Per-entry computation matches the PRD requirement for immediate feedback. Storing
the computed value avoids recomputing on every list read (benchmark can be changed on the
category, which would retroactively change historical variances if not stored).

## 4. Service schedule status: computed on read

**Decision**: `ServiceSchedule.status` (ok|due_soon|overdue) is NOT stored. Computed on every
read by comparing `equipment.currentReading` against `nextDueReading`:
- `currentReading >= nextDueReading` → `overdue`
- `nextDueReading − currentReading ≤ 50` → `due_soon`
- Otherwise → `ok`

**Rationale**: `currentReading` changes with every logbook entry; storing status would require
updating all service schedules on every logbook write — an O(N) operation per entry. Computed-on-
read is the correct trade-off for a low-frequency admin read.

## 5. `getMachineryCostByProject` and `getFuelCostByProject` P&L methods

**Decision**:
- `getMachineryCostByProject(projectId, dateRange)`: calls `ProjectsService.getSitesByProject()`
  to get siteIds; for HIRED equipment deployed at those sites, sums verified `HireBill.netPayable`
  within the date range; for OWNED equipment deployed at those sites, sums
  `purchaseCost × depreciationRate / 100 / 12` per month per equipment.
- `getFuelCostByProject(projectId, dateRange)`: calls `ProjectsService.getSitesByProject()`;
  sums `FuelEntry.amount` for equipment deployed at those sites within the date range.

Both return 0 gracefully if `ProjectsService` is unavailable.

## 6. Utilisation % recomputation

**Decision**: `equipment.utilizationPercent` is recomputed and stored on every logbook entry
for the **current calendar month**. Query: `SUM(LogbookEntry.totalHours) WHERE equipmentId =
X AND date >= first of current month`. Divide by `category.targetHoursPerMonth`.

**Rationale**: Stored for O(1) list reads (equipment list shows utilisation %). Recomputed on
write (not read) since logbook entries are the only write path that changes it.

## 7. Permission enum — three new values

**Decision**: `PLANT_ASSETS`, `PLANT_OPERATIONS`, `PLANT_BILLING` added to Settings' enum.
Natural role split: Plant Manager needs all three; Site Engineer needs Operations only;
Accountant needs Billing only.

## 8. LogbookEntry uniqueness and hire bill verification

**Decision**: `UNIQUE(equipmentId, date)` on `LogbookEntry` enforced at the database level.
`HireBill.logbookHours` is fetched at hire-bill creation time from logbook entries within the
billing period — a snapshot, not a live join, so the hire bill can be verified independently
of future logbook edits.

## 9. EquipmentDocument expiry alerts

**Decision**: `expiryAlert` flag is NOT stored on the document. `GET /plant/equipment` computes
per-equipment `expiryAlert: boolean` by checking if any of the equipment's documents has
`expiresAt < today + 30 days`. Computed in the service layer, not a stored flag (document
expiry date can be updated after upload).
