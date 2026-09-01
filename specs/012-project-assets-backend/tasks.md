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

- [ ] T001 [P] Extend `src/settings/permission.enum.ts`: `ASSETS`, `ASSETS_APPROVE` only — reuse
      the existing `REPORTS` value verbatim (spec FR-033)
- [ ] T002 Add the 8 `assets` models and the 3 `settings` reference-data models (AssetCategory,
      AssetDocType, ConditionGrade) to `prisma/schema.prisma` — data-model.md
- [ ] T003 Generate and apply migration(s); add RLS policies for all 11 tables; unique index on
      `AssetStock(assetId, siteId)` and on `Asset.serialNumber` per company (spec FR-008)
- [ ] T004 [P] Extend `shared.AuditLogEntry.entityType` with `ASSET`, `ASSET_ALLOCATION`,
      `ASSET_TRANSFER`, `ASSET_REQUEST`, `ASSET_INSPECTION`, `ASSET_REPAIR` (spec FR-034)
- [ ] T005 Scaffold `AssetsModule` in `src/assets/assets.module.ts`; export `AssetsService` with
      stubs `getAssetCostByProject()` returning 0 and `getOutstandingCustody(employeeId)` returning
      `[]` — 008's P&L and 005's exit flow depend on them
- [ ] T006 [P] Extend Settings' code-series service with an `ASSET` series type (spec FR-006)
- [ ] T007 [P] Scaffold `src/settings/asset-masters/` with `AssetCategoriesService`,
      `AssetDocTypesService`, `ConditionGradesService` (`settings` schema, exported — Principle I)

**Checkpoint**: Schema, permissions, masters, and the two exported stubs are ready.

---

## Phase 2: US1 & US2 — Masters & Asset Register (Priority: P1)

- [ ] T008 [P] [US1] `AssetCategoriesService` (T007): CRUD; `trackingMode` immutable once assets
      exist → 409 (spec FR-003); `inspectionRequired` without `inspectionIntervalDays` → 400;
      delete guard → 409; list returns `assetCount` and `totalBookValue`
- [ ] T009 [P] [US1] `AssetDocTypesService` and `ConditionGradesService` (T007) — condition grades
      carry the `isDamaged` / `isScrap` semantics that drive the return-status mapping
- [ ] T010 [US1] Thin master controllers in `src/assets/masters/` calling T008/T009, guarded with
      `SETTINGS`
- [ ] T011 [US2] `AssetService` in `src/assets/assets.service.ts`: serialised registration
      (quantity > 1 → 400, spec FR-004), bulk registration opening the `AssetStock` row,
      serial-number uniqueness → 409, `capitalisationDate` ≥ `purchaseDate` → 400, optional
      `purchaseId` acquisition link (spec FR-038)
- [ ] T012 [US2] Implement the asset status machine as a single guarded transition method rejecting
      out-of-machine transitions with the permitted ones named (spec FR-007)
- [ ] T013 [US2] Asset document upload to encrypted object storage; refuse production start on
      local-filesystem blobs (spec FR-028)
- [ ] T014 [US2] `AssetController` with `@RequirePermission(ASSETS)`; list returning location,
      custodian, status, condition, and current book value
- [ ] T015 [P] [US2] Unit test: tracking-mode enforcement, serial uniqueness, capitalisation-date
      validation, every status transition
- [ ] T016 [P] [US2] E2e test: register serialised and bulk assets; duplicate serial → 409

**Checkpoint**: The register exists and is independently usable.

---

## Phase 3: US3 — Allocation & Custody (Priority: P1)

- [ ] T017 [US3] `AllocationService` in `src/assets/allocations/allocation.service.ts`: one open
      allocation per serialised asset → 409 (spec FR-009); `custodyRequired` guard → 400
- [ ] T018 [US3] Custodian site-match guard — the employee's active site must equal the allocation
      site, resolved via `HrService` → 400 otherwise (spec FR-010, FR-030)
- [ ] T019 [US3] Bulk allocation decrementing `AssetStock` under the transactional non-negative
      guarantee (spec FR-011) — never an application-level read-then-write
- [ ] T020 [US3] Return: close the allocation, map the condition grade to `idle` /
      `under_repair` / `scrapped` (spec FR-015), clear custody
- [ ] T021 [US3] `overdue` flag derived from `expectedReturnDate`; replace the T005
      `getOutstandingCustody()` stub so 005's exit flow can surface assets to recover (spec FR-036)
- [ ] T022 [US3] `AllocationController` with permission guards
- [ ] T023 [P] [US3] Unit test: custody site-match rejection, condition→status mapping, overdue
- [ ] T024 [P] [US3] E2e test: concurrent bulk allocations exceeding stock — no negative balance
      (SC-003)

**Checkpoint**: The matrix's "Project Assets" view (which assets are at which project) works.

---

## Phase 4: US7 — Stock & Summary (Priority: P1)

- [ ] T025 [US7] `AssetStockService`: serialised listed individually; bulk aggregated per site with
      on-hand / allocated / in-transit
- [ ] T026 [US7] `DepreciationService`: on-demand book value floored at `salvageValue`, never
      negative, zero before `capitalisationDate` (spec FR-019); no accounting postings (spec FR-020)
- [ ] T027 [US7] Summary grouped by category, project, or status with counts, original cost,
      accumulated depreciation, and book value; scrapped assets in a separate bucket
- [ ] T028 [US7] XLSX export via `exceljs`, async via bullmq above the configured row threshold
      (spec FR-037)
- [ ] T029 [P] [US7] Unit test: book value at many dates including past useful life and before
      capitalisation (SC-008)
- [ ] T030 [P] [US7] E2e test: summary totals reconcile with stock rows; cross-company read blocked
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
