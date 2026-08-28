# Research: Inventory Backend (Stock, Purchases, Issues, Transfers, Payments)

## 1. Schema placement

**Decision** (corrected during a master-PRD alignment audit): Operational entities land in
`inventory`: `StockBalance`, `StockLedgerEntry`, `Purchase`, `GoodsReceiptNote`, `PurchaseBill`,
`Issue`, `StockTransfer`, `Payment`, `PaymentAllocation` (9 tables). **`ItemCategory` and `Item`
land in `settings` instead** — this feature's original placement (all 10 entities in `inventory`)
missed that master PRD §7.8.6 explicitly places "Inventory Masters" (Item Master, Category
Master, Reorder Levels) as a Settings subsection, matching Employee Setup Masters, Reimbursement
Categories, and Machinery's corrected Equipment Categories/Doc Types/Hire Rates. CRUD logic for
both lives in `SettingsService`-exported methods; this module's own `/inventory/items`,
`/inventory/categories` controllers call those methods rather than querying `settings` directly
(Principle I). `inventory` remains a named schema in the constitution's canonical module list and
is correct for the nine operational entities.

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

## 7. Payment allocation: FIFO atomicity

**Decision**: `PaymentService.create()` runs in a single Prisma transaction implementing FIFO
allocation (master PRD §7.6.5): (1) creates the `Payment` row, (2) fetches the vendor's
unpaid/part-paid `PurchaseBill` rows ordered by `date ASC` (oldest first), (3) allocates the
payment amount greedily across bills until exhausted, (4) creates `PaymentAllocation` rows
for the audit trail, (5) updates each bill's `paidAmount` and re-derives `paymentStatus`,
(6) sets `Payment.allocatedAmount` and `Payment.unallocatedBalance`. The `SELECT ... FOR UPDATE`
lock is applied to each `PurchaseBill` row being updated to prevent concurrent double-payment
(M-006 remediation from the analyze report).

Deletion reverses all FIFO allocations atomically in the same transaction.

**Rationale**: FIFO is the master PRD-mandated behaviour. It removes the UX complexity of manual
allocation entirely — the admin simply records the payment amount and the system handles the rest.

## 8. `getMaterialCostByProject` implementation

**Decision**: `InventoryService.getMaterialCostByProject(projectId, dateRange)` calls
`ProjectsService.getSitesByProject(projectId)` (stub — TODO(008)) to get siteId array, then
queries `SUM(Purchase.amount) WHERE siteId IN [...] AND date BETWEEN ... AND ... AND deleted = false`.
If `getSitesByProject` returns `[]` or throws, returns 0 gracefully (clarification Q2).

## 9. Permission enum — reuse the existing `INVENTORY` value

**Decision** (corrected during a master-PRD alignment audit): Settings' `Permission` enum already
contains `INVENTORY` — built "covering every PRD module by name" from feature 002's own original
design, the same reason `MACHINERY`/`LOGBOOK`/`FUEL`/`PROJECTS`/`PARTNERS` already exist too.
`INVENTORY` gates every endpoint in this feature (stock, purchases, issues, transfers, payments).
Item Categories and Items (now `settings`-owned, §1) are gated with the existing `SETTINGS` value
instead, matching every other reference-data master. No new `Permission` values are added by this
feature at all.

**Rationale**: The original decision below invented three new values where `INVENTORY` already
existed reserved by name for exactly this module — the same oversight found and fixed in the
Machinery and Partners specs. A single coarse `INVENTORY` permission is appropriate: this
project's other multi-area modules (Machinery, HR & Payroll) split permissions only where trust
levels genuinely differ (e.g. asset management vs. financial verification); stock/purchases/
issues/transfers/payments here are all the same back-office warehouse-and-accounts function, not
meaningfully different trust levels.

~~**Original (superseded) decision**: `INVENTORY_STOCK`, `INVENTORY_PURCHASES`,
`INVENTORY_PAYMENTS` added to Settings' `Permission` enum.~~

## 10. Item code generation

**Decision**: Settings' `CodeSeriesService.nextCode('ITEMS', companyId)` for auto-generated
item codes. If the `ITEMS` series type doesn't exist in Settings' seed, this feature adds it
(same pattern as `PROJECTS` in 008 and `VENDORS` in 007).

## 11. `stockValue` not stored

**Decision**: `stockValue = inStock × avgRate` is computed at the service layer on every stock
read — `StockService.toRow()` computes it from the `StockBalance` fields. Never stored as a
column (stale risk every time WAR or balances change).

## 12. Reorder Level, HSN Code, and full Units enum — gaps found on re-audit

**Decision**: `Item` (now `settings`-schema, §1) gains `reorderLevel?: decimal` and `hsnCode?:
string` fields, both named explicitly in master PRD §7.6.6 and entirely absent from this
feature's original scope. `GET /inventory/stock` computes `belowReorderLevel: boolean` per row
(`inStock < item.reorderLevel`) at the service layer, same pattern as `stockValue` (§11) — never
stored, always fresh. The `Unit` enum is extended to all 8 master-PRD-named units (BAG, CUM, KG,
NOS, MT, LTR, RMT, SQM) — the original enum was missing RMT and SQM.

**Rationale**: Reorder Level is the field master PRD §7.6.1's "highlight if stock < reorder
level" alert directly depends on — without it, that named requirement has no data to compute
from. HSN Code and the two missing units are simple field/enum completeness gaps against an
explicit master PRD field list.

## 13. Issue's Activity/BOQ Item link — a gap found on re-audit

**Decision**: `Issue` gains `activityId?` / `boqItemId?` (cross-schema references, resolved via
`ProjectsService`, not duplicated into `inventory` schema) — master PRD §7.6.3 names "Activity/
BOQ Item" as a required Issue field, absent from this feature's original scope.

**Rationale**: Without this link, material consumption recorded via Issues cannot be traced back
to the project BOQ item or work activity it was consumed for — breaking the connection to
Projects' Costing/P&L views that need per-activity material cost, not just per-project totals.

**Alternatives considered**: A free-text "activity" field instead of a structured reference —
rejected: master PRD's own wording ("Activity/BOQ Item") implies a selectable reference into
Projects' existing BOQ Item / DWR Activity data, not an unstructured label.

## 14. Goods Receipt Note (GRN) — a gap found on re-audit

**Decision**: A `GoodsReceiptNote` table (`inventory` schema) is auto-created 1:1 with every
`Purchase` on save, carrying an auto-generated `grnNumber`. It's surfaced on the purchase's
project site's Bills & Expenses tab via `ProjectsService` (that tab already exists per
`008-projects` — this feature's Purchase record becomes one of the line items it lists).

**Rationale**: Master PRD §7.6.2 explicitly requires "Auto-generated on purchase save" and
"Links to project's Bills & Expenses tab" — both entirely missing from this feature's original
scope, which created only a `PurchaseBill` (a payable-tracking record) with no GRN concept at
all.

## 15. Default category seed list — corrected to all 10

**Decision**: The seeded `ItemCategory` defaults are all 10 master-PRD-named categories (Cement,
Aggregate, Steel, Bricks, Sand, Paint, Electrical, Plumbing, Fuel, Consumables) — this feature's
original seed list had only 8, omitting Fuel and Consumables.

**Rationale**: Straightforward completeness gap against an explicit master PRD list.
