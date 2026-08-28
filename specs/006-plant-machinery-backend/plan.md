# Implementation Plan: Plant & Machinery Backend

**Branch**: `006-plant-machinery-backend` | **Date**: 2026-08-28 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/006-plant-machinery-backend/spec.md`

## Summary

Build the `plant` schema — Equipment Categories, full Asset Register (with document expiry
alerting), daily Logbook with utilisation recomputation, Fuel tracking with per-entry variance
alerts via `@nestjs/event-emitter`, Service Schedules (status computed on read), Maintenance Jobs
(auto-manages equipment status), and Hire Bills (logbook-verified, TDS-deducted). Exports two
cross-module P&L methods resolving 008's machinery and fuel stubs. Three new Permission enum
values. See [research.md](research.md) for all 9 decisions.

## Technical Context

**Language/Version**: TypeScript 5.1, Node.js, NestJS 10, Prisma 5 — unchanged.
**Primary Dependencies**: Existing only — plus `@nestjs/event-emitter` (already wired by 007).
**Storage**: `plant` schema, 7 new tables.
**Testing**: Jest unit tests for `utilisation%` computation, fuel variance formula, service
schedule status derivation, `getMachineryCostByProject()` / `getFuelCostByProject()`.
E2e in `test/plant.e2e-spec.ts` for equipment lifecycle, maintenance job auto-status, hire bill.

## Constitution Check

| Principle | Check | Status |
|---|---|---|
| I. Schema Boundaries | All 7 tables in `plant`. Cross-module reads via exported services only. | PASS |
| II. Validated DTOs | Every endpoint uses typed DTOs. | PASS |
| III. No Hardcoded Values | Fuel benchmark per category; 30-day alert window via `@nestjs/config`; 15% variance threshold as named constant. | PASS |
| IV. Multi-Tenant Isolation | All 7 tables carry `companyId`; RLS on all. | PASS |
| V. Auth & Permissions | `PLANT_ASSETS` / `PLANT_OPERATIONS` / `PLANT_BILLING` gating. | PASS |
| VI. Safe Migrations | `plant` schema added in a single migration. | PASS |

## Implementation Phases

### Phase 1: Setup

- [ ] Extend `settings.Permission` enum: `PLANT_ASSETS`, `PLANT_OPERATIONS`, `PLANT_BILLING`
- [ ] Add all 7 `plant` schema models to `prisma/schema.prisma` (data-model.md)
- [ ] Generate and apply migration; add RLS policies for all 7 tables
- [ ] Extend `shared.AuditLogEntry.entityType` with 7 plant entity types
- [ ] Scaffold `PlantModule`; immediately export `PlantService` with stubs for
      `getMachineryCostByProject()` and `getFuelCostByProject()` returning 0

### Phase 2: US1 & US2 — Categories & Asset Register (P1)

- [ ] `EquipmentCategoriesService` + `EquipmentCategoriesController` (CRUD, delete guard)
- [ ] `EquipmentService` + `EquipmentController` (CRUD, document upload, expiry alert computed
      on list, manual status guard — FR-002)
- [ ] Unit test: expiry alert flag logic (30-day window)
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
      FR-006; `nextDueReading` computed on write)
- [ ] `MaintenanceService` + `MaintenanceController` (equipment status auto-management —
      FR-002; open-job uniqueness guard; service schedule update on close)
- [ ] Unit test: schedule status (ok/due_soon/overdue) logic
- [ ] E2e test: open job → Under Maintenance; close → Active; linked schedule updated

### Phase 6: US7 — Hire Bills (P3)

- [ ] `HireBillService` + `HireBillController` (logbook hour snapshot, TDS via
      `PartnersService.getVendorTds()`, computed financials, state transitions)
- [ ] Unit test: TDS deduction; netPayable formula
- [ ] E2e test: full hire bill lifecycle (create → verify → pay)

### Phase 7: US8 — P&L Service Methods (P3)

- [ ] Replace stubs: `getMachineryCostByProject()` — hired (HireBill sum) + owned (depreciation
      sum) via `ProjectsService.getSitesByProject()`
- [ ] Replace stub: `getFuelCostByProject()` — FuelEntry sum for project's sites
- [ ] Unit test: both methods with mixed hired/owned equipment; graceful 0 on ProjectsService failure

### Phase 8: Polish

- [ ] Swagger `@ApiTags('Plant')` + `@ApiOperation` on all controllers
- [ ] Add `ITEMS` seed for default equipment document types
- [ ] `npm run lint` + `npm run build` clean
