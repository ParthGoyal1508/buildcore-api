# Research: Running-Account Bill Package (023)

Phase 0 of [plan.md](./plan.md). Eight decisions. The rejections matter more than the choices in
several of these, because the rejected option is the one a later reader reaches for first.

---

## §1 — Two bill tables, one package table

**Decision**: keep `ClientBill` and `RABill` as the two bills. Put the ~30 columns the *package*
adds into a new **`BillPackage`** row that attaches to exactly one of them, enforced by a `CHECK`.

**Why not one unified bill table with a direction flag**, which the phrase "one renderer, two
bindings" suggests: **the two directions measure different schedules, and that is not a flag.** A
bill the company issues to its client measures the project's own BOQ — `BOQTaskItem`, at the client's
contracted rate. A bill the company issues to a subcontractor measures that subcontractor's
**work-order award lines** — `WorkOrderBOQItem`, at the awarded rate, which is a different and
smaller scope at different prices. The sample package's own Annexure-I is the *subcontract* schedule:
17 items of O&M work at the subcontractor's rates, not the client's 312-line tender.

A single table would therefore need a line that points at either of two parents, which is the same
polymorphism pushed down a level and made worse — a bill's lines are the thing most often queried.

**Why not extend both bill tables with the package's columns**, which keeps the model flat: it is the
same thirty columns twice. A period, three columns of cumulative figures across six figure kinds,
four recovery amounts, four deduction amounts, three tax amounts with the three rates they were
computed at, and eight statutory header fields — maintained in two places, migrated in two places,
and read by a renderer that would need two shapes for one document. The first divergence between the
two copies is a bug nobody can see from either side.

**Why `BillPackage` holds only what the bill tables lack**: see §3.

**Alternative considered and rejected outright**: a package that *replaces* both bills, with 018's
tables left behind. `ClientBill` is read by the project P&L for revenue booked and by 018's own
certification path, and `RABill` goes through the approval spine as `ACTION_RA_BILL`. Replacing them
would mean two ways to bill, which is 018 research §3's two-counters objection at the level of a
whole table.

---

## §2 — The claim is a package concept, so it is a package table

**Decision**: the per-line proposal, reduction reason, variance and over-claim flag live in a new
**`BillPackageLineClaim`**, keyed by the package and the line it describes — not as four columns on
`ClientBillLine` and four more on `RABillLine`.

**Why**: a claim records *how this quantity came to be chosen* — what 022's measurement proposed,
what the engineer chose instead, and why. That is a fact about the **package's composition**, not
about the bill line. 018's `ClientBillsService.compose` can still create a bill line with no package
at all, and in that case there is no proposal to record; columns on the line table would be
permanently null for every such row.

It also keeps the duplication out: the four fields are identical for both directions, so they exist
once rather than twice.

**Why not derive the variance** rather than storing it: the proposed figure is a **point-in-time
fact**. 022's approved measurement for a period can grow after the bill is composed — that is
precisely the case FR-014b exists for — so a variance recomputed later would answer a different
question than the one the engineer was looking at when they signed off.

---

## §3 — `grossAmount`, `retentionAmount` and `netAmount` stay where 018 put them

**Decision**: `BillPackage` carries **only** the figures the existing bill tables lack. Gross,
retention and net are not duplicated onto it.

**Why**: this repository has now refused the same thing three times, and consistency is the point.
018 research §3 refused a stored cumulative billed quantity beside `doneQty` — *"two that can
disagree about the same line is a reconciliation bug waiting for a month-end."* 022 research §6
refused a second counter for approved measurement and reapplied 018's reasoning verbatim. 022 FR-039b
then had to settle which of two figures was authoritative, precisely because `doneQty` is a cache.
Introducing a fourth instance of the pattern here, knowingly, would be the easiest thing in this plan
to criticise.

**Why nothing is dropped from `ClientBill` either**, despite its being empty and therefore droppable
without risk: `grossAmount`, `retentionAmount`, `netAmount`, `certifiedAmount` and `quotedPercentage`
are read by `ClientBillsService`, by the certification path, and by the P&L's revenue contribution.
Dropping a column to tidy a table and then re-adding it when the service that reads it is noticed is
a worse outcome than a column that is simply not this feature's business.

---

## §4 — Every rate travels with the bill it was applied to

**Decision**: the abstract's arithmetic is a **pure function whose rates are arguments with no
defaults**. Each rate is recorded on the `BillPackage` row at composition, read from the contract
(retention) or from configuration (the taxes and tax deducted at source).

**Why not a configuration lookup inside the function**, which is less to pass around: a bill issued
in March must still recompute to the same figures in September. Tax rates change in budgets and
retention changes between contracts, so a function that read the current rate would make every
historical bill re-derive to a number that does not match the paper it was signed on. FR-028
requires that a bill produced twice is identical; a rate read at render time breaks that the first
time a statute changes, and breaks it *silently*, for every bill at once.

**Why the rates are stored per bill and not per project**: the client's real package carries
retention at 5 % and performance security at 3 % *"as per Clause 13"* — a clause of one contract.
Two work orders on one project can differ, and a rate on the project would quietly apply one
contract's terms to another's bill.

**What this costs**: a composition must gather four or five rates before it can compute anything, and
a missing rate has to be a refusal rather than a default of zero. A silent zero would produce a bill
with no retention and a payable that is 5 % too high, which is the error most likely to be paid
before anybody notices.

---

## §5 — Which tax applies is derived, and the derivation is reported

**Decision**: intra-state (the two half-rate taxes) versus inter-state (the single full-rate tax) is
derived from the **first two digits of the two parties' registration numbers**, which are the state
code. `Project.cgstApplicable` is the fallback when a registration number is absent. The basis of
the decision is reported on the bill either way.

**Why derived rather than chosen at composition**: it is a fact about the two parties, not a
judgement. Both parties in the sample package carry `08` — Rajasthan — and the full-rate line is
blank for that reason. A person choosing it would eventually choose wrong, and the error presents as
a tax figure that is right in total and wrong in kind, which a client's accounts department rejects
weeks later.

**Why the derivation is reported**: because the fallback exists. A bill whose tax was decided by a
project flag rather than by the parties' registrations is a bill somebody should look at, and the
only way to know is to say which happened.

**The gap this exposes**, named in the spec's assumptions: `Client` carries no `state` and no `pan`,
while `Company` and `Vendor` carry both. So for a bill issued to a client the derivation will fall
back to the flag more often than it should, and adding those two fields to the client record is the
obvious follow-up — out of scope here, and recorded so it is not discovered at the first bill.

---

## §6 — The renderer stands beside the existing one, and sees only a view

**Decision**: a new renderer under `src/projects/billing/workbook/`, consuming a view type and
holding no Prisma client. It does **not** extend
`src/dashboard/reports/export/export-renderer.ts`.

**Why not extend it**: that renderer's whole contract is `{columns, rows} → one flat sheet`. This
package is five structurally different sheets — a questionnaire, a four-block abstract with three
money columns, a priced schedule with multi-paragraph descriptions, one measurement sheet per item
with a nested daily log, and a grouped register. There is no shared abstraction between "a table" and
"this document" except the `exceljs` API itself, and extracting one would produce a wrapper that adds
a layer and explains nothing.

**Why containment is still right, and why the constitution does not require it**: the constitution
requires *SheetJS* behind one module boundary, for a replaceability reason specific to a pinned
vendor tarball. It says nothing of the kind about `exceljs`, and eight files already import it
directly — so a plan claiming the constitution demands containment here would be wrong. The actual
reason is narrower and sufficient: the sheet builders are where the client's format lives, and a
24-sheet layout spread across its callers is a layout nobody can change safely.

**Why the renderer holds no Prisma client**: FR-028 says every figure comes from the stored bill and
none is recomputed at production time. Making that a property of what the renderer *can see* rather
than a rule it follows is the difference between a guarantee and an intention.

---

## §7 — Every new policy is read before it is written

**Decision**: each of the four new tables carries its own `companyId` and a `tenant_isolation`
policy keyed on it, with both `USING` and `WITH CHECK` stated explicitly. No policy is copied from a
neighbouring table without reading that table's own.

**Why this is worth a research note**: 022 found that `projects."DWRTask"` has **no `companyId` at
all** — its policy is a correlated subquery against its parent report. Both of 008's policies also
omit `WITH CHECK` and rely on Postgres applying `USING` to new rows, which is sound but is not what
018's tables do. So "copy the policy from the table next door" produces a different guarantee
depending which door you open, and a `companyId`-keyed policy added beside a parent-lookup one would
`AND` with it and hide every row.

**And the probe is the deliverable, not the policy.** The development and continuous-integration role
is a superuser, and Postgres exempts a superuser from row-level security unconditionally — so a
policy written and never probed has never been in force in any test run. 148 tables carry this
policy; about 24 are now named in a probe suite, three of those added by 022.

---

## §8 — Bounded statements, again

**Decision**: composing a bill writes its line claims in one multi-row statement. The period figures
come from 022 in one call. The workbook is assembled from data already loaded.

**Why**: this is the third feature in a row to record the same rule, and it is recorded again because
the client's tender is 312 lines. On 2026-10-04 the BOQ import's confirm step made 132 sequential
round trips inside one interactive transaction whose default budget is 5 000 ms. It passed every
local run and returned a bare `{"statusCode":500,"message":"Internal server error"}` on the
deployment, where the round trip is longer. The reproduction was constraining the local timeout to
90 ms; the fix was two statements instead of 132.

A 312-line composition written the obvious way is 312 round trips in the same budget — more than
twice the loop that already failed. The rule is therefore a design constraint of this phase rather
than something to measure afterwards.
