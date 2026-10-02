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

- [ ] T014 Add `WorkOrderBOQItem` and `RABillLine`; add the money columns to `RABill`
- [ ] T015 Hand-author RLS for both new tables
- [ ] T016 Implement award capture on the work order — the subcontractor's rate, not the client's
- [ ] T017 Implement measured lines with this-period / to-date / remaining (FR-007)
- [ ] T018 Implement retention, deductions and advance recovery, showing gross, deductions and net
      **separately** (FR-008)
- [ ] T019 [P] Unit-test that `netPayable` equals gross minus the three deductions, and that each is
      visible in its own right
- [ ] T020 e2e: two bills against one award, with remaining quantity correct on the second

## Phase 4: Approval invalidation (FR-009)

- [ ] T021 On a quantity edit to an approved RA bill, abandon the 016 instance and raise a new one
      through the spine. **Do not mutate the completed approval** (research §6)
- [ ] T022 Refuse the edit outright if the spine cannot be reached — an un-approved edit that looks
      approved is the failure mode
- [ ] T023 [P] Unit-test both paths
- [ ] T024 e2e: approve, edit, confirm the prior approval did not survive

## Phase 5: The project P&L (US3)

- [ ] T025 Extend `ProjectSourcesRegistry` with `ProjectCostSource`, **batched by projectIds**
      (contract Part 1) — a per-project signature makes the group view an N+1 no registrant can fix
- [ ] T026 [P] Register labour's source from `LabourModule`
- [ ] T027 [P] Register inventory's source from `InventoryModule`, handling **negative** amounts for
      returned material (spec edge case)
- [ ] T028 [P] Register plant's source from `PlantModule`
- [ ] T029 Implement `summaryFor()` — monthly and cumulative, every category present even at zero
- [ ] T030 Name unregistered modules in `unavailableModules` rather than reporting zero (FR-010,
      008's precedent)
- [ ] T031 Implement the drill-down: every figure lists its source records (FR-012)
- [ ] T032 Reconcile the labour figure to approved payment sheets (FR-013)
- [ ] T033 [P] Unit-test that a missing source is named, not zeroed — the distinction a director acts on
- [ ] T034 e2e in `test/project-pnl.e2e-spec.ts`: one project, four cost categories, figures that trace

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

- [ ] T046 Implement `groupSummary()` by calling `summaryFor()` and summing — **no second aggregate
      query** (research §7)
- [ ] T047 Apply the visibility filter once, to the project set, so rows and total cannot disagree
- [ ] T048 [P] Unit-test that the total equals the sum of the rows, and that an invisible project is
      absent from both
- [ ] T049 Boundary test in `src/projects/pnl/pnl-boundary.spec.ts`, both directions, copying
      `src/letters/letters-boundary.spec.ts`: the P&L code must not query `labour`, `inventory` or
      `plant` tables, and no business module may query the billing tables
- [ ] T050 Prove the boundary by breaking it in both directions and confirming T049 fails each time.
      A guard that has never failed has not been shown to work
- [ ] T051 RLS e2e in `test/billing-rls.e2e-spec.ts` with a `NOSUPERUSER NOBYPASSRLS` probe, copying
      `test/documents-rls.e2e-spec.ts`
- [ ] T052 **Check T051 for vacuousness** — disable a policy, confirm rows DO appear, restore. Without
      this an empty table and a working policy are indistinguishable
- [ ] T053 Quickstart Passes 1–8
- [ ] T054 Quickstart Pass 9 by hand: the group total must equal the sum of its rows **exactly**
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

- [ ] T056 [US3] Add a validated query DTO for the roll-up — `projectId`, `year`, `month`, with bounded
  month and year (Principle II). A month outside 1-12 or a year outside a sane range is a 400, not a
  query that returns nothing and looks like an empty month.
- [ ] T057 [US3] Resolve every `LabourPaymentSheet` **overlapping** the calendar month for the project:
  `periodFrom <= monthEnd AND periodTo >= monthStart`. Not `periodFrom` within the month — a fortnightly
  sheet starting on the 28th belongs to two months and would be missed by a containment test.
- [ ] T058 [US3] Apportion a straddling sheet **on days worked inside the month**, from the muster dates
  behind each `PaymentSheetLine`, not on elapsed calendar days. A worker who worked four days of a
  fortnight all in the first week is not half-attributable to each month, and a labour figure that
  disagrees with the muster is worse than a coarse one (plan D12).
- [ ] T059 [US3] Itemise per worker: days worked in the month, `resolvedRate`, gross and net. Read the
  figures as the sheet recorded them — **recompute nothing** (FR-010b). There is exactly one place a
  wage is computed and this is not it.
- [ ] T060 [US3] State the apportionment **on the response**, per sheet apportioned — which sheet, its
  period, and the days attributed to this month. FR-010a requires this; a figure the reader cannot
  account for is what this feature exists to remove.
- [ ] T061 [US3] Reach `labour`'s tables through the labour module's service, never a cross-schema join
  from `projects` (Principle I). FR-013's existing reconciliation already takes this route; follow it
  rather than opening a second one.
- [ ] T062 [P] [US3] Unit test: a sheet wholly inside the month contributes its full figures.
- [ ] T063 [P] [US3] Unit test: a sheet straddling the month boundary contributes only the days inside
  it, and the response says how it was apportioned. This is the test that earns the phase.
- [ ] T064 [P] [US3] Unit test: the apportioned sum equals FR-013's monthly labour figure **to the
  rupee**. This is SC-007, and it is the assertion that catches an apportionment rule that is merely
  plausible.
- [ ] T065 [P] [US3] Unit test: a month whose labour was engaged entirely through a contractor returns
  the sheet's totals with the engagement type stated and no per-worker disbursement list — the spec's
  edge case. An empty list here must not render as a broken screen.
- [ ] T066 [P] [US3] Unit test: a sheet corrected and re-approved changes the roll-up on the next read,
  because nothing is stored (FR-010b).
- [ ] T067 [US3] Confirm no table was added in this phase. If one was, D13's reasoning was overridden
  somewhere and a second figure for the same wage now exists.

## Phase 11: Amendment of 2026-09-29 — the monthly position export (FR-011a)

- [ ] T068 [US3] Export the selected month's position — revenue billed, cost by category, budget and
  variance — in the repository's existing export format. Do not introduce a second export mechanism.
- [ ] T069 [US3] Carry the project, the month, and the **date the export was produced**. The production
  date is not decoration: the spec's edge case is a payment sheet reopened after a month was exported,
  and this is the only thing that distinguishes two exports of the same month. Without it the older
  document is indistinguishable from the current position and somebody quotes it to a client.
- [ ] T070 [P] [US3] Unit test: the exported figures equal the screen's figures exactly (SC-008). Not
  approximately — a client-facing document that disagrees with the system by a rounding step is the
  problem this asserts against.
- [ ] T071 [P] [US3] Unit test: two exports of the same month taken either side of a sheet correction
  carry different production dates and different figures.
- [ ] T072 [US3] Respect feature 019's cash hiding if it has shipped: a hidden cash figure exports as
  marked-absent, never as zero. If 019 has not shipped, note here that this export will need revisiting
  when it does — an export that silently understates a total by every cash payment in it is worse than
  one that says a figure is hidden.
- [ ] T073 `npx tsc --noEmit`, `npx eslint <touched files only>`, `npm test`.
- [ ] T074 Re-read `spec.md` FR-010a, FR-010b and FR-011a and confirm the built behaviour matches.
  Record in the traceability notes that item 14 was **largely already satisfied** by feature 013's
  payment sheets, and that this amendment added the calendar-month framing and the export only.

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
