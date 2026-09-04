# Implementation Plan: Labour Management Backend

**Branch**: `013-labour-management-backend` | **Date**: 2026-09-01 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/013-labour-management-backend/spec.md`

## Summary

Build the `labour` schema — per-project effective-dated wage rates, labour workers (direct and
contractor-engaged) with gangs, supervisor mobile muster capture with GPS + photo + geofence
validation, muster approval, cash payment sheets with denomination breakup and thumb-impression
acknowledgement, labour advances, and an exported `getLabourCostByProject()` for feature 008's P&L.

**Supersedes feature 005's US9 and FR-023 to FR-028** (ratified 2026-09-01). The `DailyWorker`
entity and its attendance and payout surfaces migrate from `hr` to `labour` and are extended here.
Biometric enrolment and face-match machinery is reused from feature 003 unchanged.

**Created by the 2026-09-01 gap-closure pass** against the module/submodule matrix rows 11, 12, 15,
and 18.

## Technical Context

**Language/Version**: TypeScript 5.1, Node.js, NestJS 10, Prisma 5 — unchanged.

**Primary Dependencies**: Existing only — feature 003's biometric enrolment/face-match services
(reused, not reimplemented — FR-011), `exceljs`/`pdfkit` (payment sheet and report export),
`@nestjs/bullmq` (async export above threshold).

**Storage**: `labour` schema (9 tables); `settings` schema gains 1 reference-data table
(SkillCategory — FR-003). Migration moves `hr.DailyWorker` data into `labour.LabourWorker`.

**Testing**: Jest unit tests for effective-dated rate resolution (non-overlap invariant, override
precedence), gross wage computation (day fraction + OT using 005's existing multiplier), advance
recovery capping (net never negative — FR-024), denomination breakup minimising note count with
residual carry-forward (FR-027), geofence distance computation. E2e in `test/labour.e2e-spec.ts` for
muster capture → approval → payment sheet → disbursement, and the concurrent-muster and
worker-at-two-sites guards.

**Performance Goals**: A full site's muster (up to ~200 workers) submittable in one session.

**Constraints**: Face match is advisory, never blocking (ratified 2026-09-01 — FR-014). Labour cost
never enters a `PayrollRun` (FR-032, 005 FR-048).

**Scale/Scope**: 8 user stories, 42 FRs, 9 entities.

## Constitution Check

| Principle | Check | Status |
|---|---|---|
| I. Schema Boundaries | 9 tables in `labour`; 1 reference-data master in `settings` (FR-003). Site/project via `ProjectsService`, contractor via `PartnersService` — no cross-schema query (FR-034). 008 reads labour cost only through the exported method (FR-033). Biometrics reused from 003's services. | PASS |
| II. Validated DTOs | Every endpoint uses typed DTOs (FR-040). | PASS |
| III. No Hardcoded Values | Wage cycle, GPS accuracy limit, face-match threshold, backdating window, advance limit multiple, standard hours, OT multiplier (005's existing setting — FR-049), and cash denominations are all company-configured. | PASS |
| IV. Multi-Tenant Isolation | All 10 tables carry `companyId`; RLS on all (FR-001). Worker PII masked in lists, unmasked reads audit-logged (FR-009, FR-039). | PASS |
| V. Auth & Permissions | Adds exactly 1 enum value — `LABOUR_APPROVE` (FR-038); reuses the already-existing `DAILY_WORKER_REGISTRY` and `REPORTS`. | PASS |
| VI. Safe Migrations | `labour` schema and the `settings` addition ship as separate migrations, plus a data migration moving `hr.DailyWorker` into `labour.LabourWorker`. Encrypted object storage for muster photos and acknowledgement images; production start refused on local-filesystem blobs (FR-015). | PASS |

## Implementation Phases

### Phase 1: Setup & Migration from 005

- [ ] Extend `settings.Permission` enum: `LABOUR_APPROVE` only — reuse the already-existing
      `DAILY_WORKER_REGISTRY` and `REPORTS` values verbatim
- [ ] Add 9 `labour` models and `settings.SkillCategory` to `prisma/schema.prisma` (data-model.md)
- [ ] Generate and apply migration(s); add RLS policies for all 10 tables
- [ ] **Data migration**: move any existing `hr.DailyWorker` rows and their attendance into
      `labour.LabourWorker` / `labour.MusterLine`, then drop the `hr` tables — the supersession
      ratified 2026-09-01
- [ ] Extend `shared.AuditLogEntry.entityType` with `LABOUR_WORKER`, `LABOUR_GANG`, `WAGE_RATE`,
      `MUSTER_ROLL`, `LABOUR_PAYMENT_SHEET`, `LABOUR_ADVANCE`
- [ ] Scaffold `LabourModule`; export `LabourService` with a stub for
      `getLabourCostByProject()` returning 0
- [ ] Add the company-level labour wage cycle setting (FR-041) alongside 005's existing OT
      multiplier — reading, never duplicating, that multiplier (FR-049)

### Phase 2: US1 — Masters & Wage Rates (P1)

- [ ] `src/settings/skill-categories/`: `SkillCategoriesService` (`settings` schema, exported)
- [ ] `WageRateService` + `WageRateController` (effective-dated append with automatic
      `effectiveTo` closure — FR-004, backdating rejection, immutability once it has priced an
      approved muster — FR-005)
- [ ] Implement `resolveRate(workerId, projectId, date)`: override first, then project+skill rate
      in force (FR-006)
- [ ] Unit test: non-overlap invariant; historical date resolution; override precedence; missing
      rate raises rather than costing zero (FR-007)
- [ ] E2e test: two sequential rates — a mid-period date resolves to the correct one

### Phase 3: US2 — Workers, Contractors & Gangs (P1)

- [ ] `LabourWorkerService` + controller (create with engagement-type guard — FR-008, contractor
      resolution via `PartnersService`, Aadhaar uniqueness → 409 — FR-010, PII masking — FR-009,
      deactivation with gang removal)
- [ ] Wire face enrolment to feature 003's existing enrolment service — no reimplementation
      (FR-011)
- [ ] `GangService` + controller (single-gang membership guard → 409 — FR-012)
- [ ] Unit test: masking; engagement-type validation; single-gang invariant
- [ ] E2e test: contractor worker rejects an inactive contractor

### Phase 4: US3 — Supervisor Muster Capture (P1)

- [ ] `MusterService` + `MusterController` (open session with geofence + accuracy validation
      recording rather than rejecting violations — FR-013, line add with photo to encrypted object
      storage and advisory face match — FR-014/FR-015, gang bulk-add, submit freezing lines)
- [ ] Enforce: one muster per site per date in both the transaction and a DB constraint (FR-016);
      worker not on two sites the same date (FR-017); offline-sync timestamps retained (FR-018);
      backdating window (FR-019)
- [ ] Apply the company timezone basis from 003 FR-018a for every date reckoning (FR-021)
- [ ] Unit test: geofence distance; accuracy flag; attendance-type/overtime validation
- [ ] E2e test: concurrent musters for the same site+date — exactly one succeeds (FR-035)

### Phase 5: US4 — Muster Approval (P1)

- [ ] Approval endpoints (approve requiring `LABOUR_APPROVE` for flagged musters, return to draft
      with reason, immutability after approval — FR-020, un-approval blocked once in an approved
      sheet)
- [ ] Approval queue listing with flag counts, oldest first
- [ ] Unit test: flagged-muster permission requirement; immutability guards
- [ ] E2e test: approve → included in sheet → un-approve rejected with 409

### Phase 6: US5 & US7 — Payment Sheets & Advances (P1, P2)

- [ ] `LabourAdvanceService` + controller (approve requiring `LABOUR_APPROVE` above the configured
      limit, disburse, outstanding balance reduced only on sheet-line disbursement — FR-025)
- [ ] `PaymentSheetService` + controller (generate from approved musters with gross wage per
      FR-022, missing-rate failure per FR-007, overlap guard per FR-023, advance deduction capped
      per FR-024, approve freezing figures per FR-026)
- [ ] `DenominationService`: minimal note-count breakup with per-worker residual carry-forward
      (FR-027); contractor sheets grouped by contractor with no breakup (FR-028)
- [ ] Unit test: gross wage across attendance types and OT; capping; denomination minimisation and
      residual; contractor grouping
- [ ] E2e test: generate → approve → figures immutable; reopen blocked once a line is disbursed

### Phase 7: US6 — Disbursement (P2)

- [ ] Disbursement endpoints (cash requiring an acknowledgement image to encrypted object storage
      — FR-029, bank requiring a recorded account, short payment requiring a reason with
      carry-forward — FR-030, reversal requiring `LABOUR_APPROVE` reversing advance recovery —
      FR-031, sheet closure when all lines settle, ageing flag)
- [ ] Unit test: cash-without-acknowledgement rejection; short-payment carry-forward; reversal
- [ ] E2e test: partial disbursement → correct outstanding totals → closure

### Phase 8: US8 — Reports & P&L Method (P3)

- [ ] `LabourReportsService` + controller: deployment (by skill/site/contractor), attendance
      percentage, payment register
- [ ] Replace the stub: `getLabourCostByProject()` — approved-muster gross wage split by engagement
      type, reporting the count of unapproved musters excluded (FR-033)
- [ ] XLSX/PDF export, async above threshold (FR-042)
- [ ] Unit test: cost method excludes unapproved musters and reports the count
- [ ] E2e test: cost method matches a manually recomputed sheet total (SC-008)

### Phase 9: Polish

- [ ] Swagger `@ApiTags('Labour')` + `@ApiOperation` on all controllers
- [ ] Verify soft-delete on workers, musters, sheets, advances (FR-036)
- [ ] Confirm no labour figure reaches any `PayrollRun` (FR-032 / 005 FR-048)
- [ ] `npm run lint` + `npm run build` clean

## Implementation deviations (2026-09-04)

These deltas from the plan above were made during implementation and are recorded
here per the constitution's "update the spec when you change it" rule:

- **No 005 data migration (T004).** Feature 005's Daily Worker registry was never
  implemented — no `DailyWorker` model exists in the schema — so there is nothing to
  migrate or drop. The `labour` schema is created fresh. T004 is therefore a no-op and
  was removed rather than shipped as an empty migration.
- **Synchronous export only.** The codebase has no BullMQ/Redis infrastructure (a
  prior feature explicitly deferred it), so payment-sheet and report export are
  synchronous. The async-above-threshold behaviour (FR-042 / T061) is deferred to when
  queue infrastructure lands; the endpoints and export libraries are wired so it is an
  additive change.
- **Field-policy tunables live in `WorkspaceConfig.labour`, not on `Company`.** The GPS
  accuracy limit (FR-013) and advance limit multiple (US7) are config values
  (`workspace.labour.gpsAccuracyMaxMetres`, `advanceLimitMultiple`), consistent with how
  003's punch tunables are configured. The wage cycle (FR-041) and cash denominations
  (FR-027) are per-company and live on `Company` (`labourWageCycle`,
  `labourCashDenominations`). The OT multiplier is read from 005's existing
  `Company.otMultiplier` (FR-049), never duplicated.
- **Face enrolment reuses 003's machinery, not its table.** 003's `FaceEnrolment` row is
  account/employee-bound and cannot key to a non-account labour worker, so worker
  enrolment reuses the same `BiometricsService`, `ImageProcessingService`, and encrypted
  `StorageService` (the machinery FR-011 requires), storing the serialized descriptor as
  an encrypted blob referenced by `LabourWorker.faceEnrolmentId`. No second biometric
  implementation is introduced.
- **`SkillCategory` endpoints are hosted by the labour module** (route
  `/settings/skill-categories`) while the table and CRUD service live in `settings` and
  are exported — the same split 009 uses for item masters. The deletion-in-use guard is
  enforced by the labour module because only it may count `labour.LabourWorker` rows
  (Principle I).
- **Muster line photo is nullable** so a gang bulk-add (T027) can create lines before
  photos are captured; submission enforces every line has one (FR-010). A composite
  `POST /labour/musters/capture` endpoint opens+marks+submits atomically for the
  frontend's offline-drain replay (FR-018), alongside the incremental
  open/add-line/submit endpoints.

