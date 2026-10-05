---

description: "Task list for feature 023 — Running-Account Bill Package (buildcore-api)"
---

# Tasks: Running-Account Bill Package

**Input**: Design documents from `/specs/023-ra-bill-package-backend/`

**Prerequisites**: [plan.md](./plan.md) (phases A–G, two tracked deviations, the test strategy),
[spec.md](./spec.md) (7 user stories, **89** functional requirements, decisions D1–D3),
[research.md](./research.md) (§1–§8), [data-model.md](./data-model.md),
[contracts/bill-package-api.md](./contracts/bill-package-api.md), [quickstart.md](./quickstart.md)
(8 passes), [checklists/silent-failure.md](./checklists/silent-failure.md) (52 items, nine
findings).

**Tests**: **Included, and six of them are the point.** This feature produces a money document, and
a wrong figure on one looks exactly like a right one. The six that exist for that reason alone are
T060 (up-to-previous is read, not derived — without it the footer identity cannot fail), T031 (an
award line with no measurement source), T046 (the client's real arithmetic), T074 (the sheet count),
T075 (produced twice, identical), T073a (both directions from one renderer, which is the thing the
user asked for in their own words) and T098 (the isolation probe). Each has its own task rather than
a clause inside another.

**Organization**: phases follow plan.md's **A–G** plus a verification phase, because each is
independently committable and is committed on its own. Every task carries its `[US#]` label, so the
story grouping is readable down that column rather than by reordering work with a forced sequence.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel — different files, no dependency on an incomplete task
- **[US#]**: the user story in spec.md this serves. `[—]` means cross-cutting
- Exact file paths in every description

## Before every commit that touches `src/`

```bash
npx jest src/approvals/fr-022-unmigrated-modules.spec.ts   # diffs two commits — see T105
npx prettier --write "src/**/*.ts" "test/**/*.ts"          # buildcore-api HAS .prettierrc.json
npm run lint && npm run build
```

`buildcore-web` has **no** prettier config and must never be prettier-formatted — its defaults
reformat untouched code. That repository is not touched by this feature at all.

**And run the guard a second time immediately after the first commit that creates
`src/projects/billing/package/` or `src/projects/billing/workbook/`.** It diffs two commits, so it
cannot see an untracked directory; the commit that adds one is the only moment it can. 022 learned
this the hard way five times.

---

## Phase A: Schema and migration (Foundational — blocks every later phase)

**Purpose**: four new tables and six enums. Additive, no backfill — `ClientBill`, `RABill`,
`WorkOrder` and `BOQTaskItem` all held 0 rows on 2026-10-05, measured.

- [X] T001 [P] [—] Add enums `BillDirection` (`to_client`, `to_subcontractor`), `BillTaxBasis`
      (`intra_state`, `inter_state`) and `BillTaxBasisSource` (`derived_from_gstin`,
      `from_project_flag`) to the `projects` schema in `prisma/schema.prisma`
- [X] T002 [P] [—] Add enum `BillPackageStatus` (`draft`, `issued`, `certified`, **`abandoned`**) to
      `prisma/schema.prisma`, with a docblock recording that `abandoned` exists because a package in
      any status occupies its period (FR-002a), so without it one mistaken draft holds a period for
      ever and the only remedy is deleting the row that proves the period was billed (FR-002b,
      FR-044a, checklist CHK032)
- [X] T003 [P] [—] Add enums `ClaimProposalSource` (`approved_measurement`, `no_measurement_source`)
      and `CheckListAnswer` (`yes`, `no`, `not_required`) to `prisma/schema.prisma`. The docblock on
      `ClaimProposalSource` states the distinction it carries: zero means the measurement was read
      and was nothing, absent means there was nothing to read (FR-003a)
- [X] T004 [US1] Add `model BillPackage` to `prisma/schema.prisma` — `companyId`, `projectId`,
      `direction`, nullable `clientBillId`/`raBillId`, `periodFrom`/`periodTo` as `@db.Date` **both
      inclusive** (FR-001), `sequenceNo`. The client's cycle runs the 21st to the 20th, so a period
      is two stored dates and not a month anybody can derive (data-model.md §BillPackage)
- [X] T005 [US2] Add `BillPackage`'s **frozen rate** columns — `retentionFraction`, `cgstFraction`,
      `sgstFraction`, `igstFraction`, `tdsFraction` as `Decimal(8,6)`, `taxBasis`,
      `taxBasisSource` — each with a docblock stating it is recorded **per bill** so a statute or
      contract change cannot move an issued bill (FR-019, FR-023, research §4)
- [X] T006 [US2] Add `BillPackage`'s this-period figures and its `…UptoDate` cumulative twins as
      `Decimal(18,2)`: `workDone`, `releaseWithheld`, the three taxes, the four recoveries, the four
      deductions, `tdsAmount`, `payable` (FR-013, FR-014a, FR-017)
- [X] T007 [US2] Add `mobilizationAdvanceTotal` and `performanceSecurityTotal` as `Decimal(18,2)?`
      to `BillPackage`, with a docblock stating that without a recorded total nothing distinguishes
      a fully-recovered deduction from one entered as zero this month — so FR-020 would be satisfied
      by an implementation that does nothing (checklist CHK021)
- [X] T008 [US3] Add `BillPackage`'s frozen statutory header as nullable strings (issuer and
      receiver name, registration number, permanent account number, state, address; receiver code,
      nature of work, location, external work-order and bill numbers) plus
      `missingHeaderFields String[]`, with a docblock stating these are copied at **issue** and
      never re-read, which is what makes FR-028's "produced twice is identical" true rather than
      hoped for
- [X] T009 [US7] Add `BillPackage`'s lifecycle columns — `status`, `issuedAt`, `issuedByUserId`,
      `revisionCount`, `lastRevisedAt`, `lastRevisedByUserId`, `lastRevisionReason` — following
      `RABill.revisionCount`'s precedent (FR-044 to FR-046)
- [X] T010 [US1] Add `model BillPackageLineClaim` to `prisma/schema.prisma`: `packageId` with
      `onDelete: Cascade`, nullable `clientBillLineId`/`raBillLineId`, **nullable** `proposedQty`,
      `proposalSource`, `claimedQty`, **nullable** `varianceQty`, `reason`, `overClaimed`. The
      docblocks state that `proposedQty` and `varianceQty` are null together, and that a claim
      against `no_measurement_source` is **not** an over-claim — counting it would turn FR-006a's
      count into a count of unmapped award lines (FR-003a, FR-005, FR-006)
- [X] T011 [P] [US5] Add `model BillPackageDebit` to `prisma/schema.prisma` with `groupHeading`,
      `description`, `location`, the four optional dimensions, `unit`, `rate`, `amount`,
      `amountWithTax`, nullable `recoveredOnPackageId`, `recordedByUserId`, `recordedAt`. The
      docblock on `recordedAt` states it is also what makes an issued bill's register the register
      *as at issue* (FR-039a)
- [X] T012 [P] [US6] Add `model BillPackageCheckListAnswer` to `prisma/schema.prisma` with
      `packageId`, `questionKey`, **nullable** `answer`, `answeredByUserId`, `answeredAt`. The
      docblock states the nullability is FR-042 — an unanswered question is not an answer of no,
      which a boolean could not express — and that the six questions themselves are a constant in
      code because their wording is the client's format and not this system's data
- [X] T013 [—] Add the indexes data-model.md names: `@@unique([projectId, direction, sequenceNo])`,
      `@@unique([clientBillId])`, `@@unique([raBillId])`,
      `@@index([projectId, periodFrom, periodTo])` for FR-002's overlap check,
      `@@unique([packageId, clientBillLineId])`, `@@unique([packageId, raBillLineId])`,
      `@@index([packageId, overClaimed])` so FR-006a's count is a query rather than a scan,
      `@@index([companyId, projectId])`, `@@index([recoveredOnPackageId])`,
      `@@unique([packageId, questionKey])`, and `@@index([companyId])` on all four
- [X] T014 [—] Generate the migration into `prisma/migrations/`. **`npm run migrate:dev:create` is
      non-interactive in this environment** — 022 hit this — so use
      `prisma migrate diff --from-schema-datasource --to-schema-datamodel --script`, expanding
      `.env`'s `${VAR}` interpolation by hand to build the shadow URL. Inspect the output and
      **exclude the nine pre-existing index-name drifts** between the development database and the
      committed schema: they predate this work, they appear against `HEAD`'s schema too, and they
      need their own fix
- [X] T015 [—] Append the `BillPackage_one_bill_matching_direction` CHECK from
      [data-model.md](./data-model.md) to the generated migration. **This is plan.md's first tracked
      deviation** from "migrations are generated and never hand-edited" — the task exists separately
      so the deviation is visible in review, and the reason is that Prisma's schema language cannot
      express a constraint spanning two nullable references while the thing it protects is a money
      document
- [X] T016 [—] Add `ALTER TABLE … ENABLE ROW LEVEL SECURITY` and a `tenant_isolation` policy to each
      of the four new tables in the same migration, with `USING` **and** `WITH CHECK` stated
      explicitly. **Read each neighbouring policy rather than copying one** (research §7): both of
      008's policies omit `WITH CHECK`, and `projects."DWRTask"` has no `companyId` at all and is
      protected by a correlated parent lookup — a `companyId`-keyed policy added beside one of those
      would `AND` with it and hide every row (FR-050)
- [X] T017 [—] Run `npx prisma generate` and `npm run build`, then confirm with
      `prisma migrate diff --from-schema-datasource --to-schema-datamodel --script` that the only
      remaining differences are the nine known index-name drifts and nothing this feature introduced

**Checkpoint**: the schema holds the package. Nothing reads it yet. Commit.

---

## Phase B: Composition (US1 — P1)

**Goal**: open a package for a period and propose every line of the schedule its direction measures.

**Independent test**: `POST /projects/:projectId/bill-packages` returns one proposed line per
schedule line, the count is assertable, and a second call for the same period returns the first
package rather than creating another.

- [X] T018 [P] [US1] Create `src/projects/billing/package/package-error-codes.ts` with every refusal
      code [contracts/bill-package-api.md](./contracts/bill-package-api.md) names, each with a
      docblock saying what the caller should do about it — following
      `src/projects/boq/boq-error-codes.ts`, whose own docblock explains why one "it failed" sends
      every caller to the same place, which is nowhere
- [X] T019 [P] [US1] Create `src/projects/billing/package/dto/compose-bill.dto.ts` — `direction`,
      `periodFrom`, `periodTo`, `workOrderId` required when the direction is `to_subcontractor`,
      `externalBillNo`, `externalWorkOrderNo`. No total, no rate, no quantity: `whitelist` and
      `forbidNonWhitelisted` are both on, so a caller supplying a computed figure gets a 400 rather
      than having it stripped (plan.md Constitution Check II)
- [X] T020 [P] [US1] Create `src/projects/billing/package/dto/bill-line.dto.ts` — `claimedQty` and
      an optional `reason`, both validated as the repository validates decimals (the BOQ DTOs use
      `@IsNumberString`, so quantities arrive as strings; 022's e2e suite failed on exactly this)
- [X] T021 [US1] Add `resolveSchedule(direction, projectId, workOrderId)` to
      `src/projects/billing/package/bill-package.service.ts`, returning the project's `BOQTaskItem`
      lines for `to_client` and that work order's `WorkOrderBOQItem` lines for `to_subcontractor`.
      **The two directions measure different schedules** (research §1, FR-003) — this function is
      the only place that decides which, so nothing downstream has to know
- [X] T022 [US1] Implement the period-overlap refusal in `bill-package.service.ts`: refuse a period
      overlapping one already billed **on the same schedule to the same counterparty** — the project
      for a client bill, the work order for a subcontractor bill — naming the package (FR-002). One
      project is legitimately billed to its client and to several subcontractors over the same
      month, so a per-project check would refuse the second of those (checklist CHK029). A package
      in **any** status occupies its period (FR-002a)
- [X] T023 [US1] Implement `compose` in `bill-package.service.ts`: create the bill row (`ClientBill`
      or `RABill` through 018's existing service), the `BillPackage`, and one
      `BillPackageLineClaim` per schedule line. Read 022's
      `DwrPeriodFiguresService.figuresFor(ctx, projectId, {from, to})` **once** and write the claims
      in **one multi-row statement** — 312 lines is one write, not 312 (research §8, and the
      production 500 behind it: 132 sequential round trips inside a 5 s transaction budget)
- [X] T024 [US1] Map each schedule line to its proposal in `bill-package.service.ts`:
      (SC-001: the engineer reviews proposals rather than entering quantities)
      `approved_measurement` with the period's approved quantity for a BOQ line, and
      **`no_measurement_source` with a null quantity** for an award line whose `boqTaskItemId` is
      null — which the subcontract model permits because a subcontract may itemise work differently.
      Zero would say "no work was done this month" for every unmapped line of every bill (FR-003a)
- [X] T025 [US1] Implement FR-003b in `bill-package.service.ts`: where two or more award lines map
      to one BOQ line, refuse the composition naming the lines rather than proposing that line's
      full approved measurement to each. Silently duplicating it would pass FR-008's
      one-line-per-item rule, because they are two different lines
- [X] T026 [US1] Freeze each line's rate and amount at composition in `bill-package.service.ts`:
      the rate onto the claim's bill line (FR-010), and the amount as quantity × rate adjusted by
      any percentage quoted against that schedule — `ClientBillLine.amount` already carries
      `quantity × rate × (1 + quotedPercentage)`, and a work-done figure computed without it would
      disagree with the schedule it totals (FR-012, checklist CHK012)
- [X] T026a [US1] Report a cumulative claim that has passed its line's **scope or awarded**
      quantity in `bill-package.service.ts`, and carry the remaining quantity as the **negative
      figure it is** rather than its magnitude (FR-012b). 018 already flags over-scope on a bill
      line rather than refusing it (`ClientBillLine.exceedsScope`), and the real Annexure carries a
      Balance Qty column that a magnitude would print as though there were scope left
- [X] T027 [US1] Implement FR-007 in `bill-package.service.ts`: the same project, direction and
      period returns the **existing** package in the body rather than creating a second, and
      FR-011's refusal when the schedule is empty, naming the absence
- [X] T028 [US1] Implement `updateLine` in `bill-package.service.ts`: accept the proposal unchanged
      with no reason; require a reason for a reduction (FR-004); accept an over-claim with a reason
      and set `overClaimed` (FR-006); **clear the reason** when a later edit returns the claim to
      its proposal (FR-004a) — a reason beside a zero variance argues for a deduction the bill does
      not make. Store `varianceQty` rather than deriving it, and leave it null when the proposal is
      (FR-005)
- [X] T029 [US1] Implement `abandon` in `bill-package.service.ts` (FR-002b): a draft releases its
      period; an issued package is refused with `BILL_PACKAGE_ISSUED` and is never deletable
      (FR-044a)
- [X] T030 [US1] Create `src/projects/billing/package/bill-package.service.spec.ts` covering the
      overlap refusal per counterparty, the existing-package return, the reason rules including
      FR-004a's clearing, and the one-line-per-item refusal
- [X] T031 [US1] **The award line with no measurement source** — its own test in
      `bill-package.service.spec.ts`. Assert `proposedQty` is `null` and `proposalSource` is
      `no_measurement_source`, that `varianceQty` is null, and that the line is **not** counted as
      an over-claim. Then assert the contrast: a mapped line with no approved measurement comes back
      as `0` with `approved_measurement`. These two are the same number in the obvious
      implementation, on the direction the company bills every month (FR-003a, checklist CHK010)
- [X] T032 [US1] [P] Add to `bill-package.service.spec.ts` the count assertion: the number of claims
      written equals the number of lines `resolveSchedule` returned, asserted as a **count** and not
      by inspecting the list — an assertion over a returned list passes just as happily over a short
      one, and a bill missing an item is a smaller invoice (FR-003)
- [X] T033 [US1] [P] Add a test to `bill-package.service.spec.ts` proving the claims are written in
      one statement, not one per line — assert against the number of queries the transaction issues
      for a 50-line schedule, so the regression research §8 describes is caught in a unit test rather
      than on the deployment

**Checkpoint**: a package can be opened and its lines reviewed. Commit.

---

## Phase C: The abstract (US2 — P1)

**Goal**: four blocks, three columns, every rate an input and none a constant.

**Independent test**: `GET /projects/bill-packages/:packageId/abstract` reproduces the client's real
figures, and each of the three columns balances on its own.

- [X] T034 [P] [US2] Create `src/projects/billing/package/bill-tax.ts`: decide `intra_state` versus
      `inter_state` from the two parties' registration numbers, whose first two digits are the state
      code, with the project's existing flag as the fallback — and **return which source decided it**
      (FR-016, research §5). Pure function, no Nest, no Prisma
- [X] T035 [P] [US2] Create `src/projects/billing/package/bill-tax.spec.ts`: same state codes yield
      the two half-rate taxes and a zero full-rate figure; different codes the reverse; **never both
      and never neither** (FR-015); a missing registration number falls back to the flag and reports
      `from_project_flag`; and a missing registration number on *both* sides is refused rather than
      guessed
- [X] T036 [US2] Create `src/projects/billing/package/bill-abstract.ts` as a pure function taking
      every rate as an **argument with no default**: the retention fraction, the three tax
      fractions, the tax-deducted fraction, and the one-time recoveries' totals. A bill issued in
      March must recompute identically in September after a rate change, which is only true if the
      rate travels with the bill (FR-023, research §4)
- [X] T037 [US2] Implement block A in `bill-abstract.ts` — work done, release withheld, the three
      taxes, total — with the **taxable base stated in the code and its docblock**: the work done
      before any recovery, deduction or withholding, and what the withheld amount does to it,
      applied identically in all three columns (FR-015a). The sample bill withholds nothing, so no
      test drawn from it constrains this path at all
- [X] T038 [US2] Implement blocks B and C in `bill-abstract.ts` — the four named recoveries and the
      four named deductions, **each reported in its own right whether or not it carries an amount**
      (FR-017) — with retention computed from the contract's percentage over the work done before
      tax and other deductions (FR-018, FR-018a)
- [X] T039 [US2] Implement block D in `bill-abstract.ts` — tax deducted at source over the work done
      before tax, recoveries and other deductions, **not over the payable it is subtracted from**
      (FR-019, FR-019a)
- [X] T040 [US2] Implement the one-time recovery rule in `bill-abstract.ts` (FR-020): compare the
      amount recovered to date against the **recorded total**, show a fully-recovered deduction in
      the cumulative columns and blank in this bill's (FR-020a), and refuse a recovery that would
      carry the recovered-to-date past the total, naming what remains (FR-020b)
- [X] T041 [US2] Implement the rounding rule in **one** place in `bill-abstract.ts` (FR-012a): the
      unit, the direction, and totals rounded from unrounded components rather than summed from
      rounded ones. 9 % of 18,41,686 is 1,65,751.74 against a document showing 1,65,752, so the rule
      is load-bearing — and rounding each row before summing breaks FR-021's balance by a few rupees
      a column, which on a money document is a figure somebody has to explain
- [X] T042 [US2] Implement the payable in `bill-abstract.ts`: work total less recoveries, less
      deductions, less tax deducted, with **each of the three columns balancing independently**
      (FR-021) and a **negative payable permitted** rather than clamped (FR-022) — a bill whose
      debits exceed its work is a real outcome the client's own format expresses
- [X] T043 [US2] Read the up-to-date column from the previous package's **stored** figure in
      `bill-package.service.ts` (FR-014): the previous package is the one with the highest sequence
      number below this on the same schedule to the same counterparty that has been **issued**, and
      where there is none every up-to-previous figure is **zero — a position — and not absent**
- [X] T044 [US2] Mark a draft's up-to-date column **provisional** in the abstract response
      (FR-013b): a package that has not been issued has no frozen cumulative position, and a figure
      that changes when the engineer presses Issue is a figure they did not approve
- [X] T044a [US2] Report the tax basis **and how it was decided** in the abstract response
      (FR-016a): `derived_from_gstin` or `from_project_flag`. A client record carries no `state`
      today, so for a bill to a client the fallback is the likely path rather than the exceptional
      one — and a fallback recorded on a row and shown to nobody is a tax decision nobody made
- [X] T045 [P] [US2] Create `src/projects/billing/package/bill-abstract.spec.ts` with the structural
      tests: every named recovery and deduction present whether or not it carries an amount; the
      three columns each balancing; a negative payable surviving; and a rate omitted from the
      arguments being a type error rather than a silent zero
- [X] T046 [US2] **The client's real arithmetic** — its own test in `bill-abstract.spec.ts`. From a
      work-done amount of 18,41,686 assert two half-rate taxes of 1,65,752 each, retention of
      92,084 and tax deducted of 36,834, each exact to the rupee. Then assert the payable of
      11,39,971 **with the sample's own recoveries transcribed from
      `docs/Parth Realcon Pvt Ltd. RA-12 (1).pdf`** and not inferred: the work total less retention
      and tax deducted leaves 20,44,272, so 9,04,301 is accounted for elsewhere on the real sheet
      and a figure back-solved to close the gap tests nothing (SC-003, checklist CHK013).
      Reproducing a real document is what catches **a rate applied to the wrong base**; "9 % was
      applied" is satisfied by 9 % of anything
- [X] T047 [P] [US2] Add the withheld-amount tests to `bill-abstract.spec.ts`: a non-zero release
      withheld, with the stated answer about whether it leaves the taxable base asserted in all
      three columns (FR-015a). The sample bill withholds nothing, which is exactly why this needs
      writing by hand
- [X] T048 [P] [US2] Add the one-time recovery tests to `bill-abstract.spec.ts`: a partly-recovered
      advance, a fully-recovered performance security blank in this bill and present in the
      cumulative column, and a recovery past the total refused naming what remains (FR-020,
      FR-020a, FR-020b)

**Checkpoint**: the abstract reproduces the real document. Commit.

---

## Phase D: The sheets' data (US4, US5, US6 — P2)

**Goal**: three services and one constant table, each producing one sheet kind's data and **none of
them holding a workbook**.

**Independent test**: the measurement endpoint returns a claim history, a daily record and a footer
that balances; the register refuses a second application; the check list keeps unanswered apart
from no.

- [X] T049 [US4] Create `src/projects/billing/package/measurement-sheet.service.ts` with
      `historyFor(packageId, lineId)`: every period the line has been claimed in, in period order,
      each with its quantity, its reason and the package it went out on (FR-031)
- [X] T050 [US4] Reproduce reasons **verbatim** in `measurement-sheet.service.ts` (FR-032) — no
      normalising, no trimming, no sentence-casing. The remarks are the argument the document
      exists to settle, misspellings included — and SC-005 requires one to be readable on that
      item's sheet a year later, which is why the history is a query across bills rather than a
      field on one
- [X] T051 [US4] Add the daily record to `measurement-sheet.service.ts`, read through
      `ProjectSourcesRegistry.logbookSource()` — the registry 022 built, never by querying the plant
      schema (FR-033, plan.md Constitution Check I). Batched over the period's dates in one call
- [X] T052 [US4] Report a date with **no** daily record as `logbookMissing: true` in
      `measurement-sheet.service.ts`, distinguishably from a date on which nothing was done
      (FR-034). 022's source returns a map, so an absent date is absent rather than zero — keep that
      distinction rather than flattening it into a run of zeroes
- [X] T053 [US4] Compute the footer in `measurement-sheet.service.ts`: this bill, up to previous and
      up to date, where **up to previous is the previous package's stored figure** (FR-013a, FR-014)
      and not this package's up-to-date less its own quantity
- [X] T054 [P] [US5] Create `src/projects/billing/package/dto/debit-note.dto.ts` and
      `debit-note.service.ts` with `record`: description, location, the dimensions where the debit
      has them, quantity, rate, unit, amount, and amount including tax — the last carried rather
      than computed, because the tax on a debit is not always the bill's own rate (FR-036)
- [X] T055 [US5] Implement `apply` in `debit-note.service.ts` as a **conditional update whose row
      count the service checks** — `WHERE "recoveredOnPackageId" IS NULL` — so the one-bill rule is
      decided by the database and not by a read followed by a write (FR-037). A debit recovered
      twice is money taken twice
- [X] T056 [US5] Refuse application to an **issued** package in `debit-note.service.ts` with
      `BILL_PACKAGE_ISSUED` (FR-037b): applying one afterwards either moves a figure FR-044 froze or
      records a recovery the bill never made
- [X] T057 [US5] Include applied debits in the package's recoveries in `debit-note.service.ts`,
      under the **one named recovery kind FR-038a states** — so two compliant implementations cannot
      produce two different abstracts (FR-038)
- [X] T058 [US5] Implement `registerFor(packageId)` in `debit-note.service.ts`: every debit on the
      project grouped under its heading for a **draft** (FR-039, FR-040), and for an **issued**
      package the register **as at issue** — `recordedAt <= issuedAt` (FR-039a). Without that split,
      FR-039's running total and FR-028's frozen workbook contradict each other and a debit recorded
      between two productions of a signed bill changes it
- [X] T059 [P] [US6] Create `src/projects/billing/package/check-list.ts` holding the **six fixed
      questions in a fixed order with fixed wording** as a constant, and
      `dto/check-list.dto.ts` accepting `yes`, `no`, `not_required` or **absent** per question
      (FR-041, FR-042). A constant rather than rows because the client reads them by position and
      their wording is the format rather than this system's data; absent rather than a boolean
      because an unanswered question is not an answer of no
- [X] T060 [US4] **Up to previous is read, not derived** — its own test in
      `measurement-sheet.service.spec.ts`. Build three consecutive packages, then assert that the
      third's up-to-previous figure **equals the second's stored up-to-date column**, read directly
      from the second package's row. Without this, FR-035's footer identity — which the plan calls
      the one property of the package nobody can check by reading a single bill — is a rearrangement
      of its own definition and holds for any values whatever (FR-013a, checklist CHK002)
- [X] T061 [US4] Add the footer identity test to `measurement-sheet.service.spec.ts`: this bill plus
      up to previous equals up to date **exactly**, for every item on every package, with no
      rounding difference (FR-035, SC-004)
- [X] T062 [P] [US5] Create `src/projects/billing/package/debit-note.service.spec.ts`: a debit
      applied to a second package refused **naming the first** (FR-037); two **simultaneous**
      applications of one debit, exactly one landing (FR-037a) — the rule has to hold where
      concurrent writers meet it and not only against a second attempt made afterwards; and
      application to an issued package refused (FR-037b). SC-007 is this test and nothing else
- [X] T063 [P] [US5] Add the register tests to `debit-note.service.spec.ts`: a draft's register
      showing a debit recorded against a later package, an issued package's register **not** growing
      when a debit is recorded afterwards (FR-039a), and the grouping under headings (FR-040)
- [X] T064 [P] [US6] Create `src/projects/billing/package/check-list.spec.ts`: six questions in
      order with their exact wording, an unanswered question distinguishable from one answered no,
      and the gaps returned rather than refusing anything (FR-041 to FR-043a)

**Checkpoint**: every sheet's data exists without a workbook anywhere. Commit.

---

## Phase E: The workbook (US3 — P1)

**Goal**: one renderer, five sheet kinds, two party bindings, and no database client.

**Independent test**: `GET /projects/bill-packages/:packageId/workbook.xlsx` opens in a spreadsheet,
contains one measurement sheet per schedule line, and is identical when produced twice.

- [X] T065 [US3] Create `src/projects/billing/workbook/bill-workbook.types.ts` — the **view type**
      the renderer consumes and the only thing it can see. FR-028's "every figure comes from the
      stored bill and none is recomputed at production time" becomes a property of the renderer's
      inputs rather than a rule it follows (plan.md Structure Decision, research §6)
- [X] T066 [US3] Create `src/projects/billing/workbook/bill-workbook.renderer.ts` importing
      `exceljs` as `import * as ExcelJS` — which is **correct** under this repository's compiler
      split, because `exceljs` is read through its properties and a namespace object carries
      properties perfectly well. `src/common/swc-interop.spec.ts` guards the form that breaks, which
      is a module whose export *is* the callable. The renderer holds **no** Prisma client
- [X] T067 [US3] Implement the sheet-naming rule in `bill-workbook.renderer.ts` (FR-024a): names are
      capped at 31 characters, exclude the characters a file path uses, and must be unique in the
      workbook — so a name drawn from a BOQ number or a description collides or truncates on a
      312-item schedule, and what the writer does with a collision decides whether an item's sheet
      silently disappears. Name by position, guarantee uniqueness, and identify the item **inside**
      the sheet (checklist CHK040)
- [X] T068 [P] [US6] Create `src/projects/billing/workbook/sheets/check-list.sheet.ts` — the six
      questions, their answers, the responsibility footer, and the two signature blocks
- [X] T069 [P] [US2] Create `src/projects/billing/workbook/sheets/abstract.sheet.ts` — four blocks,
      three money columns each, the full-rate tax row present and blank where it does not apply, and
      the payable and net payable lines
- [X] T070 [P] [US3] Create `src/projects/billing/workbook/sheets/schedule.sheet.ts` — the priced
      schedule with each item's scope, balance, and quantity and amount split three ways, footed by
      the totals. **Every sheet names the package it belongs to, from one source**: the sample
      workbook's own schedule sheet is headed "RA Bill - 09" inside package RA-12, an error from
      copying a sheet, and the system will not reproduce it (spec.md Assumptions)
- [X] T071 [P] [US4] Create `src/projects/billing/workbook/sheets/measurement.sheet.ts` — the
      monthly claim table with its remarks and the package each claim went out on, and the daily
      record beneath it where the line has one, with a missing date shown as missing
- [X] T072 [P] [US5] Create `src/projects/billing/workbook/sheets/debit-note.sheet.ts` — the
      register's own header block and its lines grouped under their headings
- [X] T073 [US3] Bind the two party positions by direction in `bill-workbook.renderer.ts` (FR-025):
      for a bill to a subcontractor the company is the issuing party, for a bill to a client the
      client is. Identifiers come from the **frozen header** on the package (FR-026), and a missing
      one is reported through the `X-Bill-Package-Missing-Fields` response header and the issue
      response body, never refused (FR-027, FR-027a)
- [X] T073a [US3] **Both directions, one renderer** — its own test in
      `bill-workbook.renderer.spec.ts` (SC-008, FR-025). Render the same figures as a bill to a
      client and as a bill to a subcontractor, and assert the **issuing and receiving party cells
      exchange** while every other cell is identical. This is the requirement the user stated first
      and in their own words — one renderer, two bindings, the two party names being the stated
      variables — and two renderers that drift apart is the failure it exists to prevent
- [X] T074 [US3] **The sheet count** — its own test in `bill-workbook.renderer.spec.ts`. Assert that
      the number of measurement sheets **equals** the number of lines the schedule holds, including
      lines with nothing claimed, as a count computed from the input rather than a number typed into
      the test (FR-030, FR-030a). An assertion over the sheets a workbook contains passes just as
      happily over a short list, and a missing sheet is a smaller invoice. 022's T052 is the
      precedent
- [X] T075 [US3] **Produced twice, identical** — its own test in `bill-workbook.renderer.spec.ts`.
      Render the same view twice and assert **every cell value** is equal. Not byte-for-byte: a
      workbook file records when it was written, so two productions are never identical as bytes and
      a test written that way would fail for a reason that does not matter while hiding the one that
      does (FR-028, SC-009)
- [X] T076 [P] [US3] Add the long-description tests to `bill-workbook.renderer.spec.ts`: a
      multi-paragraph item description carried whole (FR-029), and one exceeding what a single cell
      can hold **reported** rather than silently truncated (FR-029a)
- [X] T077 [P] [US3] Add the naming tests to `bill-workbook.renderer.spec.ts`: two items whose names
      would collide produce two distinct sheets, both present; a name over the character cap is
      shortened by the rule and the item is still identifiable from inside its sheet (FR-024a)
- [X] T077a [US3] Assert the **five sheet kinds are present in the client's own order** in
      `bill-workbook.renderer.spec.ts` (FR-024, SC-002): check list, abstract, priced schedule, the
      measurement sheets, then the debit register. A reviewer finds each figure by where it sits,
      and a workbook carrying every sheet in a different order is a workbook they have to search
- [X] T078 [US3] Add a renderer test asserting it cannot query: the renderer's constructor takes no
      Prisma client and `bill-workbook.renderer.ts` imports none. A renderer that could query could
      recompute, and a bill produced twice must be identical (FR-028, research §6)

- [X] T078a [—] Add a guard test asserting **no model links a bill claim to an individual daily
      work report** (FR-049, decision D3) — scanning `prisma/schema.prisma` for a relation between
      the package tables and `DailyWorkReport` or `DWRTask`. A prohibition nothing checks is a
      prohibition a later "improvement" removes, and this one is load-bearing: 022's reversal guard
      stays a quantity floor *because* this linkage does not exist (FR-049a). Follow
      `src/common/strip-comments.ts` for the scan, as the other source-scanning guards do

**Checkpoint**: the package is a workbook. Commit.

---

## Phase F: Lifecycle, and the two reports the decisions oblige (US7 — P3)

**Goal**: issue, revise, certify — and the two reports without which D1 and D2 are not safe.

**Independent test**: an issued package is readable as issued after a revision, and both reports
return the cases their decisions create.

- [X] T079 [US7] Implement `issue` in `bill-package.service.ts` (FR-044): freeze every figure and
      the statutory header, record when it went out and by whom, and refuse an **unpriced** line
      carrying a non-zero claim (FR-009) — 018's `unpriced` flag means "nobody has priced this", not
      "this is free"
- [X] T080 [US7] Return `missingHeaderFields` and the check-list gaps in the issue response
      (FR-027a, FR-043a): reported to the caller, never a refusal, and not merely recorded against a
      row where nobody looks. **Assert that an issue with every question unanswered still
      succeeds** (FR-043) — the check list records a fact, and the client's own footer says only
      that gaps "may delay the process"
- [X] T081 [US7] Implement `revise` and `certify` in `bill-package.service.ts`: a revision counted
      with a reason and what the package stated at issue still readable (FR-045, FR-046), and a
      certified amount kept **beside** the billed one and never instead of it (FR-047) — the
      variance between the two is what a project manager chases, and overwriting the billed figure
      erases the fact that there was a shortfall
- [X] T082 [US7] Refuse deletion of an issued package (FR-044a). A draft is abandoned instead
      (T029), which is the only way a period is ever released
- [X] T083 [US7] Create `src/projects/billing/package/package-reports.service.ts` with
      `understatement(projectId)` (FR-014b): compare each issued package's period claims against
      that period's approved measurement **as it now stands**, answered on demand, with **no
      tolerance** — quantities are fixed-point, so any difference at all is reportable
- [X] T084 [US7] Carry the **remedy** on each understatement line in `package-reports.service.ts`
      (FR-014c): 022 attributes measurement by work date, so a quantity approved late whose work
      date sits inside an already-billed period never appears in any later period's proposal — it is
      unreachable rather than deferred. The route back is an over-claim under FR-006 on a later
      package carrying this report as its reason, and the response says so rather than leaving each
      engineer to work it out
- [X] T085 [US7] Implement `overClaims(projectId)` in `package-reports.service.ts` (FR-006a): the
      count per package and per project, **with the number of lines it was drawn from** (FR-006b).
      Three over-claims out of five lines and three out of 312 are the same count and different
      facts, and "observed as a pattern" is FR-006a's own stated purpose
- [X] T086 [US7] Answer FR-048 and FR-049b from the **same** comparison as FR-014b in
      `package-reports.service.ts` (FR-048a): all three are "compare a billed period's claims against
      that period's approved measurement as it now stands", and two implementations of one
      comparison disagree — after which nobody knows which to believe
- [X] T087 [P] [US7] Create `src/projects/billing/package/package-reports.service.spec.ts`: a
      package whose period's measurement has since grown is reported with the exact difference and
      its remedy; one whose measurement has not is absent; and a reversal after issue appears as a
      discrepancy without moving the issued figures (FR-014b, FR-048)
- [X] T088 [P] [US7] Add the over-claim tests to `package-reports.service.spec.ts`: counted per
      package and per project with its denominator, and a line proposed from
      `no_measurement_source` **not** counted as an over-claim (FR-006a, FR-006b, FR-003a)
- [X] T089 [P] [US7] Add the revision test to `package-reports.service.spec.ts` or
      `bill-package.service.spec.ts`: a package issued, then revised, still reads as it was issued
      (FR-045, SC-006)

**Checkpoint**: the lifecycle and both obliged reports. Commit.

---

## Phase G: Controller, permissions, and the isolation proof

**Goal**: every route reachable, permissioned, locked and proven isolated.

- [ ] T090 [—] Create `src/projects/billing/package/bill-package.controller.ts` with every route
      [contracts/bill-package-api.md](./contracts/bill-package-api.md) names, `Permission.PROJECT_FINANCIALS`
      on **all** of them (FR-051) — a bill is money, unlike a BOQ which is project work
- [ ] T091 [—] Add `ProjectLockGuard` to every write route in `bill-package.controller.ts`,
      returning **423 and not 403** (FR-052): the same caller may write once the project is
      unlocked, which is a different fact from not being allowed to
- [ ] T092 [—] Report another company's package as **404 and not 403** throughout
      `bill-package.service.ts` (FR-053) — a 403 confirms the row exists
- [ ] T093 [—] Register `BillPackageController` in `src/projects/projects.module.ts` **ahead of
      `ProjectsController`**, and its providers. During 022 `src/projects/route-shadowing.spec.ts`
      caught `GET projects/dwr` being swallowed by the parameterised `GET projects/:id` because the
      controller was registered second; these routes carry literal paths under `projects/` and have
      the same exposure
- [ ] T094 [—] Run `npx jest src/projects/route-shadowing.spec.ts` and confirm it passes with the
      new literal paths. If it fails, the registration order is wrong and the guard will say which
      route is swallowed — my own comment during 022 said "after" when the answer was "before"
- [ ] T095 [—] Add the workbook route's response wiring in `bill-package.controller.ts`:
      `contentDispositionFor`, the content type for a spreadsheet, and the
      `X-Bill-Package-Missing-Fields` header (FR-027a)
- [ ] T096 [—] Create `test/bill-package.e2e-spec.ts` covering [quickstart.md](./quickstart.md)
      passes 1–3: compose with the count that must match, reduce and over-claim with their two
      reasons, and the abstract against the client's own figures. Note that the BOQ DTOs use
      `@IsNumberString`, so seeded quantities and rates are sent as **strings** — 022 had all 24 of
      its tests failing from one `beforeAll` line that did not
- [ ] T097 [—] Extend `test/bill-package.e2e-spec.ts` with passes 4–7: the frozen cumulative
      position across three consecutive packages with measurement approved between the second and
      the third (D1's whole point, and the case that distinguishes frozen from recomputed); the
      footer identity on every item of every package; the debits including the as-at-issue register;
      and the workbook's sheet count
- [ ] T097a [—] Establish SC-011 in `test/bill-package.e2e-spec.ts`: compose a package against a
      **312-line** schedule inside one transaction's budget, and produce its workbook — 312
      measurement sheets — in under ten seconds and under twenty megabytes. Measured rather than
      assumed: `withRlsContext`'s interactive transaction defaults are `maxWait` 2000 ms and
      `timeout` 5000 ms, and 022 research §8 records 132 sequential round trips inside that budget
      returning a bare 500 on the deployment while passing every local run
- [ ] T098 [—] **The isolation probe** — `test/ra-bill-package-rls.e2e-spec.ts`, following
      `test/dwr-rls.e2e-spec.ts` and `test/company-selection-rls.e2e-spec.ts`. Create a
      `NOSUPERUSER NOBYPASSRLS` role, and assert **first** that the role was actually created
      (FR-050a) — every assertion after it is vacuous if it was not. A probe that cannot run reports
      as **skipped and never as passed** (FR-050b): the development and continuous-integration role
      is a superuser and Postgres exempts superusers from row-level security unconditionally, so a
      policy without this test has never been in force in any test run
- [ ] T099 [—] Cover all **four** new tables in `test/ra-bill-package-rls.e2e-spec.ts` (FR-050), and
      exercise the **write** half of each policy as well as the read half (FR-050c, SC-010) — a probe that
      proves another company's rows are invisible says nothing about whether a row can be written
      *into* another company
- [ ] T100 [—] Extend `test/bill-package.e2e-spec.ts` with pass 8: `Permission.PROJECT_FINANCIALS`
      refused without it, 423 against a locked project, and 404 for another company's package
- [ ] T101 [—] Confirm every e2e suite this feature adds calls `app.close()` and disconnects any
      `PrismaClient` it constructs — `src/common/prisma/e2e-teardown.spec.ts` scans the sources and
      names the file. It strips comments first, because its own first version passed against a
      commented-out `app.close()`

**Checkpoint**: the feature is reachable, guarded and proven isolated. Commit.

---

## Phase H: Verification

- [ ] T102 [—] `npx prettier --write "src/**/*.ts" "test/**/*.ts"` — `buildcore-api` has
      `.prettierrc.json`. **Never run prettier on `buildcore-web`**: it has no config and its
      defaults reformatted 2,400 lines of untouched code on 2026-10-01
- [ ] T103 [—] `npm run lint`. Note it runs with `--fix` and may modify files this feature does not
      own; revert anything outside it, as 022 had to for `test/account-creation.e2e-spec.ts`
- [ ] T104 [—] `npm run build` — SWC, which is what the application is actually compiled by, and
      therefore the only build that proves the imports work in production
- [ ] T105 [—] `npx jest src/approvals/fr-022-unmigrated-modules.spec.ts` **before** each commit
      touching `src/`, and **again immediately after** the first commit that creates
      `src/projects/billing/package/` or `src/projects/billing/workbook/`. It diffs two commits, so
      it cannot see an untracked directory and fires one commit late — that commit is the only
      moment it can see a new one. Add the two new directories to its exclusions with the reason in
      the comment, as 022 did
- [ ] T106 [—] `npm test` — the full unit suite. 022 left it at 155 suites / 1732 tests; nothing
      here should reduce either number
- [ ] T107 [—] `npm run test:e2e` — the full e2e suite. 022 left it at 38 suites / 637 tests, and
      this feature adds two
- [ ] T108 [—] `npx jest src/common/swc-interop.spec.ts` — the `exceljs` import form, which this
      feature adds a consumer of
- [ ] T109 [—] Walk [quickstart.md](./quickstart.md)'s eight passes against a running server by
      hand, including Pass 3's arithmetic and Pass 6's two halves. A test suite proves the code does
      what the test says; the quickstart proves it does what the document needs

---

## Out of scope — stated so nobody picks them up

- **The `buildcore-web` screens.** A separate feature in that repository. No file there is touched,
  and prettier is never run on it
- **Any change to feature 022.** It is complete, its 62 requirements are met, and FR-049a records
  that its reversal guard stays a quantity floor rather than being tightened to provenance
- **PDF output.** The user chose a spreadsheet, the source is a spreadsheet, and the layout is
  native to one
- **The nine pre-existing index-name drifts** between the development database and the committed
  schema. They appear against `HEAD`'s schema too, so they predate this work and need their own fix
- **Adding `state` and `pan` to the client record.** Named in spec.md's assumptions as the likeliest
  FR-027 gaps for a bill issued to a client, and the right fix, but a change to another module's
  table and not this feature's to make
- **CHK048**, the one checklist item left for the reviewer: whether `BillPackageLineClaim`'s own
  isolation needs stating beyond FR-050

---

## Dependencies

- **Phase A blocks everything.** Nothing else can be written against a schema that does not exist
- **Phase B blocks C, D, E, F**: there is no abstract, no sheet and no workbook without a composed
  package
- **Phase C blocks E's abstract sheet** (T069) and **F's reports** (T083 to T086)
- **Phase D blocks E's measurement, register and check-list sheets** (T068, T071, T072)
- **Phase E is independent of F** — the renderer consumes a view type, so it can be built against a
  hand-written view before the lifecycle exists
- **Phase G depends on B through F**, because it exposes them
- T060 depends on T043 and T053; T074 and T075 depend on T065 and T066; T098 and T099 depend on A

## Parallel opportunities

- T001, T002, T003 — three enum blocks, one file, but no dependency between them
- T011, T012 — two independent models
- T018, T019, T020 — error codes and two DTOs, three files
- T034 with T036 — the tax decision and the abstract are separate pure modules
- T045, T047, T048 — three test groups in one spec file, independent of each other
- T068 through T072 — **five sheet builders, five files, no dependency between them**: the widest
  parallel opportunity in the feature
- T087, T088, T089 — three independent report tests

## Implementation strategy

**MVP is Phase A + Phase B + Phase C.** That is a package composed from real measurement with an
abstract that reproduces the client's arithmetic — which is the part no spreadsheet can be trusted
to do by hand, and the part that would justify the feature on its own even if the workbook were
still assembled manually for a month.

**Then Phase E** rather than D, if a choice has to be made: a workbook with a check list, an
abstract and a priced schedule is already a document somebody can send, with the measurement sheets
following.

Each phase is one commit, and the commits go in one at a time.
