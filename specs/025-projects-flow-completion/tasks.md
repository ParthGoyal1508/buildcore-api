---
description: "Task list for feature 025 — Projects Flow Completion"
---

# Tasks: Projects Flow Completion

**Input**: Design documents from `specs/025-projects-flow-completion/`
**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/projects-flow-api.md](./contracts/projects-flow-api.md), [quickstart.md](./quickstart.md)

## Before anything is written, two facts that change what these tasks are

**There is no migration in this feature and there must be no migration task.** Every column it needs
already exists — [data-model.md](./data-model.md) audits them one by one. A task that creates a
migration has misread the feature.

**Phase E writes no service.** Fourteen surfaces, every one of them over an endpoint that exists and
is tested today, and twelve of them over a client function that is already written and simply has no
caller. A task in Phase E that creates a service, a DTO or a table has been misread.

## Repository rules that apply to every commit

- **Commit one at a time. Push nothing.**
- `npm run prettier` in **buildcore-api only** — it has `.prettierrc.json`. **buildcore-web has no
  prettier config and must never be formatted**; its defaults reformatted 2,400 untouched lines on
  2026-10-01.
- Run `src/approvals/fr-022-unmigrated-modules.spec.ts` **before** every commit touching
  buildcore-api `src/`, and **again straight after** the first commit that creates a new directory —
  it diffs two commits, so it cannot see untracked files. It has fired late seven times.
- `npm run lint` in buildcore-api runs with `--fix` and keeps modifying
  `test/account-creation.e2e-spec.ts`. **Revert it every time.**
- `docs/Parth Realcon Pvt Ltd. RA-12 (1).pdf` is untracked client data. **Never stage it.** Every
  `git add` is explicit-path; never `git add -A`.

---

## Phase A — The day that could not be saved (US1, P1)

**Goal**: a site engineer records a day and it saves. This is the defect the user reported and it
owes nothing to any other phase.

**Independent test**: record a day with a measured line carrying **Nos**, save, find it in the list
under its `dprNumber`.

- [X] T001 [US1] Add `createdByUserId` and `submittedByUserId` to the `select` in `DwrService.list`
      in `src/projects/dwr/dwr.service.ts`. Both columns exist on `DailyWorkReport` (lines 42–43) and
      are already read by the detail endpoint; this is two lines. Research §1 explains why the list
      grows rather than the client dropping its rule — 022 FR-012a is enforced on the server and
      invisible on the screen, so every submitted report currently shows an enabled Approve button
      and the author learns the rule by being refused.
- [X] T002 [US1] Update `specs/022-daily-work-reports-backend/contracts/dwr-api.md` with the two new
      list fields **in the same commit as T001**. Research §1: shipping a response-shape change
      without its contract is this feature's own bug, committed again.
- [X] T003 [US1] Realign `app/lib/api/dwr.ts` (buildcore-web) to the contract: `dprNumber` replaces
      the invented `reportNumber` (FR-001); the creation response is `{ id, dprNumber, status,
      warnings }` with **no** `projectId` and **no** `workDate` (FR-002); `warnings` is an array of
      `{ code, message, detail? }` (FR-003); the list is `{ items, total, page, pageSize }` whose
      items carry `lineCount` and **no lines array** (FR-005). Narrow the response schemas rather
      than leaving `.passthrough()` to swallow the next divergence.
- [X] T004 [US1] In `app/ui/projects/dwr-form.tsx`, send `nos1` and `nos2` where the payload today
      sends `nos` and `factor` (FR-007). The labels stay **Nos** and **Factor** per the user's
      decision. The global pipe runs at `forbidNonWhitelisted`, so an unknown field is a 400 and not
      a strip — this is the second half of the reported defect.
- [X] T005 [US1] Move `previewMeasuredQuantity`'s key list in `app/lib/api/dwr.ts` to the same six
      names the server multiplies — `nos1`, `nos2`, `length`, `breadth`, `depth`, `density`
      (FR-007a). It currently multiplies two keys the server has never heard of, so the figure shown
      before saving is not the figure the save would produce.
- [X] T006 [US1] In `app/ui/projects/dwr-panel.tsx`, render the Lines column from `lineCount`
      (FR-005, research §2) and let the author check read the two fields T001 adds (FR-006). Both
      currently read fields that never arrive, so the column shows "none" for every report and the
      rule never fires.
- [X] T007 [P] [US1] Follow T003 through the three pages under
      `app/dashboard/projects/portfolio/[id]/dwr/` and any other consumer the type errors name.
- [X] T008 [US1] Render each warning beside the success, in its own sentence, never as a failure
      (FR-004). A warning shown as an error is how a day that was recorded gets recorded twice.

---

## Phase B — A divergence caught by something other than a user (FR-008)

**Goal**: the server's promise is pinned, and what is *not* checked is written down rather than
implied.

- [X] T009 Assert the **exact** key set of the creation response in `test/dwr.e2e-spec.ts`:
      `expect(Object.keys(body).sort()).toEqual(['dprNumber', 'id', 'status', 'warnings'])`.
      **Vacuity note**: an assertion that the response *contains* `dprNumber` passes just as happily
      against a response containing everything. Equality is the point; containment is the failure
      mode plan.md names.
- [X] T010 Assert the exact key set of a **list item** the same way, including the two fields T001
      adds. Same vacuity note.
- [X] T011 Add one pointer comment at the top of `app/lib/api/dwr.ts` naming
      `specs/022-daily-work-reports-backend/contracts/dwr-api.md` as the document this module is
      aligned to. **Do not add a test runner to buildcore-web** — research §3: its `package.json`
      has four scripts and no jest, vitest or testing-library, and introducing a framework, its
      config and its CI step to run one assertion is a permanent surface for a single check. The
      research section records the upgrade path and the condition that should trigger it.

---

## Phase C — An imported line can be planned (US2, P1)

**Goal**: the three programme columns stop reading *Not planned* forever.

**Independent test**: PATCH a line's programme, re-read the BOQ, and find figures where the words
used to be.

- [X] T012 [US2] Add `PlanBoqItemDto` to `src/projects/boq/dto/boq.dto.ts` carrying **only**
      `startDate`, `finishDate`, `duration`, `perDayQty`, each reusing the validator stack
      `CreateBoqItemDto` already declares for it (FR-010). Nothing else is accepted, which is what
      makes FR-015 a property of the DTO rather than a check somebody can forget. Document that
      `null` clears and omission leaves alone (FR-011, research §4): `@IsOptional()` skips validation
      on `null` as well as `undefined`, the pipe's `whitelist` keeps a declared property that arrives
      as `null`, and the service distinguishes the two with `!== undefined`.
- [X] T013 [US2] Implement `BoqService.planItem()` in `src/projects/boq/boq.service.ts`: read the
      row, overlay the request, and validate the **merged** programme before writing (FR-012,
      research §6). A PATCH carrying only a finish date must still be refused against the stored
      start date — validating the request alone accepts it, and `neededRate()` then divides by a
      negative number and returns a plausible small figure. Inside the existing RLS transaction.
- [X] T014 [US2] Add `boq_programme_inconsistent` to `src/projects/boq/boq-error-codes.ts` with a
      message naming which two dates contradict each other.
- [X] T015 [US2] Add `PATCH items/:itemId` to `src/projects/boq/boq.controller.ts` with
      `Permission.PROJECTS`, `ProjectLockGuard` and 404-not-403 — copied from the sibling
      `DELETE items/:itemId` rather than reasoned afresh (FR-013). Return the updated line in the
      same shape the BOQ read returns, so a client can replace the row in place.
- [X] T016 [US2] `test/boq-planning.e2e-spec.ts`: the round trip. **Vacuity note**: asserting the
      PATCH returns 200 proves nothing about the read. Re-read through `GET projects/:id/boq` and
      assert `finishDate`, `perDayQty` and the derived `avgQtyPerDay` are no longer null.
- [X] T017 [US2] Same suite: the clear-versus-omit pair. One request sends `finishDate: null` and
      the field returns to null; another omits it entirely and the stored value survives. **Both
      halves**, because a clear that works and an omission that also clears is a planner's work
      silently discarded.
- [X] T018 [US2] Same suite: a PATCH carrying **only** a finish date earlier than the stored start
      date is refused with `boq_programme_inconsistent`. This is the case T013 exists for.
- [X] T019 [US2] Confirm the suite closes its Nest app and disconnects any `PrismaClient` it
      constructs, or `src/common/prisma/e2e-teardown.spec.ts` will name the file.
- [X] T020 [US2] Add the patch wrapper to `app/lib/api/projects.ts` (buildcore-web) in the existing
      module style, parsing the returned line with the schema that already describes a BOQ item.
- [X] T021 [US2] Inline programme edit on a BOQ row in `app/ui/projects/boq-tree.tsx`: start date,
      finish date, per-day target, saved against T015. Reuse the row-action and error-`describe()`
      patterns already in the file.
- [X] T022 [US2] Add the missing **start date** to `app/ui/projects/boq-entry.tsx` (FR-014). The
      field is already accepted by the create DTO; without it *Avg / day* can never populate, because
      the achieved rate is derived from it.

---

## Phase D — The two configuration gaps (US3 + US4, P1/P2)

**Goal**: a bill can be raised to the client at all, and a statutory rate can change without SQL.

**Independent test**: compose a client-direction package before and after recording the retention
term; change TDS and confirm an issued package does not move.

- [X] T023 [US3] Add `clientRetentionFraction` to the create and update project DTOs under
      `src/projects/portfolio/dto/` with **exactly** `WorkOrderDto.retentionPercent`'s constraints —
      `@IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 6 }) @Min(0) @Max(1)` — and
      the same docblock reasoning (FR-016, FR-018). Research §5: `resolveRates()` reads both terms
      four lines apart in one function, and two units in one function is how a 5% term becomes a
      500% deduction.
- [X] T024 [US3] Persist and return it in `src/projects/portfolio/projects.service.ts`. Absent stays
      absent — **not zero** (FR-019). The composition refusal is correct and must survive.
- [X] T025 [US3] `test/bill-package.e2e-spec.ts`: compose `to_client` **without** the term and assert
      the refusal by code `rate_missing` with `missingRate: 'retentionFraction'`; record the term;
      compose again and assert it opens. **Vacuity note**: a test that only composes *with* the term
      never proves the refusal still works. Both halves.
- [X] T026 [US3] Add the retention percent field to `app/ui/projects/project-form.tsx`, dividing by
      100 before sending exactly as `app/ui/projects/bill-sheet.tsx` already does for the subcontract
      term, and multiplying by 100 to display (FR-017, FR-020 — the round trip must not drift).
- [X] T027 [US4] Add a bounded DTO for the four statutory rates under `src/settings/companies/dto/`:
      each a fraction in `[0, 1]` to six decimal places (FR-022). `0.09` is nine per cent; `9` is
      refused, because a rate entered as 9 multiplies every tax by a hundred.
- [X] T028 [US4] Read and write the four rates in `src/settings/companies/companies.service.ts`,
      beside the existing `getBillingTaxRates`, auditing every change under
      `AuditEntityType.COMPANY` with the before and after values (FR-021, FR-024).
- [X] T029 [US4] Expose them on `src/settings/companies/companies.controller.ts` under the settings
      permission that already governs company configuration, per
      [contracts/projects-flow-api.md](./contracts/projects-flow-api.md) §4.
- [X] T030 [US4] `test/bill-package.e2e-spec.ts`: **issue** a package, *then* change a rate, *then*
      re-read the issued package and assert every figure is unchanged (FR-023). **Vacuity note**:
      changing a rate and re-reading a *draft* proves the opposite of what is wanted — a draft is
      supposed to move. The package must be issued first.
- [X] T031 [P] [US4] Add the four rates to `app/lib/api/settings.ts` (buildcore-web) in the existing
      module style.
- [X] T032 [US4] A tax-rate settings surface under `app/dashboard/settings/`, reusing the existing
      settings form patterns. State on the screen that changing a rate does not move an issued bill.

---

## Phase E — What was built becomes reachable (US5, P2)

**Goal**: every endpoint the projects module answers can be reached by the people it was built for.

**No task in this phase writes a service, a DTO or a table.** Each names the endpoint it calls and
the component it reuses. Twelve of the client functions below are **already written and unused**.

**Batch E1 — the daily report**

- [X] T033 [US5] Add wrappers for `POST projects/dwr/:dwrId/attachments` and
      `GET projects/dwr/attachments/:attachmentId` to `app/lib/api/dwr.ts`. These are two of the six
      endpoints with no client function at all.
- [X] T034 [US5] Attach and open evidence on the report detail screen (FR-025), reusing the upload
      pattern in `app/ui/projects/project-document-uploads.tsx` and `app/lib/download-file.ts`.
- [X] T035 [US5] Add a wrapper for `PATCH projects/dwr/:dwrId` and wire draft edit and delete
      (FR-026). `deleteDwr` **already exists and is unused** — wire it, do not rewrite it. Reuse
      `dwr-form.tsx` in an edit mode rather than building a second form.
- [X] T036 [US5] Add wrappers for `GET projects/:projectId/dwr/reconciliation` and
      `POST .../reconciliation/repair`, and a screen showing the difference per line with repair as a
      deliberate, confirmed action (FR-027). Repair is permissioned and recorded on the server and is
      **never** automatic — the screen must not call it on load.

**Batch E2 — the bill package**

- [X] T037 [US5] A measurement-sheet view per schedule line (FR-028), calling
      `getMeasurementSheet` — **already written and unused**. Today this can only be seen by
      downloading a workbook.
- [X] T038 [US5] Raise a debit and apply it to one bill (FR-029), calling `recordDebit` and
      `applyDebit` — **both already written and unused**. The second application is refused by the
      server; show the server's own sentence rather than pre-empting it.
- [X] T039 [US5] Revise an issued package and abandon a draft (FR-030), calling
      `reviseBillPackage` and `abandonBillPackage` — **both already written and unused**.
- [X] T040 [US5] The understatement and over-claim reports (FR-031), calling
      `getUnderstatementReport` and `getOverClaimReport` — **both already written and unused**. Each
      states its denominator; a rate without one is not a rate.

**Batch E3 — billing, BOQ and letters**

- [X] T041 [US5] Work-order edit (FR-032), calling `updateWorkOrder` — **already written and
      unused**.
- [X] T042 [US5] Retention release: wrappers for `GET projects/ra-bills/retention/:workOrderId` and
      `POST .../release`, and a screen (FR-032). Two more of the six endpoints with no client.
- [X] T043 [US5] Estimate import (FR-032), reusing `app/ui/projects/boq-import.tsx` against
      `estimate-import/validate` and `estimate-import/confirm` rather than copying the component.
- [X] T044 [US5] A Letters surface under Projects (FR-033) for the `work_order`, `loi`,
      `purchase_order`, `indent`, `service_order` and `service_bill` kinds the backend already
      permits, reusing the recruitment letters screens. Only the entry point is missing.
- [X] T045 [US5] Register every new route in `app/lib/constants.ts` and every new section in
      `app/ui/projects/project-detail-sections.ts`, with the permission each endpoint actually
      guards — not a guess (FR-034).

---

## Phase F — The corrections (US6, P3)

- [X] T046 [US6] Refuse a punch at a site whose status is `inactive`, naming the site's state
      (FR-035, 008 T057).
- [X] T047 [US6] Reconcile the project-detail costing breakdown with the figures the project reports
      elsewhere, or state on the screen which basis it uses where they legitimately differ (FR-036,
      008 T058).
- [X] T048 [US6] Correct 008 FR-012's citation of `SitesService.getHolidayCalendar()`, which does not
      exist, to name what does (FR-037, 008 T059). **Documentation only — no code.**
- [X] T049 [US6] Add the `PROJECT_FINANCIALS` refusal to `test/bill-package.e2e-spec.ts` (FR-038,
      023 T100). **Vacuity note**: a caller with no permissions at all would also be refused by a
      route guarded by nothing. The caller must hold **other** permissions and lack only this one.
- [X] T050 [US6] Tick 023's T100 and T101 in `specs/023-ra-bill-package-backend/tasks.md` — T101 is
      already satisfied, both new suites disconnect — and 008's T057/T058/T059 in
      `specs/008-projects-backend/tasks.md`, marking superseded rather than done where that is the
      truth.

---

## Phase G — Verification

- [X] T051 `npm run prettier` in **buildcore-api only**.
- [X] T052 `npm run lint` in buildcore-api, then `git checkout test/account-creation.e2e-spec.ts` —
      the `--fix` keeps modifying it.
- [X] T053 `npm run lint` in buildcore-web. **No `--fix`, no prettier**, ever.
- [X] T054 [P] `npm run build` in buildcore-api.
- [X] T055 [P] `npm run build` in buildcore-web.
- [X] T056 The full unit suite in buildcore-api.
- [X] T057 The full e2e suite in buildcore-api.
- [X] T058 The four repo guards: `fr-022-unmigrated-modules`, `route-shadowing`, `swc-interop`,
      `e2e-teardown`.
- [X] T059 Walk [quickstart.md](./quickstart.md)'s six passes against a running stack.

---

## Dependencies

- **Phase A** depends on nothing and is the MVP on its own: without it no day can be recorded.
- **Phase B** depends on A (it asserts the shape A aligns to).
- **Phase C**'s web half (T020–T022) depends on its API half (T012–T015).
- **Phase D**'s two halves are independent of each other and of A–C.
- **Phase E** depends on nothing but is last: it is the largest by count and the smallest by risk.
- **Phase F** is independent throughout.

## Parallel opportunities

`[P]` is marked only where the files genuinely do not overlap: T007 (pages), T031 (web settings
module), T054/T055 (two repositories). Phase E's three batches can proceed in parallel between
people but not between agents editing `app/lib/constants.ts`, which T045 touches once at the end.

## Out of scope — stated so nobody picks them up

- **The project schedule and progress module** — 008's TA001–TA020: phases, activities,
  dependencies, baselines, weightage, targets, variance. The largest unbuilt area of the module, and
  its own feature. This one plans a *line*, not a *programme*.
- **The nine pre-existing index-name drifts** between the dev database and the committed schema.
- **`Client.state` and `Client.pan`** — another module's table, reported rather than refused today.
- **PDF output.**
- **A test runner in buildcore-web.** Research §3 records why, and what should change the answer.
- **Any change to how a daily report is recorded or approved, or a package composed, issued or
  certified, on the server.** Both are complete and tested. This feature reaches them.
