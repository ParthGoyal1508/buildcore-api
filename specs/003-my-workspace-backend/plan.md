# Implementation Plan: My Workspace Backend (Punch, Leave, Salary, Face Enrolment)

**Branch**: `003-my-workspace-backend` | **Date**: 2026-08-27 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/003-my-workspace-backend/spec.md`

## Summary

Build the self-service `hr`/`projects`/`payroll` schema entities (Employee, Site, PunchRecord,
FaceEnrolment, ReEnrolmentRequest, LeaveType/Balance/Application, PayrollRun status, SalarySlip
projection) and their `/my/*` endpoints, plus the admin-side attendance-exception-resolution and
leave-approval endpoints this feature also owns per its clarification. In-process face matching
(`@vladmandic/face-api`) and PDF generation (`pdfkit`) are both newly pre-approved additions to
this repo's constitution (v1.1.0), introduced by this feature at the user's explicit direction. See
[research.md](research.md) for the full set of technical decisions, especially schema placement
(§1) and how this feature reconciles with feature 001 (`shared.User`) and feature 002
(`settings.Company`/`settings.Shift`) rather than redefining them (§9).

## Technical Context

**Language/Version**: TypeScript 5.1, Node.js, NestJS 10, Prisma 5 against PostgreSQL — unchanged
from features 001/002.

**Primary Dependencies**: Existing — `class-validator`/`class-transformer`, `@nestjs/swagger`,
`@nestjs/config`, `nestjs-prisma`, feature 001's `JwtAuthGuard`/`RolesGuard`, feature 002's
permission-guard extension. New — `@vladmandic/face-api` (in-process face matching, research.md
§2) and `pdfkit` (salary-slip PDF, research.md §7), both newly pre-approved (constitution v1.1.0).

**Storage**: PostgreSQL via Prisma multi-schema — adds `hr` and `projects` schemas (new) and
extends the existing `payroll`-schema stub with `PayrollRun`/`SalarySlip`; extends `shared`'s
`AuditLogEntry.entityType` enum (data-model.md cross-reference).

**Testing**: Jest unit tests for every new service (geofence distance calc, offline-timestamp
tagging, leave day-count calc, face-match threshold logic, one-open-punch-in guard) and
`test/my-workspace.e2e-spec.ts` — this repo's constitution requires e2e coverage for endpoints
touching PII, and biometric/attendance/payroll data all qualify.

**Target Platform**: Linux server (Node.js), same as the rest of `buildcore-api`.

**Project Type**: Web service (backend API) — single NestJS project; adds `hr`/`projects` modules
and extends `payroll`'s stub module.

**Performance Goals**: A punch-in/out round trip (photo + GPS submission → recorded response)
completes in a normal-conditions timeframe consistent with SC-001's 10-second end-to-end UX target;
the face-match computation itself (one descriptor comparison per punch) is the dominant cost and
must stay well within that budget.

**Constraints**: Every controller method uses a validated DTO (Principle II); `hr`/`projects`/
`payroll` modules never query directly into `shared`/`settings` schemas — cross-module reads go
through each owning module's exported service (Principle I, research.md §1/§9); biometric photos/
descriptors encrypted at rest with every access audit-logged (Principle IV, FR-026, research.md
§8); face-match threshold, offline-queue max age, and re-enrolment unlock duration all centralized
config, never inline magic numbers (Principle III); every Prisma schema change ships as a generated
migration (Principle VI).

**Scale/Scope**: Three new schemas' worth of entities (~10, including the new Reimbursement Claim
added for US8), ~24 employee-facing endpoints plus 4 admin-side endpoints
(contracts/my-workspace-api.md), two newly pre-approved dependencies. No existing feature 001/002
code is modified beyond the additive schema changes in data-model.md's cross-reference table
(`User.roleId` unaffected; `AuditLogEntry.entityType` gains new values; `settings` gains a
`ReimbursementCategory` table, added by feature 005, read here read-only).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Check | Status |
|---|---|---|
| I. Schema-Per-Module Boundaries (NON-NEGOTIABLE) | New `hr`/`projects` schemas match the named module list; `payroll` schema extended, not newly created. All cross-schema needs (Employee↔User, Employee↔Company/Shift, AuditLogEntry writes) go through each owning module's exported service (research.md §1, §9). | PASS |
| II. Validated DTO Contracts (NON-NEGOTIABLE) | Every endpoint in contracts/my-workspace-api.md uses a typed DTO; global `ValidationPipe` continues to reject unexpected fields. | PASS |
| III. Centralized Configuration & No Hardcoded Values (NON-NEGOTIABLE) | Face-match distance threshold, max offline-queue age, re-enrolment unlock duration (7 days), and clock-skew tolerance all added to a typed `WorkspaceConfig` (`config.ts`/`config.interface.ts`), not inline. | PASS |
| IV. Multi-Tenant Isolation & PII Protection (NON-NEGOTIABLE) | Every `companyId`-scoped table RLS-protected per the existing pattern; biometric data explicitly extended to the same encryption/audit/masking tier as named regulated PII, per FR-026 (research.md §8) — this is a spec-level requirement this plan implements, not a new constitutional obligation being invented. | PASS |
| V. Authentication, Authorization & Secrets Hygiene | Every `/my/*` endpoint behind `JwtAuthGuard`; admin-side endpoints additionally behind `@RequirePermission()` (feature 002's guard). No new auth mechanism introduced. | PASS |
| VI. Observability & Safe Migrations | All new schema changes (three schemas' worth) ship as generated Prisma migrations. | PASS |

**New architectural dependencies**: `@vladmandic/face-api` and `pdfkit` are both now pre-approved
in the constitution (v1.1.0, amended as part of this feature's planning, at the user's explicit
direction in both cases) — no Complexity Tracking entry required; this is the intended "module that
needs them lands" trigger the constitution's Technology Stack section describes for its
pre-approved-package pattern.

**Post-design re-check (after Phase 1)**: data-model.md and contracts/my-workspace-api.md keep
every module's queries inside its own schema, every biometric field on the protected-tier path, and
every new config value centralized. Still PASS.

## Project Structure

### Documentation (this feature)

```text
specs/003-my-workspace-backend/
├── plan.md                    # This file
├── research.md                # Phase 0 output
├── data-model.md              # Phase 1 output
├── quickstart.md              # Phase 1 output
└── contracts/
    └── my-workspace-api.md    # Phase 1 output

(tasks.md — Phase 2 output, /speckit-tasks — not created by /speckit-plan)
```

### Source Code (repository root)

```text
buildcore-api/
├── prisma/
│   ├── schema.prisma                             # MODIFIED — new `hr` schema (Employee,
│   │                                             #   PunchRecord, FaceEnrolment,
│   │                                             #   ReEnrolmentRequest, LeaveType/Balance/
│   │                                             #   Application), new `projects` schema (Site),
│   │                                             #   `payroll` schema gets PayrollRun/SalarySlip;
│   │                                             #   `shared.AuditLogEntry.entityType` extended
│   └── migrations/                                # NEW migration(s) via `migrate:dev:create`
├── src/
│   ├── common/configs/
│   │   ├── config.ts                              # MODIFIED — WorkspaceConfig (thresholds,
│   │   │                                         #   max offline age, unlock duration)
│   │   └── config.interface.ts                    # MODIFIED — WorkspaceConfig type
│   ├── hr/
│   │   ├── hr.module.ts                           # NEW
│   │   ├── employees/employees.service.ts         # NEW — exported for other modules to resolve
│   │   │                                         #   `userId → Employee`
│   │   ├── biometrics/
│   │   │   ├── biometrics.service.ts              # NEW — face-api.js descriptor compute/compare
│   │   │   ├── face-enrolment.controller.ts       # NEW — /my/face-enrol*
│   │   │   ├── face-enrolment.service.ts          # NEW
│   │   │   └── dto/                               # NEW — enrol/re-enrolment DTOs
│   │   ├── punch/
│   │   │   ├── punch.controller.ts                # NEW — /my/punch*
│   │   │   ├── punch.service.ts                   # NEW — geofence calc, offline tagging,
│   │   │   │                                     #   open-punch-in guard (research.md §5)
│   │   │   └── dto/
│   │   ├── attendance-exceptions/
│   │   │   └── attendance-exceptions.controller.ts # NEW — /workspace-admin/attendance-exceptions*
│   │   └── leave/
│   │       ├── leave.controller.ts                 # NEW — /my/leave*
│   │       ├── leave-admin.controller.ts           # NEW — /workspace-admin/leave-applications*
│   │       ├── leave.service.ts                    # NEW — day-count calc, balance check
│   │       └── dto/
│   │   └── reimbursements/
│   │       ├── reimbursement.controller.ts          # NEW — /my/reimbursements* (US8)
│   │       ├── reimbursement.service.ts              # NEW — research.md §10
│   │       └── dto/
│   ├── projects/
│   │   ├── projects.module.ts                      # NEW
│   │   └── sites/sites.service.ts                  # NEW — exported geofence/holiday lookups
│   └── payroll/
│       ├── payroll.module.ts                       # NEW (or extends an existing stub)
│       └── salary/
│           ├── salary.controller.ts                 # NEW — /my/salary*
│           ├── salary.service.ts                    # NEW
│           └── salary-pdf.service.ts                 # NEW — pdfkit rendering
└── test/
    └── my-workspace.e2e-spec.ts                     # NEW
```

**Structure Decision**: Single NestJS project (`buildcore-api`), adding three new top-level modules
(`hr`, `projects`, `payroll`) alongside the existing `auth`/`settings`. The three new Postgres
schemas are the structural database addition, via the same Prisma multi-schema mechanism features
001/002 already use.

## Complexity Tracking

*No entries — the two new dependencies are pre-approved via constitution amendment (v1.1.0), not
undocumented violations; no other constitution deviation exists (see Constitution Check above).*
