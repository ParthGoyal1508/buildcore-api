# Data Model: Inventory Backend (Stock, Purchases, Issues, Transfers, Payments)

All tables live in the `inventory` schema. See research.md for design rationale.

## ItemCategory (`inventory` schema — new)

```
{ id, companyId, name (unique per company, stored uppercase), createdAt }
```

UNIQUE: `(companyId, name)`.

## Item (`inventory` schema — new)

```
{ id, companyId, code (auto-gen via CodeSeriesService 'ITEMS'),
  name (unique per company), categoryId FK→ItemCategory,
  unit: 'BAG' | 'CUM' | 'KG' | 'NOS' | 'MT' | 'LTR',
  description?, createdAt }
```

UNIQUE: `(companyId, name)`, `(companyId, code)`.

## StockBalance (`inventory` schema — new, lazy-created on first purchase)

```
{ id, companyId, itemId FK→Item, siteId (UUID — plain cross-schema ref to projects.Site),
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
{ id, companyId, itemId FK→Item, siteId (UUID),
  type: 'purchase' | 'purchase_reversal' | 'issue' | 'issue_reversal'
      | 'transfer_in' | 'transfer_out' | 'transfer_in_reversal' | 'transfer_out_reversal',
  quantity (decimal), rate (decimal? — populated for purchase/purchase_reversal only),
  referenceId (UUID — FK to the source Purchase/Issue/StockTransfer),
  date (date), createdAt }
```

Immutable after insert. Referenced by `StockService.recomputeWAR()` (research.md §3).

## Purchase (`inventory` schema — new)

```
{ id, companyId, siteId (UUID), itemId FK→Item,
  vendorId (UUID — plain cross-schema ref to partners.Vendor),
  date (date), quantity (decimal), rate (decimal),
  amount (decimal — stored: quantity × rate),
  billFileRef? (encrypted object-storage reference),
  deleted (boolean, default false), createdAt }
```

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
{ id, companyId, siteId (UUID), itemId FK→Item,
  date (date), quantity (decimal), issuedTo (string), remarks?,
  deleted (boolean, default false), createdAt }
```

## StockTransfer (`inventory` schema — new)

```
{ id, companyId, fromSiteId (UUID), toSiteId (UUID), itemId FK→Item,
  date (date), quantity (decimal), remarks?,
  deleted (boolean, default false), createdAt }
```

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
| `Purchase.vendorId`, `Payment.vendorId` | Plain UUID | `PartnersService.getVendorById()` for vendor name in lists |
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
}
```
