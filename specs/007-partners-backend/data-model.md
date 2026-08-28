# Data Model: Partners Backend (Vendors, Contractor Vault, Compliance, RAG Matrix, BOCW Cess)

Field names are conceptual; exact Prisma types are a task-level decision. All tables live in the
`partners` schema unless noted. See research.md for schema/entity decisions.

## VendorCategory (`settings` schema — new, moved from `partners` per research.md §1)

```
{ id, companyId, name (unique per company), description?, isDefault (boolean, default false),
  createdAt }
```

UNIQUE: `(companyId, name)`. CRUD lives in `SettingsService` (`createVendorCategory()` etc.);
Partners' own controller calls those exported methods rather than querying this table directly
(Principle I, research.md §1).

## Vendor (`partners` schema — new)

```
{ id, companyId, code (auto-generated via CodeSeriesService 'VENDORS' series),
  name, type: 'material' | 'fuel' | 'hire' | 'service' | 'subcontractor' | 'labour_contractor',
  gstin? (validated 15-char GSTIN format, research.md §13),
  pan? (validated 10-char PAN format, research.md §13),
  tdsSection? (string, validated against the Income Tax Act TDS-section pattern — open-ended
  list per master PRD, not a closed enum), tdsRate (decimal?),
  active (boolean, default true),
  address?, city?, state?, pinCode?,
  vendorCurrency (string, default 'INR'), exchangeRate (decimal, default 1.0),
  createdAt, updatedAt }
```

UNIQUE: `(companyId, code)`.

## VendorContact (`partners` schema — new)

```
{ id, vendorId FK→Vendor (cascade delete), name, phone?, email? }
```

Contacts are always replaced atomically on vendor update (research.md §10). No `updatedAt` needed
on individual contact rows.

## VendorDealsIn (`partners` schema — join table)

```
{ vendorId FK→Vendor, categoryId FK→settings.VendorCategory }
```

`categoryId` is a cross-schema reference, validated via `SettingsService.getVendorCategory()` on
write — never a direct cross-schema FK constraint (Principle I).

PRIMARY KEY: `(vendorId, categoryId)`. Replaced atomically with VendorContacts on vendor update.

## VendorHireDetail (`partners` schema — new, for subcontractor/hire types)

```
{ id, vendorId FK→Vendor (1:1, cascade delete),
  hireType: 'taken' | 'given',
  contractCode?, periodFrom (date?), periodTo (date?),
  machineCategory?, machineName?, requiredAvg (decimal?),
  chargesBase: 'monthly' | 'daily', rate (decimal?), minWorkingDays (integer?),
  allowBdDays (boolean, default false), allowIdleDays (boolean, default false),
  operatorCharges (decimal?), helperCharges (decimal?),
  maintenanceCharges (decimal?), fuelCharges (decimal?),
  termsAndConditions (text?), requirements (text?) }
```

UNIQUE: `(vendorId)` — one hire detail record per vendor.

## ContractorProfile (`partners` schema — new)

```
{ id, companyId, vendorId FK→Vendor (unique, cascade delete),
  licenceNumber?, pfRegistration?, esicRegistration?,
  bocwRegistration?, insurancePolicyNumber?,
  complianceStatus: 'compliant' | 'non_compliant' | 'partially_compliant'
    (default 'non_compliant' — recomputed on every MonthlyCompliance change, research.md §3),
  createdAt, updatedAt }
```

UNIQUE: `(vendorId)`, `(companyId, vendorId)`.

## ContractorDocument (`partners` schema — new)

```
{ id, contractorProfileId FK→ContractorProfile (cascade delete),
  documentType: 'labour_license' | 'pf_registration' | 'esic_registration'
    | 'insurance' | 'bocw_registration',
  fileRef (encrypted object-storage reference — same pattern as 005/008),
  expiresAt (date?), uploadedByUserId (UUID), uploadedAt }
```

Derived (not stored): `expiryWarning = expiresAt != null && expiresAt <= today + 30 days`.

## MonthlyCompliance (`partners` schema — new)

```
{ id, companyId, contractorProfileId FK→ContractorProfile,
  month (string 'YYYY-MM'),
  pfChallanNumber?, pfAmount (decimal?), pfDate (date?),
  esicChallanNumber?, esicAmount (decimal?), esicDate (date?),
  status: 'missing' | 'partial' | 'submitted' | 'verified'
    (auto-derived on create/update; 'verified' set only via explicit PATCH .../verify),
  verifiedByUserId (UUID?), verifiedAt?,
  createdAt, updatedAt }
```

UNIQUE: `(contractorProfileId, month)`.

Status derivation (research.md §3):
- `missing`: pfChallanNumber IS NULL AND esicChallanNumber IS NULL
- `partial`: exactly one of PF or ESIC provided
- `submitted`: both PF and ESIC provided
- `verified`: explicitly set via PATCH endpoint (overrides submitted only)

## BOCWPayment (`partners` schema — new)

```
{ id, companyId, projectId (UUID — plain cross-schema ref to projects.Project),
  amountPaid (decimal), paymentDate (date), referenceNumber (string),
  remarks (text?), recordedByUserId (UUID), createdAt }
```

BOCW cess liability, balance, and status are computed on-demand at request time (research.md §5):
- `cessLiability = projectContractValue × bocwCessRate` (from Settings)
- `totalPaid = SUM(BOCWPayment.amountPaid) WHERE projectId = X`
- `balance = cessLiability − totalPaid`
- `status`: paid (balance=0), partial (balance>0 and totalPaid>0), pending (totalPaid=0)

## `settings.Company` extension — MODIFIES feature 002's model

```
bocwCessRate Decimal @default(0.01)
```

Same additive migration pattern as 005's `otMultiplier`. Owned by this feature's migration.

## Cross-module references

| Reference | Stored as | Resolved via |
|---|---|---|
| `BOCWPayment.projectId` | Plain UUID | `ProjectsService.getProjectsWithContractValues()` on read |
| BOCW cess rate | In `settings.Company.bocwCessRate` | `SettingsService.getBocwCessRate(companyId)` |
| `getSubcontractorCostByProject()` | Not stored | `ProjectsService.getWorkOrderTotalByProject()` stub (TODO 008) |
| `VendorDealsIn.categoryId` | Plain UUID, cross-schema | `SettingsService.getVendorCategory()` (research.md §1) |
| Vendor name/TDS for Inventory (009) and Machinery (006) | Not duplicated | `PartnersService.getVendorById()` / `.getVendorTds()` — exported in-process methods (research.md §12), not the HTTP endpoint |

## RAG Matrix Response Shape (computed on demand)

```typescript
interface RagMatrixResponse {
  fy: string;                          // e.g. "2025-26"
  months: string[];                    // ["2025-04", "2025-05", ... "2026-03"]
  rows: Array<{
    contractorProfileId: string;
    contractorName: string;
    cells: Array<{
      month: string;
      status: 'verified' | 'submitted' | 'partial' | 'missing' | 'gray';
      complianceId: string | null;     // null for missing/gray cells
    }>;
  }>;
}
```
