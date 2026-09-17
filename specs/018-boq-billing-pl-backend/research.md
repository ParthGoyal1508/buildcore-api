# Research: BOQ, Billing and Project P&L (018, backend)

**Date**: 2026-09-16 · Spec: [spec.md](./spec.md) (clarified 2026-09-16)

Every decision below was taken against the **shipped schema**, not against a document. The most
important thing that reading it changed is §1, which found that the feature's central requirement
has nothing to stand on today.

---

## §1 — `BOQTaskItem` has no rate, and FR-002 cannot be met without one

`model BOQTaskItem` (schema.prisma:1374) carries `boqNo`, `taskName`, `unit`, `scopeQty`,
`perDayQty`, `doneQty` and dates. **There is no rate anywhere in the BOQ.**

FR-002 — "compute client bill line value from executed quantity and the BOQ rate in force" — is
therefore not a matter of wiring existing data together. The rate does not exist. 008 built the BOQ
as a *schedule of work* for planning and DWR progress; 018 needs it to also be a *schedule of rates*.

**Decision**: add `rate Decimal @db.Decimal(18, 2)` to `BOQTaskItem`, defaulting to 0, plus
`isVariation Boolean @default(false)` and `variationRef String?` per the clarification.

**Why a default of 0 rather than a required column**: the table is populated on every installation
that has used the BOQ, and a required column cannot be added to a populated table (the same
constraint 017 §1 hit). A zero rate is also the honest starting value — it prices a line at nothing,
which is visibly wrong on a bill and therefore gets fixed, whereas a guessed rate is invisibly wrong.

**Alternative considered and rejected**: a separate `BOQRate` table versioned by date. It answers a
question nobody asked — the spec's FR-002 freezes the rate *onto the bill*, so historical rates are
already retained where they matter, and a second table would need joining on every line of every
bill for no additional truth.

---

## §2 — Bills get lines; `Revenue` and `RABill` keep their heads

`Revenue` and `RABill` are both flat today: a description, an amount, a date, a status. The gap
sentence in the spec is precisely that client billing "carries only a description, an amount, a date
and a status".

**Decision**: add `ClientBill` + `ClientBillLine` and `RABillLine`, rather than widening `Revenue`.

- `ClientBill` is a **new** model. `Revenue` stays exactly as it is and keeps its meaning: money
  received, entered directly. A client bill is a different thing — a claim made, priced from the
  BOQ — and collapsing the two would make "revenue" mean two things on the same screen.
- `RABillLine` attaches to the **existing** `RABill`, because an RA bill already is the subcontractor
  bill; what it lacks is measurement. Replacing it would orphan the approval state 008 already built
  on it and the `ProjectLockGuard` that governs it.

**The `amount` on `RABill` becomes derived but is NOT dropped.** Existing rows have amounts and no
lines, and dropping the column would erase them. New bills compute it from their lines; old ones keep
what they were entered with. The service sets it in the same transaction that writes the lines, so
the two cannot disagree.

---

## §3 — Cumulative billed quantity is computed, never stored

FR-003 needs cumulative billed quantity per BOQ line. The obvious implementation is a running total
on `BOQTaskItem`, incremented as bills are raised.

**Decision**: compute it with an aggregate over `ClientBillLine`, grouped by `boqTaskItemId`.

**Why**: a stored running total is a second source of truth for a number that is already fully
determined by the bill lines, and every path that edits, voids or deletes a bill has to remember to
adjust it. `doneQty` on `BOQTaskItem` is exactly this pattern already and is maintained by DWR — one
denormalised counter per table is a maintenance cost; two that can disagree about the same line is a
reconciliation bug waiting for a month-end.

The cost is one `groupBy` per bill composition screen. It is bounded by the number of BOQ lines in a
project, not by the number of bills, and it is indexed.

---

## §4 — The P&L roll-up crosses four module boundaries and must not query any of them

FR-010 needs, per project per month: revenue billed, subcontractor cost, labour cost, material issued
and plant cost. Those live in `projects`, `labour`, `inventory` and `plant` respectively.

**Decision**: a registry, exactly as 008 already built for the project detail page.

`ProjectSourcesRegistry` (src/projects/portfolio/project-sources.registry.ts) is the shipped precedent:
Plant and Inventory *register* themselves with the projects module rather than being imported by it,
which is what keeps the dependency pointing one way. 018 extends the same registry with a
`costSource` contributing `(projectId, month) → amount`.

**Why not events**: a monthly roll-up is a pull, not a push. An event-sourced running total would be
a third denormalised counter (see §3) and would be wrong for any month whose source records were
corrected after the fact — which is normal for payment sheets.

**A module that has not registered contributes nothing and is NAMED.** 008 established
`unavailableModules` for precisely this, and the distinction it draws — "we asked and there is none"
versus "we could not ask" — is the difference between a zero a director can act on and one they
cannot.

---

## §5 — Over-billing is refused at submit, not at entry

FR-004 requires an excess quantity to be flagged and to need an explicit reason.

**Decision**: the flag is computed and returned on every line as the bill is composed; the *refusal*
happens at submit, and only submit.

**Why not refuse at entry**: a billing engineer types quantities across twenty lines and discovers
the excess on line three after entering the other seventeen. Refusing the keystroke means the
correction has to happen before anything else can be entered; flagging it means they finish, see the
one line that needs a reason, and supply it. The system's obligation is that the bill cannot be
*submitted* without the reason, which is what FR-004 actually says.

---

## §6 — Editing an approved RA bill's quantities invalidates its approval

FR-009. 016 owns approval state and 018 must not reimplement it.

**Decision**: on any quantity edit to an approved RA bill, call the 016 spine to abandon the existing
instance and raise a new one, and refuse the edit outright if the spine cannot be reached.

**Why abandon-and-raise rather than mutate**: 016's chain records *what was approved*. Editing the
quantities under a completed approval would leave a recorded decision describing a bill that no
longer exists — the approver's name against numbers they never saw. That is worse than making them
approve again.

---

## §7 — The group view is the project summary, aggregated, with the same visibility rule

FR-014 and its scenario 2: a project the viewer may not see is excluded **from the totals as well as
from the list**.

**Decision**: the group view calls the same per-project summary method the project screen uses, over
the set of projects the caller may see, and sums. It does not have its own query.

**Why**: a separate aggregate query is a second implementation of "what did this project earn",
and the two will disagree the first time either changes. More specifically, a total computed by a
different path than the rows beneath it is the classic reconciliation failure — the director sees a
company total that does not equal the sum of the projects on the same screen, and neither figure can
be trusted afterwards.

Scenario 2 falls out of this for free: the visibility filter is applied once, to the project set, and
both the rows and the total derive from what survives it.
