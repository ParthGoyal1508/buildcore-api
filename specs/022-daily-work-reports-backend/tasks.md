---

description: "Task list for feature 022 — Daily Work Reports (buildcore-api)"
---

# Tasks: Daily Work Reports

**Input**: Design documents from `/specs/022-daily-work-reports-backend/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md) (6 user stories, 61 functional
requirements), [research.md](./research.md) (§1–§8), [data-model.md](./data-model.md),
[contracts/dwr-api.md](./contracts/dwr-api.md), [quickstart.md](./quickstart.md) (8 passes),
[checklists/silent-failure.md](./checklists/silent-failure.md) (36 items).

**Tests**: **Included, and three of them are the point.** plan.md's test strategy names eight; the
coincidental quantity (T011), the omitted BOQ line (T038) and the skipped isolation probe (T049)
are this feature's only defence against a failure that looks like success, so each has its own task
rather than a clause inside another.

**Organization**: Phases follow plan.md's **A–F**, because each is independently committable and is
committed on its own. Every task also carries its `[US#]` label, so the story grouping the template
asks for is readable down the `[US#]` column rather than by reordering work that has a forced
sequence.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel — different files, no dependency on an incomplete task
- **[US#]**: the user story in spec.md this serves
- Exact file paths in every description

## Before every commit that touches `src/`

```bash
npx jest src/approvals/fr-022-unmigrated-modules.spec.ts   # diffs two commits — see T057
npx prettier --write "src/**/*.ts" "test/**/*.ts"          # buildcore-api HAS .prettierrc.json
npm run lint && npm run build
```

`buildcore-web` has **no** prettier config and must never be prettier-formatted — its defaults
reformat untouched code. That repository is not touched by this feature at all.

---

## Phase A: Migration (Foundational — blocks every later phase)

**Purpose**: the six columns the design needs. Additive, nullable, no backfill — the tables are
empty, measured on 2026-10-04 (`DailyWorkReport` 0 rows, `DWRTask` 0 rows).

- [X] T001 Add `servedQty Decimal? @db.Decimal(18, 3)` to `model DWRTask` in `prisma/schema.prisma`,
      with a docblock saying it is the quantity of a presence-paid day and is non-null exactly when
      `paymentMode = day_basis` (FR-030, research §3)
- [X] T002 Loosen `DWRTask.actualQty` to `Decimal?` in `prisma/schema.prisma`, with a docblock
      recording that absence means "not measured" while 0 means "measured as nothing", and that the
      client's real sheets contain both (data-model.md, plan.md Complexity Tracking)
- [X] T003 Add `equipmentId String?` to `model DWRTask` in `prisma/schema.prisma` as a **bare
      `plant.Equipment` id with no cross-schema relation**, matching `supervisorEmployeeId` and the
      schema-level note; without it FR-032 has no key to read a logbook entry by (research §5)
- [X] T004 Add `reversedAt DateTime?`, `reversedByUserId String?`, `reversalReason String?` and
      `reversalCount Int @default(0)` to `model DailyWorkReport` in `prisma/schema.prisma`, with a
      docblock stating that `approvedAt`/`approvedByUserId` are **not** cleared on reversal and why
      (research §7)
- [X] T005 Generate the migration with `npm run migrate:dev:create`, naming it
      `dwr_served_qty_and_reversal`
- [X] T006 Append the single `CHECK` constraint `DWRTask_quantity_matches_basis` to the generated
      `prisma/migrations/*_dwr_served_qty_and_reversal/migration.sql`, using the exact SQL in
      [data-model.md](./data-model.md) (FR-030a). **This is plan.md's tracked deviation** from the
      constitution's "never a hand-edited migration SQL file" — the migration is generated and one
      additive statement is appended. Put the reason in a SQL comment above it: Prisma's schema
      language cannot express a constraint spanning two columns and an enum, and a service-only
      invariant is one `prisma.dWRTask.create` away from being bypassed
- [X] T007 Apply with `npm run migrate:dev` and `npm run prisma:generate`, then confirm the
      constraint rejects a row with both quantities and a row with neither, via
      `npx prisma db execute`

**Checkpoint**: the schema holds exactly one quantity per line, enforced by the database. Commit
Phase A on its own.

---

## Phase B: The quantity in force (US1, US5 — the pure core)

**Purpose**: one place that knows which quantity governs a line. No Nest, no Prisma, unit-tested
alone.

- [X] T008 [US1] Create `src/projects/dwr/dwr-quantity.ts` with the two input types — a
      work-measured line carrying the six factors and no served quantity, a presence-paid line
      carrying a served quantity and **no factor fields at all** — discriminated on `paymentMode`
      (FR-030a, FR-030b, research §3)
- [X] T009 [US1] Implement `computeMeasuredQty(factors)` in `src/projects/dwr/dwr-quantity.ts`: the
      product of the six factors as `Prisma.Decimal`, an unsupplied factor treated as 1, a factor
      supplied as 0 refused **by name** (FR-003 as narrowed to work-measured lines, FR-004)
- [X] T010 [US5] Implement `quantityInForce(line)` in `src/projects/dwr/dwr-quantity.ts` as a
      discriminated switch: `work_basis` returns the measured quantity, `day_basis` returns the
      served quantity. **The `day_basis` branch must not reference a factor field** (FR-030b)
- [X] T011 [P] [US5] **The awkward test.** In `src/projects/dwr/dwr-quantity.spec.ts`, assert that a
      presence-paid line whose six factors are set to **7** still yields its served quantity
      unchanged (FR-030d, quickstart Pass 4 step 4). Write the docblock explaining why the test is
      shaped this way: all six factors default to 1, so their product is 1 — identical to one day
      served — and a design that read them would be right for every row written by hand and wrong
      the instant a factor moved, with nothing in a conventionally-written test to notice
- [X] T012 [P] [US1] In `src/projects/dwr/dwr-quantity.spec.ts`, cover `computeMeasuredQty`: the
      full six-factor product, unsupplied factors behaving as 1 and not 0, a supplied quantity being
      ignored, and the zero-factor refusal naming the factor
- [X] T013 [P] [US5] In `src/projects/dwr/dwr-quantity.spec.ts`, assert `servedQty = 1` is one full
      day and that no "full day" is inferred from the line's unit or rate (FR-030e)
- [X] T014 [P] Create `src/projects/dwr/dwr-error-codes.ts` with every refusal code named in
      [contracts/dwr-api.md](./contracts/dwr-api.md), following the shape and the docblock rhetoric
      of `src/projects/boq/boq-error-codes.ts` — each code names its own condition because the
      person who hit one needs a different action for each (Principle III)

**Checkpoint**: `npm test -- src/projects/dwr` green. Commit Phase B on its own.

---

## Phase C: Recording (US1 — P1)

**Goal**: a site engineer can record a day's work, and the server computes every quantity.

**Independent test**: create a report against a seeded project and BOQ line with the six factors
set, read it back, confirm the computed quantity matches the product — while the BOQ line's done
quantity is unchanged.

- [X] T015 [US1] Create `src/projects/dwr/dto/create-dwr.dto.ts` as **two line shapes**
      discriminated by `paymentMode` via `class-validator` + `@Type`, so a presence line cannot
      carry factors at all and a work line cannot carry a served quantity (FR-030b, Principle II)
- [X] T014a Add `model DWRAttachment` to `prisma/schema.prisma` (companyId, dwrId, fileRef,
      fileName, mimeType, sizeBytes, uploadedByUserId, uploadedAt) with its `tenant_isolation`
      policy, in a second migration. **FR-009 requires the name a file was uploaded under and
      `DailyWorkReport.fileRefs String[]` cannot hold it** — 017 fixed exactly this defect for
      project documents, where files downloaded as a bare UUID with no extension and a browser
      refused to open them, and the fix was columns for the name and the type. `fileRefs` is left in
      place, empty, documented as superseded (FR-009a, found while implementing Phase C)
- [X] T015a [US1] In `src/projects/dwr/dto/create-dwr.dto.ts` and `src/projects/dwr/dwr.service.ts`,
      carry and persist a measurement line's **position**: `chainageFrom`, `chainageTo`, `layer`,
      `roadSide`, `section`, `engineerName`, `remark` and `paymentMode` (FR-005). All eight columns
      already exist on `DWRTask`; this task exists because FR-005 had no covering task until
      cross-artifact analysis found it (finding F4), and a position nobody stores is a measurement
      nobody can locate on site
- [X] T016 [P] [US1] Create `src/projects/dwr/dto/update-dwr.dto.ts` and
      `src/projects/dwr/dto/dwr-query.dto.ts` (project, date range, status, page, pageSize)
- [X] T017 [US1] Create `src/projects/dwr/dwr.service.ts` with `create`, taking the report's own
      fields — supervisor, weather, worker count, machinery count, progress assessment, location,
      description, contract reference, inspection number, layer — and starting it in `draft`, which
      is one of exactly three statuses the existing `DwrStatus` enum already permits (FR-001,
      FR-010). Generate `dprNumber` as
      `{Project.code}{separator}{per-project sequence}` in that one rendering (FR-002, FR-002a) —
      `Site` has no code field and the report has no site, so 008's `{siteCode}-{sequence}` was
      impossible twice over (research §2)
- [X] T018 [US1] In `create`, resolve a `dprNumber` collision under concurrent creation by retrying
      against the existing `@@unique([companyId, dprNumber])` rather than surfacing it, losing
      neither attempt (FR-002b); document that gaps in a project's sequence are permitted and carry
      no meaning (FR-002c)
- [X] T019 [US1] In `create`, check BOQ-line ownership before writing anything and refuse a line
      belonging to another project, naming both
- [X] T020 [US1] In `create`, flag `exceedsScope` where a line's quantity passes its BOQ line's
      scope and **do not refuse** it (FR-006) — the site did the work, and refusing at entry means
      the measurement is recorded nowhere
- [X] T021 [US1] In `create`, accept a measurement line referencing no BOQ line and mark it as
      moving no done quantity and feeding no period figure (FR-007)
- [X] T022 [US1] In `create`, refuse a work date in the future, and accept one before the project's
      start date while returning the discrepancy as a warning (FR-025)
- [X] T023 [US1] In `create`, accept a second report for a date already covered and return the
      existing one's id and number in `existingReports` (US1 AC8) — two crews on two stretches is
      ordinary, and refusing the second loses it
- [X] T024 [US5] In `create`, require a remark on any presence line whose served quantity is less
      than a full day (FR-030c), because that shortfall is the fact a client's deduction is argued
      from
- [X] T024a [US5] In `src/projects/dwr/dwr.service.ts`, accept a presence-paid day whose served
      quantity is **zero** with a remark, and keep it distinguishable from no record for that date:
      a stored zero means "the asset was there and performed nothing", an absent line means "nobody
      recorded this day" (FR-031). The client's real sheets carry both — many measurement rows read
      "-" — and collapsing them loses the fact the deduction is argued from. Found absent from
      tasks.md by cross-artifact analysis (finding F2)
- [X] T025 [US1] In `create`, write the report's measurement lines in **one multi-row statement**,
      not one per line (research §8) — 132 sequential round trips inside one 5 s transaction budget
      was a production 500 on 2026-10-04
- [X] T026 [US1] Implement `update` in `src/projects/dwr/dwr.service.ts`, recomputing quantities
      from new factors, and refusing an approved report by naming the reversal path (FR-018, US3 AC1)
- [X] T027 [US1] Implement attachment upload and read in `src/projects/dwr/dwr.service.ts` through
      the existing `StorageService`, using `detectContentType`, `describeStoredFile` and
      `contentDispositionFor` from `src/common/storage/file-type.ts` so a download arrives named and
      typed rather than as a bare UUID (FR-009)
- [X] T028 [P] [US1] Unit-test `create` in `src/projects/dwr/dwr.service.spec.ts`: the generated
      number's rendering, the ignored client quantity, the over-scope flag, the future-date refusal,
      the pre-start warning, the second same-day report, and the short-day remark

**Checkpoint**: a day can be recorded and read back. Commit Phase C on its own.

---

## Phase D: The lifecycle (US2 and US3 — both P1)

**Goal**: submission is a claim and approval is a fact; and a wrong approval can be undone.

**Independent test**: submit and confirm no done quantity changed; approve and confirm it increments
by exactly the approved measurement, once; reverse and confirm it returns to its exact prior value.

- [X] T029 [US2] Create `src/projects/dwr/dto/dwr-lifecycle.dto.ts` for submit, approve, return and
      reverse — the reversal reason required (FR-019)
- [X] T030 [US2] Implement `submit` in `src/projects/dwr/dwr.service.ts`: `draft → submitted`,
      **moving no done quantity** (FR-011), refusing a report with no measurement lines (FR-024) and
      one not in draft by naming its status
- [X] T031 [US2] Wire `BoqService` into `DwrService` and register `DwrService` in
      `src/projects/projects.module.ts`. `BoqService.updateDoneQty` has existed since August, is
      exported from this module **for this caller**, and has had no caller — this task is where that
      closes (plan.md Phase D)
- [X] T032 [US2] Implement `approve` in `src/projects/dwr/dwr.service.ts`: `submitted → approved`,
      recording approver and time, incrementing each measured BOQ line by `quantityInForce`
      (FR-012); refusing when the approver is the author (FR-012a, decision D2) and when not
      submitted (FR-016)
- [X] T033 [US2] In `approve`, apply every increment or none inside one `withRlsContext`
      transaction, leaving the report **submitted** as the only permitted outcome of failure
      (FR-013); group the increments rather than issuing one round trip per line (research §8)
- [X] T034 [US2] In `approve`, make a failed approval observable: the refusal names the line that
      could not be moved and the reason, and the attempt is recorded (FR-013a) — an all-or-nothing
      rule that reports nothing leaves an operator retrying a write that will fail again for a
      reason nobody has been told
- [X] T035 [US2] In `approve`, make the status transition conditional on the current status inside
      the same transaction, so a second concurrent approval loses and the counter moves once
      (FR-014, FR-014a); and use `{ increment: … }` only, never a value read earlier in the same
      operation, so two reports measuring one line and approved at once both land (FR-015, FR-015a)
- [X] T036 [US2] Write one audit entry per submission, approval and reversal from
      `src/projects/dwr/dwr.service.ts`, naming the actor, the report and the quantities moved
      (FR-022), using the existing `AuditEntityType.DWR` and its mapping in
      `src/dashboard/activity-log/module-bucket-mapping.ts` — both added in August and never used
- [X] T037 [US3] Implement `returnToDraft` in `src/projects/dwr/dwr.service.ts`:
      `submitted → draft` (FR-017), moving nothing because submission never moved anything
      (US3 AC2)
- [X] T038 [US3] Implement `reverse` in `src/projects/dwr/dwr.service.ts`: `approved → draft`,
      subtracting exactly what the approval added, recording actor, time and reason and incrementing
      `reversalCount` (FR-019); never driving a counter below zero (FR-021); leaving `approvedAt`
      and `approvedByUserId` **set** (research §7)
- [X] T039 [US3] In `reverse`, implement **FR-020 as the billed-quantity floor**: refuse when the
      reversal would reduce a BOQ line's done quantity below the quantity already billed against it
      on a `submitted`/`certified` `ClientBill` or a `submitted`/`approved` `RABill`, including one
      reaching the line through a `WorkOrderBOQItem`. **Reuse the cumulative-billed-quantity
      aggregate `src/projects/billing/client-bills.service.ts` already computes** rather than writing
      a second one — 018 research §3 chose that aggregate deliberately over a stored counter, and two
      implementations of it would be the disagreement that decision exists to prevent (finding F5).
      Name the bill. Put research §4's reasoning in
      the docblock: **nothing in the data links a bill line to the measurement it consumed**, so
      provenance is not a question the database can answer, and this floor protects the arithmetic
      instead. Say that FR-020a hands the provenance question to feature 023
- [X] T040 [US3] Implement `remove` in `src/projects/dwr/dwr.service.ts`: drafts only, refusing a
      submitted or approved report (FR-023)
- [X] T041 [P] [US2] Unit-test approval in `src/projects/dwr/dwr.service.spec.ts`: submit leaves the
      counter alone, approve increments it, a second approve refuses and it does not move twice, the
      author cannot approve, and a part-failure leaves the report submitted with the line named
- [X] T042 [P] [US3] Create `src/projects/dwr/dwr-reversal.spec.ts` asserting the counter returns to
      its **exact** pre-approval value — not approximately — plus FR-021's floor and the
      billed-quantity refusal of T039

**Checkpoint**: the 008 US5 lifecycle works and is reversible. Commit Phase D on its own.

---

## Phase E: Reading, the logbook, and the contract to 023 (US4, US5, US6)

**Goal**: the day's record can be found, its evidence read across a module boundary, and the figures
a bill will be built from obtained in one request.

**Independent test**: seed reports across three months in two statuses and confirm the list filters
and paginates; seed approved reports across two months and confirm the period figures.

- [X] T043 [US4] Implement `list` in `src/projects/dwr/dwr.service.ts`: project, date-range and
      status filters, ordered by work date, server-paginated with a `total` independent of the page
      returned (FR-026)
- [X] T044 [US4] Implement `findOne` in `src/projects/dwr/dwr.service.ts`, returning each line
      beside its BOQ line's `scopeQty`, `doneQty`, `pendingQty` and period target by reusing
      `BoqService`'s existing projection rather than recomputing it (FR-027)
- [X] T045 [US5] Add `ProjectLogbookSource` to
      `src/projects/portfolio/project-sources.registry.ts`, taking an equipment id and a **list of
      dates** and returning a **map keyed by date**, so a date with no entry is absent rather than
      zero (FR-033). The registry's own docblock already states this rule for cost sources; the
      batched signature is its own lesson about per-project N+1
- [X] T046 [US5] Register the logbook source from `PlantService.onModuleInit` in
      `src/plant/plant.service.ts`, beside the existing machinery and cost registrations. Document
      that the direction is **forced**: `PlantModule` already imports `ProjectsModule`, the reverse
      would close a cycle, and this is the hazard 006 T058/T059 recorded from the other side
      (research §5)
- [X] T047 [US5] In `findOne`, attach the equipment's logbook entry for the work date where a line
      names an `equipmentId`, and report `logbookMissing: true` with a null entry where it has none
      (FR-032, FR-033) — an absence reported as an absence, never as a run of zero
- [X] T048 [US6] Create `src/projects/dwr/dwr-period-figures.service.ts` returning, per BOQ line,
      the measurement approved within a range, before it, and their sum — **aggregated, never
      stored** (FR-034, research §6, following 018 research §3), counting only approved reports and
      excluding reversed ones (FR-035), attributed by **work date** and not approval date (FR-036),
      and refusing an inverted range (FR-038)
- [X] T049 [US6] In `dwr-period-figures.service.ts`, return **every** BOQ line in the project —
      every line under every group, unpriced lines and over-measured lines included — with zeros
      where there is no approved measurement (FR-037), and an empty set rather than an error for a
      project with no BOQ lines (FR-037b)
- [X] T050 [US6] Implement `reconcile(projectId)` in `src/projects/dwr/dwr-period-figures.service.ts`
      (FR-039): per BOQ line, the difference between the stored counter and the authoritative sum,
      at an **exact** tolerance (FR-039a). Docblock the direction of authority: the sum is right by
      construction and the counter is a cache of it (FR-039b)
- [X] T050a [US6] Add an **absolute** set path for a BOQ line's done quantity to
      `src/projects/boq/boq.service.ts`, distinct from `updateDoneQty`'s relative increment and
      reachable only from repair (FR-015b). FR-015 forbids writing a figure read earlier in the same
      operation; a repair cannot obey that, because "make this equal that" is not expressible as an
      increment when the difference is the very thing being corrected. Docblock it as FR-015's sole
      exception and record the previous value. **This contradiction between FR-015 and FR-039c was
      invisible inside the spec** — both requirements are individually sound — and was found only by
      reading across artifacts (finding F1)
- [X] T051 [US6] Implement `repair(boqItemIds, reason)` in
      `src/projects/dwr/dwr-period-figures.service.ts` (FR-039c): explicit, permissioned, audited
      with the previous value, refusing when there is nothing to repair, and **never automatic**.
      Docblock decision D3 — the discrepancy is the only symptom of whatever moved the counter
      without a report, and a silent self-heal destroys that evidence every time it runs
- [X] T052 [P] [US6] **The omitted-line test.** In
      `src/projects/dwr/dwr-period-figures.service.spec.ts`, assert the count of lines returned
      equals the project's own BOQ line count (FR-037a), and that a line with no approved
      measurement is present reading zero. Docblock why the count is asserted and not just the
      contents: an assertion over a returned list passes just as happily over a short list, and a
      bill that silently omits a line is this repository's recurring failure shape
- [X] T053 [P] [US6] In `src/projects/dwr/dwr-period-figures.service.spec.ts`, cover the three
      figures over three approved reports across two months plus one submitted: the period sum, the
      prior sum, the submitted report contributing to none, attribution by work date, and the
      identity that consecutive non-overlapping ranges sum to the line's own `doneQty` (US6 AC6)

**Checkpoint**: 023 has a contract it can be built against. Commit Phase E on its own.

---

## Phase F: Controller, guards, and the isolation proof (cross-cutting)

- [X] T054 Create `src/projects/dwr/dwr.controller.ts` with every route in
      [contracts/dwr-api.md](./contracts/dwr-api.md), `@RequirePermission(Permission.DWR)` on all of
      them (FR-028) and `ProjectLockGuard` on every write, returning **423 and not 403** (FR-008) —
      the same caller may write once the project is unlocked
- [X] T055 In `src/projects/dwr/dwr.service.ts`, scope every read and write through `withRlsContext`
      and report another company's report as **404, not 403** (FR-029), because a 403 confirms the
      row exists
- [X] T056 [P] Add `@nestjs/swagger` decorators to `src/projects/dwr/dwr.controller.ts` so every
      refusal code in `dwr-error-codes.ts` appears in the served contract at `/api`
- [X] T057 Create `test/dwr-rls.e2e-spec.ts` following `test/company-selection-rls.e2e-spec.ts`:
      a `NOSUPERUSER NOBYPASSRLS` probe role, covering **both** `projects."DailyWorkReport"` and
      `projects."DWRTask"` by name (FR-040). Both have carried `tenant_isolation` since August and
      **neither has ever had it in force in a test run** — and `projects."DWRAttachment"`, created
      by T014a, whose policy is new. Docblock FR-040c: the BOQ line table,
      whose counter this feature moves, is deliberately **out** of this suite's scope — it is owned
      by another feature's service, and naming it here would claim coverage this feature does not
      deliver
- [X] T058 In `test/dwr-rls.e2e-spec.ts`, assert the probe role was actually created **before any
      other assertion** (FR-040a) — without it every later assertion runs against a privileged
      connection and passes while proving nothing, which is exactly how a `42501` reached production
      on 2026-10-04
- [X] T059 In `test/dwr-rls.e2e-spec.ts`, make an un-creatable probe role report as **skipped,
      never as passed**, with the reason stated (FR-040b). A console warning and a bare `return`
      renders in a CI summary indistinguishably from a pass, and the visibility is the requirement
- [X] T060 [P] Confirm `test/dwr-rls.e2e-spec.ts` closes any Nest application it creates and
      `$disconnect()`s every `PrismaClient` it constructs, or
      `src/common/prisma/e2e-teardown.spec.ts` will name the file — it scans sources, and a leaking
      suite passes while the twentieth suite fails with an error pointing nowhere near the cause

**Checkpoint**: isolation is proven rather than assumed. Commit Phase F on its own.

---

## Phase G: End-to-end suite and verification

- [X] T061 Create `test/dwr.e2e-spec.ts` covering [quickstart.md](./quickstart.md) passes 1–3: the
      computed quantity and the ignored client figure, the zero-factor refusal, **submit → counter
      unchanged, approve → increments, approve again → refused and it does not move twice** (the 008
      US5 acceptance test that has never been runnable), and reversal returning the counter to its
      exact prior value
- [X] T062 In `test/dwr.e2e-spec.ts`, cover quickstart passes 4–5: the short-day remark, factors
      refused on a presence line, and the logbook read plus its reported absence
- [X] T063 In `test/dwr.e2e-spec.ts`, cover quickstart passes 6–7: the period figures across two
      months, every line present including zeros, the inverted range, and the reconciliation
      reporting a deliberately induced drift
- [X] T064 In `test/dwr.e2e-spec.ts`, cover quickstart pass 8: 423 on a locked project, 403 without
      the permission, and 404 for another company's report
- [X] T065 In `test/dwr.e2e-spec.ts`, cover the two concurrency properties: two reports measuring
      one BOQ line approved at once both landing (FR-015a), and one report approved twice at once
      moving the counter once (FR-014a)
- [X] T066 [P] Confirm `test/dwr.e2e-spec.ts` closes its Nest application and disconnects any
      `PrismaClient`, per T060's reasoning
- [X] T066a Establish **SC-008** in `test/dwr.e2e-spec.ts`: time recording, submitting and
      approving a report of seventeen measurement lines, asserting each step under three seconds,
      and listing a month of reports for one project under two seconds. Until this exists SC-008 is
      a number nobody measures — no task referenced any success criterion at all before
      cross-artifact analysis said so (finding F3). Assert generously enough not to be flaky on a
      loaded machine, and state the margin in a comment rather than silently widening it later
- [X] T067 Run `npx jest src/approvals/fr-022-unmigrated-modules.spec.ts` **before** each of the
      seven phase commits. It diffs two commits, so files this feature adds are invisible to it
      until the commit lands and it then fires one commit late — running it after is running it on
      the wrong tree
- [X] T068 Run `npx prettier --write "src/**/*.ts" "test/**/*.ts"` per this repository's
      `.prettierrc.json`, then `npm run lint` and `npm run build` — both MUST pass before merge
      (constitution, Development Workflow)
- [X] T069 Run the full unit suite (`npm test`) and confirm no existing spec regressed — in
      particular `src/projects/boq/boq.service.spec.ts`, which mocks `updateDoneQty`'s surroundings
      and now has a real caller
- [X] T070 Run the full e2e suite (`npm run test:e2e`) and confirm the baseline of 36 suites / 602
      tests still passes alongside the two new suites

---

## Dependencies

```text
Phase A (migration)  ──> Phase B (quantity)  ──> Phase C (recording, US1)
                                              └─> Phase D (lifecycle, US2+US3)
                                                    └─> Phase E (reading, US4+US5+US6)
                                                          └─> Phase F (controller, RLS)
                                                                └─> Phase G (e2e, verification)
```

- **Phase A blocks everything.** Nothing can hold a served quantity until the column exists.
- **Phase B blocks C, D and E**, all three of which call `quantityInForce`.
- **Phase D depends on C** — there is nothing to submit until something can be created.
- **Phase E's period figures depend on D**, because only approval counts toward them.
- **US4 (reading) could ship after C** without D, and a list of drafts is already worth reading —
  but it is grouped in E to keep the commit boundaries aligned with plan.md's phases.

### Parallel opportunities

| Within | Tasks | Why they are independent |
|---|---|---|
| Phase B | T011, T012, T013, T014 | three test files' worth of cases plus a constants file; no shared edit |
| Phase C | T016, T028 | DTO files and a spec file, distinct from the service |
| Phase D | T041, T042 | two spec files |
| Phase E | T052, T053 | the same spec file, different describes — serialise if editing concurrently |
| Phase F | T056, T060 | decorators and a teardown check |

---

## Implementation strategy

**MVP is Phases A–D.** At that point a day's work can be recorded, submitted, approved and
reversed, and every BOQ line in the system reports a true executed quantity for the first time —
which is the gap this feature exists to close. Phase E is what feature 023 needs; Phase F is what
makes the isolation claim true rather than assumed.

Commit **one phase at a time**, seven commits, running T067's guard before each.

---

## Completion — 2026-10-05

All 74 tasks done, seven phase commits, every verification run green:

| Check | Result |
|---|---|
| `npm test` | **155 suites, 1732 tests** |
| `npm run test:e2e` | **38 suites, 637 tests** (was 36 / 602 — two new suites) |
| `npm run build` | 0 TypeScript issues, 716 files |
| `npm run lint` | 0 errors (76 pre-existing warnings, none in 022's files) |
| `fr-022-unmigrated-modules.spec.ts` | passes, exclusion added for `src/projects/dwr` |
| `e2e-teardown.spec.ts` | passes — both new suites close their app and disconnect |
| `route-shadowing.spec.ts` | passes — after it caught `GET projects/dwr` being shadowed |

### Six things found while building that the documents did not predict

1. **`DailyWorkReport.fileRefs String[]` could not satisfy FR-009.** A bare array of storage
   references holds no file name. `DWRAttachment` is a new table (T014a), and FR-009a was added.
2. **`DailyWorkReport` had no record of who submitted it**, so FR-012a's segregation rule had
   nothing to compare against. `submittedByUserId` and `createdByUserId` are now columns.
3. **`BoqService.updateDoneQty` opens its own transaction**, so it could not serve FR-013's
   all-or-nothing. `applyDoneQtyDeltas` was added for the caller it was written for in August.
4. **`DWRTask` has no `companyId`** — its policy is a correlated lookup on its parent. plan.md and
   data-model.md both claimed otherwise and were corrected.
5. **`Prisma.join([])` throws**, and `reconcile` always passes empty bounds; interpolating a plain
   **array** of `Prisma.Sql` binds it as a parameter and emits `42601 syntax error at or near
   "$5"`. Both found only against a real database, and the second broke every call to the two
   endpoints 023 depends on while every other test passed.
6. **`forbidNonWhitelisted` is on**, so a caller-supplied quantity is *refused* rather than
   stripped — a stronger guarantee than the spec claimed, now asserted as one.

## Out of scope — stated so nobody picks it up

- **Feature 023's bill package, entirely**: the check list sheet, the abstract sheet with its
  Upto-Date / Upto-Previous / This-Month columns, the BOQ annexure, the per-item measurement sheets,
  the debit note register, the GST / recoveries / deductions / TDS spine, and the `.xlsx` renderer.
- **The `buildcore-web` screens**, which are a separate feature in that repository. This feature
  changes no file there, and that repository must never be prettier-formatted.
- **Any change to how `ClientBill` or `RABill` is composed.** 022 adds a read they can default
  from; it alters neither.
- **The provenance link between a bill line and the measurement it consumed.** FR-020a makes
  deciding it an obligation on 023 (research §4).
- **Seven checklist items left for the reviewer**: CHK001, CHK013, CHK018, CHK023, CHK028, CHK030
  and CHK031 in [checklists/silent-failure.md](./checklists/silent-failure.md). They are judgement
  calls about requirement quality, not work items, and the markers belong to the reviewer.
