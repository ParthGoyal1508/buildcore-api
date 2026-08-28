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

- [ ] T001 [P] Extend `src/settings/permission.enum.ts`: `PLANT_ASSETS`, `PLANT_OPERATIONS`,
      `PLANT_BILLING`
- [ ] T002 Add all 7 `plant` schema models to `prisma/schema.prisma` — data-model.md
- [ ] T003 Generate and apply `plant` schema migration; add RLS policies for all 7 tables
- [ ] T004 [P] Extend `shared.AuditLogEntry.entityType` with 7 plant entity types
- [ ] T005 Scaffold `PlantModule` in `src/plant/plant.module.ts`; export `PlantService` with
      stubs `getMachineryCostByProject()` and `getFuelCostByProject()` returning 0

**Checkpoint**: Schema, permissions, and P&L stubs ready.

---

## Phase 2: US1 & US2 — Equipment Categories & Asset Register (Priority: P1)

- [ ] T006 [P] [US1] `EquipmentCategoriesService` + `EquipmentCategoriesController`:
      CRUD, delete guard → 409 if linked equipment, `Permission.PLANT_ASSETS`
- [ ] T007 [P] [US2] Create equipment DTOs: `create-equipment.dto.ts`, `update-equipment.dto.ts`
- [ ] T008 [US2] `EquipmentService` in `src/plant/equipment/equipment.service.ts`:
      `create`, `findAll` (with `expiryAlert` computed per equipment), `findOne`, `update`
      (guard: `status` cannot be set to `under_maintenance` manually — FR-002), `uploadDocument`
      (encrypted fileRef), `deleteDocument`; all writes audit-logged
- [ ] T009 [US2] `EquipmentController` in `src/plant/equipment/equipment.controller.ts`:
      all endpoints, `Permission.PLANT_ASSETS`
- [ ] T010 [P] [US2] Unit test: `expiryAlert` computed correctly (30-day window, past-expiry,
      no-expiry cases) — `src/plant/equipment/equipment.service.spec.ts`
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
      `Permission.PLANT_OPERATIONS`
- [ ] T015 [P] [US3] Unit test: utilisation % formula (partial month, zero-hours day,
      category target hours) — `src/plant/logbook/logbook.service.spec.ts`
- [ ] T016 [US3] E2e test: duplicate date → 409; currentReading updates; utilisation recomputes

**Checkpoint**: Logbook CRUD and utilisation functional.

---

## Phase 4: US4 — Fuel (Priority: P2)

- [ ] T017 [P] [US4] Create `create-fuel.dto.ts`
- [ ] T018 [US4] `FuelService` in `src/plant/fuel/fuel.service.ts`:
      `create` (compute `amount = qty × rate`; compute `variancePercent`; set `varianceAlert`;
      if `varianceAlert`, emit `fuel_variance` event via `EventEmitter2` — research.md §3;
      audit-log), `findAll`, `getMonthlySummary`
- [ ] T019 [US4] `FuelController` with `GET /plant/fuel/summary` — `Permission.PLANT_OPERATIONS`
- [ ] T020 [P] [US4] Unit test: variance formula (> 15% → alert; ≤ 15% → no alert; zero
      totalHours → no variance) — `src/plant/fuel/fuel.service.spec.ts`
- [ ] T021 [US4] E2e test: fuel entry with variancePercent > 15% → `varianceAlert: true`

**Checkpoint**: Fuel tracking with variance alerts functional.

---

## Phase 5: US5 & US6 — Maintenance & Service Schedules (Priority: P2)

- [ ] T022 [P] [US6] `ServiceScheduleService` + `ServiceScheduleController`:
      `create` (`nextDueReading = lastDone + interval`), `findAll` (with computed `status`
      per schedule — research.md §4), `update`; `Permission.PLANT_ASSETS`
- [ ] T023 [P] [US6] Unit test: schedule status derivation (ok/due_soon/overdue) for all
      threshold cases — `src/plant/services/service-schedule.service.spec.ts`
- [ ] T024 [US5] `MaintenanceService` in `src/plant/maintenance/maintenance.service.ts`:
      `create` (set `equipment.status → 'under_maintenance'`; guard: 409 if open job exists —
      research.md §2; audit-log), `update`, `close` (set `equipment.status → 'active'`;
      update linked service schedule `lastDoneReading` + recompute `nextDueReading`)
- [ ] T025 [US5] `MaintenanceController` — `Permission.PLANT_OPERATIONS`
- [ ] T026 [US5] E2e test: open job → Under Maintenance; second open → 409; close → Active;
      linked service schedule updated — `test/plant.e2e-spec.ts`

**Checkpoint**: Maintenance and service schedule management functional.

---

## Phase 6: US7 — Hire Bills (Priority: P3)

- [ ] T027 [P] [US7] Create `create-hire-bill.dto.ts`
- [ ] T028 [US7] `HireBillService` in `src/plant/hire-bills/hire-bills.service.ts`:
      `create` (fetch logbook hours snapshot for billing period; fetch TDS via
      `PartnersService.getVendorTds(vendorId)`; compute grossAmount, tdsAmount, netPayable;
      audit-log), `findAll`, `verify` (audit-log), `pay`
- [ ] T029 [US7] `HireBillController` — `Permission.PLANT_BILLING`
- [ ] T030 [P] [US7] Unit test: netPayable = grossAmount − tdsAmount; variance = billedHours −
      logbookHours — `src/plant/hire-bills/hire-bills.service.spec.ts`
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
Phase 1 → US1 (Categories) → US2 (Equipment) → US3 (Logbook) → US4 (Fuel)
                                              → US5 (Maintenance) → US6 (Services)
                                              → US7 (Hire Bills)
                                              → US8 (P&L methods — needs US2 + US3 + US7)
```

## Implementation Strategy

**MVP (Phase 1–3, US1–US3)**: Categories, Asset Register, Logbook. Delivers daily operational tracking.
**Increment 2 (Phase 4–5, US4–US6)**: Fuel, Maintenance, Service Schedules.
**Increment 3 (Phase 6–7, US7–US8)**: Hire Bills, P&L integration.
