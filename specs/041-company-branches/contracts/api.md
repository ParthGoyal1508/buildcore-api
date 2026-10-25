# API Contracts: Company Branches (041)

All endpoints use typed DTOs with `class-validator` and `@nestjs/swagger` (Principle II). Unknown
fields are rejected.

## Branch management — `COMPANY_SETTINGS` + `OwnCompanyGuard` (companies.controller.ts)

### `GET /companies/:id/branches`
Response: `CompanyBranchDto[]`, sorted head office first, then by state.

```ts
CompanyBranchDto {
  id: string; label: string | null; tradeName: string | null;
  gstin: string | null; stateCode: string | null;   // derived from state
  address: string | null; city: string | null; state: string | null; pinCode: string | null;
  phone: string | null; email: string | null; website: string | null;
  pfEstablishmentCode: string | null; esicCode: string | null; professionalTaxRegNumber: string | null;
  isHeadOffice: boolean; isActive: boolean;
}
```

### `POST /companies/:id/branches`
Body `CreateCompanyBranchDto`:
- required: `address`, `city`, `state` (from the existing state list) and `pinCode` (`^\d{6}$`)
- optional: `label`, `tradeName`, `gstin` (GSTIN regex), `phone`, `email` (`@IsEmail`), `website`,
  `pfEstablishmentCode`, `esicCode`, `professionalTaxRegNumber`

Response: `201 CompanyBranchDto`. A new branch is never head office.

| Error | Status | Message |
|---|---|---|
| GSTIN state code ≠ state | 400 | `GSTIN state code {08} ({Rajasthan}) does not match the branch state ({Gujarat}).` |
| GSTIN PAN ≠ company PAN | 400 | `GSTIN {…} does not belong to this company's PAN {AAMCP8659H}.` |
| Duplicate GSTIN in company | 409 | `Another branch of this company already has GSTIN {…}.` |

### `PATCH /companies/:id/branches/:branchId`
Body `UpdateCompanyBranchDto` = `PartialType(Create)` + `isActive?: boolean`. The validation is the
same as create.

- Deactivating the head office → `400 The head office cannot be deactivated; make another branch head office first.`
- Writing to the head office also mirrors its values to the Company columns (research R2).

### `POST /companies/:id/branches/:branchId/head-office`
Makes this branch the head office in one transaction and re-mirrors the Company columns.

- Inactive target → `400`.
- Response: `CompanyBranchDto[]`.

### `PATCH /companies/:id` (existing)
It still accepts `gstin`, `address`, `city`, `state`, `pinCode`, `phone`, `email`, `website`,
`pfEstablishmentCode`, `esicCode` and `professionalTaxRegNumber`. These now write to the head-office
branch, which mirrors them back. The response shape is unchanged. `CompanyResponseDto` gains
`branchCount: number`.

## Branch picker — `JwtAuthGuard`, company-scoped via `resolveCompanyId`

### `GET /company-branches?companyId=&includeInactive=false`
Response: `BranchOptionDto[]` = `{ id, label, gstin, state, isHeadOffice, isActive }`, where
`label` is the label, falling back to "City (State)". Used by the project, employee, letter, challan
and register forms. No addresses or statutory codes are returned.

## Changed request/response DTOs

| Endpoint | Change |
|---|---|
| `POST /projects`, `PATCH /projects/:id` | `branchId?: string` (`@IsString`). Omitted on create → head office. Inactive, or another company's branch → `400 Branch not found for this company or inactive.` |
| `GET /projects/:id`, list rows | add `branchId`, `branch: { id, label, gstin }` |
| `POST /employees`, `PATCH /employees/:id` | `branchId?: string`, same rules as projects |
| `GET /employees/:id` | add `branchId`, `branch: { id, label }` |
| `GET /challans/:type`, `GET /challans/:type/export` | query becomes the typed `ChallanQueryDto { period, companyId?, branchId? }`. The response adds `branch: { id, label, establishmentCode } \| null` and `warnings: string[]` (e.g. `"No PF establishment code is recorded for Mandsaur (Madhya Pradesh)."`). The export filename gains `-{branchLabelSlug}` when filtered. |
| `GET /payroll/registers/statutory-register/export` | query becomes the typed `StatutoryRegisterQueryDto { projectId?, siteId?, branchId? }`. A missing PF or ESIC code adds a warning note row. When `branchId` is given, the establishment line uses the branch's address and codes. Lines are filtered on `PayrollLineItem.branchId`. |
| Letter compose/draft DTOs | `branchId?: string`. It is ignored and overwritten when the subject is a project or employee (research R6). Draft and letter responses add `branchId`. |

## Internal service contracts (cross-module, Principle I)

```ts
// settings — CompaniesService
getBillingIdentity(companyId, branchId?): { name, gstin, pan, state, stateCode, address, city, pinCode }
getDocumentIdentity(companyId, branchId?): { name, address /*composed*/, gstin, pan, logo, place }
getBranchIdentity(companyId, branchId?): CompanyBranchIdentity   // full record incl. codes, phone/email/website
headOfficeBranchId(companyId): string
assertActiveBranch(companyId, branchId): Promise<void>           // throws 400
listBranchOptions(companyId, includeInactive?): BranchOptionDto[]

// projects — ProjectsService
branchIdOf(companyId, projectId): Promise<string>

// hr — EmployeesService (or existing hr refs service)
branchIdOf(companyId, employeeId): Promise<string>
```

A `null`/`undefined` branchId resolves to the head office.

## Script

```
npx ts-node scripts/import-client-companies.ts <workbook.xlsx> [--apply]
```

- The default is a dry run that prints the plan: per short code, company created/updated, then
  `branch +/~ GSTIN state city [HEAD OFFICE]`.
- On a conflict it exits non-zero, printing `Rows 4, 6 (PRPL): PAN differs (AAMCP8659H vs …)`.
