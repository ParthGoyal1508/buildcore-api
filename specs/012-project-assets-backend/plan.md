# Implementation Plan: Project Assets Backend

**Branch**: `012-project-assets-backend` | **Date**: 2026-09-01 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/012-project-assets-backend/spec.md`

## Summary

Build the `assets` schema — durable, individually-identified or bulk-tracked returnable assets that
fall between feature 009's consumables and feature 006's heavy equipment. Asset register (serialised
and bulk tracking modes) → allocation to project sites with employee custody → two-step
dispatch/receipt transfers with an `in_transit` state → allocation requests → inspection, repair,
and condemnation → stock and summary views with on-demand straight-line depreciation → reminders
registered with feature 004's centralized engine → an exported `getAssetCostByProject()` for
feature 008's P&L.

**Created by the 2026-09-01 gap-closure pass** against the module/submodule matrix, which found
row 36 uncovered. **Schema boundary ratified 2026-09-01**: its own `assets` schema, not an
extension of `inventory` or `plant`.

## Technical Context

**Language/Version**: TypeScript 5.1, Node.js, NestJS 10, Prisma 5 — unchanged.

**Primary Dependencies**: Existing only — `exceljs` (stock/summary export), `@nestjs/event-emitter`
(reminder events into 004's engine, same pattern 006 uses for fuel variance), `@nestjs/bullmq`
(async export above threshold).

**Storage**: `assets` schema (8 tables); `settings` schema gains 3 reference-data tables
(AssetCategory, AssetDocType, ConditionGrade — FR-002).

**Testing**: Jest unit tests for book-value computation (salvage floor, pre-capitalisation zero),
pro-rated depreciation across concurrent allocations (no double-count — FR-022), status machine
transitions, denomination-free bulk quantity arithmetic, inspection due-date advancement. E2e in
`test/assets.e2e-spec.ts` for the allocation/return lifecycle, two-step transfer, and concurrent
receipt.

**Performance Goals**: Stock and summary views paginated; export async above the configured row
threshold.

**Constraints**: Bulk stock must never go negative under concurrency (SC-003). Depreciation is a
computed reporting figure only — no accounting postings (FR-020).

**Scale/Scope**: 9 user stories, 38 FRs, 9 entities.

## Constitution Check

| Principle | Check | Status |
|---|---|---|
| I. Schema Boundaries | 8 tables in `assets`; 3 reference-data masters in `settings` (FR-002). Site/project via `ProjectsService`, vendor via `PartnersService`, employee via `HrService` — no cross-schema query (FR-029, FR-030). 008 reads asset cost only through the exported method (FR-021). | PASS |
| II. Validated DTOs | Every endpoint uses typed DTOs (FR-035). | PASS |
| III. No Hardcoded Values | Depreciation rate, useful life, salvage, inspection interval, alert days, transit-overdue threshold, and repair-cost threshold are all category- or company-configured, never literals. | PASS |
| IV. Multi-Tenant Isolation | All 11 tables carry `companyId`; RLS on all (FR-001). | PASS |
| V. Auth & Permissions | Adds exactly 2 enum values — `ASSETS`, `ASSETS_APPROVE` (FR-033); reuses existing `REPORTS`. | PASS |
| VI. Safe Migrations | `assets` schema and the 3 `settings` additions ship as separate migrations. Encrypted object storage for asset documents; production start refused on local-filesystem blobs (FR-028). | PASS |

## Implementation Phases

### Phase 1: Setup

- [ ] Extend `settings.Permission` enum: `ASSETS`, `ASSETS_APPROVE` only
- [ ] Add 8 `assets` models and 3 `settings` models to `prisma/schema.prisma` (data-model.md)
- [ ] Generate and apply migration(s); add RLS policies for all 11 tables
- [ ] Extend `shared.AuditLogEntry.entityType` with `ASSET`, `ASSET_ALLOCATION`, `ASSET_TRANSFER`,
      `ASSET_REQUEST`, `ASSET_INSPECTION`, `ASSET_REPAIR`
- [ ] Scaffold `AssetsModule`; export `AssetsService` with stubs for
      `getAssetCostByProject()` returning 0 and `getOutstandingCustody(employeeId)` returning []
      (005's exit flow depends on the latter — FR-036)
- [ ] Extend Settings' code-series service with an `ASSET` series type (FR-006)

### Phase 2: US1 & US2 — Masters & Asset Register (P1)

- [ ] `src/settings/asset-masters/`: `AssetCategoriesService`, `AssetDocTypesService`,
      `ConditionGradesService` (`settings` schema, exported for `AssetsModule` — Principle I)
- [ ] Enforce `trackingMode` immutability once assets exist (FR-003) and the
      `inspectionRequired`-without-interval guard
- [ ] `AssetService` + `AssetController` (serialised vs bulk registration — FR-004, opening
      `AssetStock` row for bulk, serial uniqueness → 409 — FR-008, document upload, optional
      `purchaseId` link — FR-038)
- [ ] Implement the status machine as a single guarded transition method (FR-007)
- [ ] Unit test: tracking-mode enforcement; serial uniqueness; capitalisation-date validation
- [ ] E2e test: register serialised and bulk assets; duplicate serial → 409

### Phase 3: US3 — Allocation & Custody (P1)

- [ ] `AllocationService` + controller (single open allocation per serialised asset → 409 — FR-009,
      custody-required guard, custodian-site-match guard — FR-010, bulk quantity decrement under
      the transactional guarantee — FR-011, return with condition grade driving status — FR-015)
- [ ] Implement `getOutstandingCustody()` replacing the Phase 1 stub (FR-036)
- [ ] Unit test: custody site-match rejection; condition-grade → status mapping; overdue flag
- [ ] E2e test: concurrent bulk allocations exceeding stock — no negative balance (SC-003)

### Phase 4: US7 — Stock & Summary (P1)

- [ ] `AssetStockService` + controller (serialised listed individually, bulk aggregated per site
      with on-hand / allocated / in-transit)
- [ ] `DepreciationService`: on-demand book value with salvage floor and pre-capitalisation zero
      (FR-019); summary grouped by category, project, or status
- [ ] XLSX export via `exceljs`, async above threshold (FR-037)
- [ ] Unit test: book value at many dates including past useful life and before capitalisation
- [ ] E2e test: summary totals reconcile with stock rows; scrapped assets bucketed separately

### Phase 5: US4 & US5 — Requests & Transfers (P2)

- [ ] `AssetRequestService` + controller (raise, approve requiring `ASSETS_APPROVE`, fulfil against
      an `idle` asset creating the allocation in the same transaction — FR-023, mark
      procurement-needed — FR-024, overdue flag)
- [ ] `AssetTransferService` + controller (two-step dispatch/receipt with `in_transit` —
      FR-012, receipt under a row-level lock — FR-013, partial bulk receipt recording
      `transitShortage` — FR-014, cancel requiring `ASSETS_APPROVE`)
- [ ] Unit test: fulfilment transaction; shortage arithmetic; transit-overdue flag
- [ ] E2e test: concurrent receipts — exactly one succeeds, loser gets 409

### Phase 6: US6 — Inspection, Repair & Condemnation (P2)

- [ ] `InspectionService` + controller (`nextInspectionDue` advancing from the inspection date, not
      the previous due date — FR-017; outcome driving status; condemn requiring `ASSETS_APPROVE`
      and blocked while allocated — FR-016, FR-018)
- [ ] `RepairService` + controller (open/close, computed downtime, cumulative cost and
      threshold flag)
- [ ] Unit test: late inspection does not compound the schedule; condemn-while-allocated → 409
- [ ] E2e test: inspection → repair → close → back to idle

### Phase 7: US8 — Reminders (P2)

- [ ] Register three reminder rules with feature 004's centralized engine (FR-026, ratified
      2026-09-01): `document_expiry`, `inspection_due`, `overdue_return` — evaluation, severity,
      de-duplication, and snooze all live in 004, not here
- [ ] Exclude `scrapped` assets from every rule (FR-027)
- [ ] Unit test: each rule's due-condition and days-remaining sign
- [ ] E2e test: reminders appear via 004's endpoint with no duplicate notification

### Phase 8: US9 — P&L Service Method (P3)

- [ ] Replace the stub: `getAssetCostByProject()` — pro-rated depreciation by allocated days plus
      repairs closed in range, via `ProjectsService.getSitesByProject()`
- [ ] Unit test: an asset allocated to two projects in one month — the two figures never sum to
      more than its full monthly depreciation (FR-022)

### Phase 9: Polish

- [ ] Swagger `@ApiTags('Assets')` + `@ApiOperation` on all controllers
- [ ] Verify soft-delete on assets, allocations, transfers, requests (FR-031)
- [ ] `npm run lint` + `npm run build` clean
