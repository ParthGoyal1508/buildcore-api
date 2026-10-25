# Data Model: Company Branches (041)

## New: `settings.CompanyBranch`

One GST registration (place of business) of a company.

| Field | Type | Rules |
|---|---|---|
| id | String (cuid) | PK |
| companyId | String | Relation → `Company`, `onDelete: Cascade`; RLS discriminator |
| label | String? | Display name shown in pickers. Null → "City (State)" is shown. |
| tradeName | String? | Printed name. Null → the company's legal name. |
| gstin | String? | 15-char GSTIN format; first 2 chars = state code of `state`; chars 3–12 = company PAN when the PAN is set; unique per company when present |
| address | String? | Required by the create/update DTO; nullable only so migrated companies with blanks load |
| city | String? | Same as address |
| state | String? | State **name**, as `Company.state` stores it. The code is derived. Required when `gstin` is set. |
| pinCode | String? | 6 digits; same as address |
| phone, email, website | String? | |
| pfEstablishmentCode | String? | |
| esicCode | String? | |
| professionalTaxRegNumber | String? | |
| isHeadOffice | Boolean | Exactly one `true` per company (partial unique index) |
| isActive | Boolean @default(true) | The head office cannot be inactive |
| createdAt / updatedAt | DateTime | |

**Indexes**:
- `@@index([companyId])`
- partial unique `(companyId) WHERE "isHeadOffice"`
- partial unique `(companyId, gstin) WHERE gstin IS NOT NULL`

**RLS**: `ENABLE` + `FORCE`, with the `tenant_isolation` policy (USING + WITH CHECK) copied from
`20261015230000_code_formats`.

**State transitions**:
- active ⇄ inactive. Deactivating is refused while `isHeadOffice`.
- Make head office (one transaction): clear the old head office flag, set the new one, and
  re-mirror the Company columns.
- A branch is never deleted. Projects, employees, payroll lines and letters reference it.

## Changed: `settings.Company`

- Adds the relation `branches CompanyBranch[]`.
- `gstin`, `address`, `city`, `state`, `pinCode`, `phone`, `email`, `website`,
  `pfEstablishmentCode`, `esicCode` and `professionalTaxRegNumber` are **kept** and become a mirror
  of the head-office branch, written in the same transaction as any head-office write (research R2).
- `pan`, `cin`, `tan`, `bocwRegNumber`, rates, payroll settings, logo and letterhead stay company-only.

## Changed: `projects.Project`

| Field | Type | Rules |
|---|---|---|
| branchId | String (bare id) | Required after backfill. Default on create = head office. It must be an active branch of `companyId` when set or changed. `@@index([branchId])`. |

## Changed: `hr.Employee`

| Field | Type | Rules |
|---|---|---|
| branchId | String (bare id) | Same rules as `Project.branchId` |

## Changed: `payroll.PayrollLineItem`

| Field | Type | Rules |
|---|---|---|
| branchId | String? (bare id) | Stamped from `employee.branchId` when the line is generated (regular run and F&F). Immutable once the run is processed, like every other line field. Backfilled to the run company's head office. `@@index([branchId])`. |

## Changed: `shared.IssuedLetter`

| Field | Type | Rules |
|---|---|---|
| branchId | String? (bare id) | Resolved at compose: project subject → project branch; employee → employee branch; otherwise the composer's choice, defaulting to the head office. Null on letters issued before release, which means head office. |

## Unchanged, but now sourced from the branch

`projects.BillPackage.issuer*` / `receiver*` are still frozen at issue. The company side now comes
from `getBillingIdentity(companyId, project.branchId)`.

## Migration (ordered, idempotent)

1. Create `CompanyBranch` with its indexes, the FK and RLS.
2. `INSERT … SELECT` one head-office branch per company from the current Company columns, guarded by
   `WHERE NOT EXISTS (head office for company)`. Null address fields stay null; the form requires them on
   the next edit.
3. Add `Project.branchId`, `Employee.branchId` and `IssuedLetter.branchId` as nullable. Backfill the
   project and employee columns to their company's head office, then set them `NOT NULL`.
   `IssuedLetter.branchId` stays nullable.
4. Add `PayrollLineItem.branchId` as nullable and backfill it via `PayrollRun.companyId` → head office.

Steps 3 and 4 are single `UPDATE … FROM` statements. They are safe on the dev and prod sizes.
