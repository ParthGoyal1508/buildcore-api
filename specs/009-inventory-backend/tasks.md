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

- [X] T001 [P] No `Permission` enum changes needed — reuse Settings' already-existing
      `INVENTORY` and `SETTINGS` values verbatim (corrected during a master-PRD alignment audit
      — spec FR-013, research.md §9; this task originally added `INVENTORY_STOCK`/
      `INVENTORY_PURCHASES`/`INVENTORY_PAYMENTS`)
- [X] T002 Add the 9 operational `inventory` schema models to `prisma/schema.prisma`:
      `StockBalance` (include `companyId` field for RLS consistency — M-007 remediation),
      `StockLedgerEntry`, `Purchase`, `GoodsReceiptNote` (research.md §14), `PurchaseBill`,
      `Issue` (with `activityId?`/`boqItemId?`, research.md §13), `StockTransfer`, `Payment`,
      `PaymentAllocation`; plus `settings.ItemCategory` and `settings.Item` (with
      `reorderLevel?`/`hsnCode?`/full 8-unit enum, corrected placement — research.md §1, §12) —
      data-model.md
- [X] T003 Generate and apply the `inventory` and `settings` schema migrations — Constitution
      Principle VI
- [X] T004 [P] Add RLS policies for all 11 tables (9 `inventory` + 2 `settings`) — Constitution
      Principle IV
- [X] T005 [P] Extend `shared.AuditLogEntry.entityType` with: `ITEM_CATEGORY`, `ITEM`,
      `PURCHASE`, `GOODS_RECEIPT_NOTE`, `ISSUE`, `STOCK_TRANSFER`, `PAYMENT`
- [X] T006 Scaffold `InventoryModule` in `src/inventory/inventory.module.ts`; export
      `InventoryService` with stub `getMaterialCostByProject()` returning 0 immediately so
      `ProjectsModule` can inject it from day one
- [X] T006a [P] Scaffold `src/settings/item-masters/` with `ItemCategoriesService`,
      `ItemsService` (`settings` schema, exported for `InventoryModule`'s thin controller
      proxies to call — Principle I, research.md §1)
- [X] T007 [P] Add `getSitesByProject(projectId): Promise<string[]>` stub to
      `src/projects/portfolio/projects.service.ts` and export from `ProjectsModule` —
      TODO(008) comment; same pattern as 007's T011c / BOCW stub
- [X] T007a [P] Add `getActivityById()`/`getBoqItemById()` stubs to `ProjectsModule`'s exported
      interface for Issue's `activityId`/`boqItemId` validation (research.md §13) — TODO(008)
      comment if 008 hasn't shipped the real implementations yet
- [X] T008 [P] Add `ITEMS` code-series seed entry to `prisma/seed.ts` — research.md §10

**Checkpoint**: Schema, permissions, stubs, and module scaffold ready. All user story phases
can proceed in parallel.

---

## Phase 2: User Story 1 — Item Categories (Priority: P1) 🎯 MVP

**Goal**: Category CRUD with uppercase name storage, delete guard, all 10 seeded defaults.

**Independent Test**: Create category, edit it, delete unlinked (200), delete linked (409).

### Implementation for User Story 1

- [X] T009 [P] [US1] Create `src/settings/item-masters/dto/create-category.dto.ts` and
      `update-category.dto.ts`; name is uppercased in service before write
- [X] T010 [P] [US1] Implement `ItemCategoriesService` (`settings` schema, corrected —
      research.md §1) in `src/settings/item-masters/item-categories.service.ts`: `create`
      (unique name → 409), `findAll` (with `itemCount`), `update`, `delete` (linked items →
      409); all writes audit-logged
- [X] T011 [US1] Implement a thin `CategoriesController` in
      `src/inventory/categories/categories.controller.ts` calling the `settings` service above
      (Principle I): all 4 endpoints, `@RequirePermission(Permission.SETTINGS)` (corrected —
      research.md §9)
- [X] T012 [P] [US1] Add all 10 default `ItemCategory` seed rows to `prisma/seed.ts`: CEMENT,
      AGGREGATE, STEEL, BRICKS, SAND, PAINT, ELECTRICAL, PLUMBING, FUEL, CONSUMABLES (corrected
      from 8 — research.md §15)

**Checkpoint**: Category CRUD functional and seeded.

---

## Phase 3: User Story 2 — Item Masters (Priority: P1)

**Goal**: Item CRUD with auto-generated code, unique name, category link, delete guard.

**Independent Test**: Create item with category and unit; edit description; delete unlinked
(200), delete with purchase history (409).

### Implementation for User Story 2

- [X] T013 [P] [US2] Create `src/settings/item-masters/dto/create-item.dto.ts` and
      `update-item.dto.ts` with the full 8-value unit enum (BAG/CUM/KG/NOS/MT/LTR/RMT/SQM,
      research.md §12) and optional `reorderLevel`/`hsnCode` fields
- [X] T014 [P] [US2] Implement `ItemsService` (`settings` schema, corrected — research.md §1)
      in `src/settings/item-masters/items.service.ts`: `create` (CodeSeriesService 'ITEMS',
      unique name → 409), `findAll` (paginated, filterable by category), `update`, `delete`
      (Purchase/Issue/Transfer linked → 409); audit-logged
- [X] T015 [US2] Implement a thin `ItemsController` in
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

- [X] T016 [P] [US3] Create purchase DTOs in `src/inventory/purchases/dto/`:
      `create-purchase.dto.ts` (multipart — siteId, itemId, vendorId, date, quantity, rate),
      `update-purchase.dto.ts` (date and remarks only — quantity/rate immutable)
- [X] T017 [P] [US3] Implement `StockService` in `src/inventory/stock/stock.service.ts`:
      - `upsertBalanceForPurchase(tx, itemId, siteId, qty, rate)`: upsert `StockBalance`,
        increment `received`, compute WAR incrementally (research.md §3)
      - `recomputeWAR(tx, itemId, siteId)`: replay all non-deleted purchase ledger entries
        chronologically, write final WAR to `StockBalance` (called on purchase soft-delete)
      - `toRow(balance, itemName, siteName, category, unit, reorderLevel): StockRow`: compute
        `inStock`, `stockValue`, and `belowReorderLevel` (research.md §11, §12)
- [X] T018 [P] [US3] Unit test `StockService`:
      - WAR incremental formula: 2 purchases → correct WAR
      - WAR replay after first purchase deleted → WAR = second purchase rate
      - `toRow()` arithmetic: inStock and stockValue correct
      - `src/inventory/stock/stock.service.spec.ts`
- [X] T019 [US3] Implement `PurchasesService` in
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
- [X] T020 [US3] Implement `PurchasesController` in
      `src/inventory/purchases/purchases.controller.ts`: all endpoints,
      `@RequirePermission(Permission.INVENTORY)` (corrected — research.md §9)
- [X] T021 [US3] E2e test: create purchase → stock balance correct; delete → balance reverts;
      delete with allocation → 409 — `test/inventory.e2e-spec.ts` (create file)

**Checkpoint**: Purchases and dual-write fully functional.

---

## Phase 5: User Story 4 — Issues (Priority: P1)

**Goal**: Issue creation with `SELECT FOR UPDATE` concurrency, quantity validation, dual-write;
soft-delete with reversal.

**Independent Test**: Over-issue → 422 with `availableStock`; concurrent over-issue → exactly
one 422; delete → balance reverts.

### Implementation for User Story 4

- [X] T022 [P] [US4] Create `src/inventory/issues/dto/create-issue.dto.ts` with
      siteId, itemId, date, quantity, issuedTo, `activityId`/`boqItemId` (one required,
      research.md §13), remarks validation
- [X] T023 [P] [US4] Add `validateAndLockStock(tx, itemId, siteId, qty): Promise<number>`
      to `StockService`: Prisma `$queryRaw` with `SELECT ... FOR UPDATE` on `StockBalance`,
      compute `inStock`, throw `422 { availableStock: inStock }` if `qty > inStock` —
      research.md §4, spec FR-003
- [X] T024 [P] [US4] Unit test `StockService.validateAndLockStock()`: sufficient stock →
      returns balance; insufficient → throws with `availableStock` — use mocked transaction
      `src/inventory/stock/stock.service.spec.ts`
- [X] T025 [US4] Implement `IssuesService` in `src/inventory/issues/issues.service.ts`:
      `create` (Prisma transaction: validate `activityId`/`boqItemId` via `ProjectsService`
      — research.md §13, `validateAndLockStock()`, append `issue` ledger entry, increment
      `StockBalance.issued`; audit-log), `delete` (soft-delete, `issue_reversal` entry, decrement
      `issued`, guard negative-issued check → 422), `findAll`
- [X] T026 [US4] Implement `IssuesController` in
      `src/inventory/issues/issues.controller.ts`: `@RequirePermission(Permission.INVENTORY)`
      (corrected — research.md §9)
- [X] T027 [US4] E2e test: over-issue → 422 `availableStock`; two rapid concurrent issues
      for last stock unit → exactly one succeeds — `test/inventory.e2e-spec.ts`

**Checkpoint**: Issue creation with concurrency protection functional.

---

## Phase 6: User Story 6 — Stock View (Priority: P1)

**Goal**: Paginated stock rows from `StockBalance` with computed `inStock` + `stockValue`; stock
hint endpoint for Issue/Transfer forms.

**Independent Test**: Seed purchases/issues; call `GET /inventory/stock`; verify each row's
arithmetic matches the seeded data; verify hint endpoint returns correct inStock for item-site.

### Implementation for User Story 6

- [X] T028 [P] [US6] Implement `StockController` in
      `src/inventory/stock/stock.controller.ts`:
      - `GET /inventory/stock` — reads `StockBalance` rows, calls `StockService.toRow()` per row
        (including `belowReorderLevel` from the item's `reorderLevel`, research.md §12);
        resolves site name via `ProjectsService.getSiteById()`, vendor name not needed here
      - `GET /inventory/stock/:itemId/:siteId` — single item-site hint
      - `@RequirePermission(Permission.INVENTORY)` (corrected — research.md §9)
- [X] T029 [P] [US6] Unit test `StockService.toRow()`: all four balance fields, zero-inStock
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

- [X] T030 [P] [US5] Create `src/inventory/transfers/dto/create-transfer.dto.ts` with
      `fromSiteId ≠ toSiteId` validation
- [X] T031 [US5] Implement `TransfersService` in
      `src/inventory/transfers/transfers.service.ts`:
      `create` (Prisma transaction: `fromSiteId === toSiteId → 400`,
      `validateAndLockStock()` on source `StockBalance`,
      append `transfer_out` + `transfer_in` ledger entries,
      `update` source `StockBalance` (decrements transferOut),
      `upsert` destination `StockBalance` (lazy creation if item never received at that
      site — H-001 remediation: destination may not exist yet, must be upsert not update),
      atomically; audit-log),
      `delete` (both reversal entries, atomic balance revert), `findAll`
- [X] T032 [US5] Implement `TransfersController` in
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

- [X] T033 [P] [US7] Create `src/inventory/payments/dto/create-payment.dto.ts` with
      `vendorId`, `amount`, `date`, `paymentMode`, `referenceNumber` fields only —
      no allocations array (FIFO is automatic)
- [X] T034 [P] [US7] Implement `PaymentsService` in
      `src/inventory/payments/payments.service.ts`:
      - `create`: Prisma transaction — fetch vendor's unpaid/part-paid bills ordered by
        `date ASC` (FIFO), `SELECT ... FOR UPDATE` on each, greedily allocate payment amount
        across bills, create `PaymentAllocation` rows, update `PurchaseBill.paidAmount` +
        `paymentStatus`, set `Payment.allocatedAmount` + `unallocatedBalance`; audit-log
      - `delete`: reverse all FIFO allocations atomically with bill-row lock; re-derive statuses
      - `findAll` (with `allocatedBillCount`, `unallocatedBalance`)
      - Remove `getOutstandingBills()` utility — no longer needed for manual allocation
- [X] T035 [P] [US7] Unit test `PaymentsService`:
      - FIFO order: oldest bill gets paid first
      - excess payment: all bills paid, `unallocatedBalance = amount − total outstanding`
      - partial payment: oldest bill paid first, second bill part-paid
      - delete reversal → bills revert
      - `src/inventory/payments/payments.service.spec.ts`
- [X] T036 [US7] Implement `PaymentsController` in
      `src/inventory/payments/payments.controller.ts`: all endpoints,
      `@RequirePermission(Permission.INVENTORY)` (corrected — research.md §9)
- [X] T037 [US7] E2e test: full payment lifecycle (FIFO allocation, no client-supplied
      allocation array); delete reversal; payment amount exceeding total outstanding → all bills
      paid + `unallocatedBalance` recorded (not a `400` — over-payment is allowed, corrected to
      match the automatic-FIFO design) — `test/inventory.e2e-spec.ts`

**Checkpoint**: Payment allocation fully functional.

---

## Phase 9: User Story 8 — getMaterialCostByProject (Priority: P3)

**Goal**: Implement the exported method resolving 008's P&L Materials stub.

### Implementation for User Story 8

- [X] T038 [US8] Replace stub in `InventoryService.getMaterialCostByProject()`: call
      `ProjectsService.getSitesByProject(projectId)` stub, query
      `SUM(Purchase.amount) WHERE siteId IN [...] AND date BETWEEN ... AND deleted = false`;
      return 0 gracefully on empty sites or ProjectsService error — research.md §8
- [X] T039 [US8] Unit test: correct sum for purchases in date range; excludes soft-deleted;
      returns 0 for empty project — `src/inventory/inventory.service.spec.ts`

**Checkpoint**: All 8 user stories complete.

---

## Phase 10: Polish & Cross-Cutting

- [X] T040 [P] Add Swagger `@ApiTags('Inventory')` + `@ApiOperation` to all 7 controllers
- [X] T041 [P] `npm run lint` and fix issues
- [X] T042 [P] `npm run build` typecheck and fix issues
- [X] T043 [P] Add `TODO(008)` comments in `InventoryService.getMaterialCostByProject()` and
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

- [X] TA001 Add `MaterialIndent` and `MaterialIndentLine` models to `prisma/schema.prisma`;
      migration + RLS
- [X] TA002 [P] Extend `src/settings/permission.enum.ts` with `INVENTORY_APPROVE` (spec FR-029) —
      every other indent endpoint reuses the existing `INVENTORY` value
- [X] TA003 [P] Extend `shared.AuditLogEntry.entityType` with `MATERIAL_INDENT` (spec FR-030)
- [X] TA004 [P] Extend Settings' code-series service with an `INDENT` series type (spec FR-021)
- [X] TA005 [US9] `IndentService` + `IndentController` in `src/inventory/indents/`: raise with
      header and lines, inactive-item guard → 400, optional `activityId` / `boqItemId` resolved via
      `ProjectsService` as FR-019 already does
- [X] TA006 [US9] Approve requiring `INVENTORY_APPROVE`, permitting per-line quantity reduction with
      a reason and recording both `requestedQuantity` and `approvedQuantity` (spec FR-022); reject
      requiring a reason → 400
- [X] TA007 [US9] Wire an optional `indentLineId` onto the existing issue and purchase flows,
      updating `fulfilledQuantity` and advancing the indent to partially_fulfilled / fulfilled in
      the **same transaction** (spec FR-023)
- [X] TA008 [US9] Reject an issue exceeding the line's outstanding (approved − fulfilled) quantity,
      reporting the outstanding figure (spec FR-024)
- [X] TA009 [US9] `mark-procurement-needed` endpoint plus the procurement-needed report combining
      indent demand with reorder-level shortfall, **reported separately so the two are never
      double-counted into one purchase** (spec FR-027)
- [X] TA010 [US9] `overdue` flagging against `requiredByDate`; cancel blocked once any fulfilment
      exists → 409, otherwise requiring a reason (spec FR-026)
- [X] TA011 [US9] Soft-delete on indents, matching FR-004's treatment of purchases, issues, and
      transfers (spec FR-028)
- [X] TA012 [P] Unit test: outstanding = approved − fulfilled at every step; over-fulfilment
      rejection; the procurement report keeps its two demand sources distinct
- [X] TA013 [P] E2e test: approving an indent leaves every stock balance byte-identical (SC-A02)

---

## Implementation note — 2026-09-04

Everything above is implemented, including the 2026-09-01 indent amendment. What follows
is every place the code departs from the task text, and why.

### Gap fixed before starting

`hr.PunchRecord`'s day lookup compared a `date` column against a `timestamptz` parameter,
which under the deployment's `Asia/Kolkata` session timezone matched nothing at all. Both
FR-008 guards were therefore unreachable: a duplicate punch-in surfaced the unique index as
a 500, and every punch-out was refused. Fixed on `fix/punch-day-timezone` (commit 59cec99)
before any 009 work, together with the four e2e tests that had been written against the
dead guard. `test/my-workspace.e2e-spec.ts` went from 9 failures to 93/93.

### Deviations from the task text

- **T016 says multipart; the bill upload is base64 in the JSON body.** The codebase has one
  upload mechanism — `ContractorDocument` (007) and `EmployeeDocument` (005) both take
  base64 — and `configure-app.ts` already sizes the body parser for it. Adding multipart for
  one endpoint would introduce a second mechanism, a second size limit and a new dependency
  path. `contracts/inventory-api.md` should be read as base64 for `POST /inventory/purchases`.
- **T007 says a `getSitesByProject()` stub with a `TODO(008)`; it is the real query.** 008
  has shipped, `Site.projectId` is a real indexed column, and the user chose the real
  implementation. `getMaterialCostByProject()` therefore returns measured figures rather than
  a zero nobody would notice was fake.
- **T007a's `getActivityById()`/`getBoqItemById()` are real queries too**, against
  `BOQTaskGroup` and `BOQTaskItem`. Those tables exist but nothing writes to them until 008
  US4 ships, so both return null for every id today — which is the correct answer, not a stub.
- **The Issue → Activity/BOQ link is optional, not "one required".** T022 and
  `contracts/inventory-api.md` say one of the two is required; research.md §13 declares both
  fields nullable. The user resolved the contradiction in favour of optional: requiring one
  would make material un-issuable at any site whose project has no BOQ rows, and 008's BOQ
  endpoints do not exist. A *supplied* id is still validated — an unchecked reference looks
  like traceability without being it.
- **`recomputeWAR()` folds every movement, not only purchases.** research.md §3 says "replay
  all non-deleted purchase ledger entries", which computes a quantity-weighted average of the
  surviving purchase rates. That is not what the incremental formula produces whenever
  material was issued between two purchases, because the incremental formula weights by
  *current stock*. Replaying purchases alone would let deleting a purchase silently restate
  the rate of a site whose other purchases were untouched. Folding the whole history
  reproduces the incremental sequence exactly, which is the property a reversal needs.
  `stock.service.spec.ts` has the case that distinguishes them (390 vs ≈347.4).
- **T008/T012 say seed rows in `prisma/seed.ts`; the ten default categories are seeded on
  company creation instead**, beside the six vendor categories 007 seeds there. A row in
  `seed.ts` only reaches the one company that file creates; `CompaniesService.create()`
  reaches every company that will ever exist. The `ITEMS` and `INDENT` code series need no
  seeding at all — `CodeSeriesService.next()` upserts the sequence on first use by design.
- **A third code series, `GRN`, was added** beyond the two the amendment names. FR-020's
  auto-generated GRN number has to come from somewhere and a purchase carries no code of its
  own to derive from.
- **`Item.active` was added** beyond data-model.md's field list. The delete guard refuses an
  item with any movement history, so without a retire flag a mis-created item that was ever
  purchased is permanent. It is also what the indent amendment's inactive-item guard (TA005)
  tests against.
- **`PaymentAllocation` carries its own `companyId`.** data-model.md omits it. An RLS policy
  that had to join to the parent payment to decide would be evaluated per row on every read.
- **`Payment` and `MaterialIndent` are soft-deleted** like every other movement (FR-004),
  which data-model.md does not say for either.
- **`GoodsReceiptNote` is not surfaced on 008's Bills & Expenses tab.** research.md §14 asks
  for it; the user chose to keep 009 self-contained on that point. The GRN number is on the
  purchase list. Left for whoever builds 008 US6.

### Structural notes

- `ItemCategory` and `Item` live in `settings` (research.md §1). The category delete guard
  lives *in* `ItemCategoriesService`, because linked items are a `settings` table; the item
  delete guard lives in `InventoryItemsService`, because movements are an `inventory` table
  and Principle I forbids settings reading them. Exactly the split
  `PartnerVendorCategoriesService` documents for vendor categories.
- Every cross-module read goes through `InventoryRefsService`, so Principle I is enforced in
  one file rather than argued about in five.
- Indent approval writes to no stock table at all (FR-025). The e2e asserts every balance is
  byte-identical across an approval (SC-A02).
- `INVENTORY_APPROVE` is held by no seeded role, so approval returns 403 until an
  administrator grants it under Settings > Roles. The e2e asserts the 403 first, then grants
  the permission to exercise the rest. **This is a deployment step, not a bug.**

### Verification

- `npx jest`: **501/501** unit (45 suites), including 18 new `StockService`, 10
  `PaymentsService` FIFO, 11 `IndentFulfilmentService`, 6 `IndentsService` and 5
  `InventoryService` tests.
- `npx jest --config test/jest-e2e.json test/inventory.e2e-spec.ts`: **32/32**, covering the
  dual write, WAR recalculation and replay, two genuinely simultaneous issues for the last of
  the stock, transfer to a store with no balance row, FIFO allocation and its reversal,
  over-payment, and SC-A02.
- `npx nest build` clean; `npx eslint src/inventory src/settings/item-masters` 0 errors.
- App boots with 36 `/inventory` routes registered.

### Not done

- `quickstart.md`'s manual passes. Nothing here has been exercised through a browser.

---

## Phase 11: Convergence — 2026-09-04

Gaps found by reading the shipped code back against spec.md, plan.md and
contracts/inventory-api.md. The first three were fixed in the same pass; the rest
are recorded rather than done.

- [X] T044 Apply the `belowReorderLevel` filter before paginating, not after, per
      FR-017 (contradicts). It was filtering the fetched page, so page 1 could come
      back with two rows while page 2 held ten more matches and `total` counted rows
      that would never be shown. The flag compares a computed `inStock` against a
      threshold in another schema, so it cannot be pushed into SQL — the rows are now
      fetched whole, filtered, then paged in memory, bounded by one company's
      item-site pairs.
- [X] T045 Write an audit entry when a `GoodsReceiptNote` is created, per the
      contract's audit section (missing). `AuditEntityType.GOODS_RECEIPT_NOTE` was
      added to the enum and then never used, so an activity log filtered to it found
      nothing.
- [X] T046 Serve the stored bill to the frontend (missing). `GET
      /inventory/purchases/:id/bill` was implemented and unreachable — the web had no
      client function for it, so uploads worked and downloads did not exist.
- [ ] T047 Stop hard-deleting `PurchaseBill` and `GoodsReceiptNote` rows when a
      purchase is soft-deleted (contradicts FR-004). FR-004 names purchases, issues
      and transfers, so this is within the letter of it — but a GRN is a receipt
      acknowledgement with a number other records cite, and erasing it leaves those
      citations pointing at nothing. Both should carry `deleted` flags like every
      other record here.
- [ ] T048 Refuse a category change on an item that already has stock movements, per
      contracts/inventory-api.md's `PATCH /inventory/items/:id` (partial). Currently
      any category change is accepted, which silently re-files historical purchases
      under a category they were never bought as.
- [ ] T049 Return `409` rather than `404` for a `PATCH` against a soft-deleted
      purchase, per the contract (partial). The row exists and the request is refused
      because of its state, which is what 409 means; 404 says it was never there.
- [ ] T050 Wire `InventoryService.getMaterialCostByProject()` into 008's Project P&L
      (missing). The method is implemented, exported and tested, and nothing calls
      it: 008's US4–US8 have not shipped. This task belongs to whoever builds them,
      and is recorded here so the export is not mistaken for dead code.
- [ ] T051 Run `quickstart.md`'s manual scenarios. Nothing in this feature has been
      exercised through a browser.
