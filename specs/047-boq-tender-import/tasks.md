# Tasks: Tender BOQ Import — Every Schedule, Pricing Basis, Safe Confirm

**Input**: Design documents from `/specs/047-boq-tender-import/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/boq-import.md
**Tests**: requested (the user asked for tests against the real fixtures) — included per story.

API paths are relative to `buildcore-api/`; web paths are prefixed `buildcore-web/`.

## Phase 1: Setup

- [x] T001 Copy NEWAI, Cyber Thana, Mahila Thana, STMC Kota Darah, PHC Ghar, PHC Kaleda and Bundi Minority Hostel tender workbooks into test/fixtures/tenders/ (git-ignored, local only) with stable names
- [x] T002 Provision the scratch database `buildcore_047` (clone of buildcore_scratch) per quickstart.md

## Phase 2: Foundational

- [x] T003 Add `enum BoqPricingBasis { percentage item_rate }` (schema `projects`) and `BOQTaskItem.pricingBasis BoqPricingBasis @default(percentage)` in prisma/schema.prisma
- [x] T004 Generate migration prisma/migrations/20261028100000_boq_pricing_basis/migration.sql with `prisma migrate dev --create-only` against buildcore_047, apply it, regenerate the client
- [x] T005 [P] Create src/projects/boq/pricing-basis.ts exporting `takesQuotedPercentage(line)` and `quotedPercentageFor(line, q)` with unit tests in src/projects/boq/pricing-basis.spec.ts
- [x] T006 [P] Add error codes `notReconciled`, `quotedPercentagesConflict`, `quotedPercentageChoiceRequired`, `replaceBlocked`, `groupNotEmpty`, `pricingBasisLocked` to src/projects/boq/boq-error-codes.ts

## Phase 3: User Story 1 — Import every schedule, price by basis (P1) 🎯 MVP

**Independent test**: NEWAI validates to two schedules with correct totals; a bill on an item-rate line is qty × rate.

- [x] T007 [US1] Add `identifySchedules()` (every sheet, with `basis` from label rows) to src/projects/boq/schedule-block.ts; keep `identifySchedule()` as first-of
- [x] T008 [US1] Add `pricingBasis` to `StagedItem`, and `fileQuotedPercentage`/`projectQuotedPercentage`/`replacesExisting`/`schedules` to `ImportBatch` in src/projects/boq/import-batch.store.ts
- [x] T009 [US1] Rework `validate` in src/projects/boq/boq-import.service.ts: parse each schedule, per-schedule reconcile and report (`schedules[]`), sheet-prefixed numbering when >1 schedule, combined totals, row problems carry `sheet`
- [x] T010 [US1] Write `pricingBasis` on every created line in `confirm` (src/projects/boq/boq-import.service.ts)
- [x] T011 [P] [US1] Apply `takesQuotedPercentage` in src/projects/billing/client-bills.service.ts (`compose`, `billableBoq` quotedTotal + item fields, `view` quotedRate + line field)
- [x] T012 [P] [US1] Apply it in src/projects/billing/package/bill-package.service.ts (schedule lines carry basis, compose, claim edit, certify-by-line, certifiedCopyLines) and src/projects/billing/certified-lines.ts + src/projects/billing/package/certified-copy.reader.ts line type
- [x] T013 [US1] Fixture unit tests in src/projects/boq/boq-tender-fixtures.spec.ts (line counts, totals, quoted %, basis per schedule, numbering)
- [x] T014 [P] [US1] Unit tests for basis in billing: src/projects/billing/certified-lines.spec.ts and client-bills.service.spec.ts

## Phase 4: User Story 2 — Tax/total rows excluded (P1)

- [x] T015 [P] [US2] Create src/projects/boq/summary-rows.ts (`summaryRowKind`) + src/projects/boq/summary-rows.spec.ts ("Total station survey" stays a line)
- [x] T016 [US2] In `parseRows` skip summary rows before the heading/line split, collect `excludedRows` with amounts, add tax amounts to reconciliation (src/projects/boq/boq-import.service.ts)
- [x] T017 [US2] STMC fixture assertions in src/projects/boq/boq-tender-fixtures.spec.ts

## Phase 5: User Story 3 — Non-reconciling schedule blocks confirm (P1)

- [x] T018 [US3] Blockers (`BOQ_IMPORT_NOT_RECONCILED` per schedule, `BOQ_QUOTED_PERCENTAGES_CONFLICT`) → `batchId: null`, `confirmable: false` in src/projects/boq/boq-import.service.ts
- [x] T019 [US3] Unit test with a tampered stated total in src/projects/boq/boq-import.service.spec.ts

## Phase 6: User Story 4 — Quoted-percentage choice (P2)

- [x] T020 [US4] Add `quotedPercentageSource` (`@IsIn(['file','project'])`) and `replaceExisting` (`@IsBoolean`) to `ConfirmBoqImportDto` in src/projects/boq/dto/boq.dto.ts; pass through src/projects/boq/boq.controller.ts
- [x] T021 [US4] Validate reports `projectQuotedPercentage`/`quotedPercentageDiffers`; confirm re-reads the project figure in-transaction and requires a choice when different; writes the file's figure only for `file` (src/projects/boq/boq-import.service.ts)
- [x] T022 [US4] Unit tests in src/projects/boq/boq-import-confirm.spec.ts

## Phase 7: User Story 5 — Replace an untouched BOQ (P2)

- [x] T023 [US5] Validate: when the variant has lines, compute replaceability (doneQty, dwrTasks, clientBillLines, awardLines); refuse `BOQ_REPLACE_BLOCKED` with counts and line numbers; else report `replace` (src/projects/boq/boq-import.service.ts)
- [x] T024 [US5] Confirm: require `replaceExisting`, re-check in transaction, `deleteMany` the variant's groups, then write; the single BOQ_IMPORT audit entry records schedules (sheet, basis, lines), the quoted-percentage decision (file/project, before/after) and `replaced` line count (FR-014, constitution IV) (src/projects/boq/boq-import.service.ts)
- [x] T025 [US5] Unit tests (src/projects/boq/boq-import-confirm.spec.ts) and e2e test/boq-tender-import.e2e-spec.ts (replace allowed, then blocked after billing; mixed NEWAI import confirmed then a client bill with one line of each basis — item-rate amount = qty × rate, billable quoted total applies % to percentage lines only — SC-003)

## Phase 8: User Story 6 — Empty group delete, manual basis (P3)

- [x] T026 [US6] `deleteGroup` (audited DELETE entry, constitution IV) in src/projects/boq/boq.service.ts + `DELETE groups/:groupId` in src/projects/boq/boq.controller.ts
- [x] T027 [US6] `pricingBasis` on `CreateBoqItemDto` and `PlanBoqItemDto`; service writes it; PATCH refuses on billed lines; `BoqItemView.pricingBasis` (src/projects/boq/dto/boq.dto.ts, src/projects/boq/boq.service.ts)
- [x] T028 [US6] Unit tests in src/projects/boq/boq.service.spec.ts; e2e group delete + basis in test/boq-tender-import.e2e-spec.ts

## Phase 9: Web (buildcore-web) — all stories

- [x] T029 [P] Write buildcore-web/specs/047-boq-tender-import/spec.md + tasks.md (web convention, pointing at the API spec); Zod: `pricingBasis` on BOQ item; new validate report fields; confirm body; group delete; item create/plan basis in buildcore-web/app/lib/api/projects.ts; billable BOQ / bill view / certified-copy schemas in buildcore-web/app/lib/api billing module
- [x] T030 Import screen buildcore-web/app/ui/projects/boq-import.tsx: schedule cards (basis, lines, totals, reconcile state), excluded rows, blockers disable confirm, quoted-% radio choice, replace checkbox
- [x] T031 BOQ tree buildcore-web/app/ui/projects/boq-tree.tsx: basis chip per line, delete empty group, basis select on manual add/edit; quoted value per basis
- [x] T032 [P] Pricing screens use basis: bill-sheet.tsx / bill-line-row.tsx, award-editor.tsx, bill-lifecycle.tsx, client-bill-view.tsx
- [x] T033 Web unit tests for the new schema/helpers and lint/typecheck; visual check with the dev server (dropdowns/modals opened)

## Phase 10: Polish

- [x] T034 Run lint, build/typecheck, unit tests, relevant e2e in both repos; record results in quickstart.md
- [ ] T035 Commit, push, open PRs to develop in both repos

## Dependencies

Setup → Foundational → US1 → (US2, US3 share `boq-import.service.ts`, run sequentially) → US4 → US5 → US6 → Web → Polish.
T011/T012/T014 parallel to T009 (different files) once T005 lands.

## Implementation Strategy

MVP = US1 (all schedules + basis-aware pricing). US2/US3 harden the same parse; US4/US5 change confirm; US6 and web finish.
