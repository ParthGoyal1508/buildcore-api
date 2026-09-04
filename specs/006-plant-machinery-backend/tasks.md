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

- [X] T001 [P] Extend `src/settings/permission.enum.ts`: `MAINTENANCE`, `HIRE_BILLS` only — reuse
      the already-existing `MACHINERY`, `LOGBOOK`, `FUEL`, `SETTINGS` values verbatim (corrected
      during reconciliation with a parallel spec — research.md §7)
- [X] T002 Add the 7 operational `plant` schema models and the 3 `settings` reference-data models
      (EquipmentCategory, EquipmentDocType, HireRate) to `prisma/schema.prisma` — data-model.md
      (corrected placement — research.md §1)
- [X] T003 Generate and apply migration(s); add RLS policies for all 10 tables; seed
      EquipmentCategory (10 named defaults) and EquipmentDocType (common defaults) — HireRate not
      pre-seeded
- [X] T004 [P] Extend `shared.AuditLogEntry.entityType` with 10 plant/settings entity types
      (including `EQUIPMENT_CATEGORY`, `EQUIPMENT_DOC_TYPE`, `HIRE_RATE`)
- [X] T005 Scaffold `PlantModule` in `src/plant/plant.module.ts`; export `PlantService` with
      stubs `getMachineryCostByProject()` and `getFuelCostByProject()` returning 0
- [X] T005a [P] Scaffold `src/settings/machinery-masters/` with `EquipmentCategoriesService`,
      `EquipmentDocTypesService`, `HireRatesService` (`settings` schema) — exported for
      `PlantModule`'s thin controller proxies to call (Principle I, research.md §1)

**Checkpoint**: Schema, permissions, and P&L stubs ready.

---

## Phase 2: US1 & US2 — Reference Data Masters & Asset Register (Priority: P1)

- [X] T006 [P] [US1] `EquipmentCategoriesService` in
      `src/settings/machinery-masters/equipment-categories.service.ts` (`settings` schema, T005a):
      CRUD, delete guard → 409 if linked equipment, fields include `fuelVarianceThresholdPercent`
      and `targetHoursPerMonth`; thin `EquipmentCategoriesController` in
      `src/plant/categories/equipment-categories.controller.ts` calling it, `Permission.SETTINGS`
      (corrected — research.md §1, §7)
- [X] T006a [P] [US1] `EquipmentDocTypesService` in
      `src/settings/machinery-masters/equipment-doc-types.service.ts` (`name`, `alertDays` fields):
      CRUD; thin `EquipmentDocTypesController` in `src/plant/doc-types/`, `Permission.SETTINGS`
      (research.md §1, spec FR-013)
- [X] T006b [P] [US1] `HireRatesService` in
      `src/settings/machinery-masters/hire-rates.service.ts`: CRUD plus
      `getEffectiveHireRate(categoryId, date)` (closes the prior "current" rate's `effectiveTo` on
      new-rate creation — spec FR-014); thin `HireRatesController` in `src/plant/rates/`,
      `Permission.SETTINGS`
- [X] T007 [P] [US2] Create equipment DTOs: `create-equipment.dto.ts`, `update-equipment.dto.ts`
- [X] T008 [US2] `EquipmentService` in `src/plant/equipment/equipment.service.ts`:
      `create`, `findAll` (with `expiryAlert` computed per equipment from each document's doc
      type `alertDays` — corrected, no longer a 30-day literal), `findOne`, `update`
      (guard: `status` cannot be set to `under_maintenance` manually — FR-002), `uploadDocument`
      (`docTypeId` FK, encrypted fileRef — corrected from a fixed enum), `deleteDocument`; all
      writes audit-logged
- [X] T009 [US2] `EquipmentController` in `src/plant/equipment/equipment.controller.ts`:
      all endpoints, `Permission.MACHINERY` (corrected — research.md §7)
- [X] T010 [P] [US2] Unit test: `expiryAlert` computed correctly (per-doc-type configurable
      window, past-expiry, no-expiry cases) — `src/plant/equipment/equipment.service.spec.ts`
- [X] T011 [US2] E2e test: create equipment, upload document expiring in 15 days,
      list → `expiryAlert: true` — `test/plant.e2e-spec.ts`

**Checkpoint**: Equipment CRUD with document expiry alerting functional.

---

## Phase 3: US3 — Logbook (Priority: P1)

- [X] T012 [P] [US3] Create `create-logbook.dto.ts` with `closing >= opening` validation
- [X] T013 [US3] `LogbookService` in `src/plant/logbook/logbook.service.ts`:
      `create` (check UNIQUE `(equipmentId, date)` → 409; `totalHours = closing − opening`;
      update `equipment.currentReading`; recompute `utilizationPercent` for current month
      — research.md §6; audit-log), `findAll`, `delete` (reverses currentReading update)
- [X] T014 [US3] `LogbookController` in `src/plant/logbook/logbook.controller.ts`:
      `Permission.LOGBOOK` (corrected — research.md §7)
- [X] T015 [P] [US3] Unit test: utilisation % formula (partial month, zero-hours day,
      category target hours) — `src/plant/logbook/logbook.service.spec.ts`
- [X] T016 [US3] E2e test: duplicate date → 409; currentReading updates; utilisation recomputes

**Checkpoint**: Logbook CRUD and utilisation functional.

---

## Phase 4: US4 — Fuel (Priority: P2)

- [X] T017 [P] [US4] Create `create-fuel.dto.ts`
- [X] T018 [US4] `FuelService` in `src/plant/fuel/fuel.service.ts`:
      `create` (compute `amount = qty × rate`; compute `variancePercent` against the equipment
      category's configurable `fuelVarianceThresholdPercent` — corrected, no longer a hardcoded
      `15`; set `varianceAlert`; if `varianceAlert`, emit `fuel_variance` event via
      `EventEmitter2` — research.md §3; audit-log), `findAll`, `getMonthlySummary`
- [X] T019 [US4] `FuelController` with `GET /plant/fuel/summary` — `Permission.FUEL` (corrected —
      research.md §7)
- [X] T020 [P] [US4] Unit test: variance formula (above threshold → alert; at/below → no alert;
      zero totalHours → no variance; threshold read from category config, not hardcoded) —
      `src/plant/fuel/fuel.service.spec.ts`
- [X] T021 [US4] E2e test: fuel entry with variancePercent > 15% → `varianceAlert: true`

**Checkpoint**: Fuel tracking with variance alerts functional.

---

## Phase 5: US5 & US6 — Maintenance & Service Schedules (Priority: P2)

- [X] T022 [P] [US6] `ServiceScheduleService` + `ServiceScheduleController`:
      `create` (`nextDueReading = lastDone + interval`), `findAll` (with computed `status`
      per schedule — research.md §4), `update`; `Permission.MAINTENANCE` (corrected —
      research.md §7)
- [X] T023 [P] [US6] Unit test: schedule status derivation (ok/due_soon/overdue) for all
      threshold cases — `src/plant/services/service-schedule.service.spec.ts`
- [X] T024 [US5] `MaintenanceService` in `src/plant/maintenance/maintenance.service.ts`:
      `create` (set `equipment.status → 'under_maintenance'`; guard: 409 if open job exists —
      research.md §2; audit-log), `update`, `close` (set `equipment.status → 'active'`;
      update linked service schedule `lastDoneReading` + recompute `nextDueReading`)
- [X] T025 [US5] `MaintenanceController` — `Permission.MAINTENANCE` (corrected)
- [X] T026 [US5] E2e test: open job → Under Maintenance; second open → 409; close → Active;
      linked service schedule updated — `test/plant.e2e-spec.ts`

**Checkpoint**: Maintenance and service schedule management functional.

---

## Phase 6: US7 — Hire Bills (Priority: P3)

- [X] T027 [P] [US7] Create `create-hire-bill.dto.ts` (`rate` now optional — defaults via T006b)
- [X] T028 [US7] `HireBillService` in `src/plant/hire-bills/hire-bills.service.ts`:
      `create` (default `rate` from `HireRatesService.getEffectiveHireRate(categoryId,
      billingPeriodFrom)` when omitted — spec FR-014; fetch logbook hours snapshot for billing
      period; fetch TDS via `PartnersService.getVendorTds(vendorId)`; compute grossAmount,
      tdsAmount, netPayable; audit-log), `findAll`, `verify` (audit-log), `pay`
- [X] T029 [US7] `HireBillController` — `Permission.HIRE_BILLS` (corrected — research.md §7)
- [X] T030 [P] [US7] Unit test: netPayable = grossAmount − tdsAmount; variance = billedHours −
      logbookHours; rate defaults correctly from the effective Hire Rate; a historical bill
      resolves its own period's rate after a newer rate is added (non-overlap invariant) —
      `src/plant/hire-bills/hire-bills.service.spec.ts`
- [X] T031 [US7] E2e test: create hire bill → verify → pay lifecycle

**Checkpoint**: Hire bill verification and payment tracking functional.

---

## Phase 7: US8 — P&L Service Methods (Priority: P3)

- [X] T032 [US8] Implement real `getMachineryCostByProject()`: calls
      `ProjectsService.getSitesByProject()`; for hired equipment at those sites: sum verified
      `HireBill.netPayable` in date range; for owned: sum depreciation per month — research.md §5
- [X] T033 [US8] Implement real `getFuelCostByProject()`: sum `FuelEntry.amount` for
      project's site-deployed equipment in date range — research.md §5
- [X] T034 [P] [US8] Unit test: both methods — hired + owned mixed; graceful 0 on
      ProjectsService failure — `src/plant/plant.service.spec.ts`

**Checkpoint**: All 8 user stories complete.

---

## Phase 8: Polish

- [X] T035 [P] Swagger `@ApiTags('Plant')` + `@ApiOperation` on all controllers
- [X] T036 [P] `npm run lint` + `npm run build` clean
- [X] T037 [P] Add `TODO(008)` comments in `PlantService` stubs for any remaining
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

---

## Amendment 2026-09-01 — Spare Parts Inventory & Service Bills

Covers spec FR-015 to FR-028 and plan Phases A1–A5. Task IDs prefixed `TA`. **No new permission
value** — reuses the `MAINTENANCE` value this feature already introduces.

- [X] TA001 Add `SparePart`, `SparePartMovement`, `ServiceBill` models to `prisma/schema.prisma`;
      migration + RLS on all three; unique index on `SparePart.partNumber` per company
- [X] TA002 [P] Extend `shared.AuditLogEntry.entityType` with `SPARE_PART`, `SPARE_PART_MOVEMENT`,
      `SERVICE_BILL` (spec FR-028)
- [X] TA003 [US9] `SparePartService` + controller in `src/plant/spare-parts/`: catalogue CRUD,
      part-number uniqueness → 409, delete guard → 409 when consumption history exists,
      below-reorder filter
- [X] TA004 [US9] Receipts updating the running stock balance and recomputing the weighted average
      rate with the same formula 009 FR-008 uses (spec FR-016, FR-017)
- [X] TA005 [US10] Consumption against an open maintenance job: transactional non-negative guard
      (spec FR-018), valuation at the rate in force at consumption time (never retrospectively
      restated), `partsCost` accrual on the job
- [X] TA006 [US10] Reject consumption against a closed job → 409; reversal requiring `MAINTENANCE`
      and a reason, restoring stock and adjusting `partsCost` in one transaction (spec FR-019)
- [X] TA007 [US10] Consuming a part incompatible with the equipment's category is **permitted but
      flagged** `incompatiblePart` and audit-logged, never blocked (spec FR-020)
- [X] TA008 [US10] Reconciliation view for parts declaring a `linkedInventoryItemId`, showing both
      balances so divergence is visible rather than double-counted (spec FR-024)
- [X] TA009 [US11] `ServiceBillService` + controller: server-side `tdsAmount` / `netPayable`
      (spec FR-021), bill-number uniqueness per vendor → 409, verify freezing figures, payment
      blocked while unverified → 409 (spec FR-023), recordable against a closed job
- [X] TA010 [US11] Per-equipment lifetime maintenance cost split into parts / internal labour /
      service bills (spec FR-026)
- [X] TA011 Replace this feature's own equipment document-expiry and service-due reminder
      evaluation with rule registrations against feature 004's centralized engine (ratified
      2026-09-01) — **blocked by 004 TA002/TA006**
- [X] TA012 **P&L correction**: extend `getMachineryCostByProject()` to add spare parts consumption
      and verified service bill `netPayable` for equipment deployed at the project's sites
      (spec FR-025) — corrects an existing understatement
- [X] TA013 [P] Unit test: WAR recomputation; rate frozen at consumption; incompatible-part flag
- [X] TA014 [P] Unit test: TDS and net payable; verification and payment guards
- [X] TA015 [P] Unit test: corrected machinery cost matches a manual sum including parts and service
      bills (SC-A03)
- [X] TA016 [P] E2e test: concurrent consumptions exceeding stock — no negative balance (SC-A01)
- [X] TA017 [P] Verify soft-delete on receipts, consumptions, and service bills (spec FR-027)

---

## Implementation note — 2026-09-04

All 57 tasks above are implemented. What follows is every place the code departs
from the task text, and what was verified.

### Deviations from the specified design

1. **Cross-schema references are plain columns, not Prisma relations.**
   data-model.md writes `categoryId FK→settings.EquipmentCategory` and
   `docTypeId FK→settings.EquipmentDocType`. Both are plain `String` columns with no
   declared relation, because a declared relation across a schema boundary is exactly
   what makes an accidental cross-schema join possible — the rule
   `inventory.StockBalance` and `partners.Vendor` already follow. Relations inside
   `plant` are real; every reference out of it goes through `PlantRefsService`.

2. **Document upload is base64-in-JSON, not `multipart/form-data`.**
   contracts/plant-api.md specifies multipart. Every other document upload in this
   codebase — 005's employee documents, 007's contractor documents, 009's purchase
   bills — takes the file as a base64 string in an ordinary JSON body. A second upload
   convention would mean a second interceptor, a second size guard and a second set of
   client code for no benefit.

3. **`ProjectSourcesRegistry` rather than `ProjectsModule` importing this one.**
   T032/T033 required wiring the P&L methods and the project-detail machinery tab into
   008. The obvious wiring is a direct import, but `PlantModule` and `InventoryModule`
   both already import `ProjectsModule` to resolve their sites, so closing the loop
   makes a cycle spanning five modules — `PartnersModule` and `HrModule` included,
   neither of which has anything to do with the change. The dependency therefore stays
   pointing one way and the data flows back through a registry each contributing module
   registers itself with on init. Same shape as 004's reminder-rule discovery, for the
   same reason.

4. **`ServiceSchedule.status` and `SparePart.belowReorderLevel` filters are resolved
   before paging, via raw id queries.** Both compare two columns, which Prisma cannot
   express. Filtering the page after fetching it returns a short page and a wrong total
   — the defect 009's `belowReorderLevel` filter shipped with and had to be corrected in
   its convergence pass. Done right the first time here.

5. **A partial unique index enforces one open maintenance job per equipment.**
   data-model.md says "enforced in service layer". The service check is there for a
   useful 409, but the guarantee is
   `MaintenanceJob_open_unique ON ("equipmentId") WHERE status = 'open'` — hand-authored
   in the migration, the same exception 004's `ReminderNotification_open_unique` takes.
   A service-layer-only check races with a concurrent open.

6. **Over-consumption of a spare part returns 400, not 009's 422.** Spec US10 scenario 2
   names `400 Bad Request` explicitly. `availableStock` travels in the body either way.
   Noted because it is the one place this module and 009 answer the same question with
   different codes.

7. **`getMachineryCostByProject` sums four components, not two.** FR-008 counted
   depreciation and hire bills; FR-025 corrects that to include spare parts consumed and
   verified service bills. Receipts are excluded — buying a part is stock, not a project
   cost; it becomes one when it is fitted.

8. **The service-due reminder projects a date from meter usage.** A service falls due at
   a reading; the reminders engine deals in dates. The rule measures the machine's actual
   daily usage over the last 30 logbook days and converts readings remaining into days
   remaining. A machine with no recorded usage produces no candidate, which is correct —
   an idle machine is not approaching its next service.

9. **`MeterType` is one `settings` enum referenced from `plant`.** Prisma enum names are
   global, so two identically-named enums are impossible, and a free-text column would
   let a category and its own machines disagree about what a reading means.

10. **Equipment `code` is auto-allocated but overridable.** `CodeSeriesType.EQUIPMENT` is
    added; most machines already carry a plate number the yard knows them by, and
    overwriting it would be unhelpful.

### Changes outside this feature's own files

- **`InventoryService` gained two exported methods**: `getItemStockTotals` (which
  FR-024's reconciliation reads) and `getMaterialsByProject` (008's materials tab).
  Read-only and additive; no inventory behaviour changed. `getMaterialsByProject` was
  written because leaving `materials` empty while `machinery` filled in would have made
  the project page claim inventory had not shipped when it had.
- **`unbuilt-module.rules.ts` lost its two `machinery-*` placeholders.** They are real
  providers in `src/plant/reminders/` now. Leaving them would double-report each rule as
  both available and pending — which the file's own comment says to avoid.
- **`20260904081331_plant_permissions_and_masters`** grants `MAINTENANCE` and
  `HIRE_BILLS` to the default roles, and **backfills `INVENTORY_APPROVE`**, which 009
  added and gated indent approval on but never granted to anything — so approving an
  indent had returned 403 for every user since 009 shipped, with no in-product way to
  discover why. The grants are additive `array_append`s rather than a wholesale rewrite,
  so an administrator's own edits to those roles survive. It also backfills the ten
  equipment categories and six document types for companies that already exist.
- **Three e2e assertions were updated** to match the above: 009's "no seeded role holds
  INVENTORY_APPROVE" (now revokes first, and restores each role's original permission
  array in `afterAll`), 008's `unavailableModules: ['plant','inventory']` (now empty),
  and 004's pending-rule list (no longer names the machinery rules).

### Verification

- `npx nest build` clean; `npx tsc --noEmit` clean.
- **576/576 unit tests** across 54 suites (68 new in `src/plant` and
  `src/settings/machinery-masters`).
- **290/290 e2e** across 9 suites, including 50 in the new `test/plant.e2e-spec.ts`.
- `npx eslint` on every file this feature touched: **0 errors**. 117 errors remain
  across untouched feature-005 files and were deliberately not reformatted.
- 54 `/plant/*` routes registered; the application boots with no circular-dependency
  errors.
- The concurrency claim is tested for real: two genuinely simultaneous consumptions of
  the last unit in stock, asserting exactly one 201 and one 400 and a final balance of
  zero.

### Not done

- **quickstart.md does not exist for this feature** and no manual walkthrough has been
  performed. Nothing here has been exercised outside the automated suites.
- The `fuel_variance` event is emitted and unit-tested, but **nothing subscribes to it** —
  the notifications surface is 004's US4, which is not built.
- `TODO(VIRUS_SCAN)`: equipment documents are stored unscanned, the same gap 005's and
  007's uploads carry.
