# Research: Company Branches (041)

Every decision below comes from reading the current code. The file:line references are as of
2026-10-22, on branch `036-ux-qa-hardening` at `a400d8d`.

## R1 — Where a branch lives and how it is keyed

**Decision**: A new `CompanyBranch` table in the `settings` schema, with a real relation to `Company`
(`onDelete: Cascade`) and the standard `tenant_isolation` RLS policy. It is modelled on `CodeFormat`
(migration `20261015230000_code_formats`). There are two partial unique indexes:

- one head office per company: `(companyId) WHERE "isHeadOffice"`
- one GSTIN per company: `(companyId, gstin) WHERE gstin IS NOT NULL`

**Rationale**: Company-owned tables in `settings` use a real relation (CompanyDocument, CodeFormat).
The two "at most one" rules have to be partial indexes for the same reason the `Client.gstin`
comment gives: `@@unique` treats every NULL as distinct.

**Alternatives considered**:
- A JSON array of registrations on `Company`. Rejected: projects, employees and payroll lines must
  reference a registration by id, and a JSON array has no row to reference.
- Making each registration its own `Company`. Rejected: `shortCode` is unique, the numbering series
  is per company (the user chose one series per company), and tenant scoping, roles and payroll
  would all fragment.

## R2 — What happens to the existing company columns

**Decision**: Keep `Company.gstin`, `address`, `city`, `state`, `pinCode`, `phone`, `email`,
`website`, `pfEstablishmentCode`, `esicCode` and `professionalTaxRegNumber` (spec FR-020). Treat them
as a **mirror of the head-office branch**:

- Any write to the head-office branch writes the same values to these columns in the same
  transaction.
- Making another branch head office re-mirrors from it.
- `UpdateCompanyDto` keeps accepting these fields and routes them to the head-office branch, which
  then mirrors.

**Rationale**: About a dozen readers use these columns today. The agent survey found several that
read `tx.company` directly, outside `CompaniesService`: letters, salary, the statutory register,
bank sheet, attendance sheet and DWR. The mirror means any reader this feature misses still prints
the head office, which is exactly today's behaviour. With no mirror, a missed reader would print
stale data.

**Alternatives considered**:
- Drop the columns. Rejected by FR-020 and by the project's "never drop a column to tidy" rule
  (schema comment on `logoUrl`).
- Leave them unsynchronised. Rejected because they would silently drift.

## R3 — One resolver for "who is the company on this document"

**Decision**: Make the two identity reads in `CompaniesService` branch-aware with an optional last
argument:

- `getBillingIdentity(companyId, branchId?)` (companies.service.ts:627)
- `getDocumentIdentity(companyId, branchId?)` (:662)

Add three methods:

- `getBranchIdentity(companyId, branchId?)` — the full branch record, including statutory codes.
- `assertActiveBranch(companyId, branchId)` — for project and employee validation.
- `headOfficeBranchId(companyId)`.

A `null` or `undefined` branchId means the head office.

`getBillingIdentity` keeps returning the raw `address` and gains `city` and `pinCode`.
`getDocumentIdentity` keeps its composed address. The two callers that build bill headers decide how
to join them, so frozen-header formatting does not change for existing bills.

**Rationale**: Principle I. Every other module already reaches company identity through
`CompaniesService`, which is exported from settings.module.ts:142. Making the branch an optional
argument means unchanged callers keep today's head-office answer. That is correct for every
company-level document.

**Alternative considered**: A separate `BranchesService` injected everywhere. Rejected. It doubles
the import surface, and every caller already holds `CompaniesService`.

## R4 — How a document finds its branch

**Decision**: Use the project's `branchId` where the document has a project. Use the head office
where it does not.

| Document | Source of branch |
|---|---|
| RA bill package (both directions) and its tax basis | `pkg.project.branchId`. `freezeHeader` (bill-package.service.ts:1726) and `partyGstins` (:2862) already load `pkg.project`. |
| Debit note | `projectId` (preview) / `BillPackageDebitNote.projectId` |
| Payment advice | `rABillPayment.raBill.project.branchId` |
| Store documents (indent, GRN, issue slip, daily register, transfer) | the document's `projectId`. A transfer uses the **receiving** project. |
| Hire order | `HireOrder.projectId` (nullable → head office) |
| Hire bill | `hireOrder.projectId` (nullable → head office) |
| Job card, logbook sheet, equipment register | head office. These carry no reliable project, and `equipment.deployedSiteId` is the current site, not the one at the time. |
| Letters: work order, PO, LOI, other subject letters | new `IssuedLetter.branchId` (see R6) |
| HR letters, F&F, payslip | the employee's `branchId` |
| Statutory register, challans | the branch filter, otherwise the head office (R8) |
| Bank guarantee register, DWR, bank sheet, attendance sheet | name only, so unchanged |

`ProjectsService` exports `branchIdOf(companyId, projectId)` so that plant and inventory can resolve
a branch without reading `projects.Project` (Principle I).

## R5 — Freeze or render live

**Decision**: Keep each document's current lifecycle.

- **RA bill packages** already freeze `issuer*`/`receiver*` at issue (schema.prisma:2884). They now
  freeze the branch's values. Issued bills never change.
- **Issued letters** are already frozen as a rendered PDF (`IssuedLetter.renderedRef`).
- Every other document (debit note, payment advice, store documents, hire order/bill, payslip)
  **reads live today**. It continues to read live, from the project's or employee's *current*
  branch. Today, editing the company address changes how these re-render. After this feature,
  moving a project to another branch or editing a branch changes them in the same way.

**Rationale**: Adding issuer snapshot columns to six more tables would add a large migration and
renderer changes, and it would fix a problem the client does not have today (company edits already
re-render these documents). The spec's FR-010 is narrowed to the documents that already freeze; see
the spec update.

**Alternative considered**: Snapshot the issuer on every document. Deferred: it is a reasonable
follow-up if the client asks, but out of scope here.

## R6 — Letters (work order, PO, LOI) need a branch without a project link

**Decision**: Add `IssuedLetter.branchId String?` and resolve it at compose time:

1. The subject is a project (`subjectType='project'`): use the project's branch.
2. The letter is about an employee or candidate with an employee: use the employee's branch.
3. Otherwise: the composer chooses a branch, defaulting to the head office.

`recordsFor` (letters.service.ts:895) and `brandHeader`/`letterhead` (:1025–1249) read company
identity through `CompaniesService.getBranchIdentity(companyId, letter.branchId)` instead of
`tx.company.findUnique`. Draft previews follow the stored `branchId`. Issued PDFs are already frozen.

**Rationale**: `PurchaseOrder` has no project (it has only letterId/vendorId). The letter is the
document the user composes, so the choice belongs there.

## R7 — Projects and employees reference a branch

**Decision**: Add `Project.branchId String` and `Employee.branchId String`. Both are bare ids
(cross-schema, no FK), following the `Site.companyId` note. Both are **required after backfill**.

- Create defaults to the head office when the DTO omits the field.
- Update may change it.
- Both are validated through `CompaniesService.assertActiveBranch`.
- A deactivated branch is refused for *new* assignment, but existing rows keep it.

**Rationale**: An explicit id keeps a project on its branch even if the company later changes its
head office. A nullable "null = head office" column would silently move every unassigned project
when the head office changes.

**Note**: `EmployeesService.toColumns` (employees.service.ts:301) spreads the DTO, so `branchId`
flows through. Validation is added explicitly, because siteId is not validated today and that is
not a precedent to follow.

## R8 — Payroll per establishment code

**Decision**: Add `PayrollLineItem.branchId String?` and stamp it from the employee in `generate()`
(payroll-engine.service.ts:174–383; insert at :333) and in `fnf.service.ts:148`. The migration
**backfills** every existing line to its run's company head office, which is correct because every
employee is on the head office on release day.

Per-branch filtering then reads the line, not the employee. That follows the precedent of
`salaryRegister` filtering `l.projectId` (payroll-register.service.ts:83).

- **Challans**: `get`/`export` gain an optional `branchId` (challans.controller.ts:74–107 adds
  `@Query('branchId')`). With a branch, only that branch's lines are counted, and the view and
  export header print its PF / ESIC / PT code. Without a branch, the company total is unchanged.
  `latestRunTotals`/`runTotalsForPeriods` (dashboard) stay company-wide.
- **Statutory register**: `export` gains `branchId`. Lines are filtered on `line.branchId`. The
  establishment line (statutory-register.service.ts:639–655) prints the branch's address and codes,
  or the head office's when no branch is given. Feature 040 is on branch `040-statutory-register`,
  so this lands after 040 merges.
- **Missing code** (FR-017): the output is produced with a blank code, and a `warnings[]` entry is
  added to the view and a note row to the export.
- **Payslip**: `identityFor` (salary.service.ts:354) uses the employee's branch address and city.
- **ECR**: there is no ECR export today. Building one is out of scope.

**Alternative considered**: Filtering on the employee's current branch. Rejected by spec US3
scenario 5: a later transfer must not rewrite a processed month.

## R9 — Validation rules for a GSTIN

**Decision**: Use the existing GSTIN regex at the DTO boundary (create-company.dto). Then, in the
service, apply two cross-field checks, each with its own message:

1. `gstin.slice(0,2)` must equal the GST state code of `branch.state`. A shared constant maps state
   name to two-digit code. Check whether `bill-tax.ts` already holds one and reuse it if so.
   Principle III.
2. When the company has a PAN, `gstin.slice(2,12)` must equal it.

**State storage**: `CompanyBranch.state` stores the **state name** (as `Company.state` does today and
as the workbook does). The code is derived. `Client.state` stores the code; the resolver returns both.

## R10 — Importing the client workbook

**Finding**: No importer exists. `scripts/make-client-data-templates.js` only builds the blank
workbooks. No file in src/ or scripts/ reads a "Companies" tab.

**Decision**: Add a one-time script, `scripts/import-client-companies.ts`, that reads only the
**Companies** tab with `exceljs` (the constitution's `.xlsx` library). It:

- groups rows by Short Code;
- refuses the whole file, naming the conflicting rows, when grouped rows disagree on legal name,
  PAN, CIN or TAN (FR-023);
- picks the head office as the row whose state's GST code equals the CIN's state letters
  (`U70109RJ…` → RJ → Rajasthan), or the first row when there is no CIN (FR-022);
- creates or updates the company from the head-office row, and creates or updates one branch per
  row, matched on GSTIN.

It is idempotent: re-running updates in place. It runs with `--dry-run` by default and needs
`--apply` to write.

Importing the other tabs (projects, employees) is out of scope.

The template gains:
- a note on the Companies tab ("one row per GST registration; repeat the short code"), per FR-024;
- a `Branch GSTIN` column on the Projects and Employees tabs.

**CIN state letters**: CIN characters 7–8 are the ROC state abbreviation (RJ, DL, MH…). A
shared constant maps them to state names.

## R11 — Who manages branches; who can pick one

**Decision**:
- **Management** (create, edit, deactivate, make head office) is under the existing
  `COMPANY_SETTINGS` guard on `/companies/:id/branches…`, alongside `numbering` and `billing-rates`
  (companies.controller.ts:50–54, 286, 323). There is no new permission (spec assumption).
- **Picking**: project, employee, letter and payroll forms are used by people without
  COMPANY_SETTINGS. They get a read-only `GET /company-branches?companyId=` behind `JwtAuthGuard`
  and the usual `resolveCompanyId` scope. It returns only id, label, GSTIN, state, isHeadOffice and
  isActive.

## R12 — Seeds and the dev database

**Decision**:
- `prisma/seed-dev.ts` creates PRPL's 5 and TE's 7 branches from the client data, right after each
  `company.create` (≈:3311). It puts seeded projects in different states on matching branches, so
  dev exercises intra- and inter-state bills.
- `seed-demo.ts` and `workspace.seed.ts` rely on the migration-equivalent "one head-office branch"
  helper, which is exported for reuse.
- Following the memory note on dummy data, the dev seed reads like production data.
