# Tasks: Labour Worker Edit, Site Transfer, and Contractor on Payment Sheets

**Input**: Design documents from `/specs/052-labour-worker-edit/`
**Prerequisites**: plan.md, spec.md
**Tests**: unit tests for the edit plan, the service's edit and transfer rules and the line-contractor rule; one e2e suite for all three stories.

API paths are relative to `buildcore-api/`; web paths are prefixed `buildcore-web/`.

## Phase 1: Setup

- [x] T001 Provision local `buildcore_052` (`CREATE DATABASE … TEMPLATE buildcore_scratch`, `prisma migrate deploy`, `seed:chains`, `seed:defaults`)

## Phase 2: Foundational

- [x] T002 `model LabourWorkerTransfer`, `LabourWorker.transfers`, and `PaymentSheetLine.contractorId` in prisma/schema.prisma
- [x] T003 prisma/migrations/20261031100000_labour_worker_transfer/migration.sql from `prisma migrate diff` plus the tenant RLS policy; regenerate the client and dbml
- [x] T004 [P] `LABOUR_WORKER_ERRORS` and `WORKER_EDITABLE_FIELDS` in src/labour/constants/labour.constants.ts
- [x] T005 [P] `findSite` and `contractorOptions` in src/labour/labour-refs.service.ts; `type` on `PartnersService.listVendorsForCompany`

## Phase 3: User Story 1 — Edit a worker (P1) 🎯 MVP

- [x] T006 [US1] `UpdateWorkerDto`, `TransferWorkerDto`, `ContractorOptionsDto` in src/labour/workers/dto/worker.dto.ts
- [x] T007 [US1] src/labour/workers/worker-edit.util.ts (`planWorkerEdit`) with worker-edit.util.spec.ts
- [x] T008 [US1] `update`, `contractorOptions`, `loadForWrite`, `assertMaySetRate`, `toDetail` in src/labour/workers/labour-worker.service.ts; contractor names on the list; rate permission at registration
- [x] T009 [US1] `PATCH :id` and `GET contractor-options` in src/labour/workers/labour-worker.controller.ts

## Phase 4: User Story 2 — Transfer (P1)

- [x] T010 [US2] `transfer` in labour-worker.service.ts and `POST :id/transfer` in the controller
- [x] T011 [US2] src/labour/workers/worker-site.ts (`siteOnDate`); use it in `MusterAttendanceService.correct` and `history`
- [x] T012 [US2] Unit tests for update and transfer in src/labour/workers/labour-worker.service.spec.ts

## Phase 5: User Story 3 — Contractor on payment sheets (P1)

- [x] T013 [US3] Snapshot `contractorId` on lines and skip days already on the other engagement type's sheet (`daysOnOtherSheets`) in src/labour/payment-sheets/payment-sheet.service.ts
- [x] T014 [US3] `lineContractorId` in payment-sheet.rules.ts with unit tests; `contractorId`/`contractorName` on sheet detail lines
- [x] T015 [US3] Contractor column in src/labour/reports/labour-sheets.service.ts payment workbook

## Phase 6: E2E

- [x] T016 test/labour-worker-edit.e2e-spec.ts: edit validation, rate permission, audit field names, contractor snapshot surviving an edit, workbook column and totals, double-pay guard, transfer refusals and success, correction landing at the old site

## Phase 7: Web

- [x] T017 [P] buildcore-web/app/lib/api/labour.ts: schema fields and `updateWorker`, `transferWorker`, `getContractorOptions`
- [x] T018 [P] buildcore-web/app/ui/labour/worker-details-fields.tsx (shared fields)
- [x] T019 buildcore-web/app/ui/labour/worker-edit-forms.tsx (Edit and Transfer dialogs)
- [x] T020 buildcore-web/app/dashboard/labour/workers/page.tsx: Contractor column, Edit and Transfer actions, compacted columns
- [x] T021 buildcore-web/app/labour/register/page.tsx: "More details"
- [x] T022 buildcore-web/app/dashboard/labour/payment-sheets/[id]/page.tsx: contractor under the worker
- [x] T023 buildcore-web/app/ui/settings/responsive-list.tsx: wrap row actions

## Phase 8: Polish

- [x] T024 Lint and typecheck both repos; unit and e2e suites
- [x] T025 Visual check in headless Chromium at 1366 px and 390 px: list, edit dialog, price-change warning, transfer dialog, registration, sheet screen, downloaded workbook
