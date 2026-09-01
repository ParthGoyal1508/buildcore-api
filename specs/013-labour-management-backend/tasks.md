---

description: "Task list for feature implementation"
---

# Tasks: Labour Management Backend

**Input**: Design documents from `/specs/013-labour-management-backend/`
**Tests**: Included for effective-dated rate resolution, gross wage computation, advance-recovery
capping, denomination breakup, and geofence distance. Concurrency e2e tests are required for muster
submission and the worker-at-two-sites guard.

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: Setup & Migration from 005

- [ ] T001 [P] Extend `src/settings/permission.enum.ts`: `LABOUR_APPROVE` only — reuse the
      already-existing `DAILY_WORKER_REGISTRY` and `REPORTS` values verbatim (spec FR-038)
- [ ] T002 Add the 9 `labour` models and `settings.SkillCategory` to `prisma/schema.prisma` —
      data-model.md
- [ ] T003 Generate and apply migration(s); add RLS policies for all 10 tables; add the DB
      constraint enforcing one submitted/approved muster per `(siteId, date)` (spec FR-016) and the
      partial unique index enforcing single active gang membership (spec FR-012)
- [ ] T004 **Data migration**: move existing `hr.DailyWorker` rows and their attendance into
      `labour.LabourWorker` / `labour.MusterLine`, then drop the `hr` tables — the supersession of
      005 US9 / FR-023 to FR-028 ratified 2026-09-01. Coordinate with 005's Phase A1 so the move
      happens exactly once
- [ ] T005 [P] Extend `shared.AuditLogEntry.entityType` with `LABOUR_WORKER`, `LABOUR_GANG`,
      `WAGE_RATE`, `MUSTER_ROLL`, `LABOUR_PAYMENT_SHEET`, `LABOUR_ADVANCE` (spec FR-039)
- [ ] T006 Scaffold `LabourModule` in `src/labour/labour.module.ts`; export `LabourService` with a
      stub `getLabourCostByProject()` returning 0 — 008's P&L depends on it
- [ ] T007 [P] Add the company-level labour wage cycle setting (weekly default — spec FR-041);
      **read** 005's existing OT multiplier (005 FR-014a), never define a second (spec FR-049)
- [ ] T008 [P] Scaffold `src/settings/skill-categories/` with `SkillCategoriesService`
      (`settings` schema, exported — Principle I)

**Checkpoint**: Schema, permissions, the 005 migration, and the P&L stub are ready.

---

## Phase 2: US1 — Masters & Wage Rates (Priority: P1)

- [ ] T009 [P] [US1] `SkillCategoriesService` (T008): CRUD, delete guard → 409 when workers
      reference it
- [ ] T010 [US1] `WageRateService` in `src/labour/wage-rates/wage-rate.service.ts`: effective-dated
      append automatically closing the prior open-ended rate's `effectiveTo` to the day before the
      new `effectiveFrom` (spec FR-004) — the same pattern 006 FR-014 uses
- [ ] T011 [US1] Reject backdating before an existing rate's `effectiveFrom` → 400; reject edits to
      a rate that has already priced an approved muster → 409 (spec FR-005)
- [ ] T012 [US1] Implement `resolveRate(workerId, projectId, date)`: worker `rateOverride` first,
      then the project + skill-category rate in force on that date, recording which source was used
      (spec FR-006)
- [ ] T013 [US1] `WageRateController` with `@RequirePermission(DAILY_WORKER_REGISTRY)`;
      `GET /labour/wage-rates?asOf=` returning rates in force
- [ ] T014 [P] [US1] Unit test: non-overlap invariant, historical resolution, override precedence,
      and that a missing rate raises rather than costing zero (spec FR-007)
- [ ] T015 [P] [US1] E2e test: two sequential rates — a mid-period date resolves to the correct one

**Checkpoint**: "Labour Wages Creation Per Project" (matrix row 15) exists.

---

## Phase 3: US2 — Workers, Contractors & Gangs (Priority: P1)

- [ ] T016 [US2] `LabourWorkerService`: create with `labourCode` generation; `engagementType`
      guard requiring `contractorId` when contractor → 400 (spec FR-008); contractor resolved via
      `PartnersService`, rejecting an inactive contractor → 400 (spec FR-034)
- [ ] T017 [US2] Aadhaar uniqueness among active workers → 409 (spec FR-010); PII masking on every
      list response with unmasked detail reads audit-logged (spec FR-009, FR-039)
- [ ] T018 [US2] Wire face enrolment to feature 003's **existing** enrolment and face-match
      services — no reimplementation (spec FR-011)
- [ ] T019 [US2] Deactivation with `lastWorkingDate`, gang removal, exclusion from future musters,
      and a `settlementPending` flag when payment lines are unsettled
- [ ] T020 [US2] `GangService`: create with members; single active gang membership → 409
      (spec FR-012)
- [ ] T021 [US2] Controllers with permission guards
- [ ] T022 [P] [US2] Unit test: masking, engagement-type validation, single-gang invariant
- [ ] T023 [P] [US2] E2e test: contractor worker rejects an inactive contractor

---

## Phase 4: US3 — Supervisor Muster Capture (Priority: P1)

- [ ] T024 [US3] `MusterService`: open a session validating GPS against the site geofence resolved
      via `ProjectsService`; **record and flag** `geofenceViolation` / `lowGpsAccuracy` rather than
      rejecting (spec FR-013) — matching how 003 FR-007 treats out-of-fence punches
- [ ] T025 [US3] Add lines with a captured photo to encrypted object storage and an **advisory**
      face-match result — a below-threshold match is flagged `faceMatchLow`, never blocked
      (spec FR-014, FR-015; ratified 2026-09-01)
- [ ] T026 [US3] Validate per line: worker active at that site on that date → 400;
      `overtime_only` without `overtimeHours` → 400; snapshot `skillCategoryIdOnDay`
- [ ] T027 [US3] Gang bulk-add creating a line per active member, each still requiring its own
      photo before submission
- [ ] T028 [US3] Enforce one muster per site per date in the transaction **and** by the T003 DB
      constraint, under a row-level lock (spec FR-016, FR-035); reject a worker already on another
      site's muster that date → 409 (spec FR-017)
- [ ] T029 [US3] Accept offline-synced musters retaining both `capturedAt` and `receivedAt`
      (spec FR-018); reject dates outside the backdating window → 400 (spec FR-019)
- [ ] T030 [US3] Apply the company-timezone date basis from 003 FR-018a everywhere (spec FR-021)
- [ ] T031 [US3] Submit freezing lines; `MusterController` with permission guards
- [ ] T032 [P] [US3] Unit test: geofence distance, accuracy flagging, attendance-type validation
- [ ] T033 [P] [US3] E2e test: concurrent musters for the same site+date — exactly one succeeds
- [ ] T034 [P] [US3] E2e test: the same worker on two sites the same date → 409 naming the other
      site (SC-007)

**Checkpoint**: The matrix's headline item (row 11) works — supervisor GPS + photo + geofence
capture.

---

## Phase 5: US4 — Muster Approval (Priority: P1)

- [ ] T035 [US4] Approve requiring `LABOUR_APPROVE` for any flagged muster → 403 otherwise;
      approved musters become eligible for payment sheets
- [ ] T036 [US4] Return-to-draft with a reason re-opening lines and notifying the supervisor;
      immutability after approval → 409 (spec FR-020); un-approval blocked once included in an
      approved sheet → 409
- [ ] T037 [US4] Approval queue listing flag counts, supervisor, and line count, oldest first
- [ ] T038 [P] [US4] Unit test: flagged-muster permission requirement, immutability guards
- [ ] T039 [P] [US4] E2e test: approve → include in sheet → un-approve rejected with 409

---

## Phase 6: US5 & US7 — Payment Sheets & Advances (Priority: P1, P2)

- [ ] T040 [US7] `LabourAdvanceService`: create with computed instalment; `exceedsLimit` flag
      requiring `LABOUR_APPROVE`; approve and disburse setting `outstandingBalance`
- [ ] T041 [US7] `outstandingBalance` reduced **only on disbursement** of the recovering sheet
      line, never on sheet generation (spec FR-025); `recoveryAtRisk` flag on deactivated workers
- [ ] T042 [US5] `PaymentSheetService`: generate from approved musters in the period; gross wage
      per spec FR-022 using `resolveRate()` (T012) and 005's existing OT multiplier (spec FR-049)
- [ ] T043 [US5] Fail generation with 409 naming the project, skill category, and date when any
      worked date has no applicable rate — never cost it at zero (spec FR-007)
- [ ] T044 [US5] Overlapping sheet guard per `(projectId, engagementType, period)` → 409
      (spec FR-023); advance deduction capped so net payable is never negative with the remainder
      carried forward (spec FR-024)
- [ ] T045 [US5] Approve freezing every figure (spec FR-026); reopen requiring `LABOUR_APPROVE`,
      blocked once any line is disbursed, releasing the musters when it succeeds
- [ ] T046 [US5] `DenominationService`: minimal note-count breakup for direct sheets with per-worker
      residual reported and carried forward (spec FR-027); contractor sheets grouped by contractor
      with **no** breakup (spec FR-028)
- [ ] T047 [US5] XLSX/PDF export of the sheet via the existing libraries
- [ ] T048 [US5/US7] Controllers with permission guards
- [ ] T049 [P] [US5] Unit test: gross wage across attendance types and OT; capping order; missing
      rate failure
- [ ] T050 [P] [US5] Unit test: denomination minimisation and residual carry-forward; contractor
      grouping
- [ ] T051 [P] [US5] E2e test: generate → approve → figures immutable; reopen blocked after a
      disbursement

**Checkpoint**: "Payment Sheet" and "Labour Payment Sheet Per Project Cash" (matrix rows 12, 18)
exist (SC-003).

---

## Phase 7: US6 — Disbursement (Priority: P2)

- [ ] T052 [US6] Disburse a line: cash requiring an acknowledgement image to encrypted object
      storage → 400 otherwise (spec FR-029); bank requiring a recorded account → 400 otherwise
- [ ] T053 [US6] Short payment rejected unless a `shortPaymentReason` is supplied, then carried
      forward as an unpaid balance (spec FR-030); apply the line's advance recovery to the
      advance's outstanding balance
- [ ] T054 [US6] Sheet totals (`disbursedCount`, `pendingCount`, `disbursedAmount`,
      `outstandingAmount`); closure when every line settles; `disbursementOverdue` ageing flag
- [ ] T055 [US6] Reversal requiring `LABOUR_APPROVE` and a reason, reversing the advance recovery,
      both audit-logged; blocked on a closed sheet without reopening (spec FR-031)
- [ ] T056 [P] [US6] Unit test: cash-without-acknowledgement rejection, short-payment carry-forward,
      reversal
- [ ] T057 [P] [US6] E2e test: partial disbursement → correct outstanding totals → closure
      (SC-005)

---

## Phase 8: US8 — Reports & P&L Method (Priority: P3)

- [ ] T058 [US8] `LabourReportsService`: deployment report grouped by skill / site / contractor with
      headcount and man-days
- [ ] T059 [US8] Attendance report (days present, half days, absent, overtime hours, attendance
      percentage) and the payment register — the labour equivalent of a salary register
- [ ] T060 [US8] Replace the T006 stub: `getLabourCostByProject()` — approved-muster gross wage
      split by engagement type, **reporting the count of unapproved musters excluded** so the P&L
      consumer can flag incompleteness (spec FR-033)
- [ ] T061 [US8] XLSX/PDF export, async via bullmq above the configured row threshold (spec FR-042);
      `REPORTS` permission on every report endpoint
- [ ] T062 [P] [US8] Unit test: the cost method excludes unapproved musters and reports the count
- [ ] T063 [P] [US8] E2e test: the cost method matches a manually recomputed sheet total (SC-008)

---

## Phase 9: Polish

- [ ] T064 [P] Swagger `@ApiTags('Labour')` + `@ApiOperation` on all controllers
- [ ] T065 [P] Verify soft-delete on workers, musters, sheets, advances (spec FR-036)
- [ ] T066 Confirm **no labour figure reaches any `PayrollRun`** (spec FR-032 / 005 FR-048)
- [ ] T067 Confirm typed DTOs on every endpoint (spec FR-040); `npm run lint` + `npm run build`
      clean

## Dependencies

```
Phase 1 (incl. the 005 data migration) → US1 (Wage Rates) → US5 (Payment Sheets)
                                       → US2 (Workers/Gangs) → US3 (Muster Capture)
                                                             → US4 (Approval) → US5
                                       → US7 (Advances) → US5 (deduction lines)
                                                        → US6 (Disbursement)
                                       → US8 (Reports/P&L — needs US4 + US5)

External: 008's P&L blocks on T060. 005's Phase A1 must coordinate with T004 (single migration).
003's biometric services are a read dependency (T018).
```

## Implementation Strategy

**MVP (Phases 1–5, US1–US4)**: wage rates, workers, supervisor muster capture, and approval. This
is the daily site operation and the matrix's headline gap.
**Increment 2 (Phases 6–7, US5–US7)**: payment sheets, advances, and disbursement — the financial
output.
**Increment 3 (Phase 8, US8)**: reporting and P&L integration.
