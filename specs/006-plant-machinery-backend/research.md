# Research: Plant & Machinery Backend (Asset Register, Logbook, Fuel, Maintenance, Hire Bills)

## 1. Schema placement

**Decision** (corrected during reconciliation, §10): Operational entities land in `plant`:
`Equipment`, `EquipmentDocument`, `LogbookEntry`, `FuelEntry`, `ServiceSchedule`, `MaintenanceJob`,
`HireBill`. Reference-data masters — `EquipmentCategory`, `EquipmentDocType` (new), `HireRate`
(new) — land in `settings` instead, matching master PRD §7.8.5's explicit placement of "Machinery
Masters" as a Settings subsection and this project's own established convention (Employee Setup
masters, Reimbursement Categories are all Settings-owned). `plant` remains a named schema in the
constitution's canonical module list and is correct for the seven operational entities.

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

## 7. Permission enum — reuse what already exists, add only what's missing

**Decision** (corrected during reconciliation, §10): Settings' `Permission` enum already contains
`MACHINERY`, `LOGBOOK`, and `FUEL` — built "covering every PRD module by name" from feature 002's
own original design. This feature reuses those three verbatim: `MACHINERY` guards equipment +
documents (asset register); `LOGBOOK` guards logbook entries; `FUEL` guards fuel entries;
`SETTINGS` (also already existing) guards the three reference-data masters. Only `MAINTENANCE`
(maintenance jobs + service schedules) and `HIRE_BILLS` are genuinely new values.

**Rationale**: The original decision below invented three new values where three of the five
needed already existed under different names — a naming collision waiting to happen and pure
duplication of intent. Reusing costs nothing and keeps one permission meaning one thing.

~~**Original (superseded) decision**: `PLANT_ASSETS`, `PLANT_OPERATIONS`, `PLANT_BILLING` added to
Settings' enum. Natural role split: Plant Manager needs all three; Site Engineer needs Operations
only; Accountant needs Billing only.~~

## 8. LogbookEntry uniqueness and hire bill verification

**Decision**: `UNIQUE(equipmentId, date)` on `LogbookEntry` enforced at the database level.
`HireBill.logbookHours` is fetched at hire-bill creation time from logbook entries within the
billing period — a snapshot, not a live join, so the hire bill can be verified independently
of future logbook edits.

## 9. EquipmentDocument expiry alerts

**Decision**: `expiryAlert` flag is NOT stored on the document. `GET /plant/equipment` computes
per-equipment `expiryAlert: boolean` by checking if any of the equipment's documents has
`expiresAt` within its doc type's configured Alert Days (§10 — no longer a hardcoded 30-day
literal). Computed in the service layer, not a stored flag (document expiry date can be updated
after upload).

## 10. Reconciliation with a parallel, independently-specced version of this feature

**Context**: This feature was built twice, concurrently and independently, by two different spec
workflows — this one, driven directly from master PRD §7.4, and a second one
(`006-machinery-backend`, since retired) driven from the standalone module PRD
`04-machinery.prd.md`. Both were discovered during a master-PRD alignment audit before either was
implemented. Rather than pick one wholesale, the two were reconciled: this spec's utilisation
formula, event-driven fuel-variance emission, auto-managed equipment status, and P&L service
methods were kept as-is (more precisely master-PRD-aligned and further along — the P&L methods in
particular resolve a real dependency feature 008 is waiting on); the retired spec's two
corrections were merged in:

1. **Reference-data masters relocated to `settings`** (§1) — this spec had originally put
   `EquipmentCategory` in `plant` alongside operational data, and had no `EquipmentDocType` or
   `HireRate` masters at all (document type was a hardcoded enum; hire bill rate was a manual
   per-bill entry with no effective-dated history). Both gaps are fixed by the merge: doc type
   becomes a real master (`docTypeId` FK replacing the enum), and Hire Rates becomes a proper
   effective-dated master a hire bill's rate defaults from — matching master PRD §7.8.5's complete
   three-master list, not just one of the three.
2. **Permission values corrected to reuse 002's existing enum** (§7) — this spec had invented
   three new values (`PLANT_ASSETS`/`PLANT_OPERATIONS`/`PLANT_BILLING`) that either duplicated or
   renamed values 002 already had reserved by name (`MACHINERY`/`LOGBOOK`/`FUEL`).

**Rationale**: Neither version was strictly better — one had the higher-value architectural work
(P&L integration, correct utilisation formula), the other had caught two real constitution/
master-PRD-alignment gaps the first had missed. Merging captured both without re-deriving either
from scratch.

**Retired**: `006-machinery-backend` (both `buildcore-api` and its `buildcore-web` counterpart,
`006-machinery`) are no longer the source of truth for this module — superseded by this feature
(and its `buildcore-web` counterpart, `006-plant-machinery`) as of this reconciliation.
