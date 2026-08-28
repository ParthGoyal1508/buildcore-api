# Quickstart: Validating the Inventory Backend

## Prerequisites

- Seeded company (002), admin session. Migrations applied: `inventory` schema (10 tables),
  `Permission` enum extended with `INVENTORY_STOCK`/`INVENTORY_PURCHASES`/`INVENTORY_PAYMENTS`,
  `ITEMS` code-series seeded.

---

## Scenario 1 — Item Categories & Items (US1 & US2)

1. `POST /inventory/categories` with `{ name: "cement" }`. **Expected**: 201, name stored
   as "CEMENT".
2. `POST /inventory/categories` same name. **Expected**: 409.
3. `POST /inventory/items` with `{ name: "Cement OPC 43", categoryId, unit: "BAG" }`.
   **Expected**: 201, code auto-generated (e.g. "ITM-001").
4. `DELETE /inventory/categories/:id` (still has linked item). **Expected**: 409.

---

## Scenario 2 — Purchases, WAR, and Stock (US3 & US6)

1. `POST /inventory/purchases` with qty=100, rate=50. **Expected**: 201; `GET /inventory/stock`
   shows `received: 100, inStock: 100, avgRate: 50, stockValue: 5000`.
2. Second purchase: qty=50, rate=60. **Expected**: `StockBalance`: `received: 150`,
   `avgRate: (100×50 + 50×60) / 150 = 53.33`, `stockValue: 7999.50`.
3. `DELETE /inventory/purchases/:id` (first purchase, no allocations). **Expected**: soft-deleted;
   WAR replayed from only the second purchase → `received: 50, avgRate: 60`.

---

## Scenario 3 — Issues with concurrency check (US4)

1. With `inStock: 50`, `POST /inventory/issues` qty=30. **Expected**: 201; `inStock: 20`.
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

1. Create two purchases → two `PurchaseBill` rows (₹5,000 + ₹3,000), both `unpaid`.
2. `GET /inventory/bills?vendorId=&paymentStatus=unpaid,part_paid`. **Expected**: 2 bills.
3. `POST /inventory/payments` amount=7000, allocations: [{ bill1, 5000 }, { bill2, 2000 }].
   **Expected**: bill1 → `paid`; bill2 → `part_paid (paidAmount: 2000)`.
4. Over-allocate: allocations sum = 7500 > payment amount 7000. **Expected**: 400.
5. `DELETE /inventory/payments/:id`. **Expected**: both bills revert to original status.

---

## Scenario 6 — getMaterialCostByProject (US8)

1. Seed 3 purchases for Site A (projectId=X) within a date range totalling ₹1,50,000.
   Seed 1 purchase outside the range.
2. Call `InventoryService.getMaterialCostByProject(X, { from, to })` in a unit test.
   **Expected**: returns 150000 (stub `getSitesByProject` returning [siteAId]).
