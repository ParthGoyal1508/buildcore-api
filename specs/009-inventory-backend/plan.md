# Implementation Plan: Inventory Backend (Stock, Purchases, Issues, Transfers, Payments)

**Branch**: `009-inventory-backend` | **Date**: 2026-08-28 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/009-inventory-backend/spec.md`

## Summary

Build the `inventory` schema — ledger-based stock tracking using dual-write (`StockBalance` for
O(1) reads + `StockLedgerEntry` for audit), `SELECT FOR UPDATE` concurrency on issue/transfer,
WAR incremental update on purchase and full-replay on deletion, atomic FIFO payment-bill
allocation, and the exported `getMaterialCostByProject()` method that resolves 008's P&L
Materials stub. One cross-module stub added to `ProjectsModule`.

**Corrected during a master-PRD alignment audit**: Item Categories and Items are `settings`-schema
masters (not `inventory`-owned), matching master PRD §7.8.6 and this project's established
convention; permission checks reuse Settings' already-existing `INVENTORY` value instead of three
invented ones; Item gains Reorder Level and HSN Code fields plus two missing units (RMT, SQM);
Issue gains an Activity/BOQ Item link; a Goods Receipt Note is now auto-created per purchase;
`quickstart.md`'s payment scenario (which described manual, client-supplied allocation) is
corrected to match the fully-automatic FIFO design every other artifact already specified. See
[research.md](research.md) for all 15 decisions (11 original + 4 corrections).

## Technical Context

**Language/Version**: TypeScript 5.1, Node.js, NestJS 10, Prisma 5 against PostgreSQL — unchanged.

**Primary Dependencies**: Existing — `class-validator`/`class-transformer`, `@nestjs/swagger`,
001/002's guards, 005/007/008's object-storage pattern for bill file uploads. First use of Prisma
`$queryRaw` for `SELECT FOR UPDATE` (pre-approved — Prisma raw SQL, not a new package).

**Storage**: PostgreSQL via Prisma — new `inventory` schema with 9 operational tables (adds
`GoodsReceiptNote`, research.md §14); 2 new `settings`-schema tables (`ItemCategory`, `Item`,
corrected placement — research.md §1).

**Testing**: Jest unit tests for `StockService.recomputeWAR()`, `StockService.toRow()`,
`PaymentService` allocation validation. E2e in `test/inventory.e2e-spec.ts` for purchase
create/delete, issue concurrency check, payment allocation + reversal.

**Target Platform**: Linux server (Node.js), same as rest of `buildcore-api`.

**Performance Goals**: `GET /inventory/stock` under 500ms for 500 item-site rows (O(1) reads
from `StockBalance`). `getMaterialCostByProject()` under 1 second for 500 purchases (SC-005).

**Constraints**: `inventory` schema never queries `projects`/`partners`/`settings` schemas
directly — only via exported service calls (Principle I), including its own Item/Category
masters (§1); `StockLedgerEntry` is append-only — no updates or hard deletes permitted; `SELECT
FOR UPDATE` via `$queryRaw` for issue/transfer validation (research.md §4); all 11 tables
`companyId`-scoped with RLS (Principle IV); `stockValue`/`belowReorderLevel` never stored
(research.md §11, §12); payment allocation atomic and fully automatic FIFO — no client-supplied
allocation (research.md §7).

**Scale/Scope**: 11 new tables (9 `inventory` + 2 `settings`), ~20 endpoints, 0 new Permission
enum values (reuses `INVENTORY`/`SETTINGS`, corrected), 1 exported P&L service method, 1
cross-module stub added to ProjectsModule.

## Constitution Check

| Principle | Check | Status |
|---|---|---|
| I. Schema-Per-Module Boundaries | 9 operational tables in `inventory`; `ItemCategory`/`Item` in `settings` (corrected, research.md §1) with CRUD via `SettingsService`-exported methods. Vendor names via `PartnersService.getVendorById()` — exported in-process method (research.md §12 there), not the HTTP endpoint. Site resolution via `ProjectsService.getSitesByProject()` stub; Issue's Activity/BOQ Item via `ProjectsService` (research.md §13). No direct cross-schema queries. | PASS |
| II. Validated DTO Contracts | Every endpoint uses typed DTOs. | PASS |
| III. Centralized Configuration | No hardcoded values. Item code series via `CodeSeriesService`. Reorder Level is per-item config, not a hardcoded threshold (research.md §12). | PASS |
| IV. Multi-Tenant Isolation | All 11 tables carry `companyId`; RLS on all. `StockBalance` UNIQUE on `(itemId, siteId)` — scoped within company. | PASS |
| V. Authentication & Authorization | Every endpoint behind `JwtAuthGuard` + `@RequirePermission(INVENTORY)`, reusing 002's existing value; Item/Category masters behind `SETTINGS` (corrected, research.md §9). | PASS |
| VI. Observability & Safe Migrations | `inventory` and `settings` schema changes shipped as separate, logically-grouped migrations. All schema changes via `prisma migrate`. `SELECT FOR UPDATE` via `$queryRaw` — no ORM bypass of Prisma's safety model. | PASS |

## Project Structure

```text
src/
├── settings/
│   ├── item-masters/                 # NEW — settings schema (research.md §1)
│   │   ├── item-categories.service.ts
│   │   ├── items.service.ts
│   │   └── dto/
│   └── permission.enum.ts            # unchanged — INVENTORY/SETTINGS already exist
├── inventory/
│   ├── inventory.module.ts
│   ├── categories/
│   │   └── categories.controller.ts  # thin proxy to settings/item-masters service
│   ├── items/
│   │   └── items.controller.ts       # thin proxy to settings/item-masters service
│   ├── stock/
│   │   ├── stock.controller.ts
│   │   ├── stock.service.ts       # dual-write, WAR, SELECT FOR UPDATE, recomputeWAR(),
│   │   │                          #   belowReorderLevel (research.md §12)
│   │   └── dto/
│   ├── purchases/
│   │   ├── purchases.controller.ts
│   │   ├── purchases.service.ts   # + GoodsReceiptNote creation (research.md §14)
│   │   └── dto/
│   ├── issues/
│   │   ├── issues.controller.ts
│   │   ├── issues.service.ts      # + activityId/boqItemId validation (research.md §13)
│   │   └── dto/
│   ├── transfers/
│   │   ├── transfers.controller.ts
│   │   ├── transfers.service.ts
│   │   └── dto/
│   └── payments/
│       ├── payments.controller.ts
│       ├── payments.service.ts    # fully automatic FIFO, no client-supplied allocation
│       └── dto/
src/projects/
│   └── portfolio/projects.service.ts  # MODIFIED: +getSitesByProject() stub export

prisma/schema.prisma                # MODIFIED: inventory schema (9 models), settings schema
                                     #   (+ItemCategory, +Item)

test/
└── inventory.e2e-spec.ts          # new
```

## Implementation Phases

### Phase 1: Setup & Schema

- [ ] No `Permission` enum changes needed — reuse Settings' already-existing `INVENTORY` and
      `SETTINGS` values verbatim (corrected, research.md §9)
- [ ] Add the 9 operational `inventory` schema models (including `GoodsReceiptNote`, research.md
      §14) and the `settings.ItemCategory`/`settings.Item` models (corrected placement —
      research.md §1) to `prisma/schema.prisma` (data-model.md)
- [ ] Generate and apply migrations for `inventory` and `settings` schema changes
- [ ] Add RLS policies for all 11 tables
- [ ] Extend `shared.AuditLogEntry.entityType` with 7 new inventory values (including
      `GOODS_RECEIPT_NOTE`)
- [ ] Scaffold `InventoryModule`; export `InventoryService` with stub
      `getMaterialCostByProject()` returning 0 immediately
- [ ] Scaffold `src/settings/item-masters/` with `ItemCategoriesService`, `ItemsService`
      (`settings` schema, exported for `InventoryModule`'s thin controller proxies to call —
      Principle I, research.md §1)
- [ ] Add `getSitesByProject(projectId): Promise<string[]>` stub to
      `src/projects/portfolio/projects.service.ts` and export from `ProjectsModule` —
      TODO(008) comment (same pattern as 007's T011c)
- [ ] Add `ITEMS` code-series seed entry to `prisma/seed.ts`; seed all 10 master-PRD-named
      `ItemCategory` defaults (research.md §15, corrected from 8)

**Checkpoint**: Schema, permissions, stubs ready. All phases proceed in parallel.

### Phase 2: US1 & US2 — Item Categories and Items (P1)

- [ ] Category DTOs + `ItemCategoriesService` (`settings` schema — uppercase name, delete guard)
      in `src/settings/item-masters/`; thin `CategoriesController` proxy in
      `src/inventory/categories/`, guarded with `SETTINGS`
- [ ] Item DTOs (including `reorderLevel?`, `hsnCode?`, full 8-value `unit` enum — research.md
      §12) + `ItemsService` (`settings` schema — code-series, unique name, delete guard) in
      `src/settings/item-masters/`; thin `ItemsController` proxy in `src/inventory/items/`,
      guarded with `SETTINGS`
- [ ] Unit test: duplicate category → 409; delete linked category → 409; item with all 8 units
      accepted

### Phase 3: US3 — Purchases (P1)

- [ ] Purchase + PurchaseBill DTOs + `PurchasesService`: `create` (dual-write, WAR update,
      PurchaseBill creation, auto-created `GoodsReceiptNote` — research.md §14), `delete`
      (soft-delete, reversal ledger, WAR replay via `StockService.recomputeWAR()`, allocation
      guard → 409)
- [ ] `PurchasesController` + `PATCH` (date/remarks only)
- [ ] Unit test: WAR incremental formula; WAR replay after deletion
- [ ] E2e test: create purchase → stock balance; delete → balance reverts; delete with
      allocation → 409

### Phase 4: US4 — Issues (P1)

- [ ] Issue DTOs (with `activityId?`/`boqItemId?`, one required — research.md §13) +
      `IssuesService`: `create` (`SELECT FOR UPDATE` on `StockBalance`, `422` if insufficient,
      validates activity/BOQ item via `ProjectsService`, dual-write), `delete` (reversal, guard
      negative-issued check)
- [ ] `IssuesController`
- [ ] E2e test: over-issue → 422 with availableStock; concurrent issues (simulate with 2 rapid
      requests) → exactly one succeeds

### Phase 5: US5 — Transfers (P2)

- [ ] Transfer DTOs + `TransfersService`: `create` (same-site guard → 400, `SELECT FOR UPDATE`,
      atomic dual `StockBalance` update), `delete` (atomic reversal)
- [ ] `TransfersController`

### Phase 6: US6 — Stock View (P1)

- [ ] `StockService.getStock(companyId, filters)` reading from `StockBalance` with
      `toRow()` computing `inStock`, `stockValue`, and `belowReorderLevel` (research.md §12)
- [ ] `GET /inventory/stock/:itemId/:siteId` utility endpoint (for Issue/Transfer form hints)
- [ ] `StockController`
- [ ] Unit test: `toRow()` arithmetic; zero-balance row still returned; `belowReorderLevel`
      flips correctly around the item's `reorderLevel` threshold

### Phase 7: US7 — Payments (P2)

- [ ] Payment DTO (amount/date/mode/reference only — no client-supplied allocation, corrected)
      + `PaymentsService`: fully automatic FIFO allocation against the vendor's oldest
      unpaid/part-paid bills first (research.md §7), atomic transaction (payment + allocations +
      bill updates), delete reversal, `GET /inventory/bills` utility
- [ ] `PaymentsController`
- [ ] Unit test: FIFO allocates oldest bill first; partial allocation → correct bill statuses;
      amount exceeding total outstanding → all bills paid + `unallocatedBalance` recorded
- [ ] E2e test: full payment lifecycle; delete reversal

### Phase 8: US8 — getMaterialCostByProject (P3)

- [ ] Replace stub in `InventoryService.getMaterialCostByProject()` with real implementation
      calling `ProjectsService.getSitesByProject()` + purchase sum query; graceful 0 on failure
- [ ] Unit test: correct sum within date range; excludes soft-deleted purchases

### Phase 9: Polish

- [ ] Swagger `@ApiTags('Inventory')` + `@ApiOperation` on all controllers
- [ ] `npm run lint` + `npm run build` clean

## TODO

- `TODO(008)`: Implement real `ProjectsService.getSitesByProject(projectId)` returning actual
  site IDs for a project — required for `getMaterialCostByProject()` to return real values.

---

## Amendment 2026-09-01 — Material Request / Indent Workflow

Covers spec FR-021 to FR-030. Adds 2 `inventory` tables; adds 1 permission value
(`INVENTORY_APPROVE`).

**Constitution re-check**: Principle I — both tables in `inventory`; activity/BOQ references
resolved via `ProjectsService` as FR-019 already does. Principle III — no thresholds hardcoded.
Principle IV — `companyId` + RLS. Principle V — adds exactly one value. PASS.

**Key invariant**: indent approval must not reserve stock (FR-025). The existing transactional
quantity validation at issue time (FR-003) stays the single point of stock enforcement, so this
amendment cannot introduce a path to a negative balance.

### Phase A1: Schema

- [ ] Add `MaterialIndent` and `MaterialIndentLine` models; migration + RLS
- [ ] Extend `settings.Permission` enum with `INVENTORY_APPROVE` (FR-029)
- [ ] Extend `shared.AuditLogEntry.entityType` with `MATERIAL_INDENT`
- [ ] Extend Settings' code-series service with an `INDENT` series type (FR-021)

### Phase A2: US9 — Indents (P1)

- [ ] `IndentService` + `IndentController` (raise with lines, inactive-item guard → 400, approve
      with per-line quantity reduction requiring `INVENTORY_APPROVE` and a reason — FR-022, reject
      requiring a reason, cancel guard once any fulfilment exists → 409 — FR-026)
- [ ] Wire optional `indentLineId` onto the existing issue and purchase flows, updating
      `fulfilledQuantity` and the indent status in the same transaction (FR-023) and rejecting
      over-fulfilment (FR-024)
- [ ] `mark-procurement-needed` endpoint and the procurement-needed report combining indent demand
      with reorder-level shortfall, reported separately so the two are not double-counted (FR-027)
- [ ] Overdue flagging against `requiredByDate`
- [ ] Unit test: outstanding = approved − fulfilled at every step; over-fulfilment rejection;
      procurement report keeps the two demand sources distinct
- [ ] E2e test: approving an indent leaves every stock balance byte-identical (SC-A02)
