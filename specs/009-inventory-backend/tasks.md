---

description: "Task list for feature implementation"
---

# Tasks: Inventory Backend (Stock, Purchases, Issues, Transfers, Payments)

**Input**: Design documents from `/specs/009-inventory-backend/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/inventory-api.md,
quickstart.md

**Tests**: Included for WAR computation, stock balance arithmetic, payment allocation validation,
and e2e coverage for purchase/issue/concurrency/payment lifecycle — these are financial and
concurrency-sensitive paths.

**Organization**: Tasks grouped by user story (US1–US8).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: User story (US1–US8)
- Every task includes an exact file path

---

## Phase 1: Setup (Shared Infrastructure)

- [ ] T001 [P] No `Permission` enum changes needed — reuse Settings' already-existing
      `INVENTORY` and `SETTINGS` values verbatim (corrected during a master-PRD alignment audit
      — spec FR-013, research.md §9; this task originally added `INVENTORY_STOCK`/
      `INVENTORY_PURCHASES`/`INVENTORY_PAYMENTS`)
- [ ] T002 Add the 9 operational `inventory` schema models to `prisma/schema.prisma`:
      `StockBalance` (include `companyId` field for RLS consistency — M-007 remediation),
      `StockLedgerEntry`, `Purchase`, `GoodsReceiptNote` (research.md §14), `PurchaseBill`,
      `Issue` (with `activityId?`/`boqItemId?`, research.md §13), `StockTransfer`, `Payment`,
      `PaymentAllocation`; plus `settings.ItemCategory` and `settings.Item` (with
      `reorderLevel?`/`hsnCode?`/full 8-unit enum, corrected placement — research.md §1, §12) —
      data-model.md
- [ ] T003 Generate and apply the `inventory` and `settings` schema migrations — Constitution
      Principle VI
- [ ] T004 [P] Add RLS policies for all 11 tables (9 `inventory` + 2 `settings`) — Constitution
      Principle IV
- [ ] T005 [P] Extend `shared.AuditLogEntry.entityType` with: `ITEM_CATEGORY`, `ITEM`,
      `PURCHASE`, `GOODS_RECEIPT_NOTE`, `ISSUE`, `STOCK_TRANSFER`, `PAYMENT`
- [ ] T006 Scaffold `InventoryModule` in `src/inventory/inventory.module.ts`; export
      `InventoryService` with stub `getMaterialCostByProject()` returning 0 immediately so
      `ProjectsModule` can inject it from day one
- [ ] T006a [P] Scaffold `src/settings/item-masters/` with `ItemCategoriesService`,
      `ItemsService` (`settings` schema, exported for `InventoryModule`'s thin controller
      proxies to call — Principle I, research.md §1)
- [ ] T007 [P] Add `getSitesByProject(projectId): Promise<string[]>` stub to
      `src/projects/portfolio/projects.service.ts` and export from `ProjectsModule` —
      TODO(008) comment; same pattern as 007's T011c / BOCW stub
- [ ] T007a [P] Add `getActivityById()`/`getBoqItemById()` stubs to `ProjectsModule`'s exported
      interface for Issue's `activityId`/`boqItemId` validation (research.md §13) — TODO(008)
      comment if 008 hasn't shipped the real implementations yet
- [ ] T008 [P] Add `ITEMS` code-series seed entry to `prisma/seed.ts` — research.md §10

**Checkpoint**: Schema, permissions, stubs, and module scaffold ready. All user story phases
can proceed in parallel.

---

## Phase 2: User Story 1 — Item Categories (Priority: P1) 🎯 MVP

**Goal**: Category CRUD with uppercase name storage, delete guard, all 10 seeded defaults.

**Independent Test**: Create category, edit it, delete unlinked (200), delete linked (409).

### Implementation for User Story 1

- [ ] T009 [P] [US1] Create `src/settings/item-masters/dto/create-category.dto.ts` and
      `update-category.dto.ts`; name is uppercased in service before write
- [ ] T010 [P] [US1] Implement `ItemCategoriesService` (`settings` schema, corrected —
      research.md §1) in `src/settings/item-masters/item-categories.service.ts`: `create`
      (unique name → 409), `findAll` (with `itemCount`), `update`, `delete` (linked items →
      409); all writes audit-logged
- [ ] T011 [US1] Implement a thin `CategoriesController` in
      `src/inventory/categories/categories.controller.ts` calling the `settings` service above
      (Principle I): all 4 endpoints, `@RequirePermission(Permission.SETTINGS)` (corrected —
      research.md §9)
- [ ] T012 [P] [US1] Add all 10 default `ItemCategory` seed rows to `prisma/seed.ts`: CEMENT,
      AGGREGATE, STEEL, BRICKS, SAND, PAINT, ELECTRICAL, PLUMBING, FUEL, CONSUMABLES (corrected
      from 8 — research.md §15)

**Checkpoint**: Category CRUD functional and seeded.

---

## Phase 3: User Story 2 — Item Masters (Priority: P1)

**Goal**: Item CRUD with auto-generated code, unique name, category link, delete guard.

**Independent Test**: Create item with category and unit; edit description; delete unlinked
(200), delete with purchase history (409).

### Implementation for User Story 2

- [ ] T013 [P] [US2] Create `src/settings/item-masters/dto/create-item.dto.ts` and
      `update-item.dto.ts` with the full 8-value unit enum (BAG/CUM/KG/NOS/MT/LTR/RMT/SQM,
      research.md §12) and optional `reorderLevel`/`hsnCode` fields
- [ ] T014 [P] [US2] Implement `ItemsService` (`settings` schema, corrected — research.md §1)
      in `src/settings/item-masters/items.service.ts`: `create` (CodeSeriesService 'ITEMS',
      unique name → 409), `findAll` (paginated, filterable by category), `update`, `delete`
      (Purchase/Issue/Transfer linked → 409); audit-logged
- [ ] T015 [US2] Implement a thin `ItemsController` in
      `src/inventory/items/items.controller.ts` calling the `settings` service above: all 4
      endpoints, `@RequirePermission(Permission.SETTINGS)` (corrected — research.md §9)

**Checkpoint**: Item master CRUD functional; item codes auto-generated.

---

## Phase 4: User Story 3 — Purchases (Priority: P1)

**Goal**: Purchase CRUD with dual-write (`StockLedgerEntry` + `StockBalance` upsert + WAR
increment), `PurchaseBill` creation, soft-delete with WAR replay, allocation guard.

**Independent Test**: Create purchase → verify `StockBalance` received/WAR; second purchase →
verify WAR recalculates; delete first → WAR replays from remaining; delete with allocation → 409.

### Implementation for User Story 3

- [ ] T016 [P] [US3] Create purchase DTOs in `src/inventory/purchases/dto/`:
      `create-purchase.dto.ts` (multipart — siteId, itemId, vendorId, date, quantity, rate),
      `update-purchase.dto.ts` (date and remarks only — quantity/rate immutable)
- [ ] T017 [P] [US3] Implement `StockService` in `src/inventory/stock/stock.service.ts`:
      - `upsertBalanceForPurchase(tx, itemId, siteId, qty, rate)`: upsert `StockBalance`,
        increment `received`, compute WAR incrementally (research.md §3)
      - `recomputeWAR(tx, itemId, siteId)`: replay all non-deleted purchase ledger entries
        chronologically, write final WAR to `StockBalance` (called on purchase soft-delete)
      - `toRow(balance, itemName, siteName, category, unit, reorderLevel): StockRow`: compute
        `inStock`, `stockValue`, and `belowReorderLevel` (research.md §11, §12)
- [ ] T018 [P] [US3] Unit test `StockService`:
      - WAR incremental formula: 2 purchases → correct WAR
      - WAR replay after first purchase deleted → WAR = second purchase rate
      - `toRow()` arithmetic: inStock and stockValue correct
      - `src/inventory/stock/stock.service.spec.ts`
- [ ] T019 [US3] Implement `PurchasesService` in
      `src/inventory/purchases/purchases.service.ts`:
      - `create`: Prisma transaction — append `StockLedgerEntry` (purchase), call
        `StockService.upsertBalanceForPurchase()`, create `PurchaseBill` (unpaid), auto-create a
        `GoodsReceiptNote` linked 1:1 to the purchase (research.md §14), store `billFileRef` via
        encrypted object-storage reference (same pattern as 005/008 `EmployeeDocument` /
        `ProjectDocument`) — H-002 remediation, audit-log
      - `delete`: check `PaymentAllocation` → 409 if allocated; soft-delete; append
        `purchase_reversal` ledger entry; decrement `StockBalance.received`; call
        `StockService.recomputeWAR()`; audit-log
      - `findAll`: paginated with vendor name via `PartnersService.getVendorById()` (exported
        in-process method, `007-partners-backend` research.md §12 — never the HTTP endpoint)
- [ ] T020 [US3] Implement `PurchasesController` in
      `src/inventory/purchases/purchases.controller.ts`: all endpoints,
      `@RequirePermission(Permission.INVENTORY)` (corrected — research.md §9)
- [ ] T021 [US3] E2e test: create purchase → stock balance correct; delete → balance reverts;
      delete with allocation → 409 — `test/inventory.e2e-spec.ts` (create file)

**Checkpoint**: Purchases and dual-write fully functional.

---

## Phase 5: User Story 4 — Issues (Priority: P1)

**Goal**: Issue creation with `SELECT FOR UPDATE` concurrency, quantity validation, dual-write;
soft-delete with reversal.

**Independent Test**: Over-issue → 422 with `availableStock`; concurrent over-issue → exactly
one 422; delete → balance reverts.

### Implementation for User Story 4

- [ ] T022 [P] [US4] Create `src/inventory/issues/dto/create-issue.dto.ts` with
      siteId, itemId, date, quantity, issuedTo, `activityId`/`boqItemId` (one required,
      research.md §13), remarks validation
- [ ] T023 [P] [US4] Add `validateAndLockStock(tx, itemId, siteId, qty): Promise<number>`
      to `StockService`: Prisma `$queryRaw` with `SELECT ... FOR UPDATE` on `StockBalance`,
      compute `inStock`, throw `422 { availableStock: inStock }` if `qty > inStock` —
      research.md §4, spec FR-003
- [ ] T024 [P] [US4] Unit test `StockService.validateAndLockStock()`: sufficient stock →
      returns balance; insufficient → throws with `availableStock` — use mocked transaction
      `src/inventory/stock/stock.service.spec.ts`
- [ ] T025 [US4] Implement `IssuesService` in `src/inventory/issues/issues.service.ts`:
      `create` (Prisma transaction: validate `activityId`/`boqItemId` via `ProjectsService`
      — research.md §13, `validateAndLockStock()`, append `issue` ledger entry, increment
      `StockBalance.issued`; audit-log), `delete` (soft-delete, `issue_reversal` entry, decrement
      `issued`, guard negative-issued check → 422), `findAll`
- [ ] T026 [US4] Implement `IssuesController` in
      `src/inventory/issues/issues.controller.ts`: `@RequirePermission(Permission.INVENTORY)`
      (corrected — research.md §9)
- [ ] T027 [US4] E2e test: over-issue → 422 `availableStock`; two rapid concurrent issues
      for last stock unit → exactly one succeeds — `test/inventory.e2e-spec.ts`

**Checkpoint**: Issue creation with concurrency protection functional.

---

## Phase 6: User Story 6 — Stock View (Priority: P1)

**Goal**: Paginated stock rows from `StockBalance` with computed `inStock` + `stockValue`; stock
hint endpoint for Issue/Transfer forms.

**Independent Test**: Seed purchases/issues; call `GET /inventory/stock`; verify each row's
arithmetic matches the seeded data; verify hint endpoint returns correct inStock for item-site.

### Implementation for User Story 6

- [ ] T028 [P] [US6] Implement `StockController` in
      `src/inventory/stock/stock.controller.ts`:
      - `GET /inventory/stock` — reads `StockBalance` rows, calls `StockService.toRow()` per row
        (including `belowReorderLevel` from the item's `reorderLevel`, research.md §12);
        resolves site name via `ProjectsService.getSiteById()`, vendor name not needed here
      - `GET /inventory/stock/:itemId/:siteId` — single item-site hint
      - `@RequirePermission(Permission.INVENTORY)` (corrected — research.md §9)
- [ ] T029 [P] [US6] Unit test `StockService.toRow()`: all four balance fields, zero-inStock
      row still returned, `stockValue` rounds correctly, `belowReorderLevel` flips correctly
      around the item's `reorderLevel` threshold

**Checkpoint**: Stock view and hint endpoint functional; used by Issue/Transfer forms.

---

## Phase 7: User Story 5 — Transfers (Priority: P2)

**Goal**: Transfer creation with same-site guard, `SELECT FOR UPDATE` on source, atomic dual
`StockBalance` update; soft-delete with paired reversals.

**Independent Test**: Transfer 30 from A to B (A 100 → 70, B 0 → 30); over-transfer → 422;
same-site → 400; delete → both balances revert.

### Implementation for User Story 5

- [ ] T030 [P] [US5] Create `src/inventory/transfers/dto/create-transfer.dto.ts` with
      `fromSiteId ≠ toSiteId` validation
- [ ] T031 [US5] Implement `TransfersService` in
      `src/inventory/transfers/transfers.service.ts`:
      `create` (Prisma transaction: `fromSiteId === toSiteId → 400`,
      `validateAndLockStock()` on source `StockBalance`,
      append `transfer_out` + `transfer_in` ledger entries,
      `update` source `StockBalance` (decrements transferOut),
      `upsert` destination `StockBalance` (lazy creation if item never received at that
      site — H-001 remediation: destination may not exist yet, must be upsert not update),
      atomically; audit-log),
      `delete` (both reversal entries, atomic balance revert), `findAll`
- [ ] T032 [US5] Implement `TransfersController` in
      `src/inventory/transfers/transfers.controller.ts`: `@RequirePermission(Permission.
      INVENTORY)` (corrected — research.md §9)

**Checkpoint**: Transfer CRUD functional.

---

## Phase 8: User Story 7 — Payments & Bill Allocation (Priority: P2)

**Goal**: FIFO payment allocation — system auto-allocates oldest bills first, no manual selection.

**Independent Test**: Seed oldest bill ₹5,000 + newer bill ₹3,000 for a vendor. Record ₹7,000
payment — oldest bill → paid, newer bill → part_paid. Record ₹1,000 — newer bill → paid.
Delete first payment — both bills revert.

### Implementation for User Story 7

- [ ] T033 [P] [US7] Create `src/inventory/payments/dto/create-payment.dto.ts` with
      `vendorId`, `amount`, `date`, `paymentMode`, `referenceNumber` fields only —
      no allocations array (FIFO is automatic)
- [ ] T034 [P] [US7] Implement `PaymentsService` in
      `src/inventory/payments/payments.service.ts`:
      - `create`: Prisma transaction — fetch vendor's unpaid/part-paid bills ordered by
        `date ASC` (FIFO), `SELECT ... FOR UPDATE` on each, greedily allocate payment amount
        across bills, create `PaymentAllocation` rows, update `PurchaseBill.paidAmount` +
        `paymentStatus`, set `Payment.allocatedAmount` + `unallocatedBalance`; audit-log
      - `delete`: reverse all FIFO allocations atomically with bill-row lock; re-derive statuses
      - `findAll` (with `allocatedBillCount`, `unallocatedBalance`)
      - Remove `getOutstandingBills()` utility — no longer needed for manual allocation
- [ ] T035 [P] [US7] Unit test `PaymentsService`:
      - FIFO order: oldest bill gets paid first
      - excess payment: all bills paid, `unallocatedBalance = amount − total outstanding`
      - partial payment: oldest bill paid first, second bill part-paid
      - delete reversal → bills revert
      - `src/inventory/payments/payments.service.spec.ts`
- [ ] T036 [US7] Implement `PaymentsController` in
      `src/inventory/payments/payments.controller.ts`: all endpoints,
      `@RequirePermission(Permission.INVENTORY)` (corrected — research.md §9)
- [ ] T037 [US7] E2e test: full payment lifecycle (FIFO allocation, no client-supplied
      allocation array); delete reversal; payment amount exceeding total outstanding → all bills
      paid + `unallocatedBalance` recorded (not a `400` — over-payment is allowed, corrected to
      match the automatic-FIFO design) — `test/inventory.e2e-spec.ts`

**Checkpoint**: Payment allocation fully functional.

---

## Phase 9: User Story 8 — getMaterialCostByProject (Priority: P3)

**Goal**: Implement the exported method resolving 008's P&L Materials stub.

### Implementation for User Story 8

- [ ] T038 [US8] Replace stub in `InventoryService.getMaterialCostByProject()`: call
      `ProjectsService.getSitesByProject(projectId)` stub, query
      `SUM(Purchase.amount) WHERE siteId IN [...] AND date BETWEEN ... AND deleted = false`;
      return 0 gracefully on empty sites or ProjectsService error — research.md §8
- [ ] T039 [US8] Unit test: correct sum for purchases in date range; excludes soft-deleted;
      returns 0 for empty project — `src/inventory/inventory.service.spec.ts`

**Checkpoint**: All 8 user stories complete.

---

## Phase 10: Polish & Cross-Cutting

- [ ] T040 [P] Add Swagger `@ApiTags('Inventory')` + `@ApiOperation` to all 7 controllers
- [ ] T041 [P] `npm run lint` and fix issues
- [ ] T042 [P] `npm run build` typecheck and fix issues
- [ ] T043 [P] Add `TODO(008)` comments in `InventoryService.getMaterialCostByProject()` and
      `ProjectsService.getSitesByProject()` stub

---

## Dependencies

```
Phase 1 (Schema) ──┬── US1 (Categories) ──┐
                   ├── US2 (Items) ─────────┤
                   └── US6 (Stock view) ─── US3 (Purchases) ─┬── US4 (Issues)
                                                               ├── US5 (Transfers)
                                                               └── US7 (Payments)
                                                               └── US8 (P&L method)
```

US1 and US2 can start immediately after Phase 1. US3 requires `StockService` (T017) which
must exist before Phase 4/5/6. US4/US5/US6 depend on US3 (need stock in the DB). US7
depends on US3 (needs `PurchaseBill` rows). US8 depends on US3 (needs purchases to sum).

## Parallel execution opportunities

- T009, T010, T011, T012 (US1) and T013, T014, T015 (US2) are fully parallel
- T017, T018 (`StockService`) and T016 (purchase DTOs) are parallel within Phase 4
- T022, T023, T024 (issue DTO + lock) and T028, T029 (stock view) are parallel
- T030 (transfer DTO) and T033, T034, T035 (payment) are parallel
- T038, T039 (US8) are parallel with T040–T043 (polish)

## Implementation Strategy

**MVP (Phase 1–6, US1–US4 + US6)**: Schema, categories, items, purchases, issues, and stock
view. Delivers functional real-time stock tracking.

**Increment 2 (Phase 7, US5)**: Transfers — inter-site material movement.

**Increment 3 (Phase 8–9, US7–US8)**: Payments + getMaterialCostByProject.

---

## Amendment 2026-09-01 — Material Request / Indent Workflow

Covers spec FR-021 to FR-030 and plan Phases A1–A2. Task IDs prefixed `TA`.

**Key invariant**: indent approval must not reserve stock (spec FR-025). The existing transactional
quantity validation at issue time (FR-003) stays the single point of stock enforcement, so this
amendment cannot introduce a path to a negative balance.

- [ ] TA001 Add `MaterialIndent` and `MaterialIndentLine` models to `prisma/schema.prisma`;
      migration + RLS
- [ ] TA002 [P] Extend `src/settings/permission.enum.ts` with `INVENTORY_APPROVE` (spec FR-029) —
      every other indent endpoint reuses the existing `INVENTORY` value
- [ ] TA003 [P] Extend `shared.AuditLogEntry.entityType` with `MATERIAL_INDENT` (spec FR-030)
- [ ] TA004 [P] Extend Settings' code-series service with an `INDENT` series type (spec FR-021)
- [ ] TA005 [US9] `IndentService` + `IndentController` in `src/inventory/indents/`: raise with
      header and lines, inactive-item guard → 400, optional `activityId` / `boqItemId` resolved via
      `ProjectsService` as FR-019 already does
- [ ] TA006 [US9] Approve requiring `INVENTORY_APPROVE`, permitting per-line quantity reduction with
      a reason and recording both `requestedQuantity` and `approvedQuantity` (spec FR-022); reject
      requiring a reason → 400
- [ ] TA007 [US9] Wire an optional `indentLineId` onto the existing issue and purchase flows,
      updating `fulfilledQuantity` and advancing the indent to partially_fulfilled / fulfilled in
      the **same transaction** (spec FR-023)
- [ ] TA008 [US9] Reject an issue exceeding the line's outstanding (approved − fulfilled) quantity,
      reporting the outstanding figure (spec FR-024)
- [ ] TA009 [US9] `mark-procurement-needed` endpoint plus the procurement-needed report combining
      indent demand with reorder-level shortfall, **reported separately so the two are never
      double-counted into one purchase** (spec FR-027)
- [ ] TA010 [US9] `overdue` flagging against `requiredByDate`; cancel blocked once any fulfilment
      exists → 409, otherwise requiring a reason (spec FR-026)
- [ ] TA011 [US9] Soft-delete on indents, matching FR-004's treatment of purchases, issues, and
      transfers (spec FR-028)
- [ ] TA012 [P] Unit test: outstanding = approved − fulfilled at every step; over-fulfilment
      rejection; the procurement report keeps its two demand sources distinct
- [ ] TA013 [P] E2e test: approving an indent leaves every stock balance byte-identical (SC-A02)
