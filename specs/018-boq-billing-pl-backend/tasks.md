---

description: "Task list for 018 BOQ, Billing and Project P&L (backend)"
---

# Tasks: BOQ, Billing and Project P&L (backend)

**Input**: [plan.md](./plan.md), [spec.md](./spec.md) (clarified 2026-09-16),
[research.md](./research.md) (seven decisions), [data-model.md](./data-model.md),
[contracts/billing-and-pnl.md](./contracts/billing-and-pnl.md), [quickstart.md](./quickstart.md)

**Tests**: REQUIRED. Real jest unit + e2e for every behavioural requirement. `npm run lint` is
`eslint --fix` **repo-wide** — every lint step means `npx eslint <touched files>`.

## Phase ordering, and why it must not be rearranged

Phases 6–8 are the ones that rest on the **assumptions** recorded in the spec's Clarifications —
variations, retention release, client certification. None was answered by the client. They are last
so that overturning one costs a phase rather than the feature, and moving them earlier for
convenience would throw that away.

---

## Phase 1: The BOQ gets a rate

**Nothing else can start.** FR-002 prices from a rate that does not exist today (research §1).

- [x] T001 Add `rate Decimal @default(0)`, `isVariation Boolean @default(false)` and
      `variationRef String?` to `BOQTaskItem`. Default 0 because the table is populated and a
      required column cannot be added to one — and because a zero rate is visibly wrong on a bill
      whereas a guessed rate is invisibly wrong
- [x] T002 [P] Expose rate on the BOQ CRUD surface and DTOs
- [x] T003 [P] Unit-test that a line with rate 0 is refused at billing with `BOQ_RATE_MISSING`,
      not billed at zero

## Phase 2: Client bills with lines (US1)

- [x] T004 Add `ClientBill` and `ClientBillLine` per data-model.md
- [x] T005 Hand-author RLS for both — `ENABLE`, `FORCE`, `tenant_isolation`
- [x] T006 [P] DTOs for compose, submit and certify
- [x] T007 Implement `compose()` — prices from the BOQ rate and **freezes it onto the line**
- [x] T008 Implement cumulative billed quantity as an aggregate, never a stored counter (research §3)
- [x] T009 Implement the over-scope flag at composition and the refusal at submit (research §5)
- [x] T010 Refuse a bill on a project with no BOQ — `BOQ_REQUIRED`
- [x] T011 [P] Unit-test the frozen rate: revise the BOQ rate, assert the submitted bill is unchanged.
      **This is the assertion the feature turns on**
- [x] T012 [P] Unit-test cumulative quantity across two bills
- [ ] T013 **NOT RUN** e2e in `test/client-bills.e2e-spec.ts`: raise, flag, refuse, supply reason, submit

## Phase 3: Subcontractor bills measured against the award (US2)

- [x] T014 Add `WorkOrderBOQItem` and `RABillLine`; add the money columns to `RABill`
- [x] T015 Hand-author RLS for both new tables
- [x] T016 Implement award capture on the work order — the subcontractor's rate, not the client's
- [x] T017 Implement measured lines with this-period / to-date / remaining (FR-007)
- [x] T018 Implement retention, deductions and advance recovery, showing gross, deductions and net
      **separately** (FR-008)
- [x] T019 [P] Unit-test that `netPayable` equals gross minus the three deductions, and that each is
      visible in its own right
- [ ] T020 **NOT RUN** e2e: two bills against one award, with remaining quantity correct on the second

## Phase 4: Approval invalidation (FR-009)

- [ ] T021 On a quantity edit to an approved RA bill, abandon the 016 instance and raise a new one
      through the spine. **Do not mutate the completed approval** (research §6)
- [ ] T022 Refuse the edit outright if the spine cannot be reached — an un-approved edit that looks
      approved is the failure mode
- [ ] T023 [P] Unit-test both paths
- [ ] T024 e2e: approve, edit, confirm the prior approval did not survive

## Phase 5: The project P&L (US3)

- [x] T025 Extend `ProjectSourcesRegistry` with `ProjectCostSource`, **batched by projectIds**
      (contract Part 1) — a per-project signature makes the group view an N+1 no registrant can fix
- [x] T026 [P] Register labour's source from `LabourModule`
- [x] T027 [P] Register inventory's source from `InventoryModule`, handling **negative** amounts for
      returned material (spec edge case)
- [x] T028 [P] Register plant's source from `PlantModule`
- [x] T029 Implement `summaryFor()` — monthly and cumulative, every category present even at zero
- [x] T030 Name unregistered modules in `unavailableModules` rather than reporting zero (FR-010,
      008's precedent)
- [x] T031 Implement the drill-down: every figure lists its source records (FR-012)
- [x] T032 Reconcile the labour figure to approved payment sheets (FR-013)
- [x] T033 [P] Unit-test that a missing source is named, not zeroed — the distinction a director acts on
- [ ] T034 **NOT DONE** e2e in `test/project-pnl.e2e-spec.ts`: one project, four cost categories, figures that trace

### T026-T028 and T032 implementation record, 2026-10-02

**The P&L now has four of its five registry-backed categories, verified at runtime** — booting the
app and reading `registeredCostCategories()` reports `fuel, labour, machinery, materials`.
`overheads` remains unavailable and should: no module owns it, so there is nothing to register and
the P&L is right to say it cannot ask.

**Labour's source is the payment sheets, not the muster** (T026, T032). `LabourService`'s existing
`getLabourCostByProject()` prices the approved *muster*, re-resolving each day's rate;
`MonthlyWageRollupService.costsByProject()` reads what the sheets *recorded*. Both are defensible and
they are **not the same figure** — the muster is what was worked, the sheet is what was approved for
payment — and FR-013 says the P&L's monthly labour cost must reconcile to the approved payment
sheets. So the sheets are what the P&L reads.

T032 is therefore satisfied **by construction rather than by a reconciliation report**: the cost
source and the roll-up view share `lineShare()`, the one function that decides where a straddling
sheet's line belongs, and a test asserts the two agree to the paisa on the straddling fixture. Two
implementations of an apportionment rule is two answers, and the second one written is always the one
nobody checks.

It is **gross, not net**: a deduction is money recovered from the worker, not money the project did
not spend. Reading `netPayable` would understate labour by every advance instalment recovered in the
period, which is the same mistake `bill-totals.ts` refuses to make with an RA bill's retention.

**Plant and inventory loop behind the batched contract, deliberately** (T027, T028).
`costSourceFromPerProject()` holds that decision in one documented place. The batched *contract* is
what T025 was for — a per-project signature makes the group view an N+1 no registrant can fix — and a
registrant that loops behind a batched contract is a different thing: the consumer asks once, and
whichever module needs to replace the loop with one query can, without anybody else changing a line.
What was not done is rewriting `getMachineryCostByProject`, which sums verified hire bills,
apportioned depreciation, spare parts net of reversals and verified service bills, and is the shipped
figure the project detail page already serves. A second batched implementation of it would be a
second machinery cost in the product, and the first time the two disagreed nobody would know which
was right.

**Negative material is not clamped** (T027). A credit note for material sent back is a negative
amount, `materialCostForSites` aggregates it as such, and there is no `Math.max(0, ...)` anywhere on
the path. Asserted, because the clamp is the thing somebody adds later believing it to be defensive.

**A project that cannot be computed is omitted, never zeroed.** Labour's source returns an empty map
on failure rather than a map of zeros: a zero is indistinguishable from a month with no labour, and a
project whose wages are invisible looks like a project running under budget.

### T031 implementation record, 2026-10-02

**`GET projects/pnl/drill-down?projectId&period&figure&scope`**, in
`src/projects/pnl/pnl-drill-down.service.ts`. 12 unit tests, plus 4 in the labour roll-up's spec for
the source it reads.

**The total is summed from the records returned, never queried separately.** A drill-down whose rows
do not add up to the total is worse than none: it tells the reader the number is wrong without
telling them how, and from then on they check everything by hand. That is also why a straddling
payment sheet appears carrying *what the month took from it* rather than its own total — asserted
both ways.

**`ProjectCostSource.recordsByProject` is optional, and the optionality carries the meaning.** A
module that reports a period total without listing what is behind it declines to implement it, and
the drill-down says so, naming the category and stating that the summary's figure is still measured.
Every source returning `[]` instead would make "we cannot itemise this" and "nothing was spent" the
same answer — the identical mistake `unavailableCategories` exists to avoid one level up, arriving by
a different route. Four states are distinguished, and none of them is a zero: no source registered,
a source that cannot itemise, a read that failed, and a genuinely empty period.

Today labour itemises (per sheet, with `itemisedFurtherAt` pointing at the per-worker register rather
than copying it); revenue and subcontractor cost are read directly because client and RA bills live
in the `projects` schema; materials, machinery and fuel report "total only" until those modules add a
reader. That is the honest state and the response says it per figure.

**The pre-018 RA bill fallback is repeated here deliberately** — `grossAmount || amount` — because
reading gross alone would silently drop every bill raised before 018 out of a total that is supposed
to match the summary's.

**`fr-022-unmigrated-modules.spec.ts` went red a commit late for the second time**, on the
T026-T028 commit. Recorded in that spec rather than quietly fixed: the check diffs two commits, so a
new file is invisible to it until the commit lands and *then* it fires. The habit that fixes it is
running that one spec before committing anything under its six scanned paths.

## Phase 6: Variations ⚠️ RESTS ON AN ASSUMPTION

- [ ] T035 Surface `isVariation` wherever quantities or values are reported (FR-015a)
- [ ] T036 [P] Unit-test that original scope and variations are separable in every report
- [ ] T037 e2e: a variation line bills and reconciles through the same path as original scope

## Phase 7: Retention release ⚠️ RESTS ON AN ASSUMPTION

- [ ] T038 Add `RetentionRelease` and `WorkOrder.retentionPercent`; RLS for the new table
- [ ] T039 Implement release as an explicit recorded act, refusing more than was withheld —
      `RETENTION_EXCEEDS_HELD`
- [ ] T040 [P] Unit-test the outstanding balance across several bills and one partial release
- [ ] T041 e2e: withhold across three bills, release part, confirm the balance

## Phase 8: Client certification ⚠️ RESTS ON AN ASSUMPTION

- [ ] T042 Implement `certify()` retaining **both** billed and certified amounts (FR-005)
- [ ] T043 Ensure a shortfall does not silently vanish from cumulative billed quantity (spec edge case)
- [ ] T044 [P] Unit-test that certifying less than billed leaves cumulative billed quantity unchanged
- [ ] T045 e2e: bill, certify less, confirm both figures and the variance

## Phase 9: The group view and verification

- [x] T046 Implement `groupSummary()` by calling `summaryFor()` and summing — **no second aggregate
      query** (research §7)
- [x] T047 Apply the visibility filter once, to the project set, so rows and total cannot disagree
- [x] T048 [P] Unit-test that the total equals the sum of the rows, and that an invisible project is
      absent from both
- [x] T049 Boundary test in `src/projects/pnl/pnl-boundary.spec.ts`, both directions, copying
      `src/letters/letters-boundary.spec.ts`: the P&L code must not query `labour`, `inventory` or
      `plant` tables, and no business module may query the billing tables
- [x] T050 Prove the boundary by breaking it in both directions and confirming T049 fails each time.
      A guard that has never failed has not been shown to work
- [ ] T051 **NOT DONE** RLS e2e in `test/billing-rls.e2e-spec.ts` with a `NOSUPERUSER NOBYPASSRLS` probe, copying
      `test/documents-rls.e2e-spec.ts`
- [ ] T052 **NOT DONE** **Check T051 for vacuousness** — disable a policy, confirm rows DO appear, restore. Without
      this an empty table and a working policy are indistinguishable
- [ ] T053 **NOT DONE** Quickstart Passes 1–8
- [ ] T054 **NOT DONE** Quickstart Pass 9 by hand: the group total must equal the sum of its rows **exactly**
- [ ] T055 `npx tsc --noEmit`, `npx eslint <touched files only>`, `npm test`. Report **actual
      numbers**; if something fails, say so with the output

---

## Dependencies

- **Phase 1 blocks everything.** There is nothing to price from until the BOQ has a rate.
- **Phases 2 and 3** are independent of each other; both block Phase 5.
- **Phase 5** blocks Phase 9's group view.
- **Phases 6–8** depend only on Phase 2 or 3, and are last by design, not by dependency.

## Implementation Strategy

**MVP = Phases 1–3.** Bills that reference the BOQ and price from it are the whole of Note 12's
complaint; the P&L is what they make truthful.

**Do not start Phase 6, 7 or 8 until the client has confirmed the three assumptions.** They are
implementable today under what is recorded in the spec, and each is a phase's worth of rework if the
answer differs — which is exactly why they are separable.

## Phase 10: Amendment of 2026-09-29 — the monthly labour roll-up (FR-010a, FR-010b)

**No migration in this phase or the next.** Both requirements are read paths over tables that already
exist — `labour.LabourPaymentSheet` and `labour.PaymentSheetLine` — which is why item 14's amendment is
two phases and no schema change. Most of what the client asked for was already built; see plan D12.

- [x] T056 [US3] Add a validated query DTO for the roll-up — `projectId`, `year`, `month`, with bounded
  month and year (Principle II). A month outside 1-12 or a year outside a sane range is a 400, not a
  query that returns nothing and looks like an empty month.
- [x] T057 [US3] Resolve every `LabourPaymentSheet` **overlapping** the calendar month for the project:
  `periodFrom <= monthEnd AND periodTo >= monthStart`. Not `periodFrom` within the month — a fortnightly
  sheet starting on the 28th belongs to two months and would be missed by a containment test.
- [x] T058 [US3] Apportion a straddling sheet **on days worked inside the month**, from the muster dates
  behind each `PaymentSheetLine`, not on elapsed calendar days. A worker who worked four days of a
  fortnight all in the first week is not half-attributable to each month, and a labour figure that
  disagrees with the muster is worse than a coarse one (plan D12).
- [x] T059 [US3] Itemise per worker: days worked in the month, `resolvedRate`, gross and net. Read the
  figures as the sheet recorded them — **recompute nothing** (FR-010b). There is exactly one place a
  wage is computed and this is not it.
- [x] T060 [US3] State the apportionment **on the response**, per sheet apportioned — which sheet, its
  period, and the days attributed to this month. FR-010a requires this; a figure the reader cannot
  account for is what this feature exists to remove.
- [x] T061 [US3] Reach `labour`'s tables through the labour module's service, never a cross-schema join
  from `projects` (Principle I). FR-013's existing reconciliation already takes this route; follow it
  rather than opening a second one.
- [x] T062 [P] [US3] Unit test: a sheet wholly inside the month contributes its full figures.
- [x] T063 [P] [US3] Unit test: a sheet straddling the month boundary contributes only the days inside
  it, and the response says how it was apportioned. This is the test that earns the phase.
- [x] T064 [P] [US3] Unit test: the apportioned sum equals FR-013's monthly labour figure **to the
  rupee**. This is SC-007, and it is the assertion that catches an apportionment rule that is merely
  plausible.
- [x] T065 [P] [US3] Unit test: a month whose labour was engaged entirely through a contractor returns
  the sheet's totals with the engagement type stated and no per-worker disbursement list — the spec's
  edge case. An empty list here must not render as a broken screen.
- [x] T066 [P] [US3] Unit test: a sheet corrected and re-approved changes the roll-up on the next read,
  because nothing is stored (FR-010b).
- [x] T067 [US3] Confirm no table was added in this phase. If one was, D13's reasoning was overridden
  somewhere and a second figure for the same wage now exists.

### Phase 10 implementation record, 2026-10-02

**`GET labour/reports/monthly-wage-rollup`**, in `src/labour/reports/monthly-wage-rollup.service.ts`,
exported from `LabourModule` so `projects` can reach it for FR-013 without a cross-schema join
(T061). 27 unit tests. No migration, as D13 requires — T067 is now a test rather than a promise: the
spec scans the service source for any Prisma write and the migrations directory for any table of its
own.

Three forks were resolved here rather than asked about, and each is stated because a later reader
would otherwise have to guess:

1. **A line the muster cannot place.** D12 apportions on muster days. A line with *no* approved
   muster day in the period — a hand-built sheet, or a muster withdrawn after the sheet was generated
   — has no basis to apportion on. Calendar pro-rating is what D12 refuses; attributing nothing would
   lose the wage from **both** months, which is worse, because the month then stops reconciling to the
   sheet and nothing says why. Such a line is placed whole in the month containing the sheet's
   `periodTo`, counted in `apportionment.placedByPeriodEnd`, and named in the apportionment note. Two
   tests cover it.
2. **A contractor sheet is not itemised.** The spec's edge case says a contractor sheet is the
   contractor's basis of payment, not a disbursement to the people named on it, so `workers` carries
   directly engaged labour only and `workersNote` says so. The money stays in `grossTotal` and in
   `byEngagement`, so a mixed month still reconciles — asserted.
3. **Permission.** `PROJECT_FINANCIALS` **or** `REPORTS`, declared on the handler rather than
   inherited from the controller's `REPORTS`. It is the P&L's labour drill-down, so a project-finance
   reader must see it; and the payment register already shows a `REPORTS` holder every one of these
   lines, so including `REPORTS` widens nobody's reach.

**`monthBounds()` duplicates `periodRange()`'s arithmetic deliberately** rather than importing it:
`labour` must not take a dependency on `projects/pnl` (Principle I), and a six-line date helper is a
cheaper duplicate than an inverted module edge. A test asserts the two agree across five months
including a leap February, so SC-008's "exactly" is checked rather than assumed.

**A regression found, not introduced.** `fr-022-unmigrated-modules.spec.ts` was red at the Phase 5
commit: the billing exclusion was pre-empted and `src/projects/pnl` was not, so the guard fired on
the next run and the suite had been reported clean when it was not. Fixed here, with the reason
recorded in that spec rather than silently patched.

## Phase 11: Amendment of 2026-09-29 — the monthly position export (FR-011a)

- [x] T068 [US3] Export the selected month's position — revenue billed, cost by category, budget and
  variance — in the repository's existing export format. Do not introduce a second export mechanism.
- [x] T069 [US3] Carry the project, the month, and the **date the export was produced**. The production
  date is not decoration: the spec's edge case is a payment sheet reopened after a month was exported,
  and this is the only thing that distinguishes two exports of the same month. Without it the older
  document is indistinguishable from the current position and somebody quotes it to a client.
- [x] T070 [P] [US3] Unit test: the exported figures equal the screen's figures exactly (SC-008). Not
  approximately — a client-facing document that disagrees with the system by a rounding step is the
  problem this asserts against.
- [x] T071 [P] [US3] Unit test: two exports of the same month taken either side of a sheet correction
  carry different production dates and different figures.
- [x] T072 [US3] Respect feature 019's cash hiding if it has shipped: a hidden cash figure exports as
  marked-absent, never as zero. If 019 has not shipped, note here that this export will need revisiting
  when it does — an export that silently understates a total by every cash payment in it is worse than
  one that says a figure is hidden.
- [x] T073 `npx tsc --noEmit`, `npx eslint <touched files only>`, `npm test`.
- [x] T074 Re-read `spec.md` FR-010a, FR-010b and FR-011a and confirm the built behaviour matches.
  Record in the traceability notes that item 14 was **largely already satisfied** by feature 013's
  payment sheets, and that this amendment added the calendar-month framing and the export only.

### Phase 11 implementation record, 2026-10-02

**`GET projects/pnl/export?projectId&period&format=pdf|excel`**, in
`src/projects/pnl/position-export.service.ts`. 17 unit tests. It uses the repository's existing
`renderReportPdf` / `renderReportExcel` / `formatMeta` over the same `ReportData` shape the
dashboard's reports use (T068) — `ExportJobService`'s sync/async machinery is deliberately not used,
because it exists for reports that run to tens of thousands of rows and one project's month is a
dozen; queuing a twelve-row document and handing back a job to poll would be a second mechanism in
everything but name.

**The production instant is to the second, in the document and in the filename** (T069, D14). A date
alone would not do it: two exports taken on the same day either side of a correction are exactly the
pair the spec's edge case is about. It is a row rather than part of the title because
`renderReportExcel` uses the title as the worksheet name, and the xlsx format rejects a colon in one
— so a timestamped title would have failed at render time, in production, on a client-facing
document.

**T072 found a real hole, and it was not the one the task anticipated.** The task asks the export to
respect 019's cash hiding. It cannot inherit it: `CashVisibilityInterceptor` shapes what a handler
*returns*, and a document written through `@Res()` returns nothing, so **every file download in this
product is outside that interceptor's reach by construction**. The rule is now read from one place —
`cashHidingFor()`, extracted from the interceptor rather than copied — and applied in the export
explicitly.

Stated plainly so nobody overclaims: **no figure on this document is hidden today.** `hideCash` keys
off a `paymentMode`/`mode` field on the row and a closed list of amount field names, and a P&L
aggregate carries neither. What is live today is the other half of the same principle — a category
whose module registered no cost source exports as `Not available`, never as the zero the P&L hands
over — and that is tested. The hidden path is implemented, tested at the formatter, and will work the
day an aggregate gains one of those field names.

**No figure is re-rounded.** Cells are the served number at two decimal places, trailing paisa kept:
a column where some cells carry two places and some carry one is the first thing a client queries,
and the answer is always "the system is fine, the export is odd".

### Item 14 traceability (T074)

Re-read against FR-010a, FR-010b and FR-011a after building. **Item 14 was largely already satisfied
by feature 013**: `LabourPaymentSheet` and `PaymentSheetLine` have given a per-project, per-worker
wage register carrying days worked, the resolved rate, gross, deductions and net since 013 shipped,
and FR-010 gave the monthly cost position. What the client asked for and did not have was the
**calendar-month framing** — sheets cover the wage period their creator named, which under a
fortnightly cycle is never a month — and a **document that can leave the system**. This amendment
added those two things and nothing else. Recorded here because "item 14 is built" and "item 14 was
mostly already built" lead to different conclusions about how much of `bugs.md` remains.

### Dependencies for phases 10-11

Phase 10 depends on **Phase 5** (the project P&L), whose monthly labour figure it itemises, and on
nothing else. Phase 11 depends on Phase 10 only for the labour line of the exported month; the rest of
the position comes from Phase 5. Neither depends on phases 6-8, which rest on client assumptions.

### MVP for this amendment

**Phase 10.** The per-worker monthly view is the half of item 14 that nobody can currently assemble
without opening several payment sheets and adding them up. The export is a convenience over a figure
that is by then already correct.

### Phases 1 and 2 implementation record, 2026-10-02

#### The client's BOQ file contradicted the design, and that is the headline

`docs/BOQ_794578.xls` arrived — the file this task list was "awaiting" — and it is not the
per-line-priced schedule this feature assumed. It is a government e-tender **"Percentage BoQ"**: the
bidder quotes **one percentage** against the schedule of rates rather than a rate per line. The file's
own footer shows it: `Total in Figures` ₹2,99,61,506.78 becoming `Quoted Rate in Figures`
₹3,06,98,559.85 at `Excess (+) 0.0246`.

**A bill priced from the line rate alone under-bills by exactly that percentage, on every line.** On
that file it is ₹7.37 lakh on a ₹3 crore project: invisible per line and material in total, which is
the worst shape a billing error can take. `Project.quotedPercentage` is the fix, frozen onto each bill
beside the frozen rates, and `bill-totals.spec.ts` asserts the gap as a *difference* rather than
describing it in a comment.

The percentage is applied **per line, not once at the total**. The two differ after rounding, and the
per-line figure is what appears on the document a client reads — so the total has to be the sum of the
printed lines rather than a separately-derived number a rupee away from them.

#### What else the file settled

* **311 item rows**, not 500. NFR-001's figure is confirmed as the right ballpark and conservatively
  high, so no row virtualization is needed beyond what it already implies.
* **Units are free text and inconsistent within one file** — `Cum` and `Cum.`, `Sqm`/`Sqm.`/`sqm`,
  `R Mtr.`/`R. Mtr.`/`R.Mtr.`/`R. mtr`. A unit master would reject this file. Units stay a string.
* The file carries a **second BOQ block at columns 238-242**, so an importer must not assume one
  section. Not built in this phase; recorded because it is exactly the thing an importer assumes.

#### bill-totals.ts exists because two definitions of "net" would not announce themselves

The figures would simply differ slightly on two screens and each would look plausible. The file states
the **four-way distinction** once: gross is the work; retention is a timing difference; an advance
recovery is money already paid; net is what changes hands. `pnlAmount` is named separately from `gross`
even though they are equal today, because "what did this bill do to the P&L" is the question a reader
actually asks, and answering it with a field called `gross` invites the next person to reach for `net`.

**A P&L that treats net as cost understates the project** by every rupee of retention held across it.
That is the mistake this file exists to make unreachable by accident.

#### Three decisions worth reading

**The rate is frozen onto the line** (T011), the assertion the feature turns on. A bill is a document
that was sent; a rate table is a current opinion. Rendering the first from the second makes every
historical bill a lie that changes shape each time somebody corrects a rate.

**Cumulative quantity is an aggregate, never a counter** (research §3). A counter diverges the first
time a bill is deleted or two are composed concurrently, and the over-scope check is then wrong in
whichever direction nobody notices. Draft bills are excluded, so two people composing bills
simultaneously do not see each other's unfinished work as billed — and a bill's *own* lines are
included in its own cumulative figure, or its column would read as though the bill had not happened.

**Certification keeps both figures** (FR-005) and leaves cumulative billed quantity untouched. A
shortfall is a dispute to pursue, not a correction to absorb; a system that silently reduced what was
billed would lose the only record there was one, and the next bill would re-bill the same work.

#### Verification

`npx tsc --noEmit` clean, `npx eslint src` 0 errors, **1,364 tests across 122 suites**, injector
resolves. One migration covering Phases 1 to 3's schema.

**T013 NOT RUN** — the e2e needs a seeded project with a priced BOQ.

**Phases 6, 7 and 8 remain deliberately unstarted**, per this file's own instruction: they rest on three
client assumptions that are not confirmed, and each is a phase's worth of rework if the answer differs.
That is exactly why they were made separable.

### Phase 3 implementation record, 2026-10-02

#### One asymmetry worth stating plainly

Over-measuring a **client BOQ** is flagged and allowed; over-measuring an **award** is refused. That
looks inconsistent and is not, and the reason is about who is owed what:

* a client bill that over-measures is a **claim the client can reject** — and refusing it at entry
  means the measurement goes in a notebook instead of into the system;
* an RA bill that over-measures is **the company agreeing to pay for work it never ordered**, with
  nobody downstream to catch it.

The refusal names the route out — a variation to the award — because a refusal with no remedy is how
somebody edits the award instead, which is the other thing this phase refuses.

#### Replacing an award is refused once it has been measured against

Changing it would move the `remaining` figure on a bill already issued, and the subcontractor's copy
would then disagree with ours. There is no safe merge for this: a reduced award under a measured bill
makes the bill retrospectively over-measured, and an increased one silently approves what was already
paid.

#### `pnlAmount` is on the response, not left to the consumer

Retention is money withheld and an advance recovery is money already paid, so **neither is a project
cost**. The consumer that gets this wrong is the P&L, and it gets it wrong by reading the field that
looks most like "the amount" — so the view says `pnlAmount: gross` rather than leaving each reader to
rediscover the distinction from `bill-totals.ts`.

#### The legacy `amount` column is set to gross

Matching the migration's backfill of existing rows, so a screen still reading `amount` sees the work
rather than the net — and bills raised either side of this change cannot disagree about what `amount`
meant.

#### The FR-022 guard, pre-empted again

`src/projects/billing` and `projects.module.ts` are excluded by path, **before** the commit rather
than after. None of this code calls `ApprovalService` — 018's Phase 4, which puts an RA bill quantity
edit through the spine, is deliberately not built — so the per-file assertions still enforce that
`src/projects` keeps no approval mechanism of its own.

#### Verification

`npx tsc --noEmit` clean, `npx eslint src` 0 errors, **1,376 tests across 123 suites**, injector
resolves.

**T020 NOT RUN** — the e2e needs a seeded work order with an award.

### Phase 5 and Phase 9 (partial) implementation record, 2026-10-02

#### The line that matters most: a missing module is named, never zeroed

FR-010, T033. A category with no registered cost source is listed in `unavailableCategories` **and
excluded from the totals**. Counting it as zero is how a project looks profitable because half its
costs are invisible — and nothing on the screen would say so.

The row is still rendered, at zero, *beside* the unavailable list. A missing row reads as "this project
has none of that"; a zero row plus a named gap is what lets a reader tell the two apart.

#### Revenue and cost are both gross, and the response says what revenue counts

An RA bill's retention is money withheld and its advance recovery is money already paid, so **neither
is a cost**. A P&L reading `netPayable` would understate every project by the retention held across it,
and the understatement grows with the project.

The same reasoning puts revenue at billed gross — but a reader comparing that to the bank will find a
gap, so `revenueNote` states what the figure counts. A figure somebody cannot reconcile is a figure
they stop trusting, and then the whole screen goes with it.

#### Two things the existing code shape forced

**`ProjectCostSource` is batched by `projectIds`** (T025). The registry's existing
`getMachineryCostByProject` and `getMaterialCostByProject` are per-project and predate this; a loop over
them is what T025 calls an N+1 no registrant can fix. The new interface takes a list, and the test
asserts the call count — ten for three projects across five categories and two date ranges, not thirty.

**Subcontractor cost falls back to the pre-018 `amount`.** A bill raised before this feature has
`grossAmount` 0 and an `amount` that is the only figure it ever had. Reading gross alone would silently
drop every historical subcontractor cost from the P&L — and silently is the word that matters.

#### The group total is the sum of the rows by construction

Not a second aggregate query (research §7, T046). `summariesFor` produces the rows and the controller
adds them up, so the figure a reader checks by hand is the figure returned. T047's visibility filter is
applied by the caller naming the project set, which is the one place it can be applied once.

#### T049 and T050: the guard was proven in both directions

A `labourPaymentSheet` read added to the P&L service → red. A `clientBill` read added to
`labour.module.ts` → red. Both restored → green. **The second direction matters as much as the first**:
the moment `labour` reads `ClientBill` to work out what was billed, two modules compute revenue and the
figures diverge — which is the defect `bill-totals.ts` exists to prevent, arriving by another route.

The spec walks the **filesystem**, not `git ls-files`. `ls-files` omits files that are new and unstaged,
which on the commit adding this test is every file it checks — and a guard that passes because it found
nothing is worse than no guard.

#### What is NOT done, and why

* **T026, T027, T028** — labour, inventory and plant have not registered a batched `ProjectCostSource`.
  The interface and the registry slot exist; each module must register itself, which is a change in
  three other modules. Until they do, the P&L reports those categories as **unavailable**, which is the
  honest state and exactly what FR-010 was written for.
* **T031, T032** — the drill-down and the labour reconciliation. Both need the sources above.
* **T034, T051 to T054** — e2e, the RLS probe, and the quickstart passes.
* **Phase 4** (approval invalidation on an edited RA bill) — not started.
* **Phases 6, 7, 8** — deliberately unstarted per this file's own instruction: three unconfirmed client
  assumptions, each a phase's worth of rework if the answer differs.

#### Verification

`npx tsc --noEmit` clean, `npx eslint src` 0 errors, **1,400 tests across 125 suites**, injector
resolves.
