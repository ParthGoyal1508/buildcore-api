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

**Why this priority**: No dependency; required before any item can be created. Ships with 8
seeded default categories.

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
   `StockBalance.received` increments, WAR recalculates, and a `PurchaseBill` (status: `unpaid`)
   is created.
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
   `siteId`, `itemId`, `date`, `quantity`, `issuedTo`, and optional `remarks`, **Then** the
   issue is recorded, `StockLedgerEntry` (type: `issue`) is appended, `StockBalance.issued`
   increments.
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
- **FR-013**: Every endpoint MUST be gated by `JwtAuthGuard` + `@RequirePermission()` using
  enum values: `INVENTORY_STOCK` (stock view), `INVENTORY_PURCHASES` (purchases + items +
  categories), `INVENTORY_PAYMENTS` (payments); these are added to Settings' existing enum.
- **FR-014**: `StockValue = inStock × avgRate` MUST be computed server-side on stock reads, never
  stored as a column (it would become stale between WAR updates).
- **FR-015**: Item names MUST be unique per company; `POST /inventory/items` returns `409` on
  duplicate name.

### Key Entities

- **ItemCategory** (`inventory` schema): `id`, `companyId`, `name` (uppercase), `createdAt`.
- **Item** (`inventory` schema): `id`, `companyId`, `code` (auto-gen), `name` (unique per
  company), `categoryId` FK, `unit` (BAG|CUM|KG|NOS|MT|LTR), `description?`, `createdAt`.
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
- **PurchaseBill** (`inventory` schema): `id`, `companyId`, `purchaseId` FK (1:1), `vendorId`,
  `totalAmount`, `paidAmount` (default 0), `paymentStatus` (unpaid|part_paid|paid),
  `createdAt`, `updatedAt`.
- **Issue** (`inventory` schema): `id`, `companyId`, `siteId`, `itemId` FK, `date`, `quantity`,
  `issuedTo`, `remarks?`, `deleted` (boolean, default false), `createdAt`.
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

## Assumptions

- Settings' CodeSeriesService supports an `ITEMS` series type; if not, a simple sequential
  item code generator is built within the `inventory` module.
- `ProjectsService` exposes `getSitesByProject(projectId): string[]` returning siteIds — needed
  for `getMaterialCostByProject`. This is added as a stub export from `ProjectsModule` (same
  pattern as other cross-module stubs).
- The `inventory` module reads `PartnersService.getVendorById(vendorId)` for vendor name display
  in purchase/payment lists — full vendor data is not cached in `inventory` tables.
- Purchase bill files use the same encrypted object-storage reference pattern as 005/007/008.
- The `@nestjs/bullmq` queue (pre-approved in the constitution) is NOT used for ledger writes —
  all ledger updates are synchronous within the request transaction, acceptable for the expected
  transaction volume.
