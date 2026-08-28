---

description: "Task list for feature implementation"
---

# Tasks: Partners Backend (Vendors, Contractor Vault, Compliance, RAG Matrix, BOCW Cess)

**Input**: Design documents from `/specs/007-partners-backend/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/partners-api.md, quickstart.md

**Tests**: Included for `ComplianceStatusService.recompute()`, `RagService.buildMatrix()`,
`BOCWService.compute()`, and e2e coverage for the compliance verify endpoint, BOCW payment, and
contractor document upload — per constitution requirements for financial and audit-trail data.

**Organization**: Tasks grouped by user story (US1–US7).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: User story (US1–US7)
- Every task includes an exact file path

---

## Phase 1: Setup (Shared Infrastructure)

- [ ] T001 [P] Extend `src/settings/permission.enum.ts` with `VENDORS`, `CONTRACTORS`, `BOCW`
      — spec FR-015, research.md §9
- [ ] T002 [P] Add `bocwCessRate Decimal @default(0.01)` to `settings.Company` in
      `prisma/schema.prisma` — research.md §7 (same pattern as 005's `otMultiplier`)
- [ ] T003 Add all 9 `partners` schema models to `prisma/schema.prisma`: `VendorCategory`,
      `Vendor`, `VendorContact`, `VendorDealsIn`, `VendorHireDetail`, `ContractorProfile`,
      `ContractorDocument`, `MonthlyCompliance`, `BOCWPayment` — data-model.md
- [ ] T004 Generate and apply migrations: `bocwCessRate` additive column (separate migration),
      then all 9 `partners` schema models (one migration) — Constitution Principle VI
- [ ] T005 [P] Add RLS policies for all 9 `partners` tables — Constitution Principle IV
- [ ] T006 [P] Extend `shared.AuditLogEntry.entityType` with: `VENDOR`, `VENDOR_CATEGORY`,
      `CONTRACTOR_PROFILE`, `CONTRACTOR_DOCUMENT`, `MONTHLY_COMPLIANCE`, `BOCW_PAYMENT`
- [ ] T007 Scaffold `PartnersModule` in `src/partners/partners.module.ts` with 7 sub-module
      structure; immediately export `PartnersService` with stub
      `getSubcontractorCostByProject()` returning 0 — so `ProjectsModule` can inject it
      without error from day one
- [ ] T008 [P] Install `@nestjs/schedule` and `@nestjs/event-emitter` packages:
      `npm install @nestjs/schedule @nestjs/event-emitter` — M-003 remediation
- [ ] T009 [P] Wire `@nestjs/schedule` in `src/app.module.ts` (first use in codebase):
      `ScheduleModule.forRoot()` in imports
- [ ] T010 [P] Wire `@nestjs/event-emitter` in `src/app.module.ts` (first use in codebase):
      `EventEmitterModule.forRoot()` in imports
- [ ] T010a [P] Define `ComplianceMissingEvent` interface in
      `src/partners/cron/compliance-missing.event.ts`:
      `{ contractorProfileId: string; contractorName: string; companyId: string; month: string }`
      — H-003: event payload contract for Dashboard/Notifications (004) to implement against
- [ ] T011a [P] Add `vendorsCodeSeries` seed entry to `prisma/seed.ts` for the `VENDORS`
      code-series type (same pattern as `PROJECTS` series in 008)
- [ ] T011b [P] Add `getBocwCessRate(companyId): Promise<number>` method to
      `src/settings/companies/companies.service.ts` and export it from `SettingsModule` —
      L-003 remediation (same pattern as 005's `getOtMultiplier`)
- [ ] T011c [P] Add `getProjectsWithContractValues(companyId): Promise<Array<{ projectId,
      name, contractValue }>>` stub to `src/projects/portfolio/projects.service.ts` and export
      it from `ProjectsModule`; returns `[]` until real implementation ships — H-002 remediation
      (TODO(008) comment included)

**Checkpoint**: Schema, permissions, module scaffold, `@nestjs/schedule`, `@nestjs/event-emitter`
and both new packages ready. All subsequent phases can proceed in parallel per story.

---

## Phase 2: User Story 1 — Vendor Categories (Priority: P1) 🎯 MVP

**Goal**: Vendor category CRUD with 6 seeded defaults and delete guard.

**Independent Test**: Create a category, edit it, delete it (no linked vendors → 200; linked → 409).

### Implementation for User Story 1

- [ ] T011 [P] [US1] Create `src/partners/vendor-categories/dto/create-vendor-category.dto.ts`
      and `update-vendor-category.dto.ts` with class-validator decorators
- [ ] T012 [P] [US1] Implement `VendorCategoriesService` in
      `src/partners/vendor-categories/vendor-categories.service.ts`: `create` (unique name per
      company → 409 if duplicate), `findAll` (with `vendorCount` via aggregation), `update`,
      `delete` (→ 409 if `VendorDealsIn` rows reference this category) — all write paths
      audit-logged
- [ ] T013 [US1] Implement `VendorCategoriesController` in
      `src/partners/vendor-categories/vendor-categories.controller.ts`: all 4 endpoints,
      `@RequirePermission(Permission.VENDORS)`
- [ ] T014 [P] [US1] Add 6 default seeded `VendorCategory` rows to `prisma/seed.ts`:
      Material, Fuel, Hire, Service, Transport, Subcontractor — `isDefault: true`

**Checkpoint**: Vendor categories CRUD functional and seeded.

---

## Phase 3: User Story 2 — Manage Vendors (Priority: P1)

**Goal**: Full Vendor CRUD with atomic contacts/tags replacement, TDS endpoint, code-series
auto-generation, active/inactive filter.

**Independent Test**: Create vendor with 2 contacts and 3 category tags, edit with new contacts
array (→ old replaced), call TDS endpoint (→ section+rate only), filter by type.

### Implementation for User Story 2

- [ ] T015 [P] [US2] Create vendor DTOs in `src/partners/vendors/dto/`: `create-vendor.dto.ts`
      (with nested `VendorContactInput[]`, `categoryIds: string[]`, optional
      `VendorHireDetailInput`), `update-vendor.dto.ts`
- [ ] T016 [P] [US2] Implement `VendorsService` in `src/partners/vendors/vendors.service.ts`:
      `create` (CodeSeriesService 'VENDORS', atomic contacts + DealsIn insert),
      `findAll` (paginated, search/type/active filters, `primaryContact` derived),
      `findOne` (full detail with contacts, categories, hireDetail, contractorProfile?),
      `update` (atomic contacts/tags replace in Prisma transaction — research.md §10),
      `getTds` (returns `{ tdsSection, tdsRate }` only — FR-002), audit-log all writes
- [ ] T017 [US2] Implement `VendorsController` in
      `src/partners/vendors/vendors.controller.ts`: all endpoints including
      `GET /partners/vendors/:id/tds`, `@RequirePermission(Permission.VENDORS)`
- [ ] T018 [P] [US2] Unit test: atomic contacts replacement (2 contacts → update with 1 →
      verify old deleted), category tags replace — `src/partners/vendors/vendors.service.spec.ts`
- [ ] T019 [US2] E2e test: `POST /partners/vendors` with contacts + categories, `PATCH` with
      new contacts array, `GET /:id/tds` — `test/partners.e2e-spec.ts` (create the file)

**Checkpoint**: Vendor CRUD fully functional.

---

## Phase 4: User Story 3 — Contractor Vault (Priority: P2)

**Goal**: ContractorProfile CRUD (1:1 Vendor extension), document upload/delete with expiry
warnings, contractor list with complianceStatus.

**Independent Test**: Create contractor profile for subcontractor vendor (→ 201, `non_compliant`);
upload document with expiry 20 days out (→ `expiryWarning: true`); try material-type vendor
(→ 400).

### Implementation for User Story 3

- [ ] T020 [P] [US3] Create contractor DTOs in `src/partners/contractors/dto/`:
      `create-contractor.dto.ts` (with `vendorId` + registration fields),
      `create-contractor-document.dto.ts` (with `documentType`, `expiresAt?`)
- [ ] T021 [P] [US3] Implement `ContractorsService` in
      `src/partners/contractors/contractors.service.ts`: `create` (validate `vendor.type IN
      subcontractor/labour_contractor` → 400 otherwise; 1:1 uniqueness → 409 if profile exists),
      `findAll` (active-vendor contractors only, `complianceStatus` filter),
      `findOne` (with documents, `expiryWarning` flag computed per document),
      `update`, `uploadDocument` (encrypted fileRef pattern — 005/008),
      `deleteDocument` (record + schedule storage cleanup);
      all writes (create/update/uploadDocument/deleteDocument) audit-logged with
      `CONTRACTOR_PROFILE` / `CONTRACTOR_DOCUMENT` entity types — H-001 remediation
- [ ] T022 [US3] Implement `ContractorsController` in
      `src/partners/contractors/contractors.controller.ts`: all 6 endpoints,
      `@RequirePermission(Permission.CONTRACTORS)`
- [ ] T023 [US3] E2e test: create contractor for wrong vendor type → 400; upload document with
      expiry → `expiryWarning: true` in response — `test/partners.e2e-spec.ts`

**Checkpoint**: Contractor vault and documents functional.

---

## Phase 5: User Story 4 — Monthly Compliance (Priority: P2)

**Goal**: PF/ESIC compliance record CRUD with auto-derived status, verify transition (audit-
logged), complianceStatus recompute on every change.

**Independent Test**: Create PF-only (→ partial), add ESIC (→ submitted), verify (→ verified,
audit-logged, immutable); check contractor `complianceStatus` updates.

### Implementation for User Story 4

- [ ] T024 [P] [US4] Create compliance DTOs in `src/partners/compliance/dto/`:
      `create-compliance.dto.ts` (with `month` YYYY-MM format validation), `update-compliance.dto.ts`
- [ ] T025 [P] [US4] Implement `ComplianceStatusService` in
      `src/partners/compliance/compliance-status.service.ts`:
      `recompute(contractorProfileId)` — queries last 3 completed calendar months (research.md §11),
      derives `complianceStatus` (all-verified → compliant; any missing → non_compliant; mixed
      partial/submitted → partially_compliant), persists to `ContractorProfile` in the caller's
      transaction
- [ ] T026 [P] [US4] Unit test `ComplianceStatusService.recompute()`:
      - all 3 months verified → `compliant`
      - 2 verified + 1 missing → `non_compliant`
      - 2 submitted + 1 verified (none missing) → `partially_compliant`
      - new contractor, no records → `non_compliant`
      - `src/partners/compliance/compliance-status.service.spec.ts`
- [ ] T027 [US4] Implement `ComplianceService` in
      `src/partners/compliance/compliance.service.ts`: `create` (status auto-derive, call
      `recompute()` in same Prisma transaction), `update` (re-derive status, re-`recompute()`;
      → 409 if verified), `verify` (→ 409 if not submitted; set verifiedBy + verifiedAt;
      re-`recompute()`; audit-log)
- [ ] T028 [US4] Implement `ComplianceController` in
      `src/partners/compliance/compliance.controller.ts`: 4 endpoints,
      `@RequirePermission(Permission.CONTRACTORS)`
- [ ] T029 [US4] E2e test: create → partial; add ESIC → submitted; verify → 200 + audit entry;
      patch after verify → 409 — `test/partners.e2e-spec.ts`

**Checkpoint**: Compliance recording + status recompute fully functional.

---

## Phase 6: User Story 5 — RAG Matrix (Priority: P2)

**Goal**: On-demand compliance matrix for a selected FY; active-only contractors; future months
→ gray.

**Independent Test**: Seed 2 contractors with mixed history; call `GET /partners/rag?fy=2025-26`;
verify correct statuses, future months = gray, inactive contractor excluded.

### Implementation for User Story 5

- [ ] T030 [P] [US5] Implement `RagService` in `src/partners/rag/rag.service.ts`:
      `buildMatrix(companyId, fy)` — parse FY string to Apr–Mar date range; single batched
      query for all compliance records in range for active-vendor contractors; build
      `RagMatrixResponse` with future-month gray logic (research.md §4); include `complianceId`
      per cell (null for gray/missing)
- [ ] T031 [P] [US5] Unit test `RagService.buildMatrix()`:
      - verified record → `verified` cell
      - future month → `gray` regardless of record presence
      - inactive vendor's contractor → excluded from rows
      - missing record for past month → `missing` cell
      - `src/partners/rag/rag.service.spec.ts`
- [ ] T032 [US5] Implement `RagController` in `src/partners/rag/rag.controller.ts`:
      `GET /partners/rag?fy=`, `@RequirePermission(Permission.CONTRACTORS)`

**Checkpoint**: RAG Matrix endpoint functional and unit tested.

---

## Phase 7: User Story 6 — BOCW Cess (Priority: P3)

**Goal**: On-demand BOCW cess list from ProjectsService + SettingsService, payment recording,
balance/status derivation.

**Independent Test**: Call GET /partners/bocw → cess liability = contractValue × 0.01; record
payment; verify balance recomputes.

### Implementation for User Story 6

- [ ] T033 [P] [US6] Create BOCW DTOs in `src/partners/bocw/dto/`:
      `create-bocw-payment.dto.ts` with `amountPaid`, `paymentDate`, `referenceNumber`, `remarks?`
- [ ] T034 [P] [US6] Implement `BOCWService` in `src/partners/bocw/bocw.service.ts`:
      `list(companyId)` — calls `ProjectsService.getProjectsWithContractValues(companyId)` stub
      + `SettingsService.getBocwCessRate(companyId)`, joins with `BOCWPayment` aggregates,
      computes liability/balance/status per project, populates `unavailableModules` on stub failure;
      `recordPayment` (create `BOCWPayment`, audit-log)
- [ ] T035 [P] [US6] Unit test `BOCWService`: liability = contractValue × rate; status
      transitions (pending/partial/paid); `unavailableModules` populated when ProjectsService
      throws — `src/partners/bocw/bocw.service.spec.ts`
- [ ] T036 [US6] Implement `BOCWController` in `src/partners/bocw/bocw.controller.ts`:
      `GET /partners/bocw`, `POST /partners/bocw/:projectId/payments`,
      `GET /partners/bocw/:projectId/payments`, `@RequirePermission(Permission.BOCW)`;
      `recordPayment` in `BOCWService` audit-logs with `BOCW_PAYMENT` entity type — H-001 remediation
- [ ] T037 [US6] E2e test: record BOCW payment → balance updates; partial → paid transition
      — `test/partners.e2e-spec.ts`

**Checkpoint**: BOCW cess recording and balance tracking functional.

---

## Phase 8: User Story 7 — Subcontractor Cost Service (Priority: P3)

**Goal**: Export `getSubcontractorCostByProject()` as a real (stub-wrapping) implementation
callable by `ProjectsModule` P&L without circular dependency.

**Independent Test**: Call `PartnersService.getSubcontractorCostByProject(projectId, range)`
from a test; verify returns 0 (stub); verify app boots with `ProjectsModule` injecting
`PartnersService` without circular dependency error.

### Implementation for User Story 7

- [ ] T038 [US7] Replace the Phase 1 stub in `src/partners/partners.service.ts` with a real
      implementation that calls `ProjectsService.getWorkOrderTotalByProject(projectId, dateRange)`
      — which is itself a stub (TODO(008)); add `TODO(008)` comment
- [ ] T039 [US7] Export `PartnersService` from `PartnersModule`; ensure `ProjectsModule` can
      import and inject it — verify no `@nestjs/core` circular dependency warning on app boot
      (use `forwardRef()` if needed)

**Checkpoint**: All 7 user stories implemented.

---

## Phase 9: Compliance Cron Job

- [ ] T040 Implement `ComplianceCheckCron` in
      `src/partners/cron/compliance-check.cron.ts`:
      `@Cron('0 8 1-5 * *')` job — queries last completed calendar month, finds all active
      contractors with no `MonthlyCompliance` record for that month, emits
      `compliance.missing` events typed as `ComplianceMissingEvent` (T010a) via `EventEmitter2`
      per missing contractor — spec FR-010, research.md §8, H-003 remediation

---

## Phase 10: Polish & Cross-Cutting

- [ ] T041 [P] Add Swagger `@ApiTags('Partners')` + `@ApiOperation` to all 6 controllers
- [ ] T042 [P] `npm run lint` and fix issues — Constitution dev workflow gate
- [ ] T043 [P] `npm run build` (tsc typecheck) and fix issues
- [ ] T044 [P] Add `TODO(008): implement getProjectsWithContractValues()` in `BOCWService`
      and `TODO(008): implement getWorkOrderTotalByProject()` in `PartnersService`
      — plan.md TODO section

---

## Dependencies

```
Phase 1 (Schema) ──┬── US1 (Categories) ──┐
                   ├── US2 (Vendors)       │
                   └─ ──────────────────── US3 (Contractors) ──┐
                                                                 ├── US4 (Compliance) ── US5 (RAG)
                                                                 └── US7 (Subcontractor Cost)
Phase 1 ────────── US6 (BOCW) [independent of US1–US5]
Phase 9 (Cron) [depends on US4 — compliance records must exist]
```

US1 and US2 are fully independent of each other. US3 requires a Vendor (US2) to exist.
US4 requires a ContractorProfile (US3). US5 requires compliance data (US4). US6 requires
only Phase 1 schema (no dependency on US1–US5). US7 wraps a stub — no hard dependency.

## Parallel execution opportunities

- T011, T012 and T015, T016 can run in parallel (categories vs vendors — independent files)
- T020, T021 and T024, T025, T026 can run in parallel (contractors vs compliance DTOs/services)
- T030, T031 and T033, T034, T035 can run in parallel (RAG vs BOCW — independent sub-modules)
- T041–T044 (Phase 10 polish) are all independent

## Implementation Strategy

**MVP (Phase 1–3, US1–US2)**: Schema, vendor categories, and vendor CRUD. Unblocks Inventory and
Machinery modules that need the vendor dropdown.

**Increment 2 (Phase 4–6, US3–US5)**: Contractor vault, compliance, RAG Matrix — the compliance
monitoring workflow.

**Increment 3 (Phase 7–9, US6–US7 + cron)**: BOCW cess, subcontractor cost service, cron job.
