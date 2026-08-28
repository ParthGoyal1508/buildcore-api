# Contract: `/inventory/*` endpoints

All endpoints require `JwtAuthGuard` + `@RequirePermission(Permission.INVENTORY)` — reusing
Settings' already-existing `INVENTORY` value verbatim (corrected during a master-PRD alignment
audit; no new enum values are added by this feature). Item Categories and Items are gated with
the existing `SETTINGS` value instead (now `settings`-schema masters, research.md §1).

---

## Item Categories — `settings` schema (permission: `SETTINGS`, via `SettingsService`)

Routes stay under `/inventory/categories` (matching the module's own grouping); each controller
action is a thin call into `SettingsService`'s exported methods — no direct query against the
`settings` schema tables (Principle I, research.md §1).

- `GET /inventory/categories` — list with `itemCount` per category.
- `POST /inventory/categories` — `{ name }` → 201; name stored uppercase. `409` on duplicate.
- `PATCH /inventory/categories/:id` — update name.
- `DELETE /inventory/categories/:id` — `409` if linked items exist.

---

## Items — `settings` schema (permission: `SETTINGS`, via `SettingsService`)

- `GET /inventory/items?search=&categoryId=&page=` — paginated list.
- `POST /inventory/items` — `{ name, categoryId, unit, reorderLevel?, hsnCode?, description? }`
  → 201; code auto-generated. `409` on duplicate name per company.
- `PATCH /inventory/items/:id` — partial update (not code; not categoryId if stock exists).
- `DELETE /inventory/items/:id` — `409` if any Purchase/Issue/Transfer references this item.

---

## Stock — `/inventory/stock` (permission: `INVENTORY`)

- `GET /inventory/stock?siteId=&categoryId=&search=&page=` — paginated stock rows. Each row
  is a `StockRow` (data-model.md); `stockValue` and `belowReorderLevel` computed server-side
  (research.md §12). Only item-sites with a `StockBalance` row (at least one purchase) are
  returned.

---

## Purchases — `/inventory/purchases` (permission: `INVENTORY`)

- `GET /inventory/purchases?siteId=&vendorId=&paymentStatus=&dateFrom=&dateTo=&page=` —
  paginated list. Includes vendor name (via `PartnersService`), bill file URL, GRN number.
- `POST /inventory/purchases` — `multipart/form-data`: `{ siteId, itemId, vendorId, date,
  quantity, rate, billFile? }`. Creates `Purchase`, appends `StockLedgerEntry` (type: purchase),
  upserts `StockBalance` (increments `received`, recalculates WAR), creates `PurchaseBill`
  (status: unpaid), auto-creates a `GoodsReceiptNote` (research.md §14). → 201. Audit-logged.
- `PATCH /inventory/purchases/:id` — update `date`, `remarks` only (quantity/rate changes
  require delete + re-create — immutable financial fields). `409` if deleted.
- `DELETE /inventory/purchases/:id` — soft-delete: sets `deleted: true`, appends
  `purchase_reversal` ledger entry, decrements `StockBalance.received`, replays WAR
  (research.md §3). `409` if bill has `allocatedAmount > 0`.

---

## Issues — `/inventory/issues` (permission: `INVENTORY`)

- `GET /inventory/issues?siteId=&itemId=&dateFrom=&dateTo=&page=` — paginated list.
- `POST /inventory/issues` — `{ siteId, itemId, date, quantity, issuedTo, activityId?,
  boqItemId?, remarks? }` — one of `activityId`/`boqItemId` required (research.md §13).
  Uses `SELECT FOR UPDATE` on `StockBalance`; `422` with `{ availableStock: N }` if
  `quantity > inStock`. On success: appends `issue` ledger entry, increments
  `StockBalance.issued`. Audit-logged. → 201.
- `DELETE /inventory/issues/:id` — soft-delete with `issue_reversal` ledger entry; decrements
  `issued`. `422` if reversal would make `issued` negative.

---

## Transfers — `/inventory/transfers` (permission: `INVENTORY`)

- `GET /inventory/transfers?fromSiteId=&toSiteId=&itemId=&dateFrom=&dateTo=&status=&page=`
- `POST /inventory/transfers` — `{ fromSiteId, toSiteId, itemId, date, quantity, remarks? }`.
  `400` if `fromSiteId === toSiteId`. Uses `SELECT FOR UPDATE` on source `StockBalance`; `422`
  if `quantity > source inStock`. Appends `transfer_out` and `transfer_in` ledger entries,
  updates both `StockBalance` rows atomically. Created with `status: 'pending'`. → 201.
- `PATCH /inventory/transfers/:id` — `{ status: 'in_transit' | 'received' }` only.
  State machine: `pending → in_transit → received`. `409` on out-of-order transition.
- `DELETE /inventory/transfers/:id` — allowed only for `pending` or `in_transit` status;
  `409` if `received`. Soft-delete with both reversal entries; both `StockBalance` rows revert.

---

## Payments — `/inventory/payments` (permission: `INVENTORY`)

- `GET /inventory/payments?vendorId=&dateFrom=&dateTo=&paymentMode=&page=` — paginated;
  includes `allocatedBillCount` (count of `PaymentAllocation` rows) and `unallocatedBalance`.
- `POST /inventory/payments` — `{ vendorId, amount, date, paymentMode, referenceNumber }`.
  Atomically: FIFO-allocates the amount against the vendor's unpaid/part-paid bills (oldest
  first), creates `PaymentAllocation` rows, updates `PurchaseBill.paidAmount` + `paymentStatus`,
  sets `Payment.allocatedAmount` and `unallocatedBalance`. `SELECT FOR UPDATE` on each bill
  row prevents concurrent over-payment. Audit-logged. → 201.
- `DELETE /inventory/payments/:id` — reverses all FIFO allocations atomically; decrements
  `PurchaseBill.paidAmount`; re-derives bill `paymentStatus`.

## Utility endpoints (permission: `INVENTORY`)

- `GET /inventory/stock/:itemId/:siteId` — single item-site stock (used by Issue/Transfer
  forms to show available stock hint). Returns `{ inStock, avgRate }` or `{ inStock: 0 }` if
  no `StockBalance` row exists.
- `GET /inventory/bills?vendorId=&paymentStatus=unpaid,part_paid` — list of outstanding
  `PurchaseBill` rows for a vendor (used by Payment modal's allocation list).

---

## Exported service method (for ProjectsModule P&L)

```typescript
// Exported from InventoryModule for injection by ProjectsModule
class InventoryService {
  async getMaterialCostByProject(
    projectId: string,
    dateRange: { from: Date; to: Date }
  ): Promise<number>
  // Calls ProjectsService.getSitesByProject(projectId) stub (TODO(008))
  // Returns 0 gracefully if stub returns [] or throws
}
```

---

## Audit logging

Extends `shared.AuditLogEntry.entityType` with: `ITEM_CATEGORY`, `ITEM`, `PURCHASE`,
`GOODS_RECEIPT_NOTE`, `ISSUE`, `STOCK_TRANSFER`, `PAYMENT`. Every create/update/delete writes an
audit entry.
