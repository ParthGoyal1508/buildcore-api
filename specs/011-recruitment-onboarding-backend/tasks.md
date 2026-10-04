---

description: "Task list for feature implementation"
---

# Tasks: Recruitment & Onboarding Backend

**Input**: Design documents from `/specs/011-recruitment-onboarding-backend/`
**Tests**: Included for the candidate stage machine, offer salary-breakup reconciliation, letter
token substitution, time-to-hire and attrition computation, and PII masking — business-rule-heavy
logic requiring unit coverage. The joining transaction requires an atomicity e2e test.

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: Setup

- [X] T001 [P] Extend `src/settings/permission.enum.ts`: `RECRUITMENT`, `RECRUITMENT_APPROVE`
      only — reuse the existing `EMPLOYEES` and `REPORTS` values verbatim (spec FR-031)
- [X] T002 Add the 11 `recruitment` models and the 2 `settings` reference-data models (KitItem,
      LetterTemplate) to `prisma/schema.prisma` — data-model.md
- [X] T003 Generate and apply migration(s); add RLS policies for all 13 tables; add the partial
      unique index enforcing one active LetterTemplate per (companyId, letterType) — spec FR-021
- [X] T004 [P] Extend `shared.AuditLogEntry.entityType` with `REQUISITION`, `CANDIDATE`,
      `INTERVIEW`, `OFFER`, `ONBOARDING_ITEM`, `LETTER`, `RESIGNATION` (spec FR-032)
- [X] T005 Scaffold `RecruitmentModule` in `src/recruitment/recruitment.module.ts`; export
      `RecruitmentService` with stubs `getAcceptedResignation(employeeId)` returning null and
      `generateLetter(employeeId, letterType)` returning null — 005 FR-065 depends on both
- [X] T006 [P] Extend Settings' code-series service with a `REQUISITION` series type (spec FR-002)
- [X] T007 [P] Scaffold `src/settings/recruitment-masters/` with `KitItemsService` and
      `LetterTemplatesService` (`settings` schema, exported for `RecruitmentModule` — Principle I)

**Checkpoint**: Schema, permissions, masters, and the two exported stubs 005 waits on are ready.

---

## Phase 2: US1 — Requisitions (Priority: P1)

- [X] T008 [US1] `RequisitionService` in `src/recruitment/requisitions/requisition.service.ts`:
      CRUD, code generation via T006, submit/approve/reject state machine, delete guard → 409 when
      candidates exist
- [X] T009 [US1] Implement `filledPositions` accounting: auto-close at
      `filledPositions == positionCount`; release a position on no-show (spec FR-014)
- [X] T010 [US1] `RequisitionController` with `@RequirePermission(RECRUITMENT)`; approve/reject
      gated by `RECRUITMENT_APPROVE`
- [ ] T011 [P] [US1] Unit test: position-count arithmetic, auto-close, no-show release
- [ ] T012 [P] [US1] E2e test: draft → submit → approve accepts candidates; reject without a
      reason → 400; delete with candidates → 409

**Checkpoint**: Open Positions is independently usable.

---

## Phase 3: US2 & US3 — Candidates & Interviews (Priority: P1)

- [X] T013 [US2] `CandidateService` in `src/recruitment/candidates/candidate.service.ts`: create
      only against an `open` requisition → 409 otherwise (spec FR-003); duplicate phone/email guard
      among non-rejected/non-no-show → 409 (spec FR-007)
- [X] T014 [US2] Implement the stage machine as a single guarded transition method taking a
      row-level lock, writing an immutable `CandidateStageHistory` row per transition and rejecting
      out-of-machine transitions with the permitted next stages named (spec FR-004, FR-005, FR-034)
- [X] T015 [US2] PII masking on every list response; unmasked single-candidate detail with the
      access audit-logged (spec FR-006, FR-032)
- [X] T016 [P] [US2] Resume upload to encrypted object storage; refuse production start on
      local-filesystem blobs (spec FR-024)
- [X] T017 [US2] `noShow` flag derived once the confirmed joining date passes the configured grace
      window, without auto-changing the stage (spec FR-035)
- [X] T018 [US3] `InterviewService` in `src/recruitment/interviews/interview.service.ts`: schedule
      with round-number uniqueness → 409, reschedule retaining history and incrementing
      `rescheduleCount`, overdue flagging
- [X] T019 [US3] Per-interviewer `InterviewFeedback`; accept only from an assigned interviewer or a
      `RECRUITMENT` holder → 403 otherwise (spec FR-009)
- [X] T020 [US3] Block advance to `selected` while any scheduled round is incomplete, naming the
      pending rounds (spec FR-008)
- [X] T021 [US2/US3] `CandidateController` and `InterviewController` with permission guards
- [ ] T022 [P] [US2] Unit test: every permitted and rejected stage transition; masking across all
      list endpoints; duplicate detection
- [ ] T023 [P] [US3] Unit test: incomplete-round gate; feedback authorisation
- [ ] T024 [P] [US2] E2e test: concurrent stage transitions — exactly one succeeds, the loser gets
      409 reporting the current stage

**Checkpoint**: The pipeline (Interviews / Selected views) works end to end.

---

## Phase 4: US4 — Offers (Priority: P1)

- [X] T025 [US4] `OfferService` in `src/recruitment/offers/offer.service.ts`: salary-breakup sum
      reconciliation against `offeredCtc / 12` within the configured tolerance → 400 reporting the
      difference (spec FR-010)
- [X] T026 [US4] `outsideBudget` flag against the requisition's `budgetedCtcMax`, requiring
      `RECRUITMENT_APPROVE` to reach `issued` (spec FR-011)
- [X] T027 [US4] Accept/decline transitions advancing the candidate stage; immutability once
      accepted → 409; supersession so at most one offer is active (spec FR-012)
- [X] T028 [US4] `OfferController` with permission guards
- [ ] T029 [P] [US4] Unit test: breakup tolerance, outside-budget detection, supersession
- [ ] T030 [P] [US4] E2e test: edit an accepted offer → 409; a second offer supersedes the first

**Checkpoint**: Offers issue and accept; candidates reach Joining Pending.

---

## Phase 5: US5 & US6 — Joining & Onboarding (Priority: P1, P2)

- [X] T031 [US5] `JoiningService`: one transaction creating `hr.Employee` via `HrService`, setting
      `candidate.employeeId`, advancing the stage, incrementing `filledPositions`, and opening the
      onboarding checklist — no partial joining observable (spec FR-013)
- [X] T032 [US5] Employee code from Settings' existing `{CompanyShortCode}-{sequence}` series
      (002 FR-023) — no second numbering scheme
- [X] T033 [US5] `delayedJoining` flag and `mark-no-show` endpoint releasing the requisition
      position and audit-logging the event
- [X] T034 [US6] `OnboardingService`: seed the checklist with one item per mandatory Document Type
      (002 FR-019) and one per default kit item (spec FR-015)
- [X] T035 [US6] Document verification storing through 005's existing employee-document surface
      with the Document Type's number-format validation → 400 (spec FR-016)
- [X] T036 [US6] Kit issue: record an `InventoryService` issue and store `linkedIssueId` when the
      kit item names an inventory item; otherwise a non-stock issuance with no inventory movement
      (spec FR-018)
- [X] T037 [US6] Waive requiring `RECRUITMENT_APPROVE` and a non-empty reason; completion when all
      mandatory items are completed or waived (spec FR-019)
- [X] T038 [US6] Assert no second attendance gate is added — 002 FR-021 remains the only one
      (spec FR-017)
- [X] T039 [US5/US6] `JoiningController` and `OnboardingController` with permission guards
- [ ] T040 [P] [US5] E2e test: forced mid-transaction failure leaves no partial Employee (spec
      FR-013)
- [ ] T041 [P] [US6] Unit test: checklist seeding; completion semantics with waivers

**Checkpoint**: A candidate becomes an employee that feature 005 can administer (SC-006).

---

## Phase 6: US7 — Letters (Priority: P2)

- [X] T042 [US7] `LetterTemplatesService` (T007): token-set validation at save → 400 naming unknown
      tokens (spec FR-020); activation atomically deactivating the prior active template of that
      type (spec FR-021)
- [X] T043 [US7] `LetterService`: render with token substitution → `pdfkit` → encrypted
      object-storage reference; immutable once issued; regeneration creates the next version and
      supersedes the prior, both remaining downloadable (spec FR-022)
- [X] T044 [US7] Relieving-letter guard: reject until the employee's F&F run is processed → 409
      (spec FR-023, 005 FR-033)
- [X] T045 [US7] Replace the T005 `generateLetter()` stub so 005 FR-065 can call it
- [X] T046 [US7] Download endpoint streaming the PDF with the access audit-logged
- [ ] T047 [P] [US7] Unit test: substitution, unknown-token rejection, versioning, relieving guard
- [ ] T048 [P] [US7] E2e test: generate → regenerate → v2 current with v1 still downloadable

**Checkpoint**: Offer, appointment, and relieving letters generate (SC-003).

---

## Phase 7: US8 — Resignations (Priority: P2)

- [X] T049 [US8] `ResignationService`: create with computed `expectedLastWorkingDay`; reject for an
      inactive employee and for a second open resignation → 409 (spec FR-026)
- [X] T050 [US8] Accept with optional `agreedLastWorkingDay` requiring waiver days and a reason
      when earlier than expected; withdraw before the last working day
- [X] T051 [US8] Replace the T005 `getAcceptedResignation()` stub so 005 FR-065 sources its
      last-working-day here rather than re-collecting it
- [X] T052 [US8] `ResignationController` with permission guards
- [ ] T053 [P] [US8] Unit test: last-working-day computation, waiver, inactive rejection

**Checkpoint**: 005's exit flow can consume resignations.

---

## Phase 8: US9 — Reports (Priority: P3)

- [X] T054 [US9] `RecruitmentReportsService`: new-joinings report (spec US9 scenario 1)
- [X] T055 [US9] Funnel report — stage counts, consecutive-stage conversion, per-source breakdown,
      and `averageTimeToHireDays` computed from stage history, never record-creation timestamps
      (spec FR-028)
- [X] T056 [US9] Resignation report — tenure in months, reason-category aggregates, and period
      attrition rate as separations over average active headcount (spec FR-027); `settlementPending`
      flag
- [ ] T057 [US9] XLSX/PDF export via the existing libraries; async via bullmq above the configured
      row threshold (spec FR-029); `REPORTS` permission on every report endpoint
- [X] T058 [P] [US9] Unit test: funnel conversion math, attrition rate, time-to-hire
- [ ] T059 [P] [US9] E2e test: the resignation report reconciles with 005's exit records (SC-007)

---

## Phase 9: Polish

- [X] T060 [P] Swagger `@ApiTags('Recruitment')` + `@ApiOperation` on all controllers
- [X] T061 [P] Verify soft-delete on requisitions, candidates, offers, resignations (spec FR-036)
- [X] T062 Confirm typed DTOs on every endpoint (spec FR-033); `npm run lint` + `npm run build`
      clean

## Dependencies

```
Phase 1 → US1 (Requisitions)
        → US2 (Candidates) → US3 (Interviews) → US4 (Offers) → US5 (Joining) → US6 (Onboarding)
        → US7 (Letters — needs US5 for appointment, 005's F&F for relieving)
        → US8 (Resignations — independent of the funnel; 005 FR-065 depends on it)
        → US9 (Reports — needs US2/US5/US8)

External: 005 FR-065 blocks on T045 + T051. 004's Department Dashboard reads Open Positions (T008).
```

## Implementation Strategy

**MVP (Phases 1–5, US1–US6)**: the full funnel through to an administrable Employee. This is the
gap the matrix actually names and delivers value on its own.
**Increment 2 (Phases 6–7, US7–US8)**: letters and resignations — also unblocks 005's amendment.
**Increment 3 (Phase 8, US9)**: reporting and analytics.

---

## Reconciliation, 2026-10-04 — read against the code, task by task

**This feature shipped and nothing was ever ticked off.** All 62 tasks were open against a
`src/recruitment/` holding eleven services, nine controllers and the requisition, candidate,
interview, offer, joining, onboarding, letter, resignation and reports flows. **48 are now closed
and 14 remain open — every one of them a test.**

Done to the standard asked for: open the code each task names and confirm the behaviour, not the
filename. Where the code did the thing somewhere else, it is ticked and the place is named. Where a
task had two halves and only one was built, it stayed open with the reason.

### Four tasks were built somewhere other than where they said

- **T007** — `KitItemsService` and `LetterTemplatesService` live in `src/settings/kit-items/` and
  `src/settings/letter-templates/`, not `src/settings/recruitment-masters/`. Same services, same
  schema, exported the same way.
- **T033** — `mark-no-show` is `@Patch(':id/mark-no-show')` on the **candidate** controller rather
  than the joining one. It releases the requisition position through `releasePositionInTx` and
  audit-logs the event, which is what the task asked for.
- **T009** — the position accounting is in `RequisitionService` (`incrementFilledInTx`,
  `releasePositionInTx`), called by joining inside its transaction rather than implemented there.
- **T003** — the partial unique index is exactly as specified and easy to miss:
  `CREATE UNIQUE INDEX "LetterTemplate_companyId_letterType_active_key" ... WHERE "isActive"`.

### The finding worth more than the 48 ticks

**The feature is built and essentially untested.** Six spec files exist and every one tests a
**pure function** — stage-transition legality, token substitution, salary-breakup arithmetic, funnel
and attrition metrics. Searched for the distinctive term of every guarded behaviour in the
services. `filledPositions`, `autoClose`, `noShow`, `feedback`, `checklist`, `waive`,
`lastWorkingDay`, `supersed`, `outsideBudget`, `mask` — **not one appears in any spec file.**

So the arithmetic is covered and the **rules are not**: position accounting and auto-close, the
incomplete-round gate, interviewer feedback authorisation, checklist seeding and waiver completion,
offer supersession, outside-budget detection, last-working-day computation, and PII masking across
every list endpoint. These are the parts where a defect is silent — a masking gap discloses an
Aadhaar number, a supersession gap leaves two live offers — and they are exactly the parts with no
test.

There is also **no recruitment end-to-end suite at all**: T012, T024, T030, T040, T048 and T059 have
nothing to be ticked against, including T024's concurrent-stage-transition test, which is the one
that proves the row-level lock does what T014 claims.

### Still open: 14 tasks, every one a test, plus one real gap

- **6 e2e** — T012, T024, T030, T040, T048, T059. No suite exists.
- **5 unit** — T011, T023, T041, T053, and T022/T029/T047 partially: each has a half the existing
  specs do cover, so they are left open rather than ticked on their covered half. T022's masking
  and duplicate detection, T029's supersession and outside-budget, T047's versioning and relieving
  guard.
- **T057 is a genuine gap, not a test.** The reports service has **no export at all** — no xlsx, no
  pdf, nothing. Its bullmq half is superseded by the same in-process decision recorded for feature
  004, but the export itself was never built, and `REPORTS` permission on every report endpoint
  needs checking with it.
