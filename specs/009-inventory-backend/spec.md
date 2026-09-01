# Feature Specification: Inventory Backend (Stock, Purchases, Issues, Transfers, Payments)

**Feature Branch**: `009-inventory-backend`

**Created**: 2026-08-28

**Status**: Draft

**Input**: User description: "Inventory Module (Stock, Purchases, Issues, Transfers, Payments,
Item & Category Masters) for the BuildCore API backend, per the PRD at
/Users/p0g02o7/Personal/ERP-Demo/docs/prd/07-inventory.prd.md. This is the `inventory` schema —
all multi-site stock tracking surfaces from purchase receipt through issue-to-work and inter-site
transfer, backed by an append-only stock ledger so balances are always derivable from transaction
history. Includes vendor payment allocation against purchase bills (transactional). This feature
also implements `InventoryService.getMaterialCostByProject()` — the exported method feature 008
(Projects P&L) stubs and waits on. Vendors are read from the Partners module; project stores
(sites) from the Projects module."

## Clarifications

### Session 2026-08-28

- Q: How is Weighted Average Rate (WAR) maintained — computed on every stock read from the ledger,
  or stored and updated on each purchase? → A: Stored per item-per-site in a `StockBalance` table
  and updated in-transaction on every purchase: `newWAR = (existingStock × existingWAR +
  newQty × newRate) / (existingStock + newQty)`. On issue or transfer-out, the WAR is unchanged
  (consumption at current average cost, standard WAR convention). `StockBalance` also holds
  running `received`, `issued`, `transferIn`, `transferOut` totals for O(1) stock reads. The
  append-only `StockLedgerEntry` retains full history for audit reconstruction.
- Q: What happens when a purchase record is deleted — does it reverse the stock? → A: Soft-delete
  only — purchases are marked `deleted: true` and a reversal `StockLedgerEntry` (type:
  `purchase_reversal`) is appended. The reversal also decrements the `StockBalance` totals. Hard
  deletes are never permitted on ledger-impacting records; the same pattern applies to issue and
  transfer deletions.
- Q: Can a payment be partially unallocated (payment amount > sum of allocated bills)? → A:
  Yes — unallocated balance is allowed. A payment can have `allocatedAmount < amount`, leaving
  an `unallocatedBalance = amount − allocatedAmount` available for future allocation to new bills.
  Payment status is not affected by allocation (a payment is recorded; its allocation is
  separate). Bill payment status is updated by allocation totals.
- Q: Does deleting a purchase require admin re-confirmation if bills have already been paid
  against it? → A: Deletion is blocked (409) if any `PaymentAllocation` row references the
  purchase's bill with `allocatedAmount > 0`. The purchase bill must be fully unallocated before
  the purchase can be deleted.
- Q: How is `getMaterialCostByProject(projectId, dateRange)` computed — from purchase records
  for that project's stores, or from issue records? → A: From purchase records — sum of
  `Purchase.amount` where `Purchase.siteId` is a site belonging to `projectId` and
  `Purchase.date` is within the date range. Purchases represent material cost inflow to the
  project; issues track consumption but don't represent additional cost.
- Q: What concurrency mechanism enforces stock validation against race conditions? → A:
  Raw `SELECT FOR UPDATE` inside a Prisma `$transaction` — pessimistic row lock on
  `StockBalance` during the validate-then-update sequence. Applied to both issue and transfer
  operations. FR-003 updated: "using Prisma `$transaction` with raw SQL `SELECT ... FOR UPDATE`
  on the `StockBalance` row for the relevant `(itemId, siteId)` pair."
- Q: Who owns adding `ProjectsService.getSitesByProject(projectId)` stub to ProjectsModule?
  → A: Feature 009 owns the task — same as 007's T011c pattern. A stub returning `[]` is added
  to `ProjectsModule`'s exported interface as part of this feature's Phase 1; `getMaterial
  CostByProject()` falls back to 0 until 008 ships the real implementation. TODO(008) comment
  included.
- Q: Should `Payment.allocatedAmount` be stored or computed on read? → A: Stored — updated in-
  transaction whenever a `PaymentAllocation` is created or deleted. Same write-once/fast-read
  pattern as `StockBalance`. `Payment.allocatedAmount` is always `SUM(PaymentAllocation.
  allocatedAmount)` for that payment, maintained by the payment service, never separately
  recalculated on reads.
- Q: When is a `StockBalance` row created — lazily on first purchase or eagerly for all
  item-site combinations? → A: Lazy — `StockBalance` is created via upsert on the first
  purchase for a given `(itemId, siteId)` pair. `GET /inventory/stock` returns only item-sites
  that have had at least one purchase. This avoids N×M row explosion; spec US6 AC2 ("zero-balance
  rows are still visible") applies only after a purchase has been made and then fully reversed.
- Q: How is WAR recalculated when a purchase is soft-deleted? → A: Recompute from scratch —
  on any purchase deletion, `StockService.recomputeWAR(itemId, siteId)` replays all non-deleted
  purchase `StockLedgerEntry` rows for that item-site in chronological order to derive the
  current WAR. At construction-site scale (hundreds of entries, not millions) this is fast
  enough; no intermediate WAR snapshot storage needed. FR-008 updated accordingly.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Manage Item Categories (Priority: P1)

An admin creates, edits, and deletes material categories (CEMENT, STEEL, AGGREGATE, etc.);
categories populate the Category dropdown in Item Masters and stock filters.

**Why this priority**: No dependency; required before any item can be created. Ships with all 10
of the master PRD's named default categories (Cement, Aggregate, Steel, Bricks, Sand, Paint,
Electrical, Plumbing, Fuel, Consumables) — corrected from this feature's original 8-category seed
list, which omitted Fuel and Consumables.

**Independent Test**: Create a category, edit it, delete it (no linked items → 200; linked → 409)
— independent of any inventory transaction.

**Acceptance Scenarios**:

1. **Given** a valid admin session, **When** `POST /inventory/categories` is called with Name,
   **Then** the category is created with Name stored uppercase.
2. **Given** a category with no linked items, **When** `DELETE /inventory/categories/:id`,
   **Then** the category is deleted.
3. **Given** a category with linked items, **When** `DELETE` is attempted, **Then** `409`.
4. **Given** the category list, **When** `GET /inventory/categories`, **Then** it returns all
   categories with `itemCount` per category.

---

### User Story 2 - Manage Item Masters (Priority: P1)

An admin creates and edits material items (Cement OPC 43, TMT Bar 8mm, etc.) with auto-generated
codes, category, and unit; items populate purchase/issue/transfer dropdowns.

**Why this priority**: Items are required before any stock transaction. Depends on categories (US1).

**Independent Test**: Create an item with a category and unit, edit its description, verify it
appears in the item list and is filterable by category — independent of any purchase or stock.

**Acceptance Scenarios**:

1. **Given** a valid category, **When** `POST /inventory/items` is called with Name, Category,
   and Unit (BAG/CUM/KG/NOS/MT/LTR), **Then** the item is created with an auto-generated Code.
2. **Given** the item list, **When** `GET /inventory/items?search=&categoryId=&page=`, **Then**
   results are paginated and filterable by name and category.
3. **Given** an item linked to purchases/issues, **When** `DELETE /inventory/items/:id` is
   attempted, **Then** `409 Conflict` — items with transaction history cannot be deleted.
4. **Given** a duplicate item name within a company, **When** `POST /inventory/items`, **Then**
   `409` — item names are unique per company.

---

### User Story 3 - Record Purchases (Priority: P1)

An admin records a material purchase for a project store: item, vendor, quantity, rate, optional
bill file upload. The `StockBalance` for that item-site increments `received`, WAR recalculates,
and a `PurchaseBill` (payable entry) is created.

**Why this priority**: Purchases are the primary stock-inflow transaction and the starting point
of the payment lifecycle. Depends on items (US2) and vendor/site data from Partners/Projects.

**Independent Test**: Record a purchase (item, vendor, qty 100, rate ₹50), verify the stock
balance shows `received: 100`, `inStock: 100`, WAR = ₹50; record a second purchase (qty 50,
rate ₹60), verify WAR recalculates to ₹53.33 and inStock = 150 — independent of issues/transfers.

**Acceptance Scenarios**:

1. **Given** a valid item and project site, **When** `POST /inventory/purchases` is called with
   `siteId`, `itemId`, `vendorId`, `date`, `quantity`, `rate`, and optional `billFile`, **Then**
   a `Purchase` record is created, a `StockLedgerEntry` (type: `purchase`) is appended, the
   `StockBalance.received` increments, WAR recalculates, a `PurchaseBill` (status: `unpaid`) is
   created, and a `GoodsReceiptNote` (GRN) is auto-generated and linked to the purchase's project
   site for visibility on that project's Bills & Expenses tab (FR-020).
2. **Given** multiple purchases for the same item+site, **When** stock is queried, **Then**
   `inStock = received − issued − transferOut + transferIn` and WAR reflects the weighted
   average across all purchases.
3. **Given** the purchase list, **When** `GET /inventory/purchases?siteId=&vendorId=&
   paymentStatus=&dateFrom=&dateTo=&page=`, **Then** results are paginated and filterable.
4. **Given** a purchase, **When** `DELETE /inventory/purchases/:id` is attempted with no
   allocated payments, **Then** soft-delete succeeds: `deleted: true`, a `purchase_reversal`
   ledger entry is appended, `StockBalance.received` decrements.
5. **Given** a purchase with an allocated payment, **When** `DELETE` is attempted, **Then**
   `409 Conflict` ("Bill has allocated payments — unallocate before deleting").

---

### User Story 4 - Record Issues (Priority: P1)

An admin records a material issue from a project store to a person or work activity. The
`StockBalance.issued` increments and stock decreases. Over-issue is blocked server-side.

**Why this priority**: Issues are the primary stock-outflow transaction; required for real-time
stock tracking. Depends on purchases (US3) to have stock to issue.

**Independent Test**: With 100 units in stock, issue 60 (→ inStock: 40); attempt to issue 50
more (→ 422 Unprocessable Entity, "insufficient stock"); issue the remaining 40 (→ inStock: 0).

**Acceptance Scenarios**:

1. **Given** an item with `inStock > 0`, **When** `POST /inventory/issues` is called with
   `siteId`, `itemId`, `date`, `quantity`, `issuedTo`, an `activityId` or `boqItemId` (FR-019),
   and optional `remarks`, **Then** the issue is recorded, `StockLedgerEntry` (type: `issue`) is
   appended, `StockBalance.issued` increments.
2. **Given** `quantity > inStock`, **When** `POST /inventory/issues` is attempted, **Then**
   `422 Unprocessable Entity` with `{ availableStock: N }` in the response — enforced
   server-side with database-level locking to prevent race conditions.
3. **Given** the issue list, **When** `GET /inventory/issues?siteId=&itemId=&dateFrom=&dateTo=
   &page=`, **Then** paginated, filtered results.
4. **Given** an issue record, **When** `DELETE /inventory/issues/:id`, **Then** soft-delete with
   an `issue_reversal` ledger entry; `StockBalance.issued` decrements; validates the reversal
   would not produce a negative `issued` count.

---

### User Story 5 - Record Stock Transfers (Priority: P2)

An admin records a material transfer between two project stores. The source store's
`transferOut` increments and the destination store's `transferIn` increments atomically.
Over-transfer from source is blocked.

**Why this priority**: Inter-site material sharing is a common construction workflow; depends
on purchase stock existing (US3).

**Independent Test**: With 100 units at Site A, transfer 30 to Site B: Site A inStock = 70,
Site B inStock = 30; attempt to transfer 80 more from Site A (→ 422 insufficient stock).

**Acceptance Scenarios**:

1. **Given** items in stock at a source site, **When** `POST /inventory/transfers` is called
   with `fromSiteId`, `toSiteId`, `itemId`, `date`, `quantity`, and optional `remarks`, **Then**
   source `transferOut` increments and destination `transferIn` increments atomically in a single
   Prisma transaction; two `StockLedgerEntry` rows are appended (`transfer_out` and
   `transfer_in`). Transfer is created with `status: 'pending'`.
2. **Given** `quantity > source inStock`, **When** attempted, **Then** `422` with
   `{ availableStock: N }`.
3. **Given** `fromSiteId === toSiteId`, **When** attempted, **Then** `400 Bad Request`.
4. **Given** a transfer in `pending` or `in_transit` status, **When**
   `PATCH /inventory/transfers/:id` is called with `{ status: 'in_transit' }` or
   `{ status: 'received' }`, **Then** status updates; transitions are one-way
   (pending → in_transit → received); out-of-order transitions return `409`.
5. **Given** a transfer record with `status: 'received'`, **When** `DELETE` is attempted,
   **Then** `409 Conflict` — received transfers cannot be reversed.
6. **Given** a transfer in `pending` or `in_transit` status, **When** `DELETE` is called,
   **Then** soft-delete with two reversal ledger entries; both `StockBalance` rows revert.

---

### User Story 6 - Stock Balances View (Priority: P1)

The stock endpoint returns real-time balances derived from `StockBalance` totals for all items
across all sites a company has, with weighted average rate and stock value per item-site.

**Why this priority**: The stock view is the primary daily-use screen. Depends on at least
purchases (US3) existing to populate balances.

**Independent Test**: Seed 3 purchases and 2 issues for 2 items at 2 sites; call `GET
/inventory/stock`; verify each row's `inStock`, `avgRate`, and `stockValue` match the expected
arithmetic — independent of transfers or payments.

**Acceptance Scenarios**:

1. **Given** stock transactions, **When** `GET /inventory/stock?siteId=&categoryId=&search=
   &page=`, **Then** each row returns `item`, `site`, `category`, `unit`, `received`,
   `issued`, `transferIn`, `transferOut`, `inStock`, `avgRate`, `stockValue`.
2. **Given** `inStock = 0` for an item-site (all purchases reversed), **When** stock is
   queried, **Then** the row is still returned with zero balances (the `StockBalance` row
   persists after creation even when fully depleted).
3. **Given** the stock endpoint, **When** the same purchase is created and then soft-deleted,
   **Then** the stock balance is identical to before the purchase (reversal is complete).

---

### User Story 7 - Record Payments (FIFO Bill Allocation) (Priority: P2)

An admin records a vendor payment; the system automatically allocates it against the vendor's
unpaid/part-paid bills in FIFO order (oldest bill first) until the payment amount is exhausted.
Bill statuses auto-update (unpaid → part_paid → paid).

**Why this priority**: Completes the purchase-to-payment audit trail. Depends on purchases
creating bills (US3).

**Independent Test**: Create 2 purchase bills for a vendor (oldest ₹5,000 + newer ₹3,000).
Record a payment of ₹7,000 — system allocates ₹5,000 to the oldest bill (→ paid) and ₹2,000
to the newer bill (→ part_paid). Record another ₹1,000 — allocated to the remaining ₹1,000
on the second bill (→ paid).

**Acceptance Scenarios**:

1. **Given** a vendor with outstanding bills, **When** `POST /inventory/payments` is called
   with `vendorId`, `amount`, `date`, `paymentMode`, and `referenceNumber`, **Then** the
   system allocates the payment amount against unpaid/part-paid bills in FIFO order (oldest
   bill date first); each bill's `paidAmount` updates and `paymentStatus` auto-derives.
2. **Given** `payment.amount` exceeds the total outstanding balance, **When** submitted,
   **Then** all bills are marked `paid` and the excess `unallocatedBalance = amount −
   totalAllocated` is recorded on the `Payment` row for future reference.
3. **Given** the payment list, **When** `GET /inventory/payments?vendorId=&dateFrom=&dateTo=
   &paymentMode=&page=`, **Then** paginated, filtered results with `allocatedBillCount`.
4. **Given** a payment, **When** `DELETE /inventory/payments/:id`, **Then** all FIFO
   allocations are reversed atomically; affected bills' `paidAmount` decrements and
   `paymentStatus` re-derives.

---

### User Story 8 - Material Cost for Projects P&L (Priority: P3)

The Inventory module implements `getMaterialCostByProject(projectId, dateRange)` — the exported
service method that feature 008's P&L engine calls via its `InventoryService` interface stub.

**Why this priority**: Unblocks the Projects P&L's Materials cost line. Depends on purchases
existing (US3).

**Independent Test**: Seed 3 purchases for a project's sites within a date range (total ₹1,50,000)
and 2 purchases outside the range; call `getMaterialCostByProject(projectId, range)`;
verify return = ₹1,50,000.

**Acceptance Scenarios**:

1. **Given** purchases for a project's sites within the date range, **When**
   `InventoryService.getMaterialCostByProject(projectId, dateRange)` is called, **Then** it
   returns the sum of `Purchase.amount` (qty × rate) for non-deleted purchases where the
   purchase's `siteId` belongs to `projectId` (via `ProjectsService.getSitesByProject()`).
2. **Given** a project with no purchases, **When** called, **Then** returns 0.
3. **Given** `ProjectsService` unavailable, **When** called, **Then** returns 0 and logs the
   failure — same fallback as other cross-module P&L methods.

---

### Edge Cases

- What if two users simultaneously try to issue the last 10 units of a stock? → Database-level
  row lock on `StockBalance` during issue validation prevents double-issue; one succeeds, the
  other receives `422`.
- What if `StockBalance.inStock` would go negative after a reversal? → Reversal is blocked with
  `422` ("Reversal would produce negative stock") — e.g., if stock has been further reduced since
  the original entry.
- What if an item has been transferred to a site but the source balance is now depleted (reversal
  would underflow)? → Transfer reversal is blocked with same `422` pattern.
- What if a payment has no allocations at all? → Allowed — the payment is recorded with
  `allocatedAmount: 0`; the full `amount` sits as `unallocatedBalance` for future allocation.
- What if `GET /inventory/stock` is called for a site with no purchases yet? → Returns an empty
  array — no stock rows until the first purchase.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: All `inventory` schema tables MUST carry `companyId` with RLS enforcing tenant
  isolation — Constitution Principle IV.
- **FR-002**: Stock balances MUST be derived from `StockBalance` running totals (updated in-
  transaction on every ledger-impacting event), backed by an append-only `StockLedgerEntry` table
  for audit reconstruction — PRD NFR "ledger-based accounting".
- **FR-003**: Issue and Transfer quantity validations MUST be enforced using Prisma
  `$transaction` with a raw SQL `SELECT ... FOR UPDATE` on the `StockBalance` row for the
  relevant `(itemId, siteId)` pair — pessimistic row lock preventing concurrent over-issue
  or over-transfer.
- **FR-004**: Purchases, issues, and transfers MUST NOT be hard-deleted; soft-delete (appending
  a reversal `StockLedgerEntry` and adjusting `StockBalance`) is the only permitted deletion
  path.
- **FR-005**: Payment-to-bill allocation MUST be atomic and follow FIFO order (oldest
  unpaid/part-paid bill date first) — the payment record and all bill `paidAmount`/`paymentStatus`
  updates commit together or not at all (master PRD §7.6.5).
- **FR-006**: The `PaymentAllocation` table records which bill received how much from each
  payment — this enables audit reversal on payment deletion.
- **FR-007**: Purchase deletion MUST be blocked (`409`) if any allocation against that bill has
  `allocatedAmount > 0`.
- **FR-008**: WAR MUST be updated on every new purchase using the formula
  `newWAR = (existingStock × existingWAR + newQty × newRate) / (existingStock + newQty)`.
  On purchase soft-delete, WAR MUST be recomputed by replaying all remaining non-deleted
  purchase entries for that `(itemId, siteId)` chronologically via
  `StockService.recomputeWAR(itemId, siteId)` within the same delete transaction.
- **FR-009**: `InventoryService.getMaterialCostByProject(projectId, dateRange)` MUST be exported
  from `InventoryModule` for injection by `ProjectsModule` — resolving 008's P&L stub.
- **FR-010**: All write operations (purchases, issues, transfers, payments, item/category changes)
  MUST be written to the audit log.
- **FR-011**: Vendor reads (name, TDS) MUST go via `PartnersService.getVendorById()` — no direct
  `partners` schema query (Constitution Principle I).
- **FR-012**: Site/project resolution MUST go via `ProjectsService.getSitesByProject()` —
  no direct `projects` schema query.
- **FR-013**: Every endpoint MUST be gated by `JwtAuthGuard` + `@RequirePermission(Permission.
  INVENTORY)`, reusing Settings' already-existing `INVENTORY` enum value verbatim — corrected
  during a master-PRD alignment audit; this feature originally invented three new values
  (`INVENTORY_STOCK`/`INVENTORY_PURCHASES`/`INVENTORY_PAYMENTS`) where `INVENTORY` already
  existed reserved by name for exactly this module (matching the same failure pattern found and
  fixed in the Machinery and Partners specs). Item/Category Masters (US1/US2, `settings`-schema
  per FR-016) are guarded with the existing `SETTINGS` permission instead.
- **FR-014**: `StockValue = inStock × avgRate` MUST be computed server-side on stock reads, never
  stored as a column (it would become stale between WAR updates).
- **FR-015**: Item names MUST be unique per company; `POST /inventory/items` returns `409` on
  duplicate name.
- **FR-016**: Item Categories and Items MUST live in the `settings` schema, not `inventory` —
  corrected during a master-PRD alignment audit (master PRD §7.8.6 places "Inventory Masters" as
  a Settings subsection, matching Employee Setup Masters, Reimbursement Categories, and
  Machinery's corrected Equipment Categories/Doc Types/Hire Rates). CRUD lives in
  `SettingsService`-exported methods; this module's own `/inventory/items`,
  `/inventory/categories` controllers call those exported methods rather than querying `settings`
  directly (Principle I).
- **FR-017**: Item Master MUST include Reorder Level (per item, per master PRD §7.6.6) and HSN
  Code — both entirely absent from this feature's original scope, found missing during a
  master-PRD alignment audit. `GET /inventory/stock` MUST flag a row `belowReorderLevel: true`
  when `inStock < item.reorderLevel` (master PRD §7.6.1's explicit alert requirement).
- **FR-018**: The `Unit` enum MUST include all 8 units the master PRD names: BAG, CUM, KG, NOS,
  MT, LTR, RMT, SQM — this feature's original enum was missing RMT and SQM.
- **FR-019**: An Issue record MUST capture the work Activity or BOQ Item it was issued against
  (`activityId?` or `boqItemId?`, resolved via `ProjectsService`) — master PRD §7.6.3 names this
  as a required field ("Activity/BOQ Item"), missing from this feature's original scope; without
  it, material consumption cannot be traced back to project costing.
- **FR-020**: A Goods Receipt Note (GRN) record MUST be auto-generated on every purchase save and
  MUST be visible from the purchase's project site via `ProjectsService`, satisfying master PRD
  §7.6.2's "Auto-generated on purchase save" and "Links to project's Bills & Expenses tab"
  requirements — both entirely absent from this feature's original scope.

### Key Entities

- **ItemCategory** (`settings` schema, corrected per FR-016): `id`, `companyId`, `name`
  (uppercase), `createdAt`.
- **Item** (`settings` schema, corrected per FR-016): `id`, `companyId`, `code` (auto-gen),
  `name` (unique per company), `categoryId` FK, `unit` (BAG|CUM|KG|NOS|MT|LTR|RMT|SQM, FR-018),
  `reorderLevel?` (decimal, FR-017), `hsnCode?` (string, FR-017), `description?`, `createdAt`.
- **StockBalance** (`inventory` schema): `id`, `companyId`, `itemId` FK, `siteId` (UUID, cross-
  schema ref to `projects.Site`), `received` (decimal, default 0), `issued` (decimal, default 0),
  `transferIn` (decimal, default 0), `transferOut` (decimal, default 0), `avgRate` (decimal,
  default 0), `updatedAt`. UNIQUE: `(itemId, siteId)`. Derived: `inStock = received + transferIn
  − issued − transferOut`.
- **StockLedgerEntry** (`inventory` schema — append-only): `id`, `companyId`, `itemId` FK,
  `siteId`, `type` (purchase|purchase_reversal|issue|issue_reversal|transfer_in|transfer_out|
  transfer_in_reversal|transfer_out_reversal), `quantity`, `rate?`, `referenceId` (UUID of the
  source Purchase/Issue/Transfer), `date`, `createdAt`.
- **Purchase** (`inventory` schema): `id`, `companyId`, `siteId`, `itemId` FK, `vendorId` (UUID,
  cross-schema ref), `date`, `quantity`, `rate`, `amount` (qty × rate, stored), `billFileRef?`
  (encrypted object-storage), `deleted` (boolean, default false), `createdAt`.
- **GoodsReceiptNote** (`inventory` schema, new per FR-020): `id`, `companyId`, `purchaseId`
  FK→Purchase (1:1), `grnNumber` (auto-generated), `siteId`, `createdAt`. Visible from the
  purchase's project site via `ProjectsService` for that project's Bills & Expenses tab.
- **PurchaseBill** (`inventory` schema): `id`, `companyId`, `purchaseId` FK (1:1), `vendorId`,
  `totalAmount`, `paidAmount` (default 0), `paymentStatus` (unpaid|part_paid|paid),
  `createdAt`, `updatedAt`.
- **Issue** (`inventory` schema): `id`, `companyId`, `siteId`, `itemId` FK, `date`, `quantity`,
  `issuedTo`, `activityId?` / `boqItemId?` (cross-schema ref to `projects`, FR-019), `remarks?`,
  `deleted` (boolean, default false), `createdAt`.
- **StockTransfer** (`inventory` schema): `id`, `companyId`, `fromSiteId`, `toSiteId`,
  `itemId` FK, `date`, `quantity`, `remarks?`, `deleted` (boolean, default false), `createdAt`.
- **Payment** (`inventory` schema): `id`, `companyId`, `vendorId`, `amount`, `date`,
  `paymentMode` (upi|bank_transfer|cash|cheque), `referenceNumber`, `allocatedAmount` (default 0),
  `createdAt`.
- **PaymentAllocation** (`inventory` schema): `id`, `paymentId` FK, `billId` FK→PurchaseBill,
  `allocatedAmount`, `createdAt`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Stock accuracy — `GET /inventory/stock` returns balances within 2% of the sum of
  all non-deleted purchase quantities minus issued and transfer-out quantities for that item-site.
- **SC-002**: Concurrency protection — two simultaneous issue requests for the last N units
  result in exactly one success and one `422`, never a negative stock balance.
- **SC-003**: Payment reconciliation — `GET /inventory/purchases?paymentStatus=unpaid` returns
  zero bills after all outstanding amounts have been fully allocated.
- **SC-004**: Full audit trail — every purchase, issue, transfer, and payment has a corresponding
  `StockLedgerEntry`; `SELECT SUM(quantity) FROM StockLedgerEntry WHERE itemId=X AND siteId=Y`
  always equals `StockBalance.received − StockBalance.issued − ...` for that row.
- **SC-005**: `getMaterialCostByProject()` returns the correct sum within 1 second for a project
  with up to 500 purchases.
- **SC-006**: Every stock row where `inStock < item.reorderLevel` is flagged `belowReorderLevel:
  true` in `GET /inventory/stock` — zero missed reorder alerts in testing.

## Assumptions

- Settings' CodeSeriesService supports an `ITEMS` series type; if not, a simple sequential
  item code generator is built within the `inventory` module.
- `ProjectsService` exposes `getSitesByProject(projectId): string[]` returning siteIds — needed
  for `getMaterialCostByProject`. This is added as a stub export from `ProjectsModule` (same
  pattern as other cross-module stubs). Issue's `activityId`/`boqItemId` (FR-019) resolves via
  the same `ProjectsService`, validated but not duplicated into `inventory` schema.
- The `inventory` module reads `PartnersService.getVendorById(vendorId)` for vendor name display
  in purchase/payment lists — full vendor data is not cached in `inventory` tables. This uses the
  exported in-process method (`007-partners-backend` research.md §12), never the HTTP endpoint.
- Purchase bill files use the same encrypted object-storage reference pattern as 005/007/008.
- The `@nestjs/bullmq` queue (pre-approved in the constitution) is NOT used for ledger writes —
  all ledger updates are synchronous within the request transaction, acceptable for the expected
  transaction volume.
- Reorder Level granularity (FR-017) is per-item, company-wide — not per-item-per-site. Master
  PRD §7.6.6 implies per-item; §7.8.6 separately says "per item per site," an internal
  inconsistency in the source document. Per-item was chosen as the simpler default; a future
  amendment can add per-site overrides if the business need materializes.

---

## Amendment 2026-09-01 — Material Request / Indent Workflow

**Reason**: A gap audit against the module/submodule matrix found that rows 26 ("Material request"
under Daily Progress Report) and 37 ("Material Management: Transfers, Issues, **New Request**,
Purchases") name a material *request* surface that this spec does not cover. As originally written,
this feature jumps straight from a purchase to an issue: a site has no way to ask for material, no
approval trail for that ask, and no link from a site's demand to the purchase that satisfies it.
This amendment adds the indent workflow that sits in front of the existing purchase and issue
flows. Everything already specified above is unchanged.

### User Story 9 - Raise and approve material indents (Priority: P1)

A site engineer raises an indent for material needed at a site — item, quantity, required-by date,
and the work activity or BOQ item it is for. The indent is approved by the project manager, then
fulfilled either from existing stock (becoming an issue) or by procurement (becoming a purchase),
so every issue and purchase is traceable back to the demand that caused it.

**Why this priority**: Without it, purchases and issues have no demand trail, and the matrix's
"New Request" surface does not exist. It sits in front of the already-specified issue and purchase
flows and does not change them.

**Independent Test**: Raise an indent for 50 bags of cement at a site, approve it, and confirm it
appears in the approved-indent queue with its pending quantity — without fulfilling it.

**Acceptance Scenarios**:

1. **Given** a site session, **When** `POST /inventory/indents` is called with `siteId`, `projectId`,
   `requiredByDate`, `lines[]` (each with `itemId`, `quantity`, optional `activityId` or
   `boqItemId`, and optional `remarks`), and a `justification`, **Then** the indent is created with
   `status: 'pending'` and an auto-generated indent number.
2. **Given** an indent line whose `itemId` is inactive, **When** creation is attempted, **Then**
   `400 Bad Request`.
3. **Given** a pending indent, **When** `PATCH /inventory/indents/:id/approve` is called by a holder
   of `INVENTORY_APPROVE`, **Then** the status becomes `approved` and it enters the fulfilment
   queue; per-line quantity reductions with a reason are permitted at approval and are recorded as
   `approvedQuantity` alongside the original `requestedQuantity`.
4. **Given** a pending indent, **When** rejection is attempted without a `reason`, **Then**
   `400 Bad Request`.
5. **Given** an approved indent line, **When** an issue is created against it, **Then** the issue
   records the `indentLineId`, the line's `fulfilledQuantity` increases, and the indent's status
   advances to `partially_fulfilled` or `fulfilled` accordingly.
6. **Given** an approved indent line with insufficient stock at the site, **When**
   `PATCH /inventory/indents/lines/:id/mark-procurement-needed` is called, **Then** the line becomes
   `procurement_pending` and appears in the procurement-needed report.
7. **Given** a purchase created against an indent line, **When** it is saved, **Then** the purchase
   records the `indentLineId` so the demand-to-purchase trail is complete.
8. **Given** an issue attempted for a quantity exceeding the approved indent line's outstanding
   quantity, **When** it is attempted, **Then** `400 Bad Request` reporting the outstanding
   quantity.
9. **Given** an approved indent whose `requiredByDate` has passed with outstanding quantity, **When**
   the indent list is read, **Then** it is flagged `overdue` with the day count.
10. **Given** an indent list request, **When**
    `GET /inventory/indents?status=&siteId=&projectId=&itemId=`, **Then** paginated, filtered results
    are returned with requested, approved, fulfilled, and outstanding quantities per line.
11. **Given** an indent with any fulfilled quantity, **When** cancellation is attempted, **Then**
    `409 Conflict`; an indent with no fulfilment may be cancelled with a reason.

### Additional Edge Cases

- An item's reorder level is breached by an approved indent's demand → the item appears in the
  procurement-needed report with both its reorder shortfall and its outstanding indent demand, so
  the two are not double-counted into a single purchase.
- Two sites indent the same item concurrently against the same limited stock → indent approval does
  not reserve stock; the existing issue-time quantity validation (FR-003) remains the single point
  of truth, and the second issue fails there rather than at approval.
- An indent is approved and then the underlying work activity is cancelled in feature 008 → the
  indent remains and must be explicitly cancelled; no automatic cascade.

### Additional Functional Requirements

- **FR-021**: The system MUST provide a material indent with header (site, project, required-by
  date, justification, status) and lines (item, requested quantity, approved quantity, fulfilled
  quantity, optional activity or BOQ item reference), with the indent number auto-generated via
  Settings' existing code-series service.
- **FR-022**: Indent approval MUST require the `INVENTORY_APPROVE` permission and MUST permit
  per-line quantity reduction with a reason, recording both `requestedQuantity` and
  `approvedQuantity` so the reduction is auditable.
- **FR-023**: An issue or purchase MAY reference an approved indent line; when it does, the line's
  `fulfilledQuantity` MUST be updated in the same transaction and the indent's status MUST advance
  to `partially_fulfilled` or `fulfilled` accordingly.
- **FR-024**: The system MUST reject an issue against an indent line for a quantity exceeding that
  line's outstanding (approved minus fulfilled) quantity, reporting the outstanding figure.
- **FR-025**: Indent approval MUST NOT reserve or allocate stock; the existing transactional
  quantity validation at issue time (FR-003) remains the single point of stock enforcement, so
  approving an indent can never cause a negative balance.
- **FR-026**: An indent with any fulfilled quantity MUST NOT be cancellable (`409 Conflict`); an
  unfulfilled indent MUST be cancellable only with a reason.
- **FR-027**: The system MUST expose a procurement-needed report combining indent lines marked
  `procurement_pending` with items below their reorder level (FR-017), reporting the two demand
  sources separately so they are not double-counted.
- **FR-028**: Indents MUST NOT be hard-deleted; removal MUST be a soft-delete, matching FR-004's
  treatment of purchases, issues, and transfers.
- **FR-029**: The `Permission` enum MUST be extended with one new value, `INVENTORY_APPROVE`, for
  indent approval and quantity reduction; all other indent endpoints MUST reuse the existing
  `INVENTORY` permission.
- **FR-030**: Indent write operations MUST be written to the audit log with the new entity type
  `MATERIAL_INDENT`.

### Additional Key Entities

- **MaterialIndent**: A site's request for material. Header carries site, project, required-by date,
  justification, requesting actor, approving actor, and status.
- **MaterialIndentLine**: One requested item: requested, approved, and fulfilled quantities, optional
  work activity or BOQ item reference, per-line status, and links to the issues and purchases that
  fulfilled it.

### Additional Success Criteria

- **SC-A01**: Every issue and purchase created from a site's demand is traceable back to the indent
  line that caused it, and every approved indent line's outstanding quantity always equals approved
  minus fulfilled.
- **SC-A02**: Approving an indent never changes any stock balance, verified by a test asserting
  balances are identical before and after approval.
