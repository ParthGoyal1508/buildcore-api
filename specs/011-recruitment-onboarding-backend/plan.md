# Implementation Plan: Recruitment & Onboarding Backend

**Branch**: `011-recruitment-onboarding-backend` | **Date**: 2026-09-01 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/011-recruitment-onboarding-backend/spec.md`

## Summary

Build the `recruitment` schema — the hiring funnel that terminates in the Employee record feature
005 administers. Requisitions (approved, position-counted) → Candidates (stage machine with
immutable history, masked PII) → Interviews (multi-round, per-interviewer feedback) → Offers
(component-validated, budget-checked, immutable once accepted) → Joining (single transaction
creating the Employee, incrementing the requisition, opening the onboarding checklist) → Onboarding
(document verification through 005's existing document surface, kit issue with optional inventory
linkage). Plus a template-driven, versioned, immutable letter-generation service (offer,
appointment, confirmation, relieving, experience) that 005's F&F flow calls for relieving letters,
and the Resignation record that 005's exit flow sources its last-working-day from.

**Created by the 2026-09-01 gap-closure pass** against the module/submodule matrix, which found
rows 22 and 23 entirely uncovered by specs 001–010.

## Technical Context

**Language/Version**: TypeScript 5.1, Node.js, NestJS 10, Prisma 5 — unchanged.

**Primary Dependencies**: Existing only — `pdfkit` (letter rendering, already used by 004/005 for
exports), `exceljs` (report exports), `@nestjs/event-emitter` (interviewer notifications, already
wired by 007), `@nestjs/bullmq` (async report export above threshold, per 004's pattern).

**Storage**: `recruitment` schema (11 tables); `settings` schema gains 2 reference-data tables
(KitItem, LetterTemplate); writes into `hr.Employee` on joining via `HrService`.

**Testing**: Jest unit tests for the candidate stage machine (permitted/rejected transitions),
offer salary-breakup reconciliation, time-to-hire computation from stage history, attrition rate,
letter token substitution and unknown-token rejection, PII masking. E2e in
`test/recruitment.e2e-spec.ts` for the full funnel (requisition → candidate → interview → offer →
join → onboard) and the joining transaction's atomicity.

**Performance Goals**: Single-employee letter generation under 10s (SC-003).

**Constraints**: No candidate-facing surface — internal HR-facing backend only (ratified
2026-09-01). Candidate PII masked in every list response.

**Scale/Scope**: 9 user stories, 37 FRs, 11 entities.

## Constitution Check

| Principle | Check | Status |
|---|---|---|
| I. Schema Boundaries | 11 tables in `recruitment`; 2 reference-data masters in `settings` (KitItem, LetterTemplate — FR-037, matching how 006/009/012 place their masters). Employee creation goes through `HrService`, never a direct `hr` write. Inventory kit linkage via `InventoryService`. | PASS |
| II. Validated DTOs | Every endpoint uses typed DTOs (FR-033). | PASS |
| III. No Hardcoded Values | Delayed-joining threshold, no-show grace window, and salary-breakup rounding tolerance are all company-configurable, not literals (FR-010, US5 scenarios 2 and 5). | PASS |
| IV. Multi-Tenant Isolation | All 13 tables carry `companyId`; RLS on all (FR-001). Candidate PII masked in lists, unmasked reads audit-logged (FR-006, FR-032). | PASS |
| V. Auth & Permissions | Adds exactly 2 enum values — `RECRUITMENT`, `RECRUITMENT_APPROVE` (FR-031); reuses existing `EMPLOYEES` and `REPORTS` everywhere else. | PASS |
| VI. Safe Migrations | `recruitment` schema and the 2 `settings` additions ship as separate, logically-grouped migrations. Encrypted object storage for resumes, letters, documents; production start refused on local-filesystem blobs (FR-024). | PASS |

## Implementation Phases

### Phase 1: Setup

- [ ] Extend `settings.Permission` enum: `RECRUITMENT`, `RECRUITMENT_APPROVE` only
- [ ] Add 11 `recruitment` models and 2 `settings` models (KitItem, LetterTemplate) to
      `prisma/schema.prisma` (data-model.md)
- [ ] Generate and apply migration(s); add RLS policies for all 13 tables
- [ ] Extend `shared.AuditLogEntry.entityType` with `REQUISITION`, `CANDIDATE`, `INTERVIEW`,
      `OFFER`, `ONBOARDING_ITEM`, `LETTER`, `RESIGNATION`
- [ ] Scaffold `RecruitmentModule`; export `RecruitmentService` with stubs for
      `getAcceptedResignation(employeeId)` (005 FR-065 depends on it) and
      `generateLetter(employeeId, letterType)` returning null
- [ ] Extend Settings' code-series service with `REQUISITION` series type (FR-002)

### Phase 2: US1 — Requisitions (P1)

- [ ] `RequisitionService` + `RequisitionController` (CRUD, submit/approve/reject state machine,
      auto-close at `filledPositions == positionCount` — FR-014, delete guard → 409)
- [ ] Unit test: position-count arithmetic; auto-close; no-show position release
- [ ] E2e test: draft → submit → approve → accepts candidates; reject without reason → 400

### Phase 3: US2 & US3 — Candidates & Interviews (P1)

- [ ] `CandidateService` + `CandidateController` (create under open requisition only — FR-003,
      resume upload, duplicate phone/email guard → 409 — FR-007, PII masking on list — FR-006)
- [ ] Implement the stage machine as a single guarded transition method with a row-level lock
      (FR-004, FR-034) writing `CandidateStageHistory` on every transition (FR-005)
- [ ] `InterviewService` + `InterviewController` (schedule, round-number uniqueness → 409,
      reschedule with history, per-interviewer feedback — FR-009, overdue flag)
- [ ] Enforce: no advance to `selected` while any round is incomplete (FR-008)
- [ ] Unit test: every permitted and rejected stage transition; masking; time-to-hire from history
- [ ] E2e test: concurrent stage transitions — exactly one succeeds, loser gets 409

### Phase 4: US4 — Offers (P1)

- [ ] `OfferService` + `OfferController` (salary-breakup reconciliation — FR-010, outside-budget
      flag requiring `RECRUITMENT_APPROVE` — FR-011, accept/decline, supersede prior offer —
      FR-012)
- [ ] Unit test: breakup sum tolerance; outside-budget detection; supersession
- [ ] E2e test: edit accepted offer → 409; second offer supersedes the first

### Phase 5: US5 & US6 — Joining & Onboarding (P1, P2)

- [ ] `JoiningService`: single transaction creating `hr.Employee` via `HrService`, setting
      `candidate.employeeId`, advancing stage, incrementing `filledPositions`, opening the
      checklist (FR-013) — employee code from Settings' existing series (002 FR-023)
- [ ] `OnboardingService` + `OnboardingController` (checklist seeded from mandatory Document Types
      + default kit items — FR-015; verify via 005's employee-document surface — FR-016; kit issue
      with optional `InventoryService` linkage — FR-018; waive requiring `RECRUITMENT_APPROVE` —
      FR-019)
- [ ] Confirm no second attendance gate is introduced (FR-017) — assert existing 002 FR-021 gate
      is the only one
- [ ] Unit test: checklist seeding; completion when all mandatory items done or waived
- [ ] E2e test: joining transaction atomicity (forced failure leaves no partial Employee)

### Phase 6: US7 — Letters (P2)

- [ ] `LetterTemplateService` + controller (token-set validation at save — FR-020, exactly one
      active template per type per company — FR-021)
- [ ] `LetterService`: render with token substitution → `pdfkit` → encrypted object-storage
      reference; immutable, versioned, supersede on regenerate (FR-022)
- [ ] Implement the relieving-letter guard: reject until F&F run is processed (FR-023)
- [ ] Replace the `generateLetter()` stub so 005 FR-065 can call it
- [ ] Unit test: token substitution; unknown-token rejection; versioning; relieving-letter guard
- [ ] E2e test: generate appointment letter, regenerate → v2 current, v1 still downloadable

### Phase 7: US8 — Resignations (P2)

- [ ] `ResignationService` + `ResignationController` (create with computed
      `expectedLastWorkingDay`, accept with optional waiver, withdraw, duplicate guard → 409 —
      FR-026)
- [ ] Replace the `getAcceptedResignation()` stub so 005 FR-065 sources last-working-day from here
- [ ] Unit test: last-working-day computation; waiver; inactive-employee rejection
- [ ] E2e test: 005's exit flow reads this record rather than re-collecting

### Phase 8: US9 — Reports (P3)

- [ ] `RecruitmentReportsService` + controller: new-joinings, funnel (stage counts, conversion,
      time-to-hire from stage history — FR-028, per-source breakdown), resignations (tenure,
      attrition rate — FR-027)
- [ ] XLSX/PDF export via existing libraries; async via bullmq above threshold (FR-029)
- [ ] Unit test: funnel conversion math; attrition rate; time-to-hire
- [ ] E2e test: resignation report reconciles with 005's exit records (SC-007)

### Phase 9: Polish

- [ ] Swagger `@ApiTags('Recruitment')` + `@ApiOperation` on all controllers
- [ ] Verify soft-delete on requisitions, candidates, offers, resignations (FR-036)
- [ ] `npm run lint` + `npm run build` clean
