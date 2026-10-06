---

description: "Task list for feature 028 — Projects defect register"
---

# Tasks: Projects defect register

**Input**: Design documents from `/specs/028-projects-defect-register/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/projects-defect-api.md, quickstart.md

**Tests**: Requested, and required. `spec.md` carries a Testing requirements section with a per-group vacuity table; `plan.md` carries the same table. **Seven test tasks, each carrying the note saying what would make it pass for the wrong reason.** That is not decoration — nine assertions in this repository have passed for the wrong reason, the most recent a sort placed in `submit()` instead of `view()` that kept 1,875 tests green while the screen was unchanged.

**Repositories**: `buildcore-api` (absolute paths below are relative to it) and `buildcore-web` (prefixed `web:`).

---

## Already done — do not redo

Item 01 of the client's list, the BOQ quoted-percentage sign, **shipped on 6 October** as `3cfd8c9` (api) and `dd30aa9` (web). A task that reimplements it has misread the feature. Its test is the precedent this feature follows: it asserts the **sign** and not the magnitude, because `Math.abs(…)` would have passed against the defect it was written for.

---

## Never — state these so nobody picks them up

- **The withdrawn "document is mandatory on edit" report receives NO CODE CHANGE.** The gate is creation-only in `ProjectsService.create`; the edit form neither fetches the required set nor sends staged ids; it stopped reproducing. Changing code to fix something that is not happening is how a working path acquires a defect.
- **The retired `RABill.advanceRecovery` / `otherDeductions` columns are NOT dropped in this feature** (research §2). Input is retired; the columns stay, because a bill with no package has nowhere for its values to go and a dropped column is a figure nobody can recover.
- The project schedule and progress module (026).
- The nine pre-existing index-name drifts — **excluded from every generated migration**. A migration containing them has been mis-generated and is regenerated, never trimmed by hand.
- Per-client layouts for the daily report.

---

## Phase 1: Setup

- [ ] T001 Confirm `specs/028-projects-defect-register/` design docs are the ones being worked from, and that `.specify/feature.json` points at this directory
- [ ] T002 Record the migration command once for the whole feature: `prisma migrate diff --from-schema-datasource --to-schema-datamodel --script` — `npm run migrate:dev:create` is non-interactive in this environment. **No migration in this feature is hand-edited** (Principle VI)
- [ ] T003 Confirm `buildcore-web` has no `.prettierrc` and must never be formatted; `buildcore-api` has `.prettierrc.json` and prettier is run on it

---

## Phase 2: Foundational — blocking, and the two gates

**These block every phase that follows, because two constitution gates in `plan.md` pass only once they exist.**

- [ ] T004 Write the RLS probe helper reuse note into this feature's test plan: every new table gets a probe proving a second company cannot read the first's rows. **Three tables in this feature** — `VendorItemRate` (D), `RABillPayment` (E), `SignedCopy` (E). Principle IV is non-negotiable
- [ ] T005 Every new e2e suite closes its Nest app and disconnects any `PrismaClient` it constructs, **or** `src/common/prisma/e2e-teardown.spec.ts` names the file. Check this per new suite, not once
- [ ] T006 Every `git add` in this feature is explicit-path. **`docs/Parth Realcon Pvt Ltd. RA-12 (1).pdf` is untracked client data and is never staged.** Never `git add -A`
- [ ] T007 `npm run lint` in `buildcore-api` runs with `--fix` and repeatedly modifies `test/account-creation.e2e-spec.ts` — revert it every time, before every commit
- [ ] T008 Run `src/approvals/fr-022-unmigrated-modules.spec.ts` before every commit touching `buildcore-api src/`, **and again straight after the first commit that creates a new directory** — it diffs two commits so it cannot see untracked files. It has fired late seven times

---

## Phase 3: User Story 1 — a second subcontractor can be billed (P1) · Phase A

**Goal**: FR-001..FR-003. The reported `P2002` that stops a subcontractor being billed at all.

**Independent test**: On a project where work order A holds RA-01, compose a package for work order B and get a bill numbered RA-01 on its own contract.

- [ ] T009 [US1] Move the constraint on `RABill` from `@@unique([projectId, billNumber])` to `@@unique([workOrderId, billNumber])` in `prisma/schema.prisma`, with a docblock recording that the allocator has always counted per work order and the constraint is what disagreed
- [ ] T010 [US1] Add `RA_BILL_NEEDS_WORK_ORDER` and refuse an RA bill created without a work order, in `src/projects/billing/ra-bills.service.ts` and the package path in `src/projects/billing/package/bill-package.service.ts`. **The task's reason, which belongs in the code comment**: Postgres does not collide NULLs, so the moved constraint alone leaves every work-order-less bill unconstrained — the same hole, moved. A partial unique index would fix it in SQL and **cannot be generated from a Prisma schema**, so the rule the database cannot express is held one layer up, deliberately and in one place (research §1)
- [ ] T011 [US1] Map `P2002` → 409 `BILL_NUMBER_TAKEN` on **both** the `rABill` and `clientBill` creates in `src/projects/billing/package/bill-package.service.ts`, matching `ra-bills.service.ts:320` and `client-bills.service.ts:340`. This is why raw Prisma text reached the user's screen
- [ ] T012 [US1] Generate the migration for T009 (T002's command). Verify it contains **one** statement and none of the nine index drifts
- [ ] T013 [US1] **Test (vacuity-noted)** in `test/bill-package.e2e-spec.ts`: two work orders on one project, each holding a bill numbered `RA-01`, asserted **on the composition response**. **Vacuity note to carry in the test's docblock**: *asserting only that composition returned 201 proves nothing — it did before, for the first work order.*
- [ ] T014 [US1] Test: a second bill on the first work order is `RA-02`, and a forced duplicate answers 409 with a sentence, never Prisma text

**Checkpoint**: a project with any number of subcontractors can raise a first bill for each (SC-001).

---

## Phase 4: User Story 2 — a deduction reaches the document (P1) · Phase B

**Goal**: FR-004..FR-008.

**Independent test**: Record a deduction through the supported path, render the PDF, read the figure **in the rendered document**.

- [ ] T015 [US2] **Do not modify `src/projects/billing/package/bill-abstract.ts` or `src/projects/billing/workbook/bill-pdf.renderer.ts`.** Both already read all ten `BillPackage` adjustment columns and print them correctly. The defect is a second store upstream, not a renderer. This task is a verification that they are untouched at the end of the phase
- [ ] T016 [US2] Retire `advanceRecovery` and `otherDeductions` from RA bill input in `src/projects/billing/dto/ra-bill.dto.ts`. Under `forbidNonWhitelisted` a caller sending them receives a 400 — a refusal, which is the intent, not a silent strip
- [ ] T017 [US2] Data migration copying existing `RABill` deduction values into the package's adjustment columns where a package exists. **The orphan rule (research §2)**: a bill with **no** package keeps its values and the fields become read-only. **The columns are not dropped in this feature**
- [ ] T018 [US2] `web:` remove the two deduction inputs from `app/ui/projects/ra-bill-sheet.tsx`, leaving the figures readable where a bill still carries them
- [ ] T019 [US2] [P] Compose a client bill through the package path from the Client bills tab in `web:app/ui/projects/client-bills-panel.tsx`; the manual sheet becomes the correction route (FR-007)
- [ ] T020 [US2] An overridden proposed quantity carries a reason (FR-008), in `src/projects/billing/package/bill-package.service.ts` and the sheet
- [ ] T021 [US2] **Test (vacuity-noted)** in `test/bill-package.e2e-spec.ts`: a deduction recorded through adjustments, then the **rendered PDF** parsed and the figure read out of it. **Vacuity note**: *asserting the column was written proves the write, not the document — the write was already correct.*

**Checkpoint**: SC-002 — every deduction recorded appears on the document the recipient receives.

---

## Phase 5: User Story 4 — an award is approved before it commits (P2) · Phase C

**Goal**: FR-009, FR-010. Two subjects, one mechanism (research §3).

**Independent test**: Raise a work order, fail to bill against it, approve it, bill against it.

- [ ] T022 [US4] Add `pending_approval` to `WorkOrderStatus` in `prisma/schema.prisma`, between `draft` and `active`
- [ ] T023 [US4] Generate the migration for T022. **It MUST NOT set existing `active` work orders to `pending_approval`** — `plan.md` risk 2: that would make every project in flight unbillable overnight. Only work orders raised after this ships start pending
- [ ] T024 [US4] Register `ACTION_WORK_ORDER_AWARD` in `src/approvals/default-chains.ts` on the same machinery as `ACTION_RA_BILL`, with submit/approve/return routes on the work order
- [ ] T025 [US4] Register `ACTION_PURCHASE_RATE_CHANGE` in the same file and the same phase. **`src/inventory` has no approval chain of any kind today** — this is the module's first, and standing the machinery up once for both subjects is why they share a phase (research §3)
- [ ] T026 [US4] Refuse a package composed against an unapproved award, by name, in `src/projects/billing/package/bill-package.service.ts` (`WORK_ORDER_NOT_APPROVED`)
- [ ] T027 [US4] **Test (vacuity-noted)** in `test/bill-package.e2e-spec.ts`: a composition refused against an unapproved award **and accepted once approved**. **Vacuity note**: *the refusal alone passes for a guard that refuses everything — the acceptance is the half that makes it mean something.*

**Checkpoint**: SC-004 — no work order can be billed against until approved.

---

## Phase 6: User Story 5 — the rate agreed with that vendor (P2) · Phase D

**Goal**: FR-011..FR-017.

**Independent test**: Buy an item from a vendor once typing a rate; buy it again and find the rate supplied and unalterable **through the endpoint**.

- [ ] T028 [US5] Add `inventory.VendorItemRate` to `prisma/schema.prisma` keyed `[companyId, vendorId, itemId, effectiveFrom]`, `effectiveTo` null meaning current, shaped on `settings.HireRate`. **`vendorId` is a plain column with no relation** — `partners.Vendor` is another schema, exactly as `Purchase.vendorId` already does it (Principle I)
- [ ] T029 [US5] Generate the migration for T028
- [ ] T030 [US5] **GATING — the RLS probe** for `VendorItemRate` in `test/rls-vendor-item-rate.e2e-spec.ts`: company B cannot read company A's agreed rates and cannot establish one against company A's item. **Principle IV is non-negotiable; this phase is not committable without it**
- [ ] T031 [US5] `src/inventory/rates/vendor-item-rate.service.ts`: the first purchase of a vendor–item pair establishes the rate; a known item from a **new vendor** is a first purchase
- [ ] T032 [US5] Enforce the agreed rate **in `src/inventory/purchases/purchases.service.ts`, on create and on update**, refusing a different one with `PURCHASE_RATE_FIXED` naming the agreed rate and its effective date. **In the service, not the DTO** (research §5): `PATCH /purchases/:id` accepts a rate from any caller, and a DTO can only omit a field, which is not refusal
- [ ] T033 [US5] Note in the service docblock that `src/inventory/stock/stock.service.ts` recomputes a **weighted average on every receipt**, so this rate moves the valuation of stock already held — the reason the control reaches past the purchase row
- [ ] T034 [US5] Forward only (FR-014): purchases already recorded are untouched and stay editable. An approved change applies from approval onward and does not restate purchases already made (FR-015)
- [ ] T035 [US5] [P] FR-016: `GET /inventory/vendor-rates?itemId=` with no `vendorId` answers what other vendors have agreed, for display beside a first entry; plus the first-purchase report over a period
- [ ] T036 [US5] FR-017: add the photo column to `Purchase` (`billFile` exists, there is no photo), generate the migration, and require both **before approval, not at creation** — site staff photographing a delivery at dusk with no signal must still record it. Not retrospective
- [ ] T037 [US5] `web:` purchase form renders the rate read-only from the server's `rateIsFixed`, with sibling-vendor rates beside a first entry
- [ ] T038 [US5] **Test (vacuity-noted)** in `test/purchases.e2e-spec.ts`: a second purchase's rate is unchanged after an attempt to alter it **through `PATCH /inventory/purchases/:id`**. **Vacuity note**: *asserting the form field is disabled proves nothing about the endpoint behind it.*

**Checkpoint**: SC-005.

---

## Phase 7: User Story 6 — found, signed for, and paid (P3) · Phase E

**Goal**: FR-018..FR-021.

- [ ] T039 [US6] Add `DEBIT_NOTE` to `CodeSeriesType` and `noteNumber String?` to `BillPackageDebit`. Generate the migration. **Nullable** because debits already recorded have none, and inventing numbers would print identifiers on documents nobody issued — the decision 027 made for work-order codes
- [ ] T040 [US6] Allocate the number through `CodeSeriesService` **when the debit is raised**, never when a PDF is produced (research §6) — a number allocated at print is a different number each time, and the register and the document would disagree
- [ ] T041 [US6] Standalone debit-note PDF in `src/projects/billing/package/debit-note.service.ts`, **reusing `bill-pdf.renderer.ts`'s primitives. No second renderer is written**
- [ ] T042 [US6] Add `projects.SignedCopy` and `projects.RABillPayment` plus `acknowledgedAt` on `RABill` to `prisma/schema.prisma`. Generate the migration. **No balance or outstanding column** — FR-021 derives it
- [ ] T043 [US6] **GATING — RLS probe** for `RABillPayment` in `test/rls-ra-bill-payment.e2e-spec.ts`
- [ ] T044 [US6] **GATING — RLS probe** for `SignedCopy` in `test/rls-signed-copy.e2e-spec.ts`, covering the stored file reference as well as the row
- [ ] T045 [US6] Signed-copy upload and named download through `StorageService` on the `DWRAttachment` pattern, for an RA bill and for a debit note; arrival sets `acknowledgedAt` — **a state, not merely a file** (FR-020)
- [ ] T046 [US6] `src/projects/billing/payments/`: record a payment, partial allowed; `outstandingAmount` **computed on read** as certified less paid
- [ ] T047 [US6] [P] `GET /projects/subcontractors/:partnerId/outstanding` reading across a subcontractor's bills, not per bill
- [ ] T048 [US6] [P] `web:` the signed-copy upload, the payment form and the outstanding view
- [ ] T049 [US6] **Test (vacuity-noted)**: a bill certified at ₹100 with ₹60 paid reports ₹40 outstanding. **Vacuity note**: *asserting the payment row exists proves the write, not the derivation.*

**Checkpoint**: SC-006.

---

## Phase 8: User Story 7 — a day's work filed, read and sent on (P3) · Phase F

**Goal**: FR-022..FR-024.

- [ ] T050 [US7] `src/projects/dwr/dwr-workbook.renderer.ts` producing the client's form, via the pattern `src/projects/billing/workbook/bill-workbook.renderer.ts` establishes. The DWR controller has fifteen endpoints and **none produces a file**
- [ ] T051 [US7] `GET /projects/dwr/:dwrId/report.xlsx`, named from the project code and the work date
- [ ] T052 [US7] Remove `weather` from `src/projects/dwr/dto/create-dwr.dto.ts` and `update-dwr.dto.ts`, and from `web:app/ui/projects/dwr-form.tsx`. **The column, its default and every recorded value are kept — there is NO migration for this task.** Removing the input is the request; discarding what was recorded is not
- [ ] T053 [US7] Resolve `recordedByName` and `submittedByName` in `src/projects/dwr/dwr.service.ts`, **reusing `project-documents.service.ts`'s `actorNames` helper rather than writing a second one**. Both names, because on a report returned for correction they are different people
- [ ] T054 [US7] [P] `web:` show both names on the report
- [ ] T055 [US7] **Test (vacuity-noted)**: the generated workbook's **cells read back** against the expected layout. **Vacuity note**: *asserting the download returned bytes proves a response, not a document.*

**Checkpoint**: SC-007.

---

## Phase 9: User Story 8 — the screens stop hiding what they hold (P3) · Phase G

**Goal**: FR-025..FR-030. **WEB ONLY — this phase makes NO API CHANGE AT ALL.** Every value is already in a response the screen receives.

- [ ] T056 [US8] Subcontractor control ahead of Work order in `web:app/ui/projects/bill-packages-panel.tsx`, work orders narrowed by `partnerId`, vendor names from the hook the Subcontractors tab already uses
- [ ] T057 [US8] **Clear the chosen work order when the subcontractor changes.** This is the one failure the control can introduce, and it would compose a bill against the wrong contract (FR-026)
- [ ] T058 [US8] Work orders with a null `partnerId` or a null `code` get their own entry in the picker rather than being filtered out of existence — filtered, they are unbillable with nothing on screen to say why (FR-027)
- [ ] T059 [US8] [P] Handle the company-switch 404 **once** in `web:app/dashboard/projects/portfolio/[id]/layout.tsx`, redirecting to the portfolio of the company now selected **with an explanation on arrival**. Not per page. The API's 404 is correct and does not change (FR-028)
- [ ] T060 [US8] [P] Commercial terms card on `web:app/dashboard/projects/portfolio/[id]/page.tsx` carrying client retention and the quoted percentage, plus the descriptive facts the response already holds (FR-029)
- [ ] T061 [US8] [P] Rename Issue to "Issue / Consumption material" in `web:app/lib/constants.ts` and the navigation — **labels only; the route and the API are unchanged**, because renaming a URL breaks every link already sent for no gain (FR-030)
- [ ] T062 [US8] **Test (vacuity-noted)**: the work order selection **after** the subcontractor is changed. **Vacuity note**: *asserting the subcontractor control renders proves it exists, not that it clears anything.*

**Checkpoint**: SC-008.

---

## Phase 10: Verification

- [ ] T063 `npx prettier --write` on every touched file in **`buildcore-api` only** — `buildcore-web` has no config and must never be formatted
- [ ] T064 `npm run lint` in both repositories; revert `test/account-creation.e2e-spec.ts` in the api afterwards (T007)
- [ ] T065 `npm run build` in both repositories
- [ ] T066 Full unit suite in `buildcore-api`
- [ ] T067 Full e2e suite **against `buildcore_scratch` only**, never the dev database
- [ ] T068 `src/approvals/fr-022-unmigrated-modules.spec.ts` — before every src/ commit and again after the first commit creating a new directory (T008)
- [ ] T069 Walk quickstart's seven passes by hand, including the three "what must NOT change" checks: editing a project still saves, every active work order is still active, the company-switch refusal is still a 404

---

## Dependencies

- **Phase 2 blocks everything.** T030, T043 and T044 are the three RLS probes; their phases are not committable without them.
- **Phase 5 (C) blocks Phase 6 (D)**: the rate-change approval needs the chain the award phase stands up. This is the only cross-story dependency in the feature.
- Phases 3 (A), 4 (B), 8 (F) and 9 (G) are independent of one another and of D/E.
- Phase 9 is web-only and can be built at any point after its data exists — which it already does.

## Parallel opportunities

- T019, T035, T047, T048, T054, T059, T060, T061 are marked `[P]` — different files, no incomplete dependency.
- Phases 3 and 4 can run in parallel: both touch billing but different concerns (numbering vs adjustments).
- Phase 9 can run in parallel with every API phase, since it makes no API change.

## Implementation strategy

**MVP is Phase 3 alone** — it is the only item that stops work outright, and it is a regression. Ship it, then Phase 4, which produces a wrong document rather than no document.

Then C→D as a pair, then E, F, G in any order.
