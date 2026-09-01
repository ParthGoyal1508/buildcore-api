# Implementation Plan: Plant & Machinery Backend

**Branch**: `006-plant-machinery-backend` | **Date**: 2026-08-28 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/006-plant-machinery-backend/spec.md`

## Summary

Build the `plant` schema — full Asset Register (with document expiry alerting), daily Logbook with
utilisation recomputation, Fuel tracking with per-entry variance alerts via `@nestjs/event-emitter`,
Service Schedules (status computed on read), Maintenance Jobs (auto-manages equipment status), and
Hire Bills (logbook-verified, TDS-deducted). Exports two cross-module P&L methods resolving 008's
machinery and fuel stubs.

**Reconciled during a master-PRD alignment pass** (research.md §10) with a second, independently
-specced version of this same feature: Equipment Categories, Equipment Doc Types (new), and Hire
Rates (new) are `settings`-schema masters, not `plant`-owned — matching master PRD §7.8.5 — and
permission checks reuse Settings' existing `MACHINERY`/`LOGBOOK`/`FUEL`/`SETTINGS` enum values,
adding only `MAINTENANCE`/`HIRE_BILLS` as genuinely new. See [research.md](research.md) for all 10
decisions.

## Technical Context

**Language/Version**: TypeScript 5.1, Node.js, NestJS 10, Prisma 5 — unchanged.
**Primary Dependencies**: Existing only — plus `@nestjs/event-emitter` (already wired by 007).
**Storage**: `plant` schema (7 operational tables); `settings` schema gains 3 new reference-data
tables (EquipmentCategory, EquipmentDocType, HireRate — research.md §1, §10).
**Testing**: Jest unit tests for `utilisation%` computation, fuel variance formula, service
schedule status derivation, effective-dated Hire Rate resolution (non-overlap invariant),
`getMachineryCostByProject()` / `getFuelCostByProject()`.
E2e in `test/plant.e2e-spec.ts` for equipment lifecycle, maintenance job auto-status, hire bill.

## Constitution Check

| Principle | Check | Status |
|---|---|---|
| I. Schema Boundaries | 7 operational tables in `plant`; 3 reference-data masters in `settings` (corrected, research.md §1). Cross-module reads/writes via exported services only — including this module's own masters, called via `SettingsService`. | PASS |
| II. Validated DTOs | Every endpoint uses typed DTOs. | PASS |
| III. No Hardcoded Values | Fuel benchmark and variance threshold per category (config, not a hardcoded `> 15` literal — corrected); document alert window per doc type (config, not a hardcoded 30-day literal — corrected). | PASS |
| IV. Multi-Tenant Isolation | All 10 tables (7 `plant` + 3 `settings`) carry `companyId`; RLS on all. | PASS |
| V. Auth & Permissions | Reuses 002's existing `MACHINERY`/`LOGBOOK`/`FUEL`/`SETTINGS` values; adds only `MAINTENANCE`/`HIRE_BILLS` (corrected, research.md §7). | PASS |
| VI. Safe Migrations | `plant` schema and the 3 `settings` additions ship as separate, logically-grouped migrations. | PASS |

## Implementation Phases

### Phase 1: Setup

- [ ] Extend `settings.Permission` enum: `MAINTENANCE`, `HIRE_BILLS` only — reuse the
      already-existing `MACHINERY`, `LOGBOOK`, `FUEL`, `SETTINGS` values verbatim (corrected,
      research.md §7)
- [ ] Add the 7 operational `plant` schema models and the 3 `settings` reference-data models
      (EquipmentCategory, EquipmentDocType, HireRate) to `prisma/schema.prisma` (data-model.md,
      corrected placement per research.md §1)
- [ ] Generate and apply migration(s); add RLS policies for all 10 tables
- [ ] Seed EquipmentCategory (10 named defaults) and EquipmentDocType (common defaults) via
      migration — HireRate is not pre-seeded (company/market-specific)
- [ ] Extend `shared.AuditLogEntry.entityType` with 10 plant/settings entity types
- [ ] Scaffold `PlantModule`; immediately export `PlantService` with stubs for
      `getMachineryCostByProject()` and `getFuelCostByProject()` returning 0
- [ ] Scaffold `src/settings/machinery-masters/` with `EquipmentCategoriesService`,
      `EquipmentDocTypesService`, `HireRatesService` (`settings` schema, exported for `PlantModule`
      to call — Principle I)

### Phase 2: US1 & US2 — Reference Data Masters & Asset Register (P1)

- [ ] `EquipmentCategoriesController`, `EquipmentDocTypesController`, `HireRatesController` in
      `src/machinery/` — thin proxies calling the `settings/machinery-masters/` services above,
      guarded with `SETTINGS` (corrected, research.md §1, §7)
- [ ] `EquipmentService` + `EquipmentController` (CRUD, document upload against `docTypeId`,
      expiry alert computed on list from the doc type's `alertDays`, manual status guard —
      FR-002), guarded with `MACHINERY` (corrected, research.md §7)
- [ ] Unit test: expiry alert flag logic (per-doc-type configurable alert window, corrected)
- [ ] E2e test: create equipment, upload expiring document, list shows `expiryAlert: true`

### Phase 3: US3 — Logbook (P1)

- [ ] `LogbookService` + `LogbookController` (UNIQUE `(equipmentId, date)` guard → 409,
      `closing < opening` → 400, `currentReading` update, `utilizationPercent` recomputation)
- [ ] Unit test: utilisation % formula; zero-hours day
- [ ] E2e test: duplicate date → 409; currentReading updates correctly

### Phase 4: US4 — Fuel (P2)

- [ ] `FuelService` + `FuelController` (per-entry variance computation, event emission on
      `varianceAlert = true`, monthly summary endpoint)
- [ ] Unit test: variance formula; zero-hours guard; 15% threshold
- [ ] E2e test: fuel entry with variance > 15% → `varianceAlert: true`

### Phase 5: US5 & US6 — Maintenance & Service Schedules (P2)

- [ ] `ServiceScheduleService` + `ServiceScheduleController` (status computed on read —
      FR-006; `nextDueReading` computed on write), guarded with `MAINTENANCE` (corrected)
- [ ] `MaintenanceService` + `MaintenanceController` (equipment status auto-management —
      FR-002; open-job uniqueness guard; service schedule update on close), guarded with
      `MAINTENANCE`
- [ ] Unit test: schedule status (ok/due_soon/overdue) logic
- [ ] E2e test: open job → Under Maintenance; close → Active; linked schedule updated

### Phase 6: US7 — Hire Bills (P3)

- [ ] Implement `HireRatesService.getEffectiveHireRate(categoryId, date)` in
      `src/settings/machinery-masters/hire-rates.service.ts` (if not already covered by Phase 1's
      scaffold) — effective-dated resolution used by hire bill rate defaulting (FR-014)
- [ ] `HireBillService` + `HireBillController` (logbook hour snapshot, rate defaulted from
      `HireRatesService.getEffectiveHireRate()` when omitted, TDS via
      `PartnersService.getVendorTds()`, computed financials, state transitions), guarded with
      `HIRE_BILLS` (corrected)
- [ ] Unit test: TDS deduction; netPayable formula; effective-dated rate resolution (non-overlap
      invariant)
- [ ] E2e test: full hire bill lifecycle (create with defaulted rate → verify → pay); a historical
      bill still resolves its own period's rate after a newer rate is added

### Phase 7: US8 — P&L Service Methods (P3)

- [ ] Replace stubs: `getMachineryCostByProject()` — hired (HireBill sum) + owned (depreciation
      sum) via `ProjectsService.getSitesByProject()`
- [ ] Replace stub: `getFuelCostByProject()` — FuelEntry sum for project's sites
- [ ] Unit test: both methods with mixed hired/owned equipment; graceful 0 on ProjectsService failure

### Phase 8: Polish

- [ ] Swagger `@ApiTags('Plant')` + `@ApiOperation` on all controllers
- [ ] `npm run lint` + `npm run build` clean

---

## Amendment 2026-09-01 — Spare Parts Inventory & Service Bills

Covers spec FR-015 to FR-028. Adds 3 `plant` tables; **no new permission value** (reuses the
`MAINTENANCE` value this feature already introduces).

**Corrects an existing defect**: `getMachineryCostByProject()` (FR-008) counted only depreciation
and hire bills, systematically understating machinery cost by every repair and spare part. FR-025
extends it.

**Constitution re-check**: Principle I — all 3 tables in `plant`; the declared inventory-item link
(FR-024) is a reference plus a reconciliation view, never a cross-schema write. Principle III —
reorder levels per part. Principle IV — `companyId` + RLS on all 3. Principle V — reuses
`MAINTENANCE`. PASS.

### Phase A1: Schema

- [ ] Add `SparePart`, `SparePartMovement`, `ServiceBill` models; migration + RLS
- [ ] Extend `shared.AuditLogEntry.entityType` with `SPARE_PART`, `SPARE_PART_MOVEMENT`,
      `SERVICE_BILL`

### Phase A2: US9 & US10 — Spare Parts Stock & Consumption (P2)

- [ ] `SparePartService` + controller (catalogue CRUD, part-number uniqueness → 409, receipts
      updating the running balance and weighted average rate — FR-016, FR-017, below-reorder
      filter)
- [ ] Consumption against a maintenance job (transactional non-negative guard — FR-018,
      valuation at the rate in force at consumption time, `partsCost` accrual, closed-job
      rejection and reversal — FR-019, incompatible-part flag rather than block — FR-020)
- [ ] Reconciliation view for parts declaring a `linkedInventoryItemId` (FR-024)
- [ ] Unit test: WAR recomputation; rate frozen at consumption; incompatible-part flagging
- [ ] E2e test: concurrent consumptions exceeding stock — no negative balance (SC-A01)

### Phase A3: US11 — Service Bills (P2)

- [ ] `ServiceBillService` + controller (server-side `tdsAmount`/`netPayable` — FR-021, bill-number
      uniqueness per vendor → 409, verify freezing figures, payment blocked while unverified —
      FR-023, recordable against a closed job)
- [ ] Per-equipment lifetime maintenance cost split by parts / internal labour / service bills
      (FR-026)
- [ ] Unit test: TDS and net payable; verification and payment guards

### Phase A4: P&L Correction

- [ ] Extend `getMachineryCostByProject()` to add spare parts consumption and verified service bill
      `netPayable` for equipment deployed at the project's sites (FR-025)
- [ ] Unit test: corrected figure matches a manual sum including parts and service bills (SC-A03)

### Phase A5: Reminders Handover

- [ ] Replace this feature's own equipment document-expiry and service-due reminder evaluation with
      rule registrations against feature 004's centralized engine (ratified 2026-09-01) — build-order
      dependency on 004's Phase A3
