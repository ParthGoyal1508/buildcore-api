# Implementation Plan: Company Branches (Multiple GST Registrations per Company)

**Branch**: `041-company-branches` | **Date**: 2026-10-22 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/041-company-branches/spec.md`

## Summary

A company gains **branches**: one per GST registration, each with its own GSTIN, address, contacts
and PF / ESIC / PT codes, and exactly one head office. Projects and employees each reference a
branch. Documents resolve the company's identity through `CompaniesService` with the branch of the
project, employee or letter, and fall back to the head office. RA bills keep freezing the issuer at
issue, so the intra/inter-state decision follows the branch GSTIN with no change to `bill-tax.ts`.

Payroll lines record the employee's branch when the run is processed, so challans and the
statutory register can be produced per establishment code. The existing company columns are kept
as a mirror of the head office, so anything not yet branch-aware keeps today's output.

A one-time script imports the client's Companies tab by grouping rows by short code.

## Technical Context

**Language/Version**: TypeScript 5 / Node 20 (API, NestJS 10); Next.js App Router (web,
`buildcore-web`)

**Primary Dependencies**: Prisma (multiSchema), class-validator / class-transformer,
@nestjs/swagger, exceljs (import script, challan/register exports), pdfkit (document renderers).
Nothing new.

**Storage**: PostgreSQL (Neon), one schema per module, RLS on tenant tables

**Testing**: Jest (SWC transform), with service specs beside the code; snapshot specs for documents

**Target Platform**: Linux server (Render) + Vercel web

**Project Type**: Web service + web app (two repos)

**Performance Goals**: Branch resolution adds at most one indexed lookup per document render. No
noticeable change.

**Constraints**:
- Bills issued before release must render byte-identically.
- Re-running the migration must be harmless.
- Numbering stays one series per company.

**Scale/Scope**:
- 2 client companies and 12 branches.
- About 15 document paths, 3 forms, 2 statutory outputs, 1 import script.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | How |
|---|---|---|
| I. Schema-per-module | ✅ Pass, and improves things | Branches live in `settings`. Other modules use only `CompaniesService` / `ProjectsService.branchIdOf`. The direct `tx.company` identity reads in letters, salary and the statutory register move to `CompaniesService` as part of this work. Cross-schema ids are bare ids (no FK), per the `Site.companyId` note. |
| II. Validated DTOs | ✅ Pass | New Create/Update/Response DTOs with swagger. Cross-field GSTIN checks are in the service, with distinct messages. |
| III. No hardcoded values | ✅ Pass | The state-name ↔ GST-code and CIN-state ↔ state maps are shared constants, reusing any existing map in billing. No new env vars. |
| IV. Tenant isolation & PII | ✅ Pass | `CompanyBranch` has `companyId` and `tenant_isolation` RLS (USING + WITH CHECK). GSTIN and PF codes are business identifiers, not regulated personal PII (company PAN is already unmasked today). Branch create/update/head-office changes are written to the audit log, as company edits are. |
| V. AuthZ | ✅ Pass | Management is under the existing `COMPANY_SETTINGS` + `OwnCompanyGuard`. The picker is under JWT + `resolveCompanyId` scope and returns no codes or addresses. |
| VI. Safe migrations | ✅ Pass | Additive migrations applied with `prisma migrate deploy`. Backfills are idempotent (`WHERE NOT EXISTS` / `WHERE branchId IS NULL`). No columns are dropped. |

**Post-design re-check**: still passing. No violations, so Complexity Tracking is empty.

## Project Structure

### Documentation (this feature)

```text
specs/041-company-branches/
├── spec.md
├── plan.md              # this file
├── research.md          # R1–R12 decisions
├── data-model.md
├── quickstart.md
├── contracts/api.md
├── checklists/requirements.md
└── tasks.md             # /speckit-tasks
```

### Source Code

```text
buildcore-api/
├── prisma/
│   ├── schema.prisma                                   # CompanyBranch; branchId on Project, Employee, PayrollLineItem, IssuedLetter
│   ├── migrations/2026xxxx_company_branches/           # table + RLS + head-office backfill
│   ├── migrations/2026xxxx_branch_references/          # branchId columns + backfill + NOT NULL
│   └── seed-dev.ts                                     # PRPL ×5, TE ×7 branches; projects on matching branches
├── scripts/
│   ├── import-client-companies.ts                      # NEW one-time importer (exceljs)
│   └── make-client-data-templates.js                   # Companies-tab note; Branch GSTIN column on Projects/Employees
└── src/
    ├── common/constants/gst-states.ts                  # state name ↔ GST code, CIN state ↔ state (reuse billing map if present)
    ├── settings/companies/
    │   ├── companies.service.ts                        # branch CRUD, mirror, identity resolvers (+branchId)
    │   ├── companies.controller.ts                     # /companies/:id/branches…
    │   ├── company-branches.controller.ts              # NEW GET /company-branches (picker)
    │   └── dto/company-branch.dto.ts                   # NEW
    ├── projects/
    │   ├── portfolio/{projects.service.ts,dto/project.dto.ts}       # branchId + branchIdOf()
    │   ├── billing/package/bill-package.service.ts                  # freezeHeader / partyGstins use project.branchId
    │   ├── billing/package/debit-note.service.ts
    │   └── billing/payments/payment-advice.service.ts
    ├── hr/employees/{employees.service.ts,dto/create-employee.dto.ts}  # branchId + validation
    ├── inventory/documents/store-documents.service.ts               # company(projectId)
    ├── plant/{plant-refs.service.ts,hire-orders/,hire-bills/}       # documentCompany(projectId?)
    ├── letters/letters.service.ts                                   # IssuedLetter.branchId; identity via CompaniesService
    └── payroll/
        ├── engine/payroll-engine.service.ts, offboarding/fnf.service.ts  # stamp line.branchId
        ├── challans/{challans.controller.ts,challans.service.ts}         # ?branchId, codes, warnings
        ├── registers/statutory-register.service.ts (+controller)         # ?branchId, establishment line
        └── salary/salary.service.ts                                      # payslip identity from employee branch

buildcore-web/app/
├── ui/settings/company-modal.tsx (+ company-branches-panel.tsx NEW)   # branch list/editor, head office, deactivate
├── ui/projects/project-form.tsx                                       # Branch select (default head office)
├── ui/hr/employee-form.tsx                                            # Branch select in the "employment" step
├── ui/hr/challans-panel.tsx                                           # Branch filter + warnings
├── (statutory register export UI)                                     # Branch filter
└── (letter compose UI)                                                # Branch select when the subject is not a project/employee
```

**Structure Decision**: The existing two-repo layout. All server logic sits in the modules that
already own each document. `settings` owns branches and the identity resolver. The web changes are
form fields and one settings panel. Branch pickers are hidden when a company has a single branch
(spec edge case).

## Delivery order (story slices)

1. **Foundation (blocks everything)**: schema, both migrations, the branch-aware identity resolvers
   (default = head office, so behaviour is unchanged), mirror, constants. Verify with quickstart §1.
2. **US1 – manage branches**: endpoints, the picker endpoint, the settings panel.
3. **US2 – billing**: `Project.branchId` in DTO and form; the bill package, debit note, payment
   advice, store documents, hire order/bill and letters resolution.
4. **US3 – payroll**: `Employee.branchId` in DTO and form; line stamping; challan and register
   filters; payslip.
5. **US4 – import**: the script and template changes. It can run in parallel with steps 2–4 once
   the foundation is done.
6. **Seed**: the dev seed gains realistic branches.

## Risks

- **A missed direct `tx.company` reader.** Mitigated by the mirror: it keeps printing the head
  office, which is today's output.
- **The statutory register is on the unmerged 040 branch.** Do US3's register part after 040 merges,
  or rebase onto it.
- **Live documents re-render after a branch move** (research R5). This is the same behaviour as a
  company edit today, and it is spelled out in spec FR-010.

## Complexity Tracking

No constitution violations.
