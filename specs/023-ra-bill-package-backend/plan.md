# Implementation Plan: Running-Account Bill Package

**Branch**: `023-ra-bill-package-backend` | **Date**: 2026-10-05 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/023-ra-bill-package-backend/spec.md`

## Summary

Turn feature 022's approved measurement into the 24-page running-account bill package the client
maintains by hand today — in both directions, from one renderer.

Seven phases. The central decision is in **Phase A** and everything else follows from it: the two
bill directions genuinely measure **different schedules** — a bill to the client measures the
project's own BOQ, a bill to a subcontractor measures that subcontractor's work-order award lines —
so they are not one table with a flag. But the ~30 columns the *package* adds are identical for
both, so those columns live once, in a `BillPackage` row attached to whichever bill it belongs to.
Research §1 sets out why each of the three alternatives was rejected.

**Amended 2026-10-05, after `checklists/silent-failure.md`.** The checklist ran against this plan
and found nine defects in the written requirements, four of which land in the design: the
up-to-previous column was defined so that FR-035's footer identity could not fail; FR-003 named the
project's BOQ for both directions when a subcontractor bill measures award lines, which are nullably
mapped and so may have no measurement source at all; FR-020's "fully recovered" had nothing recorded
to compare against; and FR-039's live debit register contradicted FR-028's frozen workbook. The
phases below carry the consequences, each marked. `spec.md` went from 58 requirements to 89.

The other work that needed real thought is the pair of reports the spec's own decisions oblige
(**Phase F**): freezing the cumulative position makes a late-approved report able to belong to an
already-billed period, and permitting an over-claim makes the reason field a potential route around
the control. Neither decision is safe without the report that makes its consequence visible.

## Technical Context

**Language/Version**: TypeScript 5 on Node.js 20, NestJS 10.

**Primary Dependencies**: Prisma 5.22 (multiSchema) on PostgreSQL; `exceljs` for the workbook —
already a dependency, constitution-approved for `.xlsx` generation, and used by eight files;
`class-validator` / `class-transformer`; `@nestjs/swagger`. **No new dependency.**

**Storage**: PostgreSQL, `projects` schema. Four existing tables are extended and four are new.
Measured on 2026-10-05: `ClientBill` 0 rows, `RABill` 0 rows, `WorkOrder` 0 rows,
`BOQTaskItem` 0 rows — **nothing in the billing chain has ever held a row**, so every migration here
is additive with no data to reinterpret and no backfill.

**Testing**: Jest + ts-jest for unit tests colocated as `*.spec.ts`; `test/*.e2e-spec.ts` against a
running Postgres. Note the compiler split this repository carries: the application is built by
**SWC**, the tests by **ts-jest with `esModuleInterop` off**. `src/common/swc-interop.spec.ts`
guards the one import form this breaks, and it matters here: the existing export renderer imports
`exceljs` as `import * as ExcelJS` — which is **correct**, because `exceljs` is read through its
properties (`new ExcelJS.Workbook()`), and a namespace object carries properties perfectly well.
Only a module whose export *is* the callable breaks. 023 follows the same form.

**Target Platform**: Linux server (Render), Node 20-slim container.

**Project Type**: Web service (REST), one module inside an existing monolith.

**Performance Goals**: A bill composed for the client's real 312-line tender in under 5 s, within
one transaction. A 24-sheet workbook produced in under 10 s and under 20 MB. The period figures read
from 022 is one request, not one per line.

**Constraints**: Money is `Decimal(18, 2)` and quantity `Decimal(18, 3)`; both are `Prisma.Decimal`
and serialise as strings. Writes run inside `withRlsContext`, whose interactive transaction defaults
are `maxWait` 2000 ms and `timeout` 5000 ms — and 022 research §8 records 132 sequential round trips
inside that budget returning a bare 500 on the deployment while passing every local run, so bounded
statements are a design rule and not an optimisation.

**Scale/Scope**: The client's real package is 17 items over 24 sheets; their tender is 312 BOQ lines
over 66 groups, which is the size the composition and the renderer must be designed for — 312
measurement sheets in one workbook.

## Constitution Check

*GATE: evaluated before Phase 0, re-evaluated after Phase 1 at the end of this document.*

| Principle | Gate | Verdict |
|---|---|---|
| **I. Schema-per-module boundaries** | Does this query a schema it does not own? | **PASS.** Everything written is in `projects`. The two parties' statutory details come from `settings.Company` and `partners.Vendor` — read through their owning services and **frozen onto the bill** at issue, which FR-028 requires anyway, so the cross-schema read happens once per bill rather than on every render. The daily record under a measurement sheet comes through `ProjectSourcesRegistry`, as 022 established. |
| **II. Validated DTO contracts** | Every request body typed and validated? | **PASS.** Note that `whitelist` and `forbidNonWhitelisted` are both on, so a field a DTO does not declare is a 400 — which 022 found is a *stronger* guarantee than stripping, and is relied on here to keep a caller from supplying a computed total. |
| **III. Centralised configuration, no hardcoded values** | Magic values? | **PASS, and this is the principle 023 stresses hardest.** 5 % retention is a contract term, 2 % tax deducted at source and 9 % CGST are statutes, and all three change — so each is recorded **per bill** at composition, sourced from the contract or from configuration, and never read from the system at render time. Research §4. Refusal codes in `src/projects/billing/package-error-codes.ts`. |
| **IV. Multi-tenant isolation and PII protection** | Every row scoped, and the scoping *proven*? | **PASS, with four new policies and a probe.** Each new table carries `companyId` and `tenant_isolation`; `test/ra-bill-package-rls.e2e-spec.ts` exercises them under a `NOSUPERUSER NOBYPASSRLS` role. 022 found that `DWRTask`'s policy is a **parent lookup** rather than a `companyId` predicate, so no policy here is copied without reading it — research §7. |
| **V. Auth, authorisation, secrets** | Every route permissioned? | **PASS.** `Permission.PROJECT_FINANCIALS` on every route — a bill is money, unlike a BOQ which is project work. `ProjectLockGuard` on writes. No new secret. |
| **VI. Observability and safe migrations** | Generated, additive, reversible? | **PASS with one tracked deviation.** All additive; no backfill, verified against four empty tables. The deviation is a `CHECK` constraint on `BillPackage` — see **Complexity Tracking**. |

**Technology stack**: no new dependency. `exceljs` is pre-approved for `.xlsx` generation and is the
only thing permitted to write a spreadsheet; SheetJS stays read-only for legacy `.xls` and is not
touched.

## Project Structure

### Documentation (this feature)

```text
specs/023-ra-bill-package-backend/
├── spec.md              # 89 requirements (58 at plan time), decisions D1–D3
├── plan.md              # This file
├── research.md          # Phase 0 — eight decisions
├── data-model.md         # Phase 1 — four new tables, four extended
├── quickstart.md         # Phase 1 — validation passes
├── contracts/
│   └── bill-package-api.md
├── checklists/
│   ├── requirements.md   # Spec quality checklist
│   └── silent-failure.md # 52 items, nine findings — amended spec.md, this file and data-model.md
└── tasks.md              # Phase 2 — NOT created by /speckit-plan
```

### Source Code (repository root)

```text
src/projects/billing/                      # Existing directory, extended
├── package/                               # New. The package's own code.
│   ├── bill-package.service.ts            # Phase B — composition
│   ├── bill-package.service.spec.ts
│   ├── bill-abstract.ts                   # Phase C — pure arithmetic, no Nest
│   ├── bill-abstract.spec.ts              # Phase C — SC-003's real figures
│   ├── bill-tax.ts                        # Phase C — intra/inter-state decision
│   ├── bill-tax.spec.ts
│   ├── measurement-sheet.service.ts       # Phase D
│   ├── debit-note.service.ts              # Phase D
│   ├── check-list.ts                      # Phase D — the six fixed questions
│   ├── bill-package.controller.ts         # Phase G
│   ├── package-error-codes.ts
│   ├── package-reports.service.ts         # Phase F — the two obliged reports
│   ├── package-reports.service.spec.ts
│   └── dto/
│       ├── compose-bill.dto.ts
│       ├── bill-line.dto.ts
│       ├── debit-note.dto.ts
│       └── check-list.dto.ts
└── workbook/                              # New. The renderer, contained.
    ├── bill-workbook.renderer.ts          # Phase E — the only exceljs consumer here
    ├── bill-workbook.renderer.spec.ts
    ├── sheets/
    │   ├── check-list.sheet.ts
    │   ├── abstract.sheet.ts
    │   ├── schedule.sheet.ts
    │   ├── measurement.sheet.ts
    │   └── debit-note.sheet.ts
    └── bill-workbook.types.ts             # The view the renderer consumes

src/projects/projects.module.ts            # Edited: providers, controller order
prisma/schema.prisma                       # Edited: Phase A
prisma/migrations/2026100XXXXXXX_bill_package/migration.sql

test/bill-package.e2e-spec.ts              # Phase G
test/ra-bill-package-rls.e2e-spec.ts       # Phase G, FR-050
```

**Structure Decision**: a `package/` and a `workbook/` directory **inside** the existing
`src/projects/billing/`, rather than a new top-level module. The package is a document assembled
from bills that module already owns, and splitting it out would put the composition on one side of a
module boundary and the bill it composes on the other.

The renderer is a separate directory from the services for a reason worth stating: it consumes a
**view type** (`bill-workbook.types.ts`) and nothing else. It holds no Prisma client and performs no
query, so FR-028's "every figure comes from the stored bill and none is recomputed at production
time" is a property of what the renderer *can* see rather than a rule it follows.

## Phases

### Phase A — the schema (FR-001, FR-005, FR-006, FR-010, FR-014a, FR-017, FR-036 to FR-042)

Four new tables and four existing ones extended. Field by field in
[data-model.md](./data-model.md); the modelling decision in research §1.

**The decision, in brief**: the two directions measure **different schedules**, so they are not one
bill table with a flag — a bill to the client measures `BOQTaskItem`, a bill to a subcontractor
measures `WorkOrderBOQItem` at the subcontractor's awarded rate, and the real package's Annexure-I
is the *subcontract* scope in the sample. But the ~30 columns the package adds are identical for
both, so they live once in **`BillPackage`**, attached to exactly one of the two bills by a pair of
nullable references and a `CHECK`.

New: `BillPackage` (the period, the frozen cumulative position, the four recoveries, the four
deductions, the taxes and the rates they were computed at, the frozen statutory header, the
direction), `BillPackageDebit` (the register), `BillPackageCheckListAnswer` (six per bill), and
`BillPackageLineClaim` (the per-line proposal, reason, variance and over-claim flag — see research
§2 for why this is not columns on the two existing line tables).

**Four additions from the checklist**, each carrying its reason into the migration: an `abandoned`
status (FR-002b — a period is occupied by a bill in any status, so without a way out one bad draft
holds a period for ever and the only remedy is deleting the row that proves the period was billed);
a **nullable** `proposedQty` with a `proposalSource` enum (FR-003a — null is *no measurement source*,
which is not the fact zero states); `mobilizationAdvanceTotal` and `performanceSecurityTotal`
(FR-020 — without a recorded total, "fully recovered" and "entered as zero this month" are the same
row and the requirement is satisfied by doing nothing); and `varianceQty` made nullable to match a
null proposal.

Extended: nothing on `ClientBill`/`RABill` beyond what already exists. **Their `grossAmount`,
`retentionAmount` and `netAmount` stay the only home for those three figures** — `BillPackage` holds
only what they lack. Research §3 is explicit that this is to avoid the two-counters problem this
repository has refused three times already (018 research §3, 022 research §6, 022 FR-039b).

Nothing is dropped from `ClientBill` despite it being empty, and research §3 says why.

### Phase B — composition (FR-002 to FR-011)

`BillPackageService.compose`: open a bill for a project and a period, read 022's
`DwrPeriodFiguresService.figuresFor` once, and write one claim per BOQ or award line in a single
multi-row statement. 312 lines is one write, not 312 — research §8 and the production 500 behind it.

**Correction, made while building this phase.** An earlier version of this paragraph said the
underlying bill row should be created "through 018's existing service". Reading
`ClientBillsService.compose` shows it cannot be, for two reasons that would both be defects:

1. **It refuses an unpriced line at composition.** Right for 018, where the caller chooses which
   lines to measure. Wrong here: FR-003 proposes *every* line and FR-009 defers that refusal to
   issue, so delegating would make one unpriced row refuse a whole 312-line package.
2. **It opens its own transaction.** Composition writes a bill, its lines, the package and a claim
   per line, and that has to be all-or-nothing. Two transactions cannot give it — the same wall 022
   hit with `BoqService.updateDoneQty`.

The bill row is therefore created inside this service's own transaction, while its figures still come
from `bill-totals.ts`, which stays the single definition of gross and net.

**Two schema additions this phase needed and Phase A did not have** (migration
`20261005130000_bill_package_rates_and_counterparty`):

- **The rates had no home.** FR-023 requires every rate from configuration or the contract, and
  research §4 requires a missing one to be a refusal — but nothing in the schema carried a tax rate
  at all, and only `WorkOrder.retentionPercent` carried a retention term, so a bill to a client had
  nowhere to read one from. The four statutory rates go on `settings.Company` beside `bocwCessRate`,
  which is this repository's existing home for exactly this kind of value, read through
  `CompaniesService.getBillingTaxRates` for Principle I. `Project.clientRetentionFraction` is
  nullable with no default: null is refused, `0` is a contract with no retention. Research §4's
  objection to project-level rates — that two work orders on one project can differ — does not reach
  the client direction, where a project has exactly one client agreement and *is* the contract.
- **`BillPackage` was keyed on project and direction alone**, which conflates two subcontractors on
  one project: they would share one running series, so A's bills would be RA-01 and RA-03 while B's
  were RA-02 and RA-04. FR-002's overlap check has the same shape. `counterpartyKey` — the client
  for `to_client`, the work order for `to_subcontractor` — carries both.

The refusals that matter: a period overlapping one already billed (FR-002, and the reason is that a
day's measurement claimed on two bills is claimed twice); the same project and period returning the
**existing** bill rather than a second (FR-007); one line per item (FR-008); an unpriced line
refused at **issue** rather than at composition (FR-009, matching 018's existing `unpriced` flag
which says "nobody has priced this", not "this is free").

Reduction requires a reason; an over-claim requires a reason **and** sets a flag (FR-006, FR-006a,
decision D2). The variance is stored, not derived, because the proposed figure is a point-in-time
fact that 022's measurement may move afterwards.

### Phase C — the abstract (FR-012 to FR-023)

`bill-abstract.ts` and `bill-tax.ts` — pure functions, no Nest, no Prisma, unit-tested alone.

- **Every rate is an input, never a constant.** The abstract function takes the retention fraction,
  the tax rates and the deduction rates as arguments and has no defaults. Research §4 explains why
  this is the shape rather than a config lookup inside the function: a bill issued in March must
  still recompute identically in September after a rate change, which is only true if the rate
  travels with the bill.
- **The intra-state versus inter-state decision** is derived from the two parties' registration
  numbers — the first two digits are the state — with the project's existing flag as a fallback and
  the derivation reported either way (FR-015, FR-016). Research §5.
- **A fully-recovered one-time deduction** shows in the cumulative columns and is blank for this
  bill (FR-020). This is what the real package's performance security does, and getting it wrong
  re-recovers money.
- **The payable may be negative** (FR-022), because a bill whose debits exceed its work is a real
  outcome the client's own format expresses.
- **Every base is stated, and the rounding rule with it** (FR-012a, FR-015a, FR-018a, FR-019a).
  The checklist found that FR-015/FR-018/FR-019 each fixed where a *rate* comes from and said
  nothing about what it multiplies, and that the sample bill withholds nothing — so the one document
  the tests reproduce constrains none of the withholding arithmetic. The base is the work done
  before any recovery, deduction or withholding, in all three columns; totals are rounded from
  unrounded components, because rounding rows and then summing breaks FR-021's balance by a few
  rupees per column, which on a money document is a figure somebody has to explain.
- **One-time recoveries compare against a recorded total** (FR-020, FR-020b). The frozen totals are
  inputs to the abstract like every rate, and a recovery that would pass the total is refused naming
  what remains.
- **SC-003 is a test, with the client's own figures.** 18,41,686 of work done must yield 1,65,752
  and 1,65,752, retention 92,084, tax deducted 36,834. Reproducing a real document catches **a rate
  applied to the wrong base** — tax on the post-retention figure rather than the gross, say, or
  retention on the tax-inclusive total — which an assertion that "9 % was applied" cannot, because it
  is satisfied by 9 % of anything. **The payable of 11,39,971 does not follow from those figures**:
  the checklist worked the arithmetic and the work total less retention and tax deducted leaves
  20,44,272, so 9,04,301 of recoveries is unaccounted for and must be transcribed from the source
  rather than inferred. SC-003 was rewritten to say so, because a figure back-solved to make a test
  pass tests nothing.

### Phase D — the sheets' data (FR-031 to FR-043)

Three services and one constant table, each producing the data for one sheet kind and **none of them
holding a workbook**.

- The measurement sheet's claim history is a query across a project's bills for one item, in period
  order, with each claim's reason and the bill it went out on (FR-031, FR-032). The daily record
  beneath it comes through `ProjectSourcesRegistry`, and a date with no record is reported as having
  none rather than as nothing done (FR-033, FR-034) — the distinction 022 established.
- The footer identity (FR-035) is asserted rather than computed twice: this bill plus up to previous
  must equal up to date, exactly, and the test for it runs over every item on every bill.
- The debit register: one bill per debit, refused twice over (FR-037) **and under two simultaneous
  applications** (FR-037a — the rule belongs where concurrent writers meet it, not only in the
  service that looks first), grouped under headings (FR-040), applied only to a bill not yet issued
  (FR-037b), and every debit on the project visible from a draft's register (FR-039). **An issued
  bill's register is the register as at issue** (FR-039a, `recordedAt <= issuedAt`), which is how
  FR-039's running total stops contradicting FR-028's frozen workbook — the checklist's CHK025, and
  quickstart Pass 6 was expecting the live behaviour.
- The check list is **six fixed questions in a fixed order with fixed wording**, in a constant
  rather than a table, because the client reads them by position (FR-041, FR-043). An unanswered
  question is distinguishable from one answered "no" (FR-042), which is a nullable answer and not a
  boolean. It never refuses an issue (FR-043).

### Phase E — the workbook (FR-024 to FR-030)

One renderer, five sheet builders, two party bindings.

**On containment**: the constitution requires SheetJS behind a single module boundary and says
nothing of the kind about `exceljs`, which eight files already import directly. So containing this
renderer is a **design choice and not a constitutional requirement**, and the plan should not claim
otherwise. It is still the right choice, for a different reason than replaceability: a 24-sheet
layout with merged cells and multi-paragraph descriptions spread across its callers is a layout
nobody can change safely, and the sheet builders are where the client's format actually lives.

**023 stands beside `src/dashboard/reports/export/export-renderer.ts` rather than extending it**, and
the reason is structural: that renderer turns `{columns, rows}` into **one flat sheet**. This package
is five structurally different sheets, one of them repeated per item, with a four-block abstract and
cells that span. There is no shared abstraction to extract that would not be an empty wrapper.

**The renderer consumes a view type and holds no Prisma client** (FR-028). Figures arrive already
computed and stored; a renderer that could query could recompute, and a bill produced twice must be
identical.

**Sheet names are a rule, not an accident** (FR-024a). A sheet name is capped at 31 characters,
excludes the characters a path uses, and must be unique in the workbook — so names drawn from BOQ
numbers or descriptions collide or truncate on a 312-item schedule, and what the writer does with a
collision decides whether an item's sheet silently disappears. The rule guarantees uniqueness and
every sheet names its own item **inside** the sheet. A description too long for a cell is reported
rather than truncated (FR-029a), and the sheet count is asserted against the schedule's line count
(FR-030a).

Missing party identifiers are reported, not refused (FR-027) — a bill that cannot be produced
because a PAN is unrecorded is worse than one produced with a gap somebody fills by hand. Note from
the spec's assumptions: `Client` carries no `state` and no `pan`, so for a bill issued to a client
those are the two most likely gaps.

### Phase F — lifecycle, and the two reports the decisions oblige (FR-044 to FR-049b)

Issue, revise, certify (FR-044 to FR-047) — the figures freeze at issue, a revision is counted with
a reason, and a certified amount sits **beside** the billed one, never instead of it, which is 018's
existing reasoning and is kept.

Then the two reports, and they are the reason this phase is not merely bookkeeping:

- **The understatement report (FR-014b).** Freezing the cumulative position means a report approved
  after a bill went out belongs to a period already billed, so its quantity falls to the next bill —
  or, if nobody looks, to no bill at all. Choosing to freeze without this report would trade a
  reconciliation problem for a silent revenue leak, which is worse because nothing surfaces it.
- **The over-claim count (FR-006a).** Permitting an over-claim with a reason is only safe if the
  reasons can be read in aggregate; a flag that can be found only by inspecting lines one at a time
  is a flag that will not be found.

FR-049b's cross-period work-date correction **shares the understatement report's mechanism** rather
than having its own: both are "compare a billed period's claims against that period's approved
measurement as it now stands", and two implementations of one comparison would disagree. FR-048a now
states that as a requirement rather than leaving it a plan note.

**And the understatement report alone was not enough** (FR-014c, from the checklist). 022 attributes
measurement by work date, so a quantity approved after a bill went out whose work date sits inside
that bill's period never appears in any later period's proposal either — it is not deferred, it is
unreachable. The route back is an over-claim under FR-006 carrying the report as its reason, and
stating it is the difference between one engineer finding it and the next writing the quantity off.

Abandoning a draft (FR-002b) and refusing to delete an issued bill (FR-044a) belong here too: a
period is occupied by a bill in any status, so the abandon path is the only thing standing between a
mistaken draft and somebody deleting the row that records the period was billed.

### Phase G — controller, permissions, and the isolation proof (FR-050 to FR-053)

`Permission.PROJECT_FINANCIALS` on every route; `ProjectLockGuard` on writes returning **423 and not
403**; another company's bill as **404 and not 403** (FR-053), because a 403 confirms the row exists.

**Route registration order is planned deliberately.** During 022, `route-shadowing.spec.ts` caught
`GET projects/dwr` being swallowed by the parameterised `GET projects/:id` because the controller was
registered second. This controller carries literal paths under `projects/` and must be registered
ahead of `ProjectsController` for the same reason; the guard will say so if it is not.

`test/ra-bill-package-rls.e2e-spec.ts` follows `test/dwr-rls.e2e-spec.ts`: the non-vacuity assertion
**first**, a skipped probe reporting as **skipped and never as passed**, and the cross-company read
that proves the rows exist to be hidden.

## Test strategy

Planned here because four of these tests are the feature's only defence against a figure that is
wrong while looking right.

| What | Where | Why it has to exist |
|---|---|---|
| The client's real arithmetic: 18,41,686 → 1,65,752 / 1,65,752 / 92,084 / 36,834 / 11,39,971 | `bill-abstract.spec.ts` | **Catches a rate applied to the wrong base.** "9 % was applied" is satisfied by 9 % of anything; the real document is only satisfied by 9 % of the right thing. |
| This bill + up to previous = up to date, exactly, for every item on every bill | `measurement-sheet.service.spec.ts` + e2e | FR-035. The one property of the package nobody can check by reading a single bill. |
| Up to previous is **read from the previous bill's stored figure**, not derived from this one | `measurement-sheet.service.spec.ts` | FR-013a. The test above is a rearrangement of its own definition unless this holds — the checklist's sharpest finding, and the reason the row above is worth anything. |
| An award line mapped to no BOQ line proposes *no measurement available*, not zero | `bill-package.service.spec.ts` + e2e | FR-003a. On the direction billed every month, zero would mean "nothing was done" for every unmapped line. |
| A rate applied to a withheld amount, and a total rounded from rounded rows | `bill-abstract.spec.ts` | FR-012a, FR-015a. The sample bill withholds nothing, so SC-003 leaves both paths untested. |
| An issued bill's register does not grow when a debit is recorded afterwards | `debit-note.service.spec.ts` + e2e | FR-039a. The resolution of FR-039 against FR-028; quickstart Pass 6 expected the opposite. |
| A one-time recovery refused past its recorded total | `bill-abstract.spec.ts` | FR-020b. Without a total, FR-020 is satisfied by doing nothing. |
| The count of measurement sheets equals the count of items, including empty ones | `bill-workbook.renderer.spec.ts` | FR-030, asserted as a **count**: an assertion over a list of sheets passes just as happily over a short list, and a missing item is a smaller invoice. 022's T052 is the precedent. |
| A bill produced twice is identical in every figure | `bill-workbook.renderer.spec.ts` | FR-028. A renderer that could recompute would drift from the signed copy. |
| The cumulative position across three consecutive bills, with measurement approved between the second and the third | e2e | D1's whole point, and the case that distinguishes frozen from recomputed. |
| A debit applied to a second bill is refused, naming the first | `debit-note.service.spec.ts` | FR-037. A debit recovered twice is money taken twice. |
| An over-claim is counted per bill and per project | `package-reports.service.spec.ts` | FR-006a. The mitigation D2 depends on. |
| An issued bill whose period's measurement has since grown is reported | `package-reports.service.spec.ts` + e2e | FR-014b. The leak D1 would otherwise create. |
| Tenant isolation under a role that cannot bypass it, non-vacuity first | `test/ra-bill-package-rls.e2e-spec.ts` | FR-050. Four new policies. |
| Every e2e suite closes its app and disconnects its clients | enforced by `e2e-teardown.spec.ts` | It scans sources and names the file. |

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| One `CHECK` constraint appended to a generated migration, where the constitution says migrations are generated and never hand-edited | `BillPackage` attaches to **exactly one** of a client bill or a subcontractor bill, and Prisma's schema language cannot express a constraint spanning two nullable references. Generated, then one additive statement appended, visible in review. The same deviation 022 tracked and for the same reason. | **A service-level invariant alone** was rejected: a package attached to both bills, or to neither, would produce a document whose figures belong to one bill and whose lines belong to another — and the thing it protects is a money document. **A discriminator column plus two nullable references and no constraint** was rejected as the same hole with extra bookkeeping. |
| A fourth new table (`BillPackageLineClaim`) rather than columns on the two existing line tables | The proposal, reason, variance and over-claim flag are identical for both directions, and the two line tables are different tables with different parents. Columns would mean the same four fields twice, maintained in two places, with the renderer reading two shapes. | **Adding the columns to both line tables** was rejected for the duplication, and because the claim is a *package* concept: a bill composed without a package (which 018's service can still do) has no proposal to record, so the columns would be permanently null on half the rows that could exist. |

## Constitution re-check, after Phase 1 design

- **I — boundaries**: holds. One cross-schema read, once per bill, frozen onto it — which FR-028
  required anyway. The daily record comes through the registry 022 established.
- **II — DTOs**: holds. `forbidNonWhitelisted` means a caller cannot supply a computed total at all.
- **III — configuration**: holds, and is the principle this feature exercises hardest. Every rate is
  an argument to a pure function and is recorded on the bill it was applied to.
- **IV — isolation**: holds. Four new policies, each read rather than copied, and a probe suite.
- **V — auth**: holds. Existing permission, existing guard, no new secret.
- **VI — migrations**: holds with the one tracked deviation, on four empty tables, no backfill.

No gate fails. Both deviations are tracked rather than waived.
