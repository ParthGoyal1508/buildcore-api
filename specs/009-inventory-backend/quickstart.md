# Quickstart: Validating the Inventory Backend

## Prerequisites

- Seeded company (002), admin session. Migrations applied: `inventory` schema (9 operational
  tables), `settings.ItemCategory`/`settings.Item` (moved, research.md §1), `ITEMS` code-series
  seeded, seeded 10 default categories. No `Permission` enum changes — this feature reuses
  Settings' existing `INVENTORY` and `SETTINGS` values (corrected, research.md §9).

---

## Scenario 1 — Item Categories & Items (US1 & US2)

1. `POST /inventory/categories` with `{ name: "cement" }`. **Expected**: 201, name stored
   as "CEMENT".
2. `POST /inventory/categories` same name. **Expected**: 409.
3. `POST /inventory/items` with `{ name: "Cement OPC 43", categoryId, unit: "BAG",
   reorderLevel: 50, hsnCode: "2523" }`. **Expected**: 201, code auto-generated (e.g. "ITM-001").
4. `DELETE /inventory/categories/:id` (still has linked item). **Expected**: 409.
5. With `inStock` below the item's `reorderLevel` (after Scenario 2/3), `GET /inventory/stock`.
   **Expected**: that row shows `belowReorderLevel: true`.

---

## Scenario 2 — Purchases, WAR, and Stock (US3 & US6)

1. `POST /inventory/purchases` with qty=100, rate=50. **Expected**: 201, response includes a
   `grnNumber` (auto-generated GRN, research.md §14); `GET /inventory/stock` shows
   `received: 100, inStock: 100, avgRate: 50, stockValue: 5000`.
2. Second purchase: qty=50, rate=60. **Expected**: `StockBalance`: `received: 150`,
   `avgRate: (100×50 + 50×60) / 150 = 53.33`, `stockValue: 7999.50`.
3. `DELETE /inventory/purchases/:id` (first purchase, no allocations). **Expected**: soft-deleted;
   WAR replayed from only the second purchase → `received: 50, avgRate: 60`.

---

## Scenario 3 — Issues with concurrency check (US4)

1. With `inStock: 50`, `POST /inventory/issues` qty=30 with a `boqItemId` (research.md §13).
   **Expected**: 201; `inStock: 20`.
2. `POST /inventory/issues` qty=25. **Expected**: 422 `{ availableStock: 20 }`.
3. `POST /inventory/issues` qty=20. **Expected**: 201; `inStock: 0`.
4. `DELETE /inventory/issues/:id` (first issue). **Expected**: `inStock` back to 20.

---

## Scenario 4 — Transfers (US5)

1. `POST /inventory/transfers` from Site A to Site B, qty=15 (Site A has 20).
   **Expected**: Site A `inStock: 5`, Site B `inStock: 15`.
2. `POST /inventory/transfers` fromSiteId=toSiteId. **Expected**: 400.
3. Transfer 10 more from Site A (only 5 available). **Expected**: 422.

---

## Scenario 5 — Payments & Bill Allocation (US7)

1. Create two purchases (oldest first) → two `PurchaseBill` rows (₹5,000 + ₹3,000), both
   `unpaid`.
2. `GET /inventory/bills?vendorId=&paymentStatus=unpaid,part_paid`. **Expected**: 2 bills.
3. `POST /inventory/payments` with `{ vendorId, amount: 7000, date, paymentMode,
   referenceNumber }` — no `allocations` array; the system allocates automatically via FIFO
   (research.md §7). **Expected**: oldest bill (₹5,000) → `paid`; newer bill (₹3,000) →
   `part_paid (paidAmount: 2000)`; `Payment.allocatedAmount: 7000`,
   `unallocatedBalance: 0`.
4. `POST /inventory/payments` with `amount: 10000` against the now-fully-allocated vendor.
   **Expected**: the remaining ₹1,000 on the part-paid bill is allocated (→ `paid`); the
   excess ₹9,000 sits as `unallocatedBalance` on the new `Payment` row (FR from spec US7 AC2) —
   no `400`, since over-payment is allowed and simply leaves a balance for future bills.
5. `DELETE /inventory/payments/:id` (the first payment). **Expected**: both bills revert to their
   pre-payment status.

---

## Scenario 6 — getMaterialCostByProject (US8)

1. Seed 3 purchases for Site A (projectId=X) within a date range totalling ₹1,50,000.
   Seed 1 purchase outside the range.
2. Call `InventoryService.getMaterialCostByProject(X, { from, to })` in a unit test.
   **Expected**: returns 150000 (stub `getSitesByProject` returning [siteAId]).
