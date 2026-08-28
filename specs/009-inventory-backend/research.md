# Research: Inventory Backend (Stock, Purchases, Issues, Transfers, Payments)

## 1. Schema placement

**Decision**: All 10 entities in a single new `inventory` schema: `ItemCategory`, `Item`,
`StockBalance`, `StockLedgerEntry`, `Purchase`, `PurchaseBill`, `Issue`, `StockTransfer`,
`Payment`, `PaymentAllocation`. `inventory` is a named schema in the constitution's canonical
module list — this feature is its first and complete population.

## 2. Dual-write: `StockBalance` + `StockLedgerEntry` in every transaction

**Decision**: Every stock-impacting operation (purchase, issue, transfer, and their reversals)
writes to both tables atomically in a single Prisma transaction:

1. Append a `StockLedgerEntry` (append-only, never updated or deleted — the audit record).
2. Update `StockBalance` running totals (received/issued/transferIn/transferOut, avgRate).

`GET /inventory/stock` reads only `StockBalance` (O(1) per item-site). Full ledger reconstruction
is available via `StockLedgerEntry` for audit without impacting read performance.

**Rationale**: The PRD mandates "append-only ledger for auditability" while also requiring
real-time stock reads. The dual-write pattern satisfies both without the latency of computing
balances from the full ledger on every request.

**Alternatives considered**: Compute balance from ledger on every read — rejected: O(N) per
item-site on every stock page load; unacceptable at scale.

## 3. WAR: incremental on purchase, full replay on deletion

**Decision**: On new purchase: `newWAR = (existingStock × existingWAR + newQty × newRate) /
(existingStock + newQty)` — incremental, runs in-transaction with the purchase write.

On purchase soft-delete: `StockService.recomputeWAR(itemId, siteId)` queries all non-deleted
purchase `StockLedgerEntry` rows for that pair ordered by `date`, replays them sequentially
to compute the final WAR, and updates `StockBalance.avgRate` — all within the delete transaction
(research.md §2, clarification Q5).

**Rationale**: WAR is path-dependent; incremental update is correct for the append-only path.
Full replay on deletion is the only correct approach for a mid-history reversal — at
construction-site scale (hundreds of purchase entries per item-site) this is fast enough.

## 4. `SELECT FOR UPDATE` concurrency control

**Decision**: `IssueService.create()` and `TransferService.create()` both use Prisma `$transaction`
with a raw SQL statement `SELECT id, received, "transferIn", issued, "transferOut" FROM
inventory."StockBalance" WHERE "itemId" = $1 AND "siteId" = $2 FOR UPDATE` before validating
quantity. This acquires a row-level lock on `StockBalance` for the duration of the transaction,
preventing concurrent over-issue (clarification Q1).

**Rationale**: `SELECT FOR UPDATE` is the simplest correct solution at this scale. No retry
logic needed (the losing transaction gets a `422`). Prisma `$queryRaw` supports parameterized
raw SQL safely — no injection risk.

## 5. Lazy `StockBalance` creation

**Decision**: `StockBalance` rows are created via Prisma `upsert` on the first purchase for a
given `(itemId, siteId)`. No pre-population. `GET /inventory/stock` returns only rows that
exist (item-sites with at least one purchase history). Once created, the row persists even
when `inStock` reaches zero (clarification Q4).

**Rationale**: Prevents N×M row explosion when items or sites are added. Zero-balance filtering
is a UI concern — the backend returns all rows, the frontend can optionally filter display.

## 6. Soft-delete with reversal entries

**Decision**: `Purchase`, `Issue`, and `StockTransfer` are soft-deleted (`deleted: true`).
Each deletion appends a corresponding reversal `StockLedgerEntry` and adjusts `StockBalance`
totals. The reversal is blocked (`422`) if it would produce negative totals. WAR is replayed
after purchase deletion (research.md §3). This is consistent with the constitution's pattern
for financial immutability.

## 7. Payment allocation atomicity

**Decision**: `PaymentService.create()` runs in a single Prisma transaction: (1) creates the
`Payment` row, (2) creates `PaymentAllocation` rows, (3) increments `PurchaseBill.paidAmount`
and re-derives `paymentStatus` per bill, (4) sets `Payment.allocatedAmount = sum(allocations)`.
Deletion runs the same steps in reverse (clarification Q3).

**Pre-validation before transaction**: Sum-of-allocations ≤ payment amount AND each
`allocatedAmount ≤ bill.remainingAmount` are checked before opening the transaction to fail
fast with a `400` rather than inside the DB lock.

## 8. `getMaterialCostByProject` implementation

**Decision**: `InventoryService.getMaterialCostByProject(projectId, dateRange)` calls
`ProjectsService.getSitesByProject(projectId)` (stub — TODO(008)) to get siteId array, then
queries `SUM(Purchase.amount) WHERE siteId IN [...] AND date BETWEEN ... AND ... AND deleted = false`.
If `getSitesByProject` returns `[]` or throws, returns 0 gracefully (clarification Q2).

## 9. Permission enum — three new values

**Decision**: `INVENTORY_STOCK`, `INVENTORY_PURCHASES`, `INVENTORY_PAYMENTS` added to
Settings' `Permission` enum. `INVENTORY_STOCK` gates the stock view + item/category CRUD
(master data). `INVENTORY_PURCHASES` gates purchases, issues, and transfers. `INVENTORY_PAYMENTS`
gates vendor payments and allocation.

**Rationale**: Three values cover the natural role split: warehouse staff (stock + transactions)
vs. finance (payments). Items/categories are gated under `INVENTORY_STOCK` as they are
operational master data accessed from the stock page.

## 10. Item code generation

**Decision**: Settings' `CodeSeriesService.nextCode('ITEMS', companyId)` for auto-generated
item codes. If the `ITEMS` series type doesn't exist in Settings' seed, this feature adds it
(same pattern as `PROJECTS` in 008 and `VENDORS` in 007).

## 11. `stockValue` not stored

**Decision**: `stockValue = inStock × avgRate` is computed at the service layer on every stock
read — `StockService.toRow()` computes it from the `StockBalance` fields. Never stored as a
column (stale risk every time WAR or balances change).
