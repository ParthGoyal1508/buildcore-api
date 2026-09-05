---

description: "Task list for feature implementation"
---

# Tasks: Project Assets Backend

**Input**: Design documents from `/specs/012-project-assets-backend/`
**Tests**: Included for book-value computation, pro-rated depreciation (no double-count), the asset
status machine, bulk quantity arithmetic, and inspection due-date advancement. Concurrency e2e
tests are required for bulk allocation and transfer receipt.

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: Setup

- [X] T001 [P] Extend `src/settings/permission.enum.ts`: `ASSETS`, `ASSETS_APPROVE` only — reuse
      the existing `REPORTS` value verbatim (spec FR-033)
- [X] T002 Add the 8 `assets` models and the 3 `settings` reference-data models (AssetCategory,
      AssetDocType, ConditionGrade) to `prisma/schema.prisma` — data-model.md
- [X] T003 Generate and apply migration(s); add RLS policies for all 11 tables; unique index on
      `AssetStock(assetId, siteId)` and on `Asset.serialNumber` per company (spec FR-008)
- [X] T004 [P] Extend `shared.AuditLogEntry.entityType` with `ASSET`, `ASSET_ALLOCATION`,
      `ASSET_TRANSFER`, `ASSET_REQUEST`, `ASSET_INSPECTION`, `ASSET_REPAIR` (spec FR-034)
- [X] T005 Scaffold `AssetsModule` in `src/assets/assets.module.ts`; export `AssetsService` with
      stubs `getAssetCostByProject()` returning 0 and `getOutstandingCustody(employeeId)` returning
      `[]` — 008's P&L and 005's exit flow depend on them
- [X] T006 [P] Extend Settings' code-series service with an `ASSET` series type (spec FR-006)
- [X] T007 [P] Scaffold `src/settings/asset-masters/` with `AssetCategoriesService`,
      `AssetDocTypesService`, `ConditionGradesService` (`settings` schema, exported — Principle I)

**Checkpoint**: Schema, permissions, masters, and the two exported stubs are ready.

---

## Phase 2: US1 & US2 — Masters & Asset Register (Priority: P1)

- [X] T008 [P] [US1] `AssetCategoriesService` (T007): CRUD; `trackingMode` immutable once assets
      exist → 409 (spec FR-003); `inspectionRequired` without `inspectionIntervalDays` → 400;
      delete guard → 409; list returns `assetCount` and `totalBookValue`
- [X] T009 [P] [US1] `AssetDocTypesService` and `ConditionGradesService` (T007) — condition grades
      carry the `isDamaged` / `isScrap` semantics that drive the return-status mapping
- [X] T010 [US1] Thin master controllers in `src/assets/masters/` calling T008/T009, guarded with
      `SETTINGS`
- [X] T011 [US2] `AssetService` in `src/assets/assets.service.ts`: serialised registration
      (quantity > 1 → 400, spec FR-004), bulk registration opening the `AssetStock` row,
      serial-number uniqueness → 409, `capitalisationDate` ≥ `purchaseDate` → 400, optional
      `purchaseId` acquisition link (spec FR-038)
- [X] T012 [US2] Implement the asset status machine as a single guarded transition method rejecting
      out-of-machine transitions with the permitted ones named (spec FR-007)
- [X] T013 [US2] Asset document upload to encrypted object storage; refuse production start on
      local-filesystem blobs (spec FR-028)
- [X] T014 [US2] `AssetController` with `@RequirePermission(ASSETS)`; list returning location,
      custodian, status, condition, and current book value
- [X] T015 [P] [US2] Unit test: tracking-mode enforcement, serial uniqueness, capitalisation-date
      validation, every status transition
- [X] T016 [P] [US2] E2e test: register serialised and bulk assets; duplicate serial → 409

**Checkpoint**: The register exists and is independently usable.

---

## Phase 3: US3 — Allocation & Custody (Priority: P1)

- [X] T017 [US3] `AllocationService` in `src/assets/allocations/allocation.service.ts`: one open
      allocation per serialised asset → 409 (spec FR-009); `custodyRequired` guard → 400
- [X] T018 [US3] Custodian site-match guard — the employee's active site must equal the allocation
      site, resolved via `HrService` → 400 otherwise (spec FR-010, FR-030)
- [X] T019 [US3] Bulk allocation decrementing `AssetStock` under the transactional non-negative
      guarantee (spec FR-011) — never an application-level read-then-write
- [X] T020 [US3] Return: close the allocation, map the condition grade to `idle` /
      `under_repair` / `scrapped` (spec FR-015), clear custody
- [X] T021 [US3] `overdue` flag derived from `expectedReturnDate`; replace the T005
      `getOutstandingCustody()` stub so 005's exit flow can surface assets to recover (spec FR-036)
- [X] T022 [US3] `AllocationController` with permission guards
- [X] T023 [P] [US3] Unit test: custody site-match rejection, condition→status mapping, overdue
- [X] T024 [P] [US3] E2e test: concurrent bulk allocations exceeding stock — no negative balance
      (SC-003)

**Checkpoint**: The matrix's "Project Assets" view (which assets are at which project) works.

---

## Phase 4: US7 — Stock & Summary (Priority: P1)

- [X] T025 [US7] `AssetStockService`: serialised listed individually; bulk aggregated per site with
      on-hand / allocated / in-transit
- [X] T026 [US7] `DepreciationService`: on-demand book value floored at `salvageValue`, never
      negative, zero before `capitalisationDate` (spec FR-019); no accounting postings (spec FR-020)
- [X] T027 [US7] Summary grouped by category, project, or status with counts, original cost,
      accumulated depreciation, and book value; scrapped assets in a separate bucket
- [X] T028 [US7] XLSX export via `exceljs`, async via bullmq above the configured row threshold
      (spec FR-037)
- [X] T029 [P] [US7] Unit test: book value at many dates including past useful life and before
      capitalisation (SC-008)
- [X] T030 [P] [US7] E2e test: summary totals reconcile with stock rows; cross-company read blocked
      by RLS

**Checkpoint**: Stock and Summary — the module's primary daily views — are live.

---

## Phase 5: US4 & US5 — Requests & Transfers (Priority: P2)

- [ ] T031 [US4] `AssetRequestService`: raise with request-number generation; approve requiring
      `ASSETS_APPROVE`; reject requiring a reason → 400; `overdue` flag against `requiredByDate`
- [ ] T032 [US4] Fulfilment against an `idle` asset only → 409 otherwise, creating the allocation
      in the same transaction (spec FR-023)
- [ ] T033 [US4] `mark-procurement-needed` and the procurement-needed report; assert no purchase
      order is created here — procurement stays feature 009's flow (spec FR-024)
- [ ] T034 [US5] `AssetTransferService`: dispatch moving the asset to `in_transit` so it counts
      toward neither site's available pool (spec FR-012); transfer blocked while allocated → 409
- [ ] T035 [US5] Receipt applied under a row-level lock (spec FR-013); `conditionDiscrepancy` flag
      audit-logged; `transitOverdue` flag
- [ ] T036 [US5] Partial bulk receipt recording `transitShortage` and closing as
      `closed_with_shortage` — never silently discarding the difference (spec FR-014)
- [ ] T037 [US5] Cancel requiring `ASSETS_APPROVE`, returning the asset to the source site as idle
- [ ] T038 [US4/US5] `AssetRequestController` and `AssetTransferController` with permission guards
- [ ] T039 [P] [US4] Unit test: fulfilment transaction; procurement-needed path
- [ ] T040 [P] [US5] Unit test: shortage arithmetic; transit-overdue
- [ ] T041 [P] [US5] E2e test: concurrent receipts — exactly one succeeds, the loser gets 409

**Checkpoint**: Requests and inter-site movement are controlled end to end (SC-002).

---

## Phase 6: US6 — Inspection, Repair & Condemnation (Priority: P2)

- [ ] T042 [US6] `InspectionService`: `nextInspectionDue` set on registration and advanced by the
      category interval **from the inspection date, not the previous due date**, so a late
      inspection does not compound the schedule (spec FR-017)
- [ ] T043 [US6] Outcome mapping — `repair_required` → `under_repair`; `condemn` requiring
      `ASSETS_APPROVE`, setting the disposal date, and blocked while allocated → 409 (spec FR-016,
      FR-018)
- [ ] T044 [US6] `RepairService`: open/close with computed downtime days, cumulative
      `totalRepairCost` / `totalDowntimeDays`, and the `repairCostExceedsThreshold` flag
- [ ] T045 [US6] Controllers with permission guards
- [ ] T046 [P] [US6] Unit test: late inspection does not compound; condemn-while-allocated → 409
- [ ] T047 [P] [US6] E2e test: inspection → repair → close → back to idle

---

## Phase 7: US8 — Reminders (Priority: P2)

- [ ] T048 [US8] Register three reminder rules with feature 004's centralized engine —
      `document_expiry`, `inspection_due`, `overdue_return` (spec FR-025, FR-026; ratified
      2026-09-01). **Evaluation, severity, de-duplication, and snooze live in 004, not here.**
- [ ] T049 [US8] Exclude `scrapped` assets from every rule (spec FR-027)
- [ ] T050 [P] [US8] Unit test: each rule's due-condition and the sign of days-remaining
- [ ] T051 [P] [US8] E2e test: reminders surface via 004's endpoint with no duplicate notification
      while the severity band is unchanged

**Blocked by**: 004's Phase A3 (reminders engine) must land first.

---

## Phase 8: US9 — P&L Service Method (Priority: P3)

- [ ] T052 [US9] Replace the T005 stub: `getAssetCostByProject()` — pro-rated depreciation by days
      allocated to the project plus repairs closed in the range, via
      `ProjectsService.getSitesByProject()` (spec FR-021, FR-029)
- [ ] T053 [P] [US9] Unit test: an asset allocated to two projects in one month — the two figures
      never sum to more than its full monthly depreciation (spec FR-022, SC-005)

---

## Phase 9: Polish

- [ ] T054 [P] Swagger `@ApiTags('Assets')` + `@ApiOperation` on all controllers
- [ ] T055 [P] Verify soft-delete on assets, allocations, transfers, requests (spec FR-031)
- [ ] T056 Confirm typed DTOs on every endpoint (spec FR-035); `npm run lint` + `npm run build`
      clean

## Dependencies

```
Phase 1 → US1 (Masters) → US2 (Register) → US3 (Allocation) → US7 (Stock/Summary)
                                          → US4 (Requests)
                                          → US5 (Transfers)
                                          → US6 (Inspection/Repair)
                                          → US8 (Reminders — BLOCKED BY 004 Phase A3)
                                          → US9 (P&L — needs US3 + US6)

External: 008's P&L blocks on T052. 005's exit flow blocks on T021.
```

## Implementation Strategy

**MVP (Phases 1–4, US1/US2/US3/US7)**: register, allocate, and see the stock. Answers "which assets
are at which project", the matrix's core ask.
**Increment 2 (Phases 5–6, US4/US5/US6)**: requests, transfers, condition lifecycle.
**Increment 3 (Phases 7–8, US8/US9)**: reminders (after 004) and P&L integration.

---

## Implementation note — 2026-09-05 (Phases 1–4, T001–T030)

The MVP slice (US1, US2, US3, US7) is implemented and marked `[X]`. Phases 5–9
(T031–T056: requests, transfers, inspection/repair, reminders, the P&L method and
polish) are untouched and remain unchecked.

Verified: 621/621 unit tests, 21/21 e2e in `test/assets.e2e-spec.ts` (including the
T024 concurrency test), `nest build` clean, `eslint` 0 errors.

Deviations, and why:

- **T028 — export is synchronous only.** The task specifies `exceljs` with a bullmq
  hand-off above a row threshold. `exceljs` is used; bullmq is not installed and
  004's US7 queue has never shipped, so there is no async path for a threshold to
  select. A threshold that fell through to the same synchronous path either way
  would be a fiction in the contract, so it is not implemented. Recorded in
  `AssetSummaryService`'s class comment.
- **T026 — depreciation is a module of pure functions, not a service.** `src/assets/
  depreciation.ts` exports `monthlyDepreciation`, `monthsElapsed`,
  `accumulatedDepreciation`, `bookValue` and `depreciationForDays`. Nothing is
  posted and nothing is stored, so there is no state for an injectable to hold, and
  a pure module is directly unit-testable without a Nest context.
- **T012 — the status machine is `src/assets/asset-status.ts`, a table plus
  `assertTransition`,** rather than a method on a service. The spec requires the
  refusal to *name the permitted transitions*, which is what makes the table worth
  having; every service calls the same guard.
- **T007–T010 — the three masters live in `src/settings/asset-masters/` and are
  routed from `src/assets/masters/`,** the split `EquipmentCategoriesService` /
  `EquipmentCategoriesController` already use. The guards that count `assets`-schema
  rows (category-in-use, tracking-mode freeze, doc-type-in-use, grade-in-use) are on
  `AssetService`, because Principle I forbids the settings services reading that
  schema; the controllers compose the two halves.
- **`AssetsService.getAssetCostByProject()` returns 0 and `isAvailable()` returns
  false** (T005's stub). The arithmetic exists and is unit-tested, but the module
  does not yet register with `ProjectSourcesRegistry` — that is T053's work in
  Phase 8.
- **`todayUtc()` (`src/assets/dates.ts`) replaced the local-midnight `startOfToday()`
  helper** copied from `EquipmentService`. Postgres returns a `@db.Date` as UTC
  midnight, and comparing it against local midnight is wrong by a day for part of
  every day east of Greenwich — which is where this system runs. Caught by the
  T029 depreciation e2e assertion returning 0 accrued after 31 days.
- **Controller order in `AssetsModule` is load-bearing.** `AssetController` owns
  `GET /assets/:id`, which swallows `/assets/allocations` and `/assets/stock` unless
  the controllers with a literal segment are declared first. Caught by the T021
  overdue e2e returning 404.
- **`InventoryService.getPurchaseById()` was added** so `AssetsRefsService` can
  validate `Asset.purchaseId` (FR-038) through the owning module's exported service
  rather than by reading the `inventory` schema.
- **`CompaniesService.create()` now seeds the three asset masters,** and the
  20260904200002 migration backfills them for companies that already existed.
- **`AssetRow.expiryAlert` / `alertDocumentTypes` were added after the fact,** when
  the web slice reached its T014: the register list had no expiry field to render, so
  "is any paperwork about to lapse?" could only be answered by opening each asset.
  Computed per document against its *own* doc type's `alertDays`, never a module-wide
  constant, and covered by an e2e.
