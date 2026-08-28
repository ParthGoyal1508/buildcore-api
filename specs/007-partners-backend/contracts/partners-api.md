# Contract: `/partners/*` endpoints

All endpoints require `JwtAuthGuard` + `@RequirePermission(Permission.PARTNERS)` — reusing
Settings' already-existing `PARTNERS` value verbatim (corrected during a master-PRD alignment
audit; no new enum values are added by this feature). Vendor Categories are gated with the
existing `SETTINGS` value instead (now a `settings`-schema master, research.md §1).

---

## Vendor Categories — `settings` schema (permission: `SETTINGS`, via `SettingsService`)

Routes stay under `/partners/vendor-categories` (matching the module's own grouping); each
controller action is a thin call into `SettingsService`'s exported methods — no direct query
against the `settings` schema tables (Principle I, research.md §1).

- `GET /partners/vendor-categories` — list all categories with `vendorCount`.
- `POST /partners/vendor-categories` — `{ name, description? }` → 201.
  `409` if `name` already exists for this company.
- `PATCH /partners/vendor-categories/:id` — partial update.
- `DELETE /partners/vendor-categories/:id` — `409` if any `VendorDealsIn` row references this
  category.

---

## Vendors — `/partners/vendors` (permission: `PARTNERS`)

- `GET /partners/vendors?search=&type=&active=&page=` — paginated list. Response includes
  `dealsIn` (array of category names), `primaryContact` (first contact's name+phone), `tdsSection`,
  `tdsRate`.
- `POST /partners/vendors` — `{ name, type, gstin?, pan?, tdsSection?, tdsRate?, active?,
  address?, city?, state?, pinCode?, vendorCurrency?, exchangeRate?,
  contacts: VendorContactInput[], categoryIds: string[],
  hireDetail?: VendorHireDetailInput }` → 201. `gstin`/`pan` rejected with a field-level `400` if
  provided but malformed (research.md §13). Contacts and category tags atomically inserted.
  Code auto-generated via `CodeSeriesService('VENDORS', companyId)`.
- `GET /partners/vendors/:id` — full vendor with `contacts`, `dealsIn` (category objects),
  `hireDetail?`, and `contractorProfile?` (if a ContractorProfile exists for this vendor).
- `PATCH /partners/vendors/:id` — partial update. If `contacts` array is provided, it atomically
  replaces all existing contacts. If `categoryIds` array is provided, it atomically replaces all
  `VendorDealsIn` rows. Audit-logged.
- `GET /partners/vendors/:id/tds` — `{ tdsSection, tdsRate }` — thin HTTP wrapper around
  `PartnersService.getVendorTds()` (research.md §12), for direct frontend consumption. Inventory
  and Machinery modules consume `getVendorById()`/`getVendorTds()` as exported in-process methods,
  never this HTTP endpoint (Principle I).

---

## Contractors — `/partners/contractors` (permission: `PARTNERS`)

- `GET /partners/contractors?complianceStatus=&page=` — paginated list of ContractorProfiles
  where `vendor.active = true`. Response includes vendor name, registration numbers,
  `complianceStatus` badge.
- `POST /partners/contractors` — `{ vendorId, licenceNumber?, pfRegistration?,
  esicRegistration?, bocwRegistration?, insurancePolicyNumber? }`. `vendorId` must reference a
  Vendor with `type IN ('subcontractor', 'labour_contractor')`; `409` if a profile already exists
  for that vendor.
- `GET /partners/contractors/:id` — full contractor detail: profile fields, `documents` array
  (with `expiryWarning` flag per document), compliance history link (contractorProfileId for
  client-side filter).
- `PATCH /partners/contractors/:id` — update registration fields.
- `POST /partners/contractors/:id/documents` — `multipart/form-data`: `documentType`, `file`,
  `expiresAt?` → 201. Stores encrypted file reference.
- `DELETE /partners/contractors/:id/documents/:docId` — removes document record + schedules
  storage cleanup.

---

## Monthly Compliance — `/partners/compliance` (permission: `PARTNERS`)

- `GET /partners/compliance?contractorId=&month=&status=&page=` — paginated list. `contractorId`
  accepts any profile ID (active or inactive vendors included in history reads).
- `POST /partners/compliance` — `{ contractorId, month (YYYY-MM), pfChallanNumber?, pfAmount?,
  pfDate?, esicChallanNumber?, esicAmount?, esicDate? }` → 201. Status auto-derived from
  provided fields. Triggers `complianceStatus` recompute for the contractor. `409` if a record
  already exists for `(contractorId, month)`.
- `PATCH /partners/compliance/:id` — update PF/ESIC fields. Status re-derived. Triggers
  `complianceStatus` recompute. `409` if status = `verified` (verified records are immutable).
- `PATCH /partners/compliance/:id/verify` — moves `submitted → verified`; sets
  `verifiedByUserId` + `verifiedAt`. Audit-logged. `409` if status != `submitted`.
  Triggers `complianceStatus` recompute.

---

## RAG Matrix — `/partners/rag` (permission: `PARTNERS`)

- `GET /partners/rag?fy=2025-26` — returns full matrix for the FY. Response shape: see
  data-model.md `RagMatrixResponse`. Only active-vendor contractors are included as rows.
  Future months → `gray`. Missing records for past months → `missing`.

---

## BOCW Cess — `/partners/bocw` (permission: `PARTNERS`)

- `GET /partners/bocw?page=` — paginated list of projects with cess computation. Each row:
  `{ projectId, projectName, contractValue, cessRate, cessLiability, totalPaid, balance,
  lastPaymentDate, status, unavailableModules? }`. Calls `ProjectsService` and `SettingsService`
  on demand.
- `POST /partners/bocw/:projectId/payments` — `{ amountPaid, paymentDate, referenceNumber,
  remarks? }` → 201. Payment recorded; balance and status recompute on next GET. Audit-logged.
- `GET /partners/bocw/:projectId/payments` — list of all payment records for a project.

---

## Exported service methods (for ProjectsModule, PlantModule, InventoryModule)

```typescript
// Exported from PartnersModule for in-process injection — never called via HTTP self-call
class PartnersService {
  async getSubcontractorCostByProject(
    projectId: string,
    dateRange: { from: Date; to: Date }
  ): Promise<number>
  // Implementation: calls ProjectsService.getWorkOrderTotalByProject() stub
  // Returns 0 until TODO(008) ships the real method

  async getVendorById(vendorId: string): Promise<{ id: string; name: string; type: string; active: boolean } | null>
  // Consumed by PlantModule (006) and InventoryModule (009) for vendor name display —
  // research.md §12, found missing on re-audit

  async getVendorTds(vendorId: string): Promise<{ tdsSection: string | null; tdsRate: number | null } | null>
  // Consumed by PlantModule (006, Hire Bills) and InventoryModule (009, Purchases/Payments)
  // for TDS calculation — same underlying data as GET /partners/vendors/:id/tds
}
```

---

## Audit logging

Extends `shared.AuditLogEntry.entityType` with: `VENDOR`, `VENDOR_CATEGORY`, `CONTRACTOR_PROFILE`,
`CONTRACTOR_DOCUMENT`, `MONTHLY_COMPLIANCE`, `BOCW_PAYMENT`. Every write to these entities
(create/update/delete/verify) writes an audit entry with `before`/`after` JSON, actor, timestamp.
