# Contract: `/partners/*` endpoints

All endpoints require `JwtAuthGuard` + `@RequirePermission()` using one of three new values
added to Settings' `Permission` enum: `VENDORS`, `CONTRACTORS`, `BOCW`.

---

## Vendor Categories — `/partners/vendor-categories` (permission: `VENDORS`)

- `GET /partners/vendor-categories` — list all categories with `vendorCount`.
- `POST /partners/vendor-categories` — `{ name, description? }` → 201.
  `409` if `name` already exists for this company.
- `PATCH /partners/vendor-categories/:id` — partial update.
- `DELETE /partners/vendor-categories/:id` — `409` if any `VendorDealsIn` row references this
  category.

---

## Vendors — `/partners/vendors` (permission: `VENDORS`)

- `GET /partners/vendors?search=&type=&active=&page=` — paginated list. Response includes
  `dealsIn` (array of category names), `primaryContact` (first contact's name+phone), `tdsSection`,
  `tdsRate`.
- `POST /partners/vendors` — `{ name, type, gstin?, pan?, tdsSection?, tdsRate?, active?,
  address?, city?, state?, pinCode?, vendorCurrency?, exchangeRate?,
  contacts: VendorContactInput[], categoryIds: string[],
  hireDetail?: VendorHireDetailInput }` → 201. Contacts and category tags atomically inserted.
  Code auto-generated via `CodeSeriesService('VENDORS', companyId)`.
- `GET /partners/vendors/:id` — full vendor with `contacts`, `dealsIn` (category objects),
  `hireDetail?`, and `contractorProfile?` (if a ContractorProfile exists for this vendor).
- `PATCH /partners/vendors/:id` — partial update. If `contacts` array is provided, it atomically
  replaces all existing contacts. If `categoryIds` array is provided, it atomically replaces all
  `VendorDealsIn` rows. Audit-logged.
- `GET /partners/vendors/:id/tds` — `{ tdsSection, tdsRate }` — minimal payload for Inventory
  and Machinery modules (consumed via exported service, not direct cross-schema query).

---

## Contractors — `/partners/contractors` (permission: `CONTRACTORS`)

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

## Monthly Compliance — `/partners/compliance` (permission: `CONTRACTORS`)

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

## RAG Matrix — `/partners/rag` (permission: `CONTRACTORS`)

- `GET /partners/rag?fy=2025-26` — returns full matrix for the FY. Response shape: see
  data-model.md `RagMatrixResponse`. Only active-vendor contractors are included as rows.
  Future months → `gray`. Missing records for past months → `missing`.

---

## BOCW Cess — `/partners/bocw` (permission: `BOCW`)

- `GET /partners/bocw?page=` — paginated list of projects with cess computation. Each row:
  `{ projectId, projectName, contractValue, cessRate, cessLiability, totalPaid, balance,
  lastPaymentDate, status, unavailableModules? }`. Calls `ProjectsService` and `SettingsService`
  on demand.
- `POST /partners/bocw/:projectId/payments` — `{ amountPaid, paymentDate, referenceNumber,
  remarks? }` → 201. Payment recorded; balance and status recompute on next GET. Audit-logged.
- `GET /partners/bocw/:projectId/payments` — list of all payment records for a project.

---

## Exported service method (for ProjectsModule P&L)

```typescript
// Exported from PartnersModule for injection by ProjectsModule
class PartnersService {
  async getSubcontractorCostByProject(
    projectId: string,
    dateRange: { from: Date; to: Date }
  ): Promise<number>
  // Implementation: calls ProjectsService.getWorkOrderTotalByProject() stub
  // Returns 0 until TODO(008) ships the real method
}
```

---

## Audit logging

Extends `shared.AuditLogEntry.entityType` with: `VENDOR`, `VENDOR_CATEGORY`, `CONTRACTOR_PROFILE`,
`CONTRACTOR_DOCUMENT`, `MONTHLY_COMPLIANCE`, `BOCW_PAYMENT`. Every write to these entities
(create/update/delete/verify) writes an audit entry with `before`/`after` JSON, actor, timestamp.
