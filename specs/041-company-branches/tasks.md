---
description: "Task list for 041 Company Branches"
---

# Tasks: Company Branches (Multiple GST Registrations per Company)

**Input**: Design documents from `specs/041-company-branches/`

**Prerequisites**: plan.md, spec.md, research.md (R1–R12), data-model.md, contracts/api.md, quickstart.md

**Tests**: Included. The repo keeps service specs beside the code, and quickstart.md § Automated
names the suites. Each test task sits next to the work it covers.

**Repos**:
- `api/` = `/Users/parthgoyal/Projects/buildcore-api`
- `web/` = `/Users/parthgoyal/Projects/buildcore-web`

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: Setup

- [ ] T001 Choose the base deliberately. The file:line refs in this file were taken on `036-ux-qa-hardening@a400d8d`, which carries 036/039 work that may not be on `main`. Base on `main` only after 036 and 039 have merged; otherwise branch from the integration branch. Create `041-company-branches` in api/ and web/. Treat every line number as approximate and locate code by function name. Confirm whether `040-statutory-register` has merged; if it has not, defer T043 until it does.
- [ ] T002 [P] Add the shared constants in api/src/common/constants/gst-states.ts:
  - `GST_STATE_CODES`: state name → two-digit code, all states and UTs, with names spelled as in the `states` list in api/scripts/make-client-data-templates.js.
  - The reverse lookup `stateNameForCode`.
  - `CIN_STATE_TO_NAME`: ROC abbreviation (RJ, DL, MH, UP, GJ, HR, BR, MP, …) → state name.
  - Helpers `gstStateCodeFor(stateName)` and `cinStateName(cin)`.
  - Unit spec in api/src/common/constants/gst-states.spec.ts covering 08 Rajasthan, 07 Delhi, 27 Maharashtra, 09 Uttar Pradesh, 24 Gujarat, 06 Haryana, 10 Bihar, 23 Madhya Pradesh, and `U70109RJ2022…` → Rajasthan.

---

## Phase 2: Foundational (blocks all stories)

**Goal**: Branches exist, every company has a head office, and every identity read is branch-aware
with the head office as default. With no branch chosen anywhere, output is identical to today.

- [ ] T003 Add `model CompanyBranch` (`@@schema("settings")`) to api/prisma/schema.prisma, with fields per data-model.md and a relation to `Company` (`onDelete: Cascade`). Add `branches CompanyBranch[]` to `Company`'s relation list (≈schema.prisma:651–708). Add `branchId String` with `@@index([branchId])` to `Project` and `Employee`. Add `branchId String?` with `@@index([branchId])` to `PayrollLineItem` and `IssuedLetter`. Add a doc comment on each, in the house style, explaining the bare id and why.
- [ ] T004 Create migration api/prisma/migrations/<ts>_company_branches/migration.sql containing:
  - the `CompanyBranch` table, its FK and `@@index`;
  - partial unique indexes `("companyId") WHERE "isHeadOffice"` and `("companyId","gstin") WHERE "gstin" IS NOT NULL`;
  - `ENABLE`/`FORCE` RLS and the `tenant_isolation` policy (USING + WITH CHECK), copied from `20261015230000_code_formats`;
  - an idempotent `INSERT … SELECT` of one head-office branch per company from the current Company columns, guarded by `WHERE NOT EXISTS`.
- [ ] T005 Create migration api/prisma/migrations/<ts+1>_branch_references/migration.sql. Add the nullable `branchId` columns to `projects.Project`, `hr.Employee`, `payroll.PayrollLineItem` and `shared.IssuedLetter`, plus indexes. Backfill:
  - Project and Employee → their company's head office (`UPDATE … FROM settings."CompanyBranch" WHERE "isHeadOffice" AND "branchId" IS NULL`);
  - PayrollLineItem → via `payroll."PayrollRun"."companyId"`.

  Then set Project and Employee `branchId` `NOT NULL`. Run `npx prisma migrate dev` and confirm quickstart §1 steps 3 and 5.
- [ ] T006 Export `ensureHeadOfficeBranch(prisma, companyId)` from api/prisma/seeds/company-branches.seed.ts, using the same idempotent logic as T004. Call it after every `company.create` in api/prisma/seed-dev.ts (≈:3311), api/prisma/seed-demo.ts (≈:2351) and api/prisma/seeds/workspace.seed.ts (≈:75), and in `CompaniesService.create`, so new companies always get a head office.
- [ ] T007 In api/src/settings/companies/companies.service.ts add three methods, all under `withRlsContext(…, {isSuperAdmin:true})` like the existing reads:
  - `headOfficeBranchId(companyId)`;
  - `getBranchIdentity(companyId, branchId?)`, which returns the full branch record merged with the company's name, PAN, logo and `stateCode`, and uses the head office when branchId is null or undefined;
  - `assertActiveBranch(companyId, branchId)`, which throws `BadRequestException('Branch not found for this company or inactive.')`.
- [ ] T008 In api/src/settings/companies/companies.service.ts give `getBillingIdentity(companyId, branchId?)` (:627) and `getDocumentIdentity(companyId, branchId?)` (:662) an optional `branchId`, and source address, city, state, PIN and GSTIN from `getBranchIdentity`. Keep `getBillingIdentity.address` as the raw address line, so frozen headers are formatted exactly as before. Add `stateCode`, `city` and `pinCode` to its return.
- [ ] T009 Implement the head-office mirror in api/src/settings/companies/companies.service.ts as a private `mirrorHeadOffice(tx, companyId)`. It copies the head-office branch's gstin, address, city, state, pinCode, phone, email, website, pfEstablishmentCode, esicCode and professionalTaxRegNumber onto `Company`. Then change `update` (the existing `PATCH /companies/:id` path) so these fields write to the head-office branch, which then mirrors.
- [ ] T010 [P] Spec api/src/settings/companies/companies.branches.spec.ts. Cover: a company with only a migrated head office gives the same `getBillingIdentity` / `getDocumentIdentity` output as before; `PATCH /companies/:id` with a new address updates both the branch and the Company columns; a null branchId resolves to the head office.

**Checkpoint**: Run the full test suite (`npm test`) and confirm quickstart §1. No visible change yet.

---

## Phase 3: User Story 1 — Record a company's branches (P1) 🎯 MVP part 1

**Goal**: An administrator can list, add, edit, deactivate and re-head-office branches.

**Independent Test**: quickstart §2.

- [ ] T011 [P] [US1] Create DTOs in api/src/settings/companies/dto/company-branch.dto.ts, all with swagger decorators:
  - `CreateCompanyBranchDto`, per contracts/api.md, reusing the GSTIN regex constant from create-company.dto.ts;
  - `UpdateCompanyBranchDto` (`PartialType` + `isActive?`);
  - `CompanyBranchDto` (with `stateCode`);
  - `BranchOptionDto`.
- [ ] T012 [US1] In api/src/settings/companies/companies.service.ts add `listBranches`, `createBranch`, `updateBranch` and `makeHeadOffice`. They must:
  - check GSTIN state code ↔ `gstStateCodeFor(state)`, and GSTIN chars 3–12 ↔ company PAN when the PAN is set, with the exact messages in contracts/api.md;
  - catch the unique-index violation and return `409`;
  - refuse to deactivate the head office;
  - make `makeHeadOffice` one transaction (unset the old flag, set the new one, `mirrorHeadOffice`);
  - mirror the Company columns on any head-office edit;
  - write each create, update and head-office change to the audit log, as company edits are.
- [ ] T013 [US1] Add `GET/POST /companies/:id/branches`, `PATCH /companies/:id/branches/:branchId` and `POST /companies/:id/branches/:branchId/head-office` to api/src/settings/companies/companies.controller.ts, under the class-level `COMPANY_SETTINGS` + `OwnCompanyGuard`. Add `branchCount` to `CompanyResponseDto` in api/src/settings/companies/dto/company-response.dto.ts.
- [ ] T014 [P] [US1] Create the picker controller api/src/settings/companies/company-branches.controller.ts: `GET /company-branches?companyId=&includeInactive=` behind `JwtAuthGuard` with `resolveCompanyId(user, companyId)` (api/src/settings/company-scope.ts:121). It returns `BranchOptionDto[]` via `CompaniesService.listBranchOptions`. Register it in api/src/settings/settings.module.ts.
- [ ] T015 [P] [US1] Spec api/src/settings/companies/company-branches.service.spec.ts covering every row of the quickstart §2 table: valid add, state mismatch, PAN mismatch, duplicate, deactivating the head office, swapping the head office twice with exactly one head office afterwards and the Company columns mirrored, and audit rows written.
- [ ] T016 [US1] Create web/app/ui/settings/company-branches-panel.tsx with:
  - a table of branches showing a head office badge, GSTIN, state, city and PF code;
  - an add/edit dialog with the CreateCompanyBranchDto fields, using the state select already used by the company modal;
  - "Make head office" and "Deactivate/Reactivate" actions, showing server messages inline.

  Mount it as a "Branches" section in web/app/ui/settings/company-modal.tsx. Move the GSTIN, address, contact and PF/ESIC/PT fields out of the company form into the head-office row (≈company-modal.tsx:62–64, 173–175, 400). Add any `lib/` API helpers following the existing companies client.
- [ ] T017 [US1] Check the web panel visually. Open the add dialog, trigger each error, swap the head office and screenshot the result, per the memory note "Verify visually".

**Checkpoint**: US1 is done. Branches can be recorded but nothing reads them yet.

---

## Phase 4: User Story 2 — A project bills from its branch (P1) 🎯 MVP part 2

**Goal**: Each project picks a branch, and every project document prints it. The RA bill tax basis
follows it.

**Independent Test**: quickstart §3.

- [ ] T018 [US2] In api/src/projects/portfolio/dto/project.dto.ts add `branchId?: string` to `CreateProjectDto` (covered by `UpdateProjectDto` via PartialType). In api/src/projects/portfolio/projects.service.ts:
  - in `create` (≈:269–381), resolve the head office when the field is omitted, otherwise `companies.assertActiveBranch`, and write `branchId` in the explicit `data` block;
  - in `update` (≈:682+), assert and conditionally spread the field;
  - include `branchId` and `branch {id,label,gstin}` in detail and list responses;
  - add `branchIdOf(companyId, projectId)` and export it from the projects module.
- [ ] T019 [US2] In api/src/projects/billing/package/bill-package.service.ts:
  - add `branchId` to the `project` select used by `freezeHeader` (:1726) and `partyGstins` (:2862);
  - pass it to `companies.getBillingIdentity(companyId, pkg.project.branchId)` in both;
  - check that `gstinsFor` (:2903) still returns frozen columns for issued and certified packages.
- [ ] T020 [P] [US2] Extend api/src/projects/billing/package/bill-package.service.spec.ts:
  - a project on a `24…` branch with a `24…` client → CGST+SGST, issuer GSTIN `24AAMCP8659H1ZU`;
  - the same branch with an `08…` client → IGST;
  - an issued package whose project then moves branch → the frozen header is unchanged;
  - a project on the head office → output identical to the pre-feature snapshot;
  - bills on projects in two different branches take consecutive numbers from the one company series (FR-011).
- [ ] T021 [P] [US2] In api/src/projects/billing/package/debit-note.service.ts, `previewView` (:314/:339) and `viewFor` (:579/:599) pass the project's branchId (via `branchIdOf`, or select it with the project) to `getDocumentIdentity`.
- [ ] T022 [P] [US2] In api/src/projects/billing/payments/payment-advice.service.ts, `viewFor` (:196/:242) selects `raBill.project.branchId` and passes it to `getDocumentIdentity`.
- [ ] T023 [P] [US2] In api/src/inventory/documents/store-documents.service.ts, change `private company()` (:767) to `company(companyId, projectId?)`. It resolves the branch via `ProjectsService.branchIdOf` and passes it on. Update the indent (:55), GRN (:304), issue slip (:434), daily register (:582) and transfer (:730, using `toProjectId`) callers.
- [ ] T024 [P] [US2] In api/src/plant/plant-refs.service.ts, change `documentCompany(companyId, projectId?)` (:91) to resolve the branch when a project is given. Pass `projectId` from api/src/plant/hire-orders/hire-orders.service.ts `document()` (:266, `HireOrder.projectId`) and from api/src/plant/hire-bills/hire-bills.service.ts `document()` (:880, via `hireOrder.projectId`). Leave the job card, logbook and equipment register on the head office (research R4).
- [ ] T025 [US2] Letters, in api/src/letters/letters.service.ts:
  1. Accept `branchId?` in the compose/draft DTOs (api/src/letters/dto/).
  2. At compose, resolve it per research R6 (project subject → `branchIdOf`; employee → employee branchId; otherwise the DTO value or head office, validated with `assertActiveBranch`) and store it on `IssuedLetter.branchId`.
  3. Replace the direct `tx.company.findUnique` in `recordsFor` (:912) and `renderDocument`/`brandHeader`/`letterhead` (:1042, :1193, :1249) with `companies.getBranchIdentity(companyId, letter.branchId)`. Keep logo and letterhead from the company.
  4. Leave the shortCode reference prefix (:1166) unchanged.
  5. Return `branchId` on draft and letter responses.
- [ ] T026 [P] [US2] Extend api/src/inventory/purchase-orders/purchase-order-document.snapshot.spec.ts and the letters specs: a PO letter composed with the Maharashtra branch prints `27AAMCP8659H1ZO` in place of `companyGstin`; a work order on a Gujarat project prints Gujarat; a letter with null `branchId` renders exactly as before.
- [ ] T027 [US2] Add a "Branch" select to web/app/ui/projects/project-form.tsx. It is fed by `GET /company-branches`, lists active branches only, defaults to the head office, and is hidden when there is one branch. Show the branch label and GSTIN on the project detail header.
- [ ] T028 [US2] Add a "Bill from branch" select to the letter compose UI in web/ (locate the compose form under web/app/ui/letters/). Show it only when the subject is not a project or employee, default it to the head office, and hide it for single-branch companies.
- [ ] T029 [US2] Visual check: walk quickstart §3 steps 1–7 in the browser and screenshot the bill header (CGST+SGST and IGST cases), a GRN header and a PO letter.

**Checkpoint**: US1 and US2 together form the MVP. Billing is GST-correct per state.

---

## Phase 5: User Story 3 — Employees on a branch; PF/ESIC per branch (P2)

**Goal**: Employees carry a branch. Payroll lines record it. Challans, the statutory register and
payslips work per establishment.

**Independent Test**: quickstart §4.

- [ ] T030 [US3] In api/src/hr/employees/dto/create-employee.dto.ts add `branchId?: string`, which flows to Update via PartialType. In api/src/hr/employees/employees.service.ts, `create` (:334) defaults to the head office and `update` (:375) asserts with `companies.assertActiveBranch`. Return `branchId` and `branch {id,label}` on detail. Export `branchIdOf(companyId, employeeId)`.
- [ ] T031 [US3] Stamp `branchId: employee.branchId` on each line in api/src/payroll/engine/payroll-engine.service.ts `generate()`. Add `branchId` to the employee select in the loop (≈:174) and to the line data (≈:333). Do the same in api/src/payroll/offboarding/fnf.service.ts (≈:148).
- [ ] T032 [P] [US3] Extend api/src/payroll/engine/payroll-engine.service.spec.ts: lines carry the employee's branch; regenerating a draft after a branch change restamps it; a processed run's lines are untouched by a later employee branch change.
- [ ] T033 [US3] Challans, in api/src/payroll/challans/challans.controller.ts (:74–107) and challans.service.ts:
  - replace the loose `@Query('period')`/`@Query('companyId')` params on `get` and `export` with a typed `ChallanQueryDto { period, companyId?, branchId? }` in api/src/payroll/challans/dto/challan-query.dto.ts, using class-validator and swagger (Principle II);
  - check `branchId` belongs to the company (an inactive branch is allowed, for history);
  - in `get` (:286) and `export` (:371), filter `lineItems` on `branchId` when given;
  - add `branch {id,label,establishmentCode}` to the view, using the PF code for `pf`, the ESIC code for `esic` and the PT registration number for `pt`;
  - add `warnings[]` when that code is missing (FR-017), and add a header row and warning note to the export;
  - suffix the filename with the branch slug;
  - leave `latestRunTotals` / `runTotalsForPeriods` company-wide.
- [ ] T034 [P] [US3] Spec api/src/payroll/challans/challans.service.spec.ts: the per-branch lists contain only that branch's lines and show its code; the per-branch totals add up to the unfiltered total; a branch with no code gets a warning and is not refused.
- [ ] T035 [US3] Payslip: in api/src/payroll/salary/salary.service.ts `identityFor` (:354), replace the direct `tx.company.findUnique` with `companies.getBranchIdentity(companyId, employee.branchId)`. The address and `location` come from the branch. The logo stays from `logoForCompany`.
- [ ] T036 [US3] Add a "Branch" select to web/app/ui/hr/employee-form.tsx in the "employment" step, beside siteId (≈:458, :593). Add it to the zod schema as optional, default it to the head office, and hide it for single-branch companies. Show the branch on the employee detail.
- [ ] T037 [US3] Add a "Branch" filter to web/app/ui/hr/challans-panel.tsx (default "All branches"). Pass `branchId` to the view and export calls. Show the establishment code and render `warnings[]` as an inline notice.
- [ ] T038 [US3] Visual check: walk quickstart §4 steps 1–5 and 7 in the browser and screenshot the Haryana challan, the Madhya Pradesh warning and B's payslip.

**Checkpoint**: US3 is done, except the statutory register (T043).

---

## Phase 6: User Story 4 — Migration and client workbook import (P1)

**Goal**: The client's workbook loads as 2 companies and 12 branches. The migration is already
delivered in Phase 2; this phase adds the import and the template changes.

**Independent Test**: quickstart §5. Run quickstart §1 again at the end.

- [ ] T039 [P] [US4] Create api/scripts/import-client-companies.ts, run with `npx ts-node`. It:
  - reads the workbook's **Companies** tab with exceljs, locating the header row by "Company Legal Name" and the columns by header text, as the template defines them (make-client-data-templates.js:247–276);
  - groups rows by Short Code;
  - refuses conflicting legal name, PAN, CIN or TAN with the row numbers and exits 1 (FR-023);
  - picks the head office as the row whose state equals `cinStateName(cin)`, otherwise the first row (FR-022);
  - plans a company upsert by shortCode from the head-office row, then a branch upsert matched on (companyId, GSTIN), or on (companyId, isHeadOffice) for a GSTIN-less head office;
  - is a dry run by default and writes only with `--apply`, through `CompaniesService`-equivalent logic or direct Prisma with the same validation and the mirror;
  - is idempotent;
  - prints the plan format from contracts/api.md.
- [ ] T040 [P] [US4] Spec api/scripts/import-client-companies.spec.ts with an in-memory workbook fixture copying the client's 5 PRPL and 7 TE rows (GSTINs and states from spec Background). Check: 2 companies and 12 branches; PRPL head office = the Deoli 08 row via CIN `U70109RJ…`; TE head office = the first row; a PAN conflict exits non-zero naming the rows; a second run reports no changes.
- [ ] T041 [P] [US4] Update api/scripts/make-client-data-templates.js:
  - Companies tab hint: "One row per GST registration. A company with several GSTINs repeats its Short Code, legal name, PAN, CIN and TAN on every row." (FR-024);
  - change the GSTIN column hint to match;
  - add a `Branch GSTIN` column (optional, "Blank = head office") to the Projects (≈:380–405) and Employees (≈:442–464) tabs.

  Regenerate the templates.
- [ ] T042 [US4] Update api/prisma/seed-dev.ts so PRPL (≈:2023) and TE (≈:2358) get their real branches from spec Background, with TE's PF codes RJRAJ1296202–207 and MP blank. Put seeded projects whose location is in another state on the matching branch, and spread some TE employees across Rajasthan and Haryana. Keep the data production-looking (memory: dummy-data naming).

---

## Phase 7: Cross-story — Statutory register (US3, depends on 040)

- [ ] T043 [US3] Once 040 has merged, make the following changes in api/src/payroll/registers/statutory-register.service.ts and its controller (payroll-register.controller.ts:112–136):
  - replace the loose `@Query` params with a typed `StatutoryRegisterQueryDto { projectId?, siteId?, branchId? }` in api/src/payroll/registers/dto/, using class-validator and swagger (Principle II);
  - filter lines on `line.branchId`. Keep the existing `projectId`/`siteId` filters as they are;
  - replace the direct `tx.company.findFirst` (:337) with `companies.getBranchIdentity(companyId, branchId)`, so the establishment line (:639–655) prints the branch's name, address, PF code and ESIC code, or the head office's when unfiltered;
  - when the branch has no PF or ESIC code, still export, and add a warning note row (FR-017);
  - include `branchId` in the audit filters (:600–615);
  - suffix the filename.

  Extend statutory-register.service.spec.ts. Add a Branch filter to the register export UI in web/.

---

## Phase 8: Polish & cross-cutting

- [ ] T044 [P] Run `grep -rnE "tx\.company\.(findUnique|findFirst)" api/src` and, for each remaining identity read (bank-sheet, attendance-sheet, DWR and slip-delivery read the name only), confirm it needs no branch. Route the identity reads that remain through `CompaniesService` (Principle I).
- [ ] T045 [P] Regenerate swagger metadata (api/src/metadata.ts) and confirm the new endpoints and DTOs appear at `/api`.
- [ ] T046 Run the whole of quickstart.md §1–§5 on a fresh `seed:dev` database. Check: issued-bill PDF byte equality (SC-004); a single-branch company (e.g. workspace seed) shows no branch pickers and unchanged documents (SC-007); time to add a branch and move a project is under 2 minutes (SC-006).
- [ ] T047 Write the 041 memory note (decisions: branches = GST registrations; Company columns mirror the head office; live documents follow the current branch; numbering per company; payroll lines stamp the branch). Add it to MEMORY.md.

---

## Dependencies & execution order

- **Phase 1 → Phase 2** blocks everything.
- **US1 (Phase 3)** depends on Phase 2. US2 and US3 need US1's picker (T014), but their API work (T018–T026, T030–T035) needs only Phase 2.
- **US2 (Phase 4)** and **US3 (Phase 5)** are independent of each other once Phase 2 is done.
- **US4 (Phase 6)**: T039–T041 need only Phase 2 and T002. T042 needs T018 and T030.
- **T043** needs the 040 merge and T031.
- **Polish** comes after all of the above.

```
T001 → T002 ─┐
             ├→ T003 → T004 → T005 → T006 → T007 → T008 → T009 → T010
             │                                                   │
             │      ┌──────────────── US1 T011–T017 ◄────────────┤
             │      ├──────────────── US2 T018–T029 ◄────────────┤
             │      ├──────────────── US3 T030–T038 ◄────────────┤
             └──────┴──────────────── US4 T039–T042 ◄────────────┘
                                         T043 (after 040 + T031) → T044–T047
```

## Parallel examples

- **After Phase 2**: T011, T014 and T015 (US1 API) ∥ T018 → {T021, T022, T023, T024} (US2 documents) ∥ T030 → T031 (US3) ∥ T039, T040 and T041 (US4).
- **Within US2**: T021, T022, T023 and T024 touch different modules and can run together after T018.
- **Within US3**: T032 and T034 (specs) can run alongside T035 (payslip).

## Implementation strategy

1. **MVP = Phase 2 + US1 + US2.** GST-correct billing per state is the client's actual pain. Ship
   it to `develop` (dev.tirupatigroups.in), then run quickstart §2–§3 there.
2. **Increment 2 = US4.** Load the client's real workbook with `--dry-run` first, then `--apply`
   on develop.
3. **Increment 3 = US3** (then T043 after 040). Per-establishment payroll.
4. Each increment keeps single-branch companies unchanged (SC-007). That is the regression guard.
