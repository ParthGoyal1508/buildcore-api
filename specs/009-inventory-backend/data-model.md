# Data Model: Inventory Backend (Stock, Purchases, Issues, Transfers, Payments)

Operational tables live in `inventory`; reference-data masters live in `settings` (research.md
§1, corrected during a master-PRD alignment audit). See research.md for design rationale.

## ItemCategory (`settings` schema — new, moved from `inventory` per research.md §1)

```
{ id, companyId, name (unique per company, stored uppercase), createdAt }
```

UNIQUE: `(companyId, name)`. CRUD lives in `SettingsService` (`createItemCategory()` etc.); this
module's own controller calls those exported methods rather than querying this table directly
(Principle I).

## Item (`settings` schema — new, moved from `inventory` per research.md §1)

```
{ id, companyId, code (auto-gen via CodeSeriesService 'ITEMS'),
  name (unique per company), categoryId FK→ItemCategory,
  unit: 'BAG' | 'CUM' | 'KG' | 'NOS' | 'MT' | 'LTR' | 'RMT' | 'SQM' (research.md §12),
  reorderLevel? (decimal, research.md §12), hsnCode? (string, research.md §12),
  description?, createdAt }
```

UNIQUE: `(companyId, name)`, `(companyId, code)`. Same `SettingsService`-exported-methods pattern
as ItemCategory.

## StockBalance (`inventory` schema — new, lazy-created on first purchase)

```
{ id, companyId, itemId (UUID — cross-schema ref to settings.Item), siteId (UUID — plain cross-schema ref to projects.Site),
  received (decimal, default 0), issued (decimal, default 0),
  transferIn (decimal, default 0), transferOut (decimal, default 0),
  avgRate (decimal, default 0), updatedAt }
```

UNIQUE: `(itemId, siteId)`. `companyId` is included for consistent RLS enforcement (M-007
remediation — `itemId` transitively scopes to company but direct `companyId` is required
for RLS policy consistency with all other `inventory` tables).

Derived (computed at service layer, never stored):
- `inStock = received + transferIn − issued − transferOut`
- `stockValue = inStock × avgRate`

## StockLedgerEntry (`inventory` schema — append-only, NEVER updated or deleted)

```
{ id, companyId, itemId (UUID — cross-schema ref to settings.Item), siteId (UUID),
  type: 'purchase' | 'purchase_reversal' | 'issue' | 'issue_reversal'
      | 'transfer_in' | 'transfer_out' | 'transfer_in_reversal' | 'transfer_out_reversal',
  quantity (decimal), rate (decimal? — populated for purchase/purchase_reversal only),
  referenceId (UUID — FK to the source Purchase/Issue/StockTransfer),
  date (date), createdAt }
```

Immutable after insert. Referenced by `StockService.recomputeWAR()` (research.md §3).

## Purchase (`inventory` schema — new)

```
{ id, companyId, siteId (UUID), itemId (UUID — cross-schema ref to settings.Item),
  vendorId (UUID — plain cross-schema ref to partners.Vendor),
  date (date), quantity (decimal), rate (decimal),
  amount (decimal — stored: quantity × rate),
  billFileRef? (encrypted object-storage reference),
  deleted (boolean, default false), createdAt }
```

## GoodsReceiptNote (`inventory` schema — new, research.md §14)

```
{ id, companyId, purchaseId FK→Purchase (unique, 1:1), grnNumber (auto-generated, unique per
  company), siteId (UUID), createdAt }
```

Auto-created whenever a `Purchase` is saved. Surfaced on the purchase's project site's Bills &
Expenses tab via `ProjectsService`.

## PurchaseBill (`inventory` schema — new, 1:1 with Purchase)

```
{ id, companyId, purchaseId FK→Purchase (unique),
  vendorId (UUID), totalAmount (decimal),
  paidAmount (decimal, default 0),
  paymentStatus: 'unpaid' | 'part_paid' | 'paid',
  createdAt, updatedAt }
```

`paymentStatus` auto-derived:
- `paidAmount = 0` → `unpaid`
- `0 < paidAmount < totalAmount` → `part_paid`
- `paidAmount >= totalAmount` → `paid`

## Issue (`inventory` schema — new)

```
{ id, companyId, siteId (UUID), itemId (UUID — cross-schema ref to settings.Item),
  date (date), quantity (decimal), issuedTo (string),
  activityId? (UUID — cross-schema ref to projects.DWR activity, research.md §13),
  boqItemId? (UUID — cross-schema ref to projects.BOQItem, research.md §13), remarks?,
  deleted (boolean, default false), createdAt }
```

## StockTransfer (`inventory` schema — new)

```
{ id, companyId, fromSiteId (UUID), toSiteId (UUID), itemId (UUID — cross-schema ref to settings.Item),
  date (date), quantity (decimal), remarks?,
  status: 'pending' | 'in_transit' | 'received' (default 'pending'),
  deleted (boolean, default false), createdAt }
```

Note: stock updates (source `transferOut` + destination `transferIn`) happen atomically at
creation regardless of status. Status tracks physical movement confirmation only.

## Payment (`inventory` schema — new)

```
{ id, companyId, vendorId (UUID), amount (decimal), date (date),
  paymentMode: 'upi' | 'bank_transfer' | 'cash' | 'cheque',
  referenceNumber (string),
  allocatedAmount (decimal, default 0 — stored, updated in-transaction per research.md §7),
  createdAt }
```

Derived: `unallocatedBalance = amount − allocatedAmount`.

## PaymentAllocation (`inventory` schema — new)

```
{ id, paymentId FK→Payment, billId FK→PurchaseBill,
  allocatedAmount (decimal), createdAt }
```

## Cross-module references

| Reference | Stored as | Resolved via |
|---|---|---|
| `StockBalance.siteId`, `Purchase.siteId`, etc. | Plain UUID | `ProjectsService.getSitesByProject()` for `getMaterialCostByProject`; `ProjectsService.getSiteById()` for site name display |
| `Purchase.vendorId`, `Payment.vendorId` | Plain UUID | `PartnersService.getVendorById()` — exported in-process method (`007-partners-backend` research.md §12), never the HTTP endpoint |
| `*.itemId` (Purchase, Issue, StockTransfer, StockBalance, StockLedgerEntry) | Plain UUID, cross-schema | `SettingsService.getItem()` (research.md §1) |
| `Issue.activityId` / `Issue.boqItemId` | Plain UUID, cross-schema | `ProjectsService.getActivityById()` / `.getBoqItemById()` (research.md §13) |
| `GoodsReceiptNote` visibility on Bills & Expenses | Not duplicated | `ProjectsService` surfaces it from the purchase's project site (research.md §14) |
| Item code | Auto-generated | `CodeSeriesService.nextCode('ITEMS', companyId)` |

## Stock Row Response Shape (computed at service layer)

```typescript
interface StockRow {
  itemId: string; itemName: string; itemCode: string;
  siteId: string; siteName: string;
  category: string; unit: string;
  received: number; issued: number; transferIn: number; transferOut: number;
  inStock: number;        // received + transferIn − issued − transferOut
  avgRate: number;
  stockValue: number;     // inStock × avgRate
  reorderLevel: number | null;
  belowReorderLevel: boolean;  // inStock < item.reorderLevel — research.md §12
}
```
