# Implementation Plan: Partners Backend (Vendors, Contractor Vault, Compliance, RAG Matrix, BOCW Cess)

**Branch**: `007-partners-backend` | **Date**: 2026-08-28 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/007-partners-backend/spec.md`

## Summary

Build the `partners` schema — full Vendor CRUD (with atomic contact/tag replacement),
ContractorProfile as a 1:1 Vendor extension, per-contractor document uploads with expiry warnings,
monthly PF/ESIC compliance recording with auto-derived status and stored `complianceStatus`
(recomputed in-transaction, single-most-recent-month rule), RAG Matrix on-demand from compliance
data, BOCW cess on-demand from ProjectsService, and the exported `getSubcontractorCostByProject()`
method that resolves 008's P&L stub. A `@Cron` job notifies for last-month missing compliance.
Adds `bocwCessRate` to `settings.Company`.

**Corrected during a master-PRD alignment audit**: Vendor Categories are a `settings`-schema
master (not `partners`-owned), matching master PRD §7.8's masters placement and this project's
established convention; permission checks reuse Settings' already-existing `PARTNERS` value
instead of three invented ones; `PartnersService` now exports `getVendorById()`/`getVendorTds()`
as real in-process methods for Machinery (006) and Inventory (009) to inject, not just an HTTP
endpoint; GSTIN/PAN gain format validation. See [research.md](research.md) for all 13 decisions
(11 original + 2 corrections).

## Technical Context

**Language/Version**: TypeScript 5.1, Node.js, NestJS 10, Prisma 5 against PostgreSQL — unchanged.

**Primary Dependencies**: Existing + `@nestjs/schedule` (pre-approved, first consumer here) for
the compliance cron job. All other dependencies existing: `class-validator`/`class-transformer`,
`@nestjs/swagger`, `@nestjs/event-emitter` (pre-approved, used here for the first time for the
missing-compliance event), 001/002's guards, 005/008's object-storage pattern.

**Storage**: PostgreSQL via Prisma — new `partners` schema with 8 operational tables; one new
`settings`-schema table (`VendorCategory`, corrected — research.md §1); one additive field on
`settings.Company` (`bocwCessRate`).

**Testing**: Jest unit tests for `ComplianceStatusService.recompute()` (the central derived-status
logic), `RagMatrixService.buildMatrix()` (future-month gray logic), and `BOCWService.compute()`
(liability derivation). E2e coverage in `test/partners.e2e-spec.ts` for compliance verify
endpoint (financial audit data), BOCW payment recording, and the contractor vault document upload.

**Target Platform**: Linux server (Node.js), same as rest of `buildcore-api`.

**Project Type**: Web service (backend API) — new `PartnersModule` alongside existing modules.

**Performance Goals**: `GET /partners/rag` responds in under 2 seconds for 50 contractors × 12
months. `getSubcontractorCostByProject()` under 500ms (spec SC-006).

**Constraints**: `partners` schema never queries `projects`/`settings`/`hr` schemas directly —
only via exported service calls (Principle I); `bocwCessRate` migration is additive (Principle VI);
all 9 tables `companyId`-scoped with RLS (Principle IV); `@nestjs/event-emitter` used for
missing-compliance notification — no direct Notifications write (Principle I); VendorContacts and
VendorDealsIn replaced atomically on vendor update (research.md §10).

**Scale/Scope**: 9 new tables (8 `partners` + 1 `settings`), ~25 endpoints, 0 new Permission enum
values (reuses `PARTNERS`/`SETTINGS`, corrected), 1 cron job, 3 exported cross-module service
methods (`getSubcontractorCostByProject`, `getVendorById`, `getVendorTds`), 1 additive field on
`settings.Company`.

## Constitution Check

| Principle | Check | Status |
|---|---|---|
| I. Schema-Per-Module Boundaries (NON-NEGOTIABLE) | 8 operational tables in `partners`; `VendorCategory` in `settings` (corrected, research.md §1) with CRUD via `SettingsService`-exported methods. BOCW reads project contract values via `ProjectsService`; cess rate via `SettingsService`. `getSubcontractorCostByProject` calls `ProjectsService` stub. Vendor name/TDS now exported as real in-process methods (`getVendorById`/`getVendorTds`, research.md §12) for Machinery/Inventory to inject — no direct cross-schema queries anywhere, and no HTTP self-calls between modules. Missing-compliance notification via `@nestjs/event-emitter` event. | PASS |
| II. Validated DTO Contracts (NON-NEGOTIABLE) | Every endpoint in contracts/partners-api.md uses a typed DTO. Atomic contacts/tags replacement is validated at DTO level. GSTIN/PAN format-validated (research.md §13). | PASS |
| III. Centralized Configuration & No Hardcoded Values (NON-NEGOTIABLE) | `bocwCessRate` in `settings.Company` (not hardcoded). Document expiry warning window (30 days) via `@nestjs/config`. `@Cron` expression in a constant, not an inline string literal. | PASS |
| IV. Multi-Tenant Isolation & PII Protection (NON-NEGOTIABLE) | All 9 tables carry `companyId`; RLS on all. No regulated PII (Aadhaar/PAN/bank) in this module. Contractor document file references use encrypted object-storage pattern (005/008). | PASS |
| V. Authentication, Authorization & Secrets Hygiene | Every endpoint behind `JwtAuthGuard` + `@RequirePermission(PARTNERS)`, reusing 002's existing value; Vendor Categories behind `SETTINGS` (corrected, research.md §9). | PASS |
| VI. Observability & Safe Migrations | `bocwCessRate` migration is additive (nullable default). `partners`/`settings` schema tables added in separate, logically-grouped migrations. `@nestjs/schedule` and `@nestjs/event-emitter` wired for the first time — both are pre-approved packages. | PASS |

## Project Structure

### Documentation

```text
specs/007-partners-backend/
├── plan.md                    # This file
├── research.md                # Phase 0 output
├── data-model.md              # Phase 1 output
├── quickstart.md              # Phase 1 output
└── contracts/
    └── partners-api.md        # Phase 1 output
```

### Source Code

```text
src/
├── settings/
│   ├── vendor-categories/                    # MOVED here — settings schema (research.md §1)
│   │   ├── vendor-categories.service.ts       # CRUD, exported for PartnersModule to call
│   │   └── dto/
│   └── permission.enum.ts                    # unchanged — PARTNERS/SETTINGS already exist
├── partners/
│   ├── partners.module.ts
│   ├── vendor-categories/
│   │   └── vendor-categories.controller.ts    # thin proxy to settings/vendor-categories service
│   ├── vendors/
│   │   ├── vendors.controller.ts
│   │   ├── vendors.service.ts
│   │   └── dto/
│   ├── contractors/
│   │   ├── contractors.controller.ts
│   │   ├── contractors.service.ts
│   │   └── dto/
│   ├── compliance/
│   │   ├── compliance.controller.ts
│   │   ├── compliance.service.ts
│   │   ├── compliance-status.service.ts  # recompute() logic + unit tests
│   │   └── dto/
│   ├── rag/
│   │   ├── rag.controller.ts
│   │   └── rag.service.ts               # buildMatrix() logic + unit tests
│   ├── bocw/
│   │   ├── bocw.controller.ts
│   │   └── bocw.service.ts
│   └── cron/
│       └── compliance-check.cron.ts     # @Cron last-month missing check
│   (settings.Company model — bocwCessRate field, owned here)

prisma/
└── schema.prisma                       # MODIFIED: partners schema, settings.VendorCategory,
                                         #   settings.Company.bocwCessRate

test/
└── partners.e2e-spec.ts               # new
```

## Implementation Phases

### Phase 1: Setup & Schema

- [ ] No `Permission` enum changes needed — reuse Settings' existing `PARTNERS` and `SETTINGS`
      values verbatim (corrected, research.md §9)
- [ ] Add `bocwCessRate Decimal @default(0.01)` to `settings.Company` in `prisma/schema.prisma`
- [ ] Add the 8 operational `partners` schema models and the `settings.VendorCategory` model to
      `prisma/schema.prisma` (data-model.md, corrected placement — research.md §1)
- [ ] Generate and apply migrations: `bocwCessRate` additive column + `partners` schema +
      `settings.VendorCategory`
- [ ] Add RLS policies for all 9 tables (8 `partners` + 1 `settings`)
- [ ] Extend `shared.AuditLogEntry.entityType` with 6 new values
- [ ] Scaffold `PartnersModule` with sub-module structure; export `PartnersService` with stubs
      `getSubcontractorCostByProject()`, `getVendorById()`, `getVendorTds()` (research.md §12) so
      `ProjectsModule`/`PlantModule`/`InventoryModule` can inject them immediately
- [ ] Scaffold `src/settings/vendor-categories/vendor-categories.service.ts` (`settings` schema,
      exported for `PartnersModule`'s thin controller proxy to call — Principle I)
- [ ] Wire `@nestjs/schedule` in `AppModule` (first use in this codebase)
- [ ] Wire `@nestjs/event-emitter` in `AppModule` (first use in this codebase)

**Checkpoint**: Schema, permissions, module scaffold, and both new packages ready.

### Phase 2: US1 & US2 — Vendor Categories and Vendors (P1)

- [ ] VendorCategory DTOs + `VendorCategoriesService` (`settings` schema — name uniqueness,
      delete guard) in `src/settings/vendor-categories/`; thin `VendorCategoriesController`
      proxy in `src/partners/vendor-categories/`, guarded with `SETTINGS`
- [ ] Vendor DTOs (GSTIN/PAN `@Matches()` format validation, research.md §13) + `VendorsService`
      (code-series, atomic contacts/tags replace, `getVendorById()`/`getVendorTds()` exported
      methods, TDS endpoint) + `VendorsController`, guarded with `PARTNERS`
- [ ] Unit test: duplicate category name → 409; delete linked category → 409; malformed
      GSTIN/PAN → 400
- [ ] E2e test: vendor CRUD with contacts replacement

**Checkpoint**: Vendor master fully functional.

### Phase 3: US3 — Contractor Vault (P2)

- [ ] Contractor DTOs + `ContractorsService` (type validation, 1:1 profile enforcement) +
      `ContractorsController`
- [ ] `POST /partners/contractors/:id/documents` + `DELETE` — encrypted file ref pattern
- [ ] `expiryWarning` flag computation in document list response
- [ ] Unit test: create contractor for material-type vendor → 400

**Checkpoint**: Contractor vault fully functional.

### Phase 4: US4 — Monthly Compliance (P2)

- [ ] Compliance DTOs + `ComplianceService` (status auto-derivation, verified immutability) +
      `ComplianceController`
- [ ] `ComplianceStatusService.recompute(contractorProfileId)`: single most-recently-concluded-
      month logic (master PRD §7.7.2, no rolling window), persists
      `ContractorProfile.complianceStatus` in same transaction (research.md §3, §11)
- [ ] `PATCH .../verify` endpoint with audit log
- [ ] Unit test: `recompute()` — both PF+ESIC verified for the last concluded month → compliant;
      exactly one → partially_compliant; neither or no record → non_compliant

**Checkpoint**: Compliance recording + status recompute fully functional.

### Phase 5: US5 — RAG Matrix (P2)

- [ ] `RagService.buildMatrix(companyId, fy)`: single batched query, future-month gray logic,
      inactive-vendor exclusion
- [ ] `RagController` + `GET /partners/rag` endpoint
- [ ] Unit test: future months → gray regardless of record; inactive contractor excluded

**Checkpoint**: RAG Matrix endpoint functional.

### Phase 6: US6 & US7 — BOCW Cess and getSubcontractorCostByProject (P3)

- [ ] BOCW DTOs + `BOCWService` (on-demand liability from ProjectsService + SettingsService,
      payment CRUD, status derivation) + `BOCWController`
- [ ] Replace `getSubcontractorCostByProject()` stub with real implementation calling
      `ProjectsService.getWorkOrderTotalByProject()` — still returns 0 until 008 ships the real
      method, but the call chain is wired
- [ ] Implement `getVendorById()` and `getVendorTds()` as real `PartnersService` methods
      (research.md §12) — both queryable immediately (no cross-module stub dependency, unlike
      `getSubcontractorCostByProject`)
- [ ] Unit test: `BOCWService.compute()` — liability = contractValue × 0.01; status transitions;
      `getVendorById()`/`getVendorTds()` return correct shapes, `null` for a non-existent vendor

**Checkpoint**: BOCW cess and cross-module method wired.

### Phase 7: Compliance Cron Job

- [ ] `ComplianceCheckCron` in `src/partners/cron/compliance-check.cron.ts`:
      `@Cron('0 8 1-5 * *')` — queries last completed month, finds active contractors missing
      a `MonthlyCompliance` record, emits `compliance.missing` events via `EventEmitter2`

**Checkpoint**: All 7 user stories implemented.

### Phase 8: Polish

- [ ] Add Swagger `@ApiTags('Partners')` + `@ApiOperation` to all controllers
- [ ] Add seed for 6 default `VendorCategory` rows (Material, Fuel, Hire, Service, Transport,
      Subcontractor) in `prisma/seed.ts`
- [ ] `npm run lint` + `npm run build` clean

## TODO

- `TODO(008)`: Add `ProjectsService.getWorkOrderTotalByProject(projectId, dateRange)` to Projects
  exported interface — required for `getSubcontractorCostByProject()` to return real values.
- `TODO(008)`: Add `ProjectsService.getProjectsWithContractValues(companyId)` to Projects
  exported interface — required for BOCW cess list to show real contract values.
