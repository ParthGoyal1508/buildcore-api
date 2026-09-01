# Implementation Plan: Settings Module Backend (Companies, Users, Roles & Reference Data)

**Branch**: `002-settings-backend` | **Date**: 2026-08-27 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/002-settings-backend/spec.md`

## Summary

Build the `settings` Postgres schema (Constitution Principle I) and its NestJS module: multi-company
configuration (statutory/payroll settings), a dynamic Roles master with a fixed-enum permission set
that supersedes feature 001's placeholder `Role` enum, user administration (list/edit/delete —
creation stays out of scope, owned by the separate Account Creation feature), and four per-company
Employee Setup reference masters (Departments, Designations, Document Types, Shifts) plus a
concurrency-safe employee-code generator. This feature also generalizes feature 001's
`AuditLogEntry` table so both features' events share one audit trail. See
[research.md](research.md) for the specific decisions, especially the cross-schema `User.roleId` ↔
`settings.Role` relationship and how it's queried without violating Principle I.

## Technical Context

**Language/Version**: TypeScript 5.1, Node.js, NestJS 10, Prisma 5 against PostgreSQL — same stack
as feature 001 and the rest of the repo (`package.json`); no new language/runtime.

**Primary Dependencies**: Existing — `class-validator`/`class-transformer`, `@nestjs/swagger`,
`@nestjs/config`, `nestjs-prisma`. Reused from feature 001 (once implemented, or built together with
it if this feature lands first) — the `RolesGuard`/`@Roles()`/`JwtAuthGuard` pattern, extended here
with a permission-based `@RequirePermission()` decorator reading `Role.permissions`. No new external
package is required for this feature's own scope.

**Storage**: PostgreSQL via Prisma multi-schema — adds the `settings` schema (Company, Role,
Department, Designation, DocumentType, Shift, EmployeeCodeSequence, `Permission` enum) and modifies
two `shared`-schema models feature 001 introduces (`User.roleId` FK, `AuditLogEntry.entityType`/
`action`/`entityId`/`changes`) per data-model.md.

**Testing**: Jest unit tests (`*.spec.ts`, colocated) for every new service (`CompaniesService`,
`RolesService`, `UsersAdminService`, the four reference-data services, the employee-code generator's
concurrency behavior) and `test/settings.e2e-spec.ts` for the full endpoint surface — this repo's
constitution requires e2e coverage for endpoints touching auth or PII-adjacent admin actions, which
role/permission management and user administration both are.

**Target Platform**: Linux server (Node.js), same deployment target as the rest of `buildcore-api`.

**Project Type**: Web service (backend API) — single NestJS project; adds one new module
(`SettingsModule`), no new service/project split.

**Performance Goals**: Company creation completes well under the 5-minute human-driven target
(spec SC-001) — this is a UX-paced number, not a backend latency requirement; the one genuine
backend performance requirement is SC-007 (1,000 concurrent employee-code generations, zero
duplicates/gaps), addressed by the atomic `UPDATE ... RETURNING` counter (research.md §6).

**Constraints**: Every controller method uses a validated DTO (Principle II); `settings` module
queries never join directly into `shared` (or any other module's) schema — cross-module reads/writes
go through exported service methods (Principle I, research.md §3); every `companyId`-scoped table is
RLS-protected with the same Super Admin bypass flag feature 001 establishes (Principle IV); payroll
rate defaults and any other environment-independent-but-configurable values come from centralized
config, not inline literals (Principle III, research.md §11); every Prisma schema change ships as a
generated migration (Principle VI).

**Scale/Scope**: One new module (`SettingsModule`) covering ~7 entities and ~20 endpoints (Companies,
Roles, Users-admin, and four reference-data resources), plus the two cross-cutting modifications to
feature 001's `shared` schema. No other existing module is touched.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Check | Status |
|---|---|---|
| I. Schema-Per-Module Boundaries (NON-NEGOTIABLE) | New `settings` schema created for this feature's own entities — matches the named module list exactly. The one cross-schema relationship (`shared.User.roleId` → `settings.Role.id`) is a DB-level FK only; every read/write across that boundary goes through an exported service method on the owning module (research.md §3), never a direct cross-schema Prisma query. | PASS |
| II. Validated DTO Contracts (NON-NEGOTIABLE) | Every endpoint in contracts/settings-api.md uses a `class-validator`-backed DTO (`CreateCompanyDto`, `UpdateRoleDto`, etc.); `Permission` values are validated against the enum (FR-007), not accepted as freeform strings. Global `ValidationPipe` (already configured) continues to reject unexpected fields. | PASS |
| III. Centralized Configuration & No Hardcoded Values (NON-NEGOTIABLE) | Default payroll rates sourced from a new `SettingsConfig` addition to `config.ts`/`config.interface.ts` (research.md §11), not inline literals; the fixed `Permission` set lives as a Prisma enum (a schema-level constant, not a scattered magic string) shared by DTOs and guards. | PASS |
| IV. Multi-Tenant Isolation & PII Protection (NON-NEGOTIABLE) | Department/Designation/DocumentType/Shift/EmployeeCodeSequence all carry `companyId` and get the same RLS policy pattern feature 001 establishes, with the identical Super Admin bypass flag (research.md §8); Company itself is the tenant root, gated by permission check rather than RLS. Every create/update/delete in this feature writes an audit log entry (FR-025); none of this feature's fields are in the constitution's regulated-PII list (Aadhaar/PAN/bank details), so no masking requirement applies to Company/Role/reference-data fields themselves. | PASS |
| V. Authentication, Authorization & Secrets Hygiene | Every endpoint sits behind `JwtAuthGuard` plus a declarative `@RequirePermission()` check (extending feature 001's guard/decorator pattern, research.md §4) — no in-handler role/permission `if` checks. Super Admin role/account protections (research.md §5) are enforced server-side in the service layer, not only via UI hiding. | PASS |
| VI. Observability & Safe Migrations | All new tables and the two `shared`-schema modifications ship as generated Prisma migrations (`migrate:dev:create`), never hand-edited SQL. Request tracing/health endpoints remain the same repo-wide, not-yet-wired initiative noted in feature 001's plan — unaffected by this feature. | PASS |

No violations require a Complexity Tracking entry.

**Post-design re-check (after Phase 1)**: data-model.md and contracts/settings-api.md keep every
`companyId`-scoped table RLS-protected with the single documented Super Admin exception, every
endpoint's request/response as a typed DTO, permissions restricted to the fixed enum, and no new
configuration read outside the centralized path. Still PASS.

## Project Structure

### Documentation (this feature)

```text
specs/002-settings-backend/
├── plan.md               # This file
├── research.md           # Phase 0 output
├── data-model.md         # Phase 1 output
├── quickstart.md         # Phase 1 output
├── contracts/
│   └── settings-api.md   # Phase 1 output
└── tasks.md               # Phase 2 output (/speckit-tasks — not created by /speckit-plan)
```

### Source Code (repository root)

```text
buildcore-api/
├── prisma/
│   ├── schema.prisma                          # MODIFIED — new `settings` schema (Company, Role,
│   │                                          #   Permission enum, Department, Designation,
│   │                                          #   DocumentType, Shift, EmployeeCodeSequence);
│   │                                          #   `shared.User.role` enum → `roleId` FK;
│   │                                          #   `shared.AuditLogEntry` generalized (entityType/
│   │                                          #   action/entityId/changes)
│   ├── seed.ts                                 # MODIFIED — seeds the nine default roles
│   │                                          #   (Super Admin protected) and, per-company, the
│   │                                          #   16 default document types
│   └── migrations/                             # NEW migration(s) generated via `migrate:dev:create`
├── src/
│   ├── common/
│   │   ├── configs/
│   │   │   ├── config.ts                       # MODIFIED — SettingsConfig (default payroll rates)
│   │   │   └── config.interface.ts             # MODIFIED — SettingsConfig type
│   │   └── decorators/
│   │       └── require-permission.decorator.ts # NEW — `@RequirePermission(...Permission[])`,
│   │                                          #   read by the existing/extended RolesGuard
│   ├── auth/
│   │   └── audit-log.service.ts                # MODIFIED (feature 001's) — generalized record()
│   │                                          #   signature (entityType/action/entityId/changes)
│   └── settings/
│       ├── settings.module.ts                  # NEW
│       ├── companies/
│       │   ├── companies.controller.ts         # NEW
│       │   ├── companies.service.ts            # NEW — incl. GSTIN/PAN validation, default seeding
│       │   └── dto/
│       │       ├── create-company.dto.ts       # NEW
│       │       └── update-company.dto.ts       # NEW
│       ├── roles/
│       │   ├── roles.controller.ts             # NEW
│       │   ├── roles.service.ts                # NEW — incl. isProtected guard, assignedUserCount
│       │   └── dto/
│       │       ├── create-role.dto.ts          # NEW
│       │       └── update-role.dto.ts          # NEW
│       ├── users-admin/
│       │   ├── users-admin.controller.ts       # NEW — calls 010's exported UsersService (corrected
│       │   │                                   #   from an original "AuthModule" assumption — 001
│       │   │                                   #   never built this; see research.md §3)
│       │   ├── users-admin.service.ts          # NEW — incl. last-Super-Admin-standing guard
│       │   └── dto/update-user.dto.ts          # NEW
│       ├── reference-data/
│       │   ├── departments.controller.ts       # NEW
│       │   ├── designations.controller.ts      # NEW
│       │   ├── document-types.controller.ts    # NEW — incl. derived-flag computation
│       │   ├── shifts.controller.ts            # NEW
│       │   ├── reference-data.service.ts       # NEW — shared CRUD + uniqueness/deletion-guard
│       │   │                                  #   logic parameterized per resource
│       │   └── dto/
│       │       ├── department.dto.ts           # NEW
│       │       ├── designation.dto.ts          # NEW
│       │       ├── document-type.dto.ts        # NEW
│       │       └── shift.dto.ts                # NEW
│       └── employee-code/
│           └── employee-code.service.ts        # NEW — exported getNextEmployeeCode(companyId)
└── test/
    └── settings.e2e-spec.ts                    # NEW — covers companies/roles/users-admin/
                                                #   reference-data/employee-code per constitution's
                                                #   e2e requirement
```

**Structure Decision**: Single NestJS project (`buildcore-api`), adding one new top-level module
(`src/settings/`) alongside the existing `src/auth/`. The one structural database addition is the
`settings` Postgres schema (via Prisma multi-schema, same mechanism feature 001 uses for `shared`).

## Complexity Tracking

*No entries — no constitution violations requiring justification (see Constitution Check above).*

---

## Amendment 2026-09-01 — Company Documents Repository

Covers spec FR-028 to FR-038. Adds 2 `settings` tables; no new permission value.

**Constitution re-check**: Principle I — both tables in `settings`, correct owner. Principle III —
`alertDays` per document type, never a literal. Principle IV — `companyId` + RLS; cross-company
reads gated by `CROSS_COMPANY_ACCESS`. Principle V — reuses `COMPANY_SETTINGS`, adds nothing.
Principle VI — encrypted object storage, production start refused on local-filesystem blobs. PASS.

### Phase A1: Schema

- [ ] Add `CompanyDocumentType` and `CompanyDocument` models to `prisma/schema.prisma`; migration
      + RLS
- [ ] Extend `shared.AuditLogEntry.entityType` with `COMPANY_DOCUMENT`
- [ ] Seed default statutory company document types on company creation, reusing the FR-020
      seeding hook rather than a second mechanism (FR-029)

### Phase A2: US8 — Company Document Types (P3)

- [ ] `CompanyDocumentTypesService` + controller (Super-Admin CRUD, `requiresExpiry`-without-
      `alertDays` guard → 400, delete guard → 409)
- [ ] Unit test: required-flag validation; seeding on new company

### Phase A3: US9 — Company Documents (P3)

- [ ] `CompanyDocumentsService` + controller (upload with per-type required-field enforcement —
      FR-030, encrypted object-storage reference, versioning scoped per document number where one
      is present — FR-031, status computed on read — FR-033, soft-delete promoting the prior
      version — FR-038)
- [ ] Register the `company_document_expiry` reminder rule with feature 004's centralized engine
      (FR-034, ratified 2026-09-01) — no evaluation or de-duplication logic here
- [ ] Confirm expiry blocks no business operation (FR-035)
- [ ] Unit test: versioning per document number; status computation across alert-window changes
- [ ] E2e test: renewal creates v2 current with v1 still downloadable; cross-company read → 403
