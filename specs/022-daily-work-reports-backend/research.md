# Research: Daily Work Reports (022)

Phase 0 of [plan.md](./plan.md). Eight decisions. Each records what was chosen, why, and what was
rejected — the rejections matter more than the choices here, because several of the rejected
options are the ones a later reader would reach for first.

---

## §1 — The tables are empty, so the migration is free

**Decision**: add every column nullable, with no backfill and no data migration, and loosen
`DWRTask.actualQty` from `NOT NULL` to nullable.

**Measured, not assumed.** Against the development database on 2026-10-04:

```
projects."DailyWorkReport"  0 rows
projects."DWRTask"          0 rows
projects."ClientBill"       0 rows
plant."LogbookEntry"        3 rows
```

Nothing has ever written a daily work report, which is the whole premise of this feature. The
absence of client bills is worth noting too: the billing module built in 018 has never been used
either, so this feature is not working around production data in either place.

**Why it matters that this was checked**: loosening a `NOT NULL` on a populated table is a
different operation — it is safe in Postgres, but the *semantics* change for every existing row,
which would then be asserting "not measured" when they meant "measured". On an empty table there is
no such claim to misinterpret.

**Rejected**: a backfill setting `servedQty = actualQty` for `day_basis` lines. There are no
`day_basis` lines, so the migration would be a no-op dressed as a precaution — and a no-op backfill
in the history is worse than none, because the next reader assumes it did something.

---

## §2 — The report number derives from the project code

**Decision**: `{Project.code}-{sequence}`, the sequence per project, stored in the existing
`dprNumber` column under its existing `@@unique([companyId, dprNumber])`.

**Why**: 008 US5 AC1 specified `{siteCode}-{sequence}`, which cannot be built, for two independent
reasons:

1. **A report references a project, not a site.** `src/projects/sites/sites.service.ts:374` says so
   in as many words — it counts daily work reports *through* the project because the report has no
   site column.
2. **`Site` has no code field at all.** It carries `id`, `companyId`, `name`, coordinates, a
   geofence radius, a weekly off day, an optional project, an address and a status. The name is
   unique per company; there is no code to build a number from.

`Project.code` is unique per company (`@@unique([companyId, code])`) and the report already
references the project, so the number is well-defined and collision-free within the tenant.

**Rejected**: *adding a site reference to the report* so the original format could be honoured. It
is a larger change than the problem justifies, it would need a decision about reports spanning two
sites (which the client's own package does — one bill covers a whole package of highway), and the
site would still need a code field inventing. A site reference can be added later for its own
reasons without disturbing the numbering.

**Rejected**: *a company-wide sequence*. Two projects' reports would interleave, so a gap in one
project's numbering would be normal, and a gap in a numbered site register is the first thing an
auditor asks about.

---

## §3 — Two input shapes, and a column of its own for the served quantity

**Decision**: the create DTO is a discriminated union on `paymentMode`. A `work_basis` line carries
the six factors and no served quantity; a `day_basis` line carries a served quantity and **cannot
carry factors at all**. `quantityInForce(line)` switches on the basis, and its `day_basis` branch
does not read a factor field. `servedQty` is a new column; `actualQty` becomes nullable; a `CHECK`
asserts that exactly one is present and that it matches the basis.

**Why this shape rather than one permissive one**: because of a number that would be correct by
coincidence. All six factors default to 1, so their product is 1 — which is exactly what one day
served looks like. A design that stored presence in `actualQty` and computed it from the factors
would produce the right answer for every row anybody wrote by hand, pass every test written the
obvious way, and become wrong the moment somebody set a factor on a presence line. The spec made
this FR-030b; the design makes it a property of the types, so the data cannot be there to be
misread.

This is the same class of problem as two defects already in this repository's history: a guard that
passed because a commented-out call still contained the text it searched for, and a PDF import that
was correct under the compiler that tested it and wrong under the compiler that shipped it. In each
case the artefact was right for a reason unrelated to the reason it was supposed to be right.

**Rejected**: *one quantity column with a flag*. Half-null rows are tolerable; a column whose
meaning depends on another column's value is not, because every reader has to know the rule and the
database cannot enforce it.

**Rejected**: *`actualQty` stays `NOT NULL` and holds 0 for presence lines*. Zero is a legitimate
measured quantity — the client's sheets contain measured zeros and unmeasured lines side by side,
and collapsing them loses the distinction the deductions are argued from.

**Rejected**: *storing the served quantity in both columns*. Two copies of one fact, which is
precisely what 018 research §3 refused for cumulative billed quantity, for the same reason: they
disagree after the first correction.

---

## §4 — FR-020 is implemented as a billed-quantity floor, and that is not what FR-020 says

**Decision**: reversal is refused when it would drop a BOQ line's done quantity **below the
quantity already billed against that line on a bill that has left draft** — a `ClientBillLine` on a
`submitted` or `certified` `ClientBill`, or an `RABillLine` reaching the same BOQ line through a
work-order award line on a `submitted` or `approved` `RABill`. The refusal names the bill.

**Said plainly: this is weaker than FR-020's literal wording, and the difference is structural
rather than a shortcut.** FR-020 asks for reversal to be refused when *this report's* measurement
has been claimed on a bill. Nothing in the schema can answer that question. A `ClientBillLine`
records that 2.600 of BOQ line X was billed; a `DWRTask` records that 0.700 of BOQ line X was
measured on 21 December. **There is no column anywhere linking the two.** Measured quantity and
billed quantity meet only at the BOQ line, and the mapping from one to the other is many-to-many
and unrecorded.

So the implementable question is not "was this report billed" but "would this reversal make the
project's executed quantity smaller than what has already been sent to a client". That is a
*stronger* invariant in the way that matters — it protects the arithmetic rather than the
provenance — and it needs no new column.

**What is deferred, and named so it is not mistaken for done**: knowing *which* report's
measurement a given bill line consumed. That linkage belongs to feature 023, where a bill line is
composed from a period's approved measurement and can record what it drew on. Until then, a
reversal inside a period that has been billed is refused by the floor rather than by provenance,
and an operator may need to revise the bill first. 023 should revisit FR-020 and say whether the
link is worth adding; this document exists partly so that it is asked.

**Rejected**: *adding the link now*, in 022, by having a bill line reference the measurement lines
it consumed. It would be designing 023's composition model from inside 022 with none of 023's
requirements written, and the shape chosen would almost certainly be wrong — the real sheets claim
a *month* against a line, not a set of days.

**Rejected**: *refusing all reversal of any approved report*, which is simple and safe and makes
FR-019 pointless.

---

## §5 — The logbook is read through the registry, and the direction is forced

**Decision**: a new `ProjectLogbookSource` interface on `ProjectSourcesRegistry`, registered by
`PlantService.onModuleInit`, returning a **map** keyed by date.

**Why through the registry at all**: Principle I forbids `projects` from querying the `plant`
schema. `plant.LogbookEntry` already holds exactly what the client's measurement sheets print
beneath each item — date, opening reading, closing reading, total hours, fuel, operator, remarks,
unique per machine per date — so the only question is how to reach it, not whether to duplicate it.
Copying those readings into a daily work report would create a second system of record for an
odometer, and the two would disagree the first time one was corrected.

**Why registration rather than injection, and why that is not a style choice**: `PlantModule`
already imports `ProjectsModule`. Having `ProjectsModule` import `PlantModule` to inject
`LogbookService` would close a cycle — `PlantService`'s own docblock says the loop would span five
modules — so the dependency runs one way and `plant` announces itself. This is the hazard 006
T058/T059 recorded from the other side: `EquipmentCategoriesService` lives under
`src/settings/machinery-masters` but is *provided* by `PlantModule`, and injecting across that line
made a cycle. The registry exists because of this, and three sources already register through it.

**Why a map rather than a list or a number**: `ProjectSourcesRegistry`'s own documentation states
the rule — "Returns a map so a project with no cost in the period is **absent rather than zero**,
and the P&L can tell 'nothing spent' from 'not asked'." FR-033 is the same requirement arriving
from a different direction: a date with no logbook entry must be reported as an absence, not as a
run of zero kilometres. The existing precedent and the new requirement agree, which is the
strongest reason to follow it.

**Why `DWRTask` gains an `equipmentId`**: without it there is nothing to look an entry up by. It is
a bare id with no cross-schema relation, exactly as `supervisorEmployeeId` and `approvedByUserId`
already are, and as the schema-level note in `prisma/schema.prisma` prescribes.

**Rejected**: *the batched per-project shape the cost sources use*. The registry's own lesson is
that per-project signatures create an N+1 no registrant can fix, so the logbook source takes a list
of dates and returns them together.

---

## §6 — Period figures are aggregated, and FR-039 is the check on the counter

**Decision**: the three figures of FR-034 are computed by aggregating approved measurement at read
time. No stored counter is added. `doneQty` stays as it is, and FR-039's reconciliation report is
the comparison between the two.

**Why**: 018 research §3 decided precisely this question for cumulative billed quantity and its
reasoning transfers without modification — *"a stored running total is a second source of truth for
a number that is already fully determined by the bill lines, and every path that edits, voids or
deletes a bill has to remember to adjust it… one denormalised counter per table is a maintenance
cost; two that can disagree about the same line is a reconciliation bug waiting for a month-end."*
That document named `doneQty` as the existing instance of the pattern. Adding a second one for the
same quantity would be doing knowingly what 018 declined to do.

**The interesting consequence**: `doneQty` *is* a denormalised counter, maintained by this
feature's approvals and reversals, and therefore capable of drifting from the aggregate — through a
failed partial transaction, a hand-edit, or a bug in reversal. FR-039 exists for that reason. The
aggregate is not a convenience alongside the counter; it is the only thing that can tell you the
counter is wrong, and a system with a denormalised total and no way to check it is a system that
discovers the drift at a month-end.

**Why attribution is by work date, not approval date** (FR-036): a billing period is a period of
*work*. A report for 21 December approved on 5 January belongs to December, or the bill for
December is short by it and the bill for January claims work done before its period began. The
client's real sheets make this explicit — each month's row carries both the month and the period
("Jan-26", "From 21.12.2025 to 20.01.2026") against the RA bill it was claimed in.

**Why every BOQ line is returned, including zeros** (FR-037): a line that is absent from a response
and a line that measured nothing are indistinguishable to the caller, and the caller is a bill. A
bill that silently omits a line is the exact shape of failure this repository has met repeatedly —
an import reporting success with zero rows, a guard passing against an empty list. Zeros are
present so that nothing can lose a line by not finding it.

---

## §7 — The latest reversal lives on the report; its history lives in the audit log

**Decision**: `reversedAt`, `reversedByUserId`, `reversalReason` and `reversalCount` on
`DailyWorkReport`. No reversal table. Each submission, approval and reversal also writes an audit
entry (FR-022), which is where the full sequence lives.

**Why**: the precedent is two tables away and explicit. `RABill` carries `revisionCount`,
`lastRevisedAt` and `lastRevisedByUserId` with a docblock saying why — *"Kept as a count rather
than left to be reconstructed from the audit trail: 'this bill has been round three times' is what
a reader wants, and counting approval instances by hand to find out is how a reader stops asking."*
A daily work report has the same reader with the same question.

**What the four columns are for, precisely**: a report in `draft` with `reversedAt` set is one that
was approved and taken back — which is a different thing from one that was never approved, and
FR-019 needs the two distinguishable. `reversalCount` answers "has this been round before" without
a query. The reason is required because a reversal moves a quantity a bill may depend on.

**Rejected**: *a `DWRReversal` table*. The sequence is already durable in the audit log, which is
the system of record for who did what; a second durable copy is the two-counters problem again, in
prose rather than in arithmetic. If a future requirement needs reversals as first-class rows —
reporting on them, approving them — that is the moment to promote them, and the audit log can be
read to build the history.

**Rejected**: *clearing `approvedAt` and `approvedByUserId` on reversal*. The approval happened.
Erasing it means a reversal reason referring to an approval nobody can see.

---

## §8 — A report's lines are written and incremented in bounded statements

**Decision**: creating a report writes its lines in one multi-row statement; approving one groups
the increments by BOQ line and issues a bounded number of updates, not one per line. Both inside
one `withRlsContext` transaction.

**Why**: this is not premature optimisation, it is a defect already paid for. On 2026-10-04 the BOQ
import's confirm step performed 132 sequential round trips inside a single interactive transaction
whose default budget is 5 000 ms (`maxWait` 2 000 ms, `timeout` 5 000 ms). It worked on every local
run and returned a bare `{"statusCode":500,"message":"Internal server error"}` on the deployment,
where the round trip to the database is longer. The fix was two statements instead of 132, and the
reproduction was constraining the local timeout to 90 ms.

A daily work report carries ~17–20 lines today and the client's tender has 312 BOQ lines, so the
same loop written the obvious way sits inside the same budget with the same latency sensitivity.
The constraint is therefore recorded as a design rule rather than discovered again after a deploy.

**Why grouping matters for correctness too**: FR-015 requires relative increments
(`{ increment: … }`) rather than a value read earlier. Two reports measuring one BOQ line and
approved concurrently must both land. A grouped relative increment satisfies both the latency rule
and the concurrency rule; a read-then-write loop satisfies neither, and loses one of the two
silently.
