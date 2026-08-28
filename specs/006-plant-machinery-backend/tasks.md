---

description: "Task list for feature implementation"
---

# Tasks: Plant & Machinery Backend

**Input**: Design documents from `/specs/006-plant-machinery-backend/`
**Tests**: Included for utilisation%, fuel variance, service schedule status, and hire bill
financial computation — business-rule-heavy calculations requiring unit test coverage.

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: Setup

- [ ] T001 [P] Extend `src/settings/permission.enum.ts`: `MAINTENANCE`, `HIRE_BILLS` only — reuse
      the already-existing `MACHINERY`, `LOGBOOK`, `FUEL`, `SETTINGS` values verbatim (corrected
      during reconciliation with a parallel spec — research.md §7)
- [ ] T002 Add the 7 operational `plant` schema models and the 3 `settings` reference-data models
      (EquipmentCategory, EquipmentDocType, HireRate) to `prisma/schema.prisma` — data-model.md
      (corrected placement — research.md §1)
- [ ] T003 Generate and apply migration(s); add RLS policies for all 10 tables; seed
      EquipmentCategory (10 named defaults) and EquipmentDocType (common defaults) — HireRate not
      pre-seeded
- [ ] T004 [P] Extend `shared.AuditLogEntry.entityType` with 10 plant/settings entity types
      (including `EQUIPMENT_CATEGORY`, `EQUIPMENT_DOC_TYPE`, `HIRE_RATE`)
- [ ] T005 Scaffold `PlantModule` in `src/plant/plant.module.ts`; export `PlantService` with
      stubs `getMachineryCostByProject()` and `getFuelCostByProject()` returning 0
- [ ] T005a [P] Scaffold `src/settings/machinery-masters/` with `EquipmentCategoriesService`,
      `EquipmentDocTypesService`, `HireRatesService` (`settings` schema) — exported for
      `PlantModule`'s thin controller proxies to call (Principle I, research.md §1)

**Checkpoint**: Schema, permissions, and P&L stubs ready.

---

## Phase 2: US1 & US2 — Reference Data Masters & Asset Register (Priority: P1)

- [ ] T006 [P] [US1] `EquipmentCategoriesService` in
      `src/settings/machinery-masters/equipment-categories.service.ts` (`settings` schema, T005a):
      CRUD, delete guard → 409 if linked equipment, fields include `fuelVarianceThresholdPercent`
      and `targetHoursPerMonth`; thin `EquipmentCategoriesController` in
      `src/plant/categories/equipment-categories.controller.ts` calling it, `Permission.SETTINGS`
      (corrected — research.md §1, §7)
- [ ] T006a [P] [US1] `EquipmentDocTypesService` in
      `src/settings/machinery-masters/equipment-doc-types.service.ts` (`name`, `alertDays` fields):
      CRUD; thin `EquipmentDocTypesController` in `src/plant/doc-types/`, `Permission.SETTINGS`
      (research.md §1, spec FR-013)
- [ ] T006b [P] [US1] `HireRatesService` in
      `src/settings/machinery-masters/hire-rates.service.ts`: CRUD plus
      `getEffectiveHireRate(categoryId, date)` (closes the prior "current" rate's `effectiveTo` on
      new-rate creation — spec FR-014); thin `HireRatesController` in `src/plant/rates/`,
      `Permission.SETTINGS`
- [ ] T007 [P] [US2] Create equipment DTOs: `create-equipment.dto.ts`, `update-equipment.dto.ts`
- [ ] T008 [US2] `EquipmentService` in `src/plant/equipment/equipment.service.ts`:
      `create`, `findAll` (with `expiryAlert` computed per equipment from each document's doc
      type `alertDays` — corrected, no longer a 30-day literal), `findOne`, `update`
      (guard: `status` cannot be set to `under_maintenance` manually — FR-002), `uploadDocument`
      (`docTypeId` FK, encrypted fileRef — corrected from a fixed enum), `deleteDocument`; all
      writes audit-logged
- [ ] T009 [US2] `EquipmentController` in `src/plant/equipment/equipment.controller.ts`:
      all endpoints, `Permission.MACHINERY` (corrected — research.md §7)
- [ ] T010 [P] [US2] Unit test: `expiryAlert` computed correctly (per-doc-type configurable
      window, past-expiry, no-expiry cases) — `src/plant/equipment/equipment.service.spec.ts`
- [ ] T011 [US2] E2e test: create equipment, upload document expiring in 15 days,
      list → `expiryAlert: true` — `test/plant.e2e-spec.ts`

**Checkpoint**: Equipment CRUD with document expiry alerting functional.

---

## Phase 3: US3 — Logbook (Priority: P1)

- [ ] T012 [P] [US3] Create `create-logbook.dto.ts` with `closing >= opening` validation
- [ ] T013 [US3] `LogbookService` in `src/plant/logbook/logbook.service.ts`:
      `create` (check UNIQUE `(equipmentId, date)` → 409; `totalHours = closing − opening`;
      update `equipment.currentReading`; recompute `utilizationPercent` for current month
      — research.md §6; audit-log), `findAll`, `delete` (reverses currentReading update)
- [ ] T014 [US3] `LogbookController` in `src/plant/logbook/logbook.controller.ts`:
      `Permission.LOGBOOK` (corrected — research.md §7)
- [ ] T015 [P] [US3] Unit test: utilisation % formula (partial month, zero-hours day,
      category target hours) — `src/plant/logbook/logbook.service.spec.ts`
- [ ] T016 [US3] E2e test: duplicate date → 409; currentReading updates; utilisation recomputes

**Checkpoint**: Logbook CRUD and utilisation functional.

---

## Phase 4: US4 — Fuel (Priority: P2)

- [ ] T017 [P] [US4] Create `create-fuel.dto.ts`
- [ ] T018 [US4] `FuelService` in `src/plant/fuel/fuel.service.ts`:
      `create` (compute `amount = qty × rate`; compute `variancePercent` against the equipment
      category's configurable `fuelVarianceThresholdPercent` — corrected, no longer a hardcoded
      `15`; set `varianceAlert`; if `varianceAlert`, emit `fuel_variance` event via
      `EventEmitter2` — research.md §3; audit-log), `findAll`, `getMonthlySummary`
- [ ] T019 [US4] `FuelController` with `GET /plant/fuel/summary` — `Permission.FUEL` (corrected —
      research.md §7)
- [ ] T020 [P] [US4] Unit test: variance formula (above threshold → alert; at/below → no alert;
      zero totalHours → no variance; threshold read from category config, not hardcoded) —
      `src/plant/fuel/fuel.service.spec.ts`
- [ ] T021 [US4] E2e test: fuel entry with variancePercent > 15% → `varianceAlert: true`

**Checkpoint**: Fuel tracking with variance alerts functional.

---

## Phase 5: US5 & US6 — Maintenance & Service Schedules (Priority: P2)

- [ ] T022 [P] [US6] `ServiceScheduleService` + `ServiceScheduleController`:
      `create` (`nextDueReading = lastDone + interval`), `findAll` (with computed `status`
      per schedule — research.md §4), `update`; `Permission.MAINTENANCE` (corrected —
      research.md §7)
- [ ] T023 [P] [US6] Unit test: schedule status derivation (ok/due_soon/overdue) for all
      threshold cases — `src/plant/services/service-schedule.service.spec.ts`
- [ ] T024 [US5] `MaintenanceService` in `src/plant/maintenance/maintenance.service.ts`:
      `create` (set `equipment.status → 'under_maintenance'`; guard: 409 if open job exists —
      research.md §2; audit-log), `update`, `close` (set `equipment.status → 'active'`;
      update linked service schedule `lastDoneReading` + recompute `nextDueReading`)
- [ ] T025 [US5] `MaintenanceController` — `Permission.MAINTENANCE` (corrected)
- [ ] T026 [US5] E2e test: open job → Under Maintenance; second open → 409; close → Active;
      linked service schedule updated — `test/plant.e2e-spec.ts`

**Checkpoint**: Maintenance and service schedule management functional.

---

## Phase 6: US7 — Hire Bills (Priority: P3)

- [ ] T027 [P] [US7] Create `create-hire-bill.dto.ts` (`rate` now optional — defaults via T006b)
- [ ] T028 [US7] `HireBillService` in `src/plant/hire-bills/hire-bills.service.ts`:
      `create` (default `rate` from `HireRatesService.getEffectiveHireRate(categoryId,
      billingPeriodFrom)` when omitted — spec FR-014; fetch logbook hours snapshot for billing
      period; fetch TDS via `PartnersService.getVendorTds(vendorId)`; compute grossAmount,
      tdsAmount, netPayable; audit-log), `findAll`, `verify` (audit-log), `pay`
- [ ] T029 [US7] `HireBillController` — `Permission.HIRE_BILLS` (corrected — research.md §7)
- [ ] T030 [P] [US7] Unit test: netPayable = grossAmount − tdsAmount; variance = billedHours −
      logbookHours; rate defaults correctly from the effective Hire Rate; a historical bill
      resolves its own period's rate after a newer rate is added (non-overlap invariant) —
      `src/plant/hire-bills/hire-bills.service.spec.ts`
- [ ] T031 [US7] E2e test: create hire bill → verify → pay lifecycle

**Checkpoint**: Hire bill verification and payment tracking functional.

---

## Phase 7: US8 — P&L Service Methods (Priority: P3)

- [ ] T032 [US8] Implement real `getMachineryCostByProject()`: calls
      `ProjectsService.getSitesByProject()`; for hired equipment at those sites: sum verified
      `HireBill.netPayable` in date range; for owned: sum depreciation per month — research.md §5
- [ ] T033 [US8] Implement real `getFuelCostByProject()`: sum `FuelEntry.amount` for
      project's site-deployed equipment in date range — research.md §5
- [ ] T034 [P] [US8] Unit test: both methods — hired + owned mixed; graceful 0 on
      ProjectsService failure — `src/plant/plant.service.spec.ts`

**Checkpoint**: All 8 user stories complete.

---

## Phase 8: Polish

- [ ] T035 [P] Swagger `@ApiTags('Plant')` + `@ApiOperation` on all controllers
- [ ] T036 [P] `npm run lint` + `npm run build` clean
- [ ] T037 [P] Add `TODO(008)` comments in `PlantService` stubs for any remaining
      cross-module methods

---

## Dependencies

```
Phase 1 → US1 (Reference Data Masters — Categories/Doc Types/Hire Rates, settings schema)
       → US2 (Equipment) → US3 (Logbook) → US4 (Fuel)
                          → US5 (Maintenance) → US6 (Services)
                          → US7 (Hire Bills — also depends on US1's Hire Rates)
                          → US8 (P&L methods — needs US2 + US3 + US7)
```

## Implementation Strategy

**MVP (Phase 1–3, US1–US3)**: Categories, Asset Register, Logbook. Delivers daily operational tracking.
**Increment 2 (Phase 4–5, US4–US6)**: Fuel, Maintenance, Service Schedules.
**Increment 3 (Phase 6–7, US7–US8)**: Hire Bills, P&L integration.
