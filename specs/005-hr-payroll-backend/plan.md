# Implementation Plan: HR & Payroll Backend (Employees, Attendance, Leave, Payroll, Challans, Loans, Daily Workers)

**Branch**: `005-hr-payroll-backend` | **Date**: 2026-08-27 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/005-hr-payroll-backend/spec.md`

## Summary

Build the real HR & Payroll admin module every prior feature (001–004) has deferred to: extend
My Workspace's minimal `Employee` with its full field set and PII masking/reveal; build Employee
Documents with mandatory-doc gating; build the admin Attendance/Leave surfaces around 003's
existing self-service data; build a real payroll calculation engine (superseding 003's
"figures already exist" placeholder) with immutable Processed/Paid runs; derive PF/ESIC/PT
challans from processed payroll with zero recomputation drift; build Loans with auto-generated
EMI schedules that feed payroll deductions; and build a structurally-separate Daily Worker
Registry reusing 003's biometric matching. See [research.md](research.md) for the eleven specific
reconciliation/architecture decisions, especially how this feature extends rather than redefines
every entity features 001–003 already specced.

## Technical Context

**Language/Version**: TypeScript 5.1, Node.js, NestJS 10, Prisma 5 against PostgreSQL — unchanged.

**Primary Dependencies**: Existing only — `class-validator`/`class-transformer`, `@nestjs/swagger`,
`@nestjs/config`, `nestjs-prisma`, 001/002's guards, 003's `BiometricsService`/`pdfkit`, 004's
`exceljs`. No new architectural dependency; both scope-framing clarifications (manual TDS, deferred
virus scanning) explicitly avoid needing one.

**Storage**: PostgreSQL via Prisma — extends `hr` (Employee columns, EmployeeDocument,
EmployeeTransfer, Holiday, AttendanceModification, DailyWorker, DailyWorkerAttendance) and
`payroll` (PayrollRun extension, PayrollLineItem, Loan, LoanScheduleEntry) schemas; adds one field
(`otMultiplier`) to `settings.Company`. No new schema.

**Testing**: Jest unit tests for the payroll engine (the highest-stakes computation in the
codebase — every earnings/deduction component individually verified), the challan-derivation
read path, loan schedule generation, and the daily-worker face-match/manual fallback; e2e coverage
across `test/hr-payroll.e2e-spec.ts` for every endpoint touching PII, payroll, or biometric data —
this repo's constitution requires it for all three categories, and this feature touches all three
extensively.

**Target Platform**: Linux server (Node.js), same as the rest of `buildcore-api`.

**Project Type**: Web service (backend API) — single NestJS project; extends the existing `hr`/
`payroll` modules (scaffolded conceptually by 003) rather than creating new top-level modules.

**Performance Goals**: Payroll generation for 100 employees completes in under 30 minutes
end-to-end (spec SC-001) — the actual computation itself should be seconds; the target accounts
for review time, not a backend performance ceiling.

**Constraints**: Every controller method uses a validated DTO (Principle II); `hr`/`payroll`
modules never query directly into `settings`/`shared` schemas — only via exported services
(Principle I); Aadhaar/PAN/bank-account/UAN encrypted at rest, masked by default, reveal
access-logged (Principle IV, research.md §3); OT multiplier and every statutory rate centralized,
company-configurable config/data, never hardcoded (Principle III, FR-014a); a Processed/Paid
payroll run's figures are immutable at the database-write-path level, not just convention
(Principle IV's "payroll integrity" NFR, FR-015); every schema change via generated migrations
(Principle VI).

**Scale/Scope**: ~45 new/extended fields on `Employee`, ~12 new tables across `hr`/`payroll`
(including `ExitRecord` and a `settings.ReimbursementCategory` addition), one field on
`settings.Company`, ~44 endpoints across ten functional areas (the original seven plus
Offboarding/F&F, Reimbursements Admin, and Bulk Attendance Import — US11–US13). No existing
001–004 endpoint contracts change — only their underlying data becomes real where it was
previously a placeholder (challans, salary slip figures, Document Expiry notifications), and
feature 003's `ReimbursementClaim` table (added by that feature as part of this same alignment
pass) gains admin-only fields here, never a redefinition.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Check | Status |
|---|---|---|
| I. Schema-Per-Module Boundaries (NON-NEGOTIABLE) | All new tables land in `hr`/`payroll` (already-established schemas); the one cross-schema field (`settings.Company.otMultiplier`) is owned and migrated by `settings`, read by `payroll` via Settings' exported service — no direct cross-schema query (research.md §1, §11). | PASS |
| II. Validated DTO Contracts (NON-NEGOTIABLE) | Every endpoint in contracts/hr-payroll-api.md uses a typed DTO. | PASS |
| III. Centralized Configuration & No Hardcoded Values (NON-NEGOTIABLE) | OT multiplier (FR-014a), document-expiry warning window, and every statutory percentage are centralized config/company-data, never inline (research.md §2, §10). | PASS |
| IV. Multi-Tenant Isolation & PII Protection (NON-NEGOTIABLE) | Aadhaar/PAN/bank-account/UAN are exactly the constitution's named regulated-PII list — encrypted, masked-by-default, reveal-gated-and-audited (research.md §3), the first feature to concretely implement this existing requirement. Every new table is `companyId`-scoped and RLS-protected. Payroll immutability (FR-015) is Principle IV's own "payroll integrity" NFR made real. | PASS |
| V. Authentication, Authorization & Secrets Hygiene | Every endpoint behind `JwtAuthGuard` + `@RequirePermission()`, reusing 002's existing enum values with no new ones needed (research.md §11). Daily Worker actions additionally site-scoped server-side (research.md §8, spec FR-023/FR-025). | PASS |
| VI. Observability & Safe Migrations | All schema changes (the largest set yet) ship as generated migrations, applied incrementally per logical group (Employee extension, then new hr tables, then payroll tables, then the Company field) rather than one giant migration. | PASS |

No violations require a Complexity Tracking entry — no new dependencies, no constitution
deviation.

**Post-design re-check (after Phase 1)**: data-model.md and contracts/hr-payroll-api.md keep every
table tenant-scoped, every PII field on the masked/audited path, payroll immutability enforced at
the write path (not just UI convention), and every endpoint permission-gated with existing enum
values. Still PASS.

## Project Structure

### Documentation (this feature)

```text
specs/005-hr-payroll-backend/
├── plan.md                    # This file
├── research.md                # Phase 0 output
├── data-model.md              # Phase 1 output
├── quickstart.md              # Phase 1 output
└── contracts/
    └── hr-payroll-api.md      # Phase 1 output

(tasks.md — Phase 2 output, /speckit-tasks — not created by /speckit-plan)
```

### Source Code (repository root)

```text
buildcore-api/
├── prisma/
│   ├── schema.prisma                              # MODIFIED — Employee extension, new hr/payroll
│   │                                              #   tables, settings.Company.otMultiplier
│   └── migrations/                                  # NEW migrations (grouped logically —
│                                                    #   research.md §2/Constitution Check VI)
├── src/
│   ├── settings/
│   │   ├── companies/                                # MODIFIED — otMultiplier field/DTO
│   │   └── reimbursement-categories/                 # NEW — research.md §15, `settings` schema
│   │       ├── reimbursement-categories.controller.ts
│   │       └── reimbursement-categories.service.ts
│   ├── hr/
│   │   ├── employees/
│   │   │   ├── employees.controller.ts              # MODIFIED (003 scaffold) — full CRUD, list,
│   │   │   │                                       #   detail, reveal-pii, transfer
│   │   │   ├── employees.service.ts                 # MODIFIED
│   │   │   ├── pii-masking.interceptor.ts            # NEW — research.md §3
│   │   │   └── documents/
│   │   │       ├── employee-documents.controller.ts  # NEW
│   │   │       └── employee-documents.service.ts     # NEW — mandatory-doc gating via 002's
│   │   │                                            #   hasMissingMandatoryDocs()
│   │   ├── attendance/
│   │   │   ├── attendance-admin.controller.ts        # NEW — Mark/Edit, Exceptions,
│   │   │   │                                       #   Modifications
│   │   │   ├── attendance-admin.service.ts           # NEW
│   │   │   └── holidays.controller.ts                # NEW — supersedes Site.holidays
│   │   ├── leave/
│   │   │   └── leave-admin.controller.ts             # NEW — thin list layer over 003
│   │   ├── daily-workers/
│   │   │   ├── daily-workers.controller.ts           # NEW
│   │   │   ├── daily-workers.service.ts              # NEW — reuses 003's BiometricsService
│   │   │   ├── daily-worker-attendance.controller.ts # NEW
│   │   │   └── daily-worker-conversion.service.ts    # NEW — research.md §9
│   │   ├── re-enrolment-requests/
│   │   │   └── re-enrolment-requests-admin.controller.ts # NEW — thin list over 003
│   │   ├── offboarding/
│   │   │   ├── exit.service.ts                        # NEW — research.md §12
│   │   │   └── dto/
│   │   └── attendance/
│   │       └── attendance-import.{controller,service}.ts # NEW — research.md §14, reuses
│   │                                                    #   attendance-admin.service.ts (US3)
│   └── payroll/
│       ├── engine/
│       │   └── payroll-engine.service.ts             # NEW — research.md §4
│       ├── runs/
│       │   ├── payroll-runs.controller.ts             # NEW
│       │   └── salary-slip.service.ts                 # NEW — reuses pdfkit (003)
│       ├── challans/
│       │   └── challans.controller.ts                 # NEW — derived read, research.md §5
│       ├── loans/
│       │   ├── loans.controller.ts                    # NEW
│       │   └── loans.service.ts                       # NEW — schedule generation
│       ├── offboarding/
│       │   └── fnf.service.ts                          # NEW — research.md §12, reuses
│       │                                               #   payroll-engine.service.ts
│       └── reimbursements-admin/
│           ├── reimbursements-admin.controller.ts       # NEW — research.md §13
│           └── reimbursements-admin.service.ts           # NEW — extends 003's
│                                                        #   hr.ReimbursementClaim, no new table
└── test/
    └── hr-payroll.e2e-spec.ts                          # NEW
```

**Structure Decision**: Single NestJS project (`buildcore-api`), substantially filling out the
`hr`/`payroll` modules feature 003 began. No new top-level module; the one cross-module touch is
`settings.Company.otMultiplier`, owned and migrated by `settings`.

## Complexity Tracking

*No entries — no constitution violations requiring justification (see Constitution Check above).*
