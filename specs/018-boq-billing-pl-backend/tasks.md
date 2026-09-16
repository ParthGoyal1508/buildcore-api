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

- [ ] T001 Add `rate Decimal @default(0)`, `isVariation Boolean @default(false)` and
      `variationRef String?` to `BOQTaskItem`. Default 0 because the table is populated and a
      required column cannot be added to one — and because a zero rate is visibly wrong on a bill
      whereas a guessed rate is invisibly wrong
- [ ] T002 [P] Expose rate on the BOQ CRUD surface and DTOs
- [ ] T003 [P] Unit-test that a line with rate 0 is refused at billing with `BOQ_RATE_MISSING`,
      not billed at zero

## Phase 2: Client bills with lines (US1)

- [ ] T004 Add `ClientBill` and `ClientBillLine` per data-model.md
- [ ] T005 Hand-author RLS for both — `ENABLE`, `FORCE`, `tenant_isolation`
- [ ] T006 [P] DTOs for compose, submit and certify
- [ ] T007 Implement `compose()` — prices from the BOQ rate and **freezes it onto the line**
- [ ] T008 Implement cumulative billed quantity as an aggregate, never a stored counter (research §3)
- [ ] T009 Implement the over-scope flag at composition and the refusal at submit (research §5)
- [ ] T010 Refuse a bill on a project with no BOQ — `BOQ_REQUIRED`
- [ ] T011 [P] Unit-test the frozen rate: revise the BOQ rate, assert the submitted bill is unchanged.
      **This is the assertion the feature turns on**
- [ ] T012 [P] Unit-test cumulative quantity across two bills
- [ ] T013 e2e in `test/client-bills.e2e-spec.ts`: raise, flag, refuse, supply reason, submit

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
