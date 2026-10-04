# Implementation Plan: Daily Work Reports

**Branch**: `022-daily-work-reports-backend` | **Date**: 2026-10-04 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/022-daily-work-reports-backend/spec.md`

## Summary

Give the daily work report tables the behaviour 008 specified and never built, so that a BOQ line's
executed quantity becomes a fact instead of a permanent zero — and expose, as a first-class read,
the approved measurement per BOQ line per period that feature 023 will default each billed quantity
from.

Six phases, each independently committable. The migration comes first and is small; the two
genuinely new pieces of thinking are **which quantity governs a measurement line** (because a
maintenance contract pays for presence, not measurement, and the six-factor formula cannot express
that) and **what undoes an approval** (because approval moves a counter that a bill is built from,
and 008 never said how to take it back).

Everything cross-module is read through the existing `ProjectSourcesRegistry` rather than queried
directly, and everything cumulative is aggregated rather than stored — both for reasons this
repository has already paid for once.

## Technical Context

**Language/Version**: TypeScript 5 on Node.js 20, NestJS 10.

**Primary Dependencies**: Prisma 5.22 (multiSchema) against PostgreSQL; `class-validator` /
`class-transformer` for DTOs; `@nestjs/swagger`; the existing `StorageService` (local encrypted
adapter in dev, S3-compatible in production) for attachments. **No new dependency.**

**Storage**: PostgreSQL, `projects` schema. Two tables already exist (`DailyWorkReport`,
`DWRTask`) with three enums (`DwrStatus`, `DwrWeather`, `DwrPaymentMode`). One table is read across
a module boundary: `plant.LogbookEntry`.

**Testing**: Jest + ts-jest for unit tests colocated as `*.spec.ts`; `test/*.e2e-spec.ts` against a
running Postgres. Note that the application is compiled by **SWC** (`nest-cli.json` sets
`"builder": "swc"`) while the tests are compiled by **ts-jest with `esModuleInterop` off** — a
difference that has already shipped one production defect, and which `src/common/swc-interop.spec.ts`
now guards. This feature adds no CommonJS-callable import, so it is not exposed to that split.

**Target Platform**: Linux server (Render), Node 20-slim container.

**Project Type**: Web service (REST), one module inside an existing monolith.

**Performance Goals**: A day's report of ~20 measurement lines recorded, submitted or approved in
under 3 s per step (SC-008). A month of reports for one project listed in under 2 s. The period
figures of FR-034 for a project with ~320 BOQ lines returned in a bounded number of queries — not
one per line.

**Constraints**: Decimal columns are `Prisma.Decimal` and serialise as strings; money and quantity
arithmetic never touches a JavaScript number. Writes run inside `withRlsContext`, whose interactive
transaction defaults are `maxWait` 2000 ms and `timeout` 5000 ms — a budget this session has
already seen exceeded by 132 sequential round trips inside one transaction, so a report's lines are
written and incremented in a bounded number of statements rather than one per line.

**Scale/Scope**: One report per project per day, ~17–20 measured lines each, ~30 reports per project
per month. The client's real tender carries 312 BOQ lines across 66 groups, which is the size the
period-figures read must be designed for.

## Constitution Check

*GATE: evaluated before Phase 0, re-evaluated after Phase 1 at the end of this document.*

| Principle | Gate | Verdict |
|---|---|---|
| **I. Schema-per-module boundaries** | Does this feature query a schema it does not own? | **PASS with one designed seam.** Everything written is in `projects`. The supervisor stays an `hr.Employee` id held bare, as the existing column already does. The equipment logbook (FR-032) lives in `plant` and is read **through `ProjectSourcesRegistry`**, never by querying `plant.LogbookEntry` — see research §5, including why the registration direction is forced. |
| **II. Validated DTO contracts** | Is every request body typed and validated? | **PASS.** Every endpoint takes a `class-validator` DTO. The create DTO is deliberately *two* shapes rather than one permissive shape — research §3. |
| **III. Centralised configuration, no hardcoded values** | Any magic values or inline strings? | **PASS.** Refusal codes and messages go in `src/projects/dwr/dwr-error-codes.ts`, following `src/projects/boq/boq-error-codes.ts`. The report-number format and the default page size are config, not literals. |
| **IV. Multi-tenant isolation and PII protection** | Is every row scoped, and is the scoping *proven*? | **PASS, and this is the gate that needs the most work.** Both tables carry `companyId`; every path runs through `withRlsContext`; another company's report is reported as not found (FR-029). FR-040 names both tables and requires a probe under a role that cannot bypass RLS, because the development and CI role is a superuser and Postgres exempts superusers from row-level security unconditionally. FR-040a requires the non-vacuity assertion **first**, FR-040b requires an un-creatable probe to report as skipped and never as passed, and FR-040c puts the BOQ line table explicitly out of scope rather than silently claiming it. This session established that 148 tables carry `tenant_isolation` while about 21 are named in the five existing probe suites, and that the gap is what let a `42501` reach production. `test/dwr-rls.e2e-spec.ts` is therefore a deliverable of this feature, not a nicety. |
| **V. Auth, authorisation, secrets** | Is every route permissioned? | **PASS.** `Permission.DWR` on every route (already seeded into roles), `ProjectLockGuard` on writes. No new secret. |
| **VI. Observability and safe migrations** | Is the migration generated, additive and reversible? | **PASS with one justified deviation.** All columns are added nullable with no backfill — verified safe because the tables are empty (research §1). The deviation is a single `CHECK` constraint appended to the generated migration, which the Prisma schema cannot express. See **Complexity Tracking**. |

**Technology stack**: no new dependency, so no pre-approval question arises. Attachments reuse the
`StorageService` interface the constitution requires rather than touching `@aws-sdk/client-s3`.

## Project Structure

### Documentation (this feature)

```text
specs/022-daily-work-reports-backend/
├── spec.md              # The specification, with D1 and D2 decided
├── plan.md              # This file
├── research.md          # Phase 0 — the eight decisions and what each rejects
├── data-model.md        # Phase 1 — the migration, field by field
├── quickstart.md        # Phase 1 — how to prove it works
├── contracts/
│   └── dwr-api.md       # Phase 1 — the endpoints, including the 023 contract
├── checklists/
│   └── requirements.md  # Spec quality checklist (from /speckit-specify)
└── tasks.md             # Phase 2 — NOT created by /speckit-plan
```

### Source Code (repository root)

```text
src/projects/dwr/                       # New. The whole feature, bar two edits elsewhere.
├── dwr.controller.ts                   # Phase F
├── dwr.service.ts                      # Phases C–E
├── dwr-quantity.ts                     # Phase B — pure, no Nest, no Prisma
├── dwr-quantity.spec.ts                # Phase B
├── dwr-period-figures.service.ts       # Phase E — the 023 contract
├── dwr-period-figures.service.spec.ts  # Phase E
├── dwr-reversal.spec.ts                # Phase D
├── dwr-error-codes.ts                  # Principle III
└── dto/
    ├── create-dwr.dto.ts               # Two shapes, by payment basis
    ├── update-dwr.dto.ts
    ├── dwr-lifecycle.dto.ts            # submit / approve / return / reverse
    └── dwr-query.dto.ts                # list filters, period range

src/projects/projects.module.ts         # Edited: register DwrService, wire BoqService into it
src/projects/portfolio/project-sources.registry.ts
                                        # Edited: + ProjectLogbookSource (Phase E)
src/plant/plant.service.ts              # Edited: registers the logbook source (Phase E)

prisma/schema.prisma                    # Edited: Phase A
prisma/migrations/2026100XXXXXXX_dwr_served_qty_and_reversal/migration.sql

test/dwr.e2e-spec.ts                    # The 008 US5 test that has never been runnable
test/dwr-rls.e2e-spec.ts                # FR-040, under a NOSUPERUSER NOBYPASSRLS role
```

**Structure Decision**: a new `src/projects/dwr/` directory inside the existing projects module,
matching the shape of its five siblings (`boq/`, `billing/`, `pnl/`, `portfolio/`, `sites/`,
`documents/`). Three files outside it are edited, each for a reason named above; nothing else in the
repository changes.

## Phases

### Phase A — the migration (FR-030, FR-019, FR-022, FR-032)

Three changes to `projects.DWRTask` and three to `projects.DailyWorkReport`, all additive and all
nullable. Detail in [data-model.md](./data-model.md); the decisions behind them in research §1–§4.

- `DWRTask.servedQty` — nullable `Decimal(18, 3)`. The quantity of a presence-paid day.
- `DWRTask.actualQty` — **becomes nullable**. It is the quantity of a *measured* line, and a
  presence line has none. Safe without backfill: the table is empty.
- `DWRTask.equipmentId` — nullable `String`, a bare `plant.Equipment` id with no cross-schema
  relation. Without it FR-032 has nothing to look a logbook entry up by.
- `DailyWorkReport.reversedAt`, `reversedByUserId`, `reversalReason` — the latest reversal.
- `DailyWorkReport.reversalCount` — `Int @default(0)`.
- One appended `CHECK`: exactly one of `actualQty` and `servedQty` is non-null, and which one
  matches `paymentMode`. See Complexity Tracking for why this is in SQL.

No new table, so no new RLS policy; both tables already carry `tenant_isolation`. What they do not
have is a test proving it, which Phase F delivers.

### Phase B — the quantity in force (FR-003, FR-004, FR-030a, FR-030b, FR-030d, FR-030e)

`src/projects/dwr/dwr-quantity.ts`: pure functions, no Nest, no Prisma, unit-tested on their own.

- `computeMeasuredQty(factors)` — the product of the six factors, with an unsupplied factor treated
  as 1 and a factor of 0 refused by name (FR-004). A zero product is a data-entry error, not a day
  on which nothing happened.
- `quantityInForce(line)` — a discriminated switch on `paymentMode`: `work_basis` returns the
  measured quantity, `day_basis` returns the served quantity. **The `day_basis` branch does not
  read the factor fields at all**, and the input type for that branch does not carry them, so
  FR-030b is a property of the types rather than a rule somebody remembers. Research §3 explains
  why this is worth the extra shape.

Every later phase calls `quantityInForce` — create, read, approval, reversal and the period figures
— so there is exactly one place that knows which quantity governs a line.

### Phase C — recording (FR-001 to FR-009, FR-025, FR-030c)

`DwrService.create`, `update`, attachments.

- The report number is generated from `Project.code` (research §2): `Site` has no code field at all
  and the report references a project, so 008's `{siteCode}-{sequence}` was doubly impossible. The
  sequence is per project, and the stored number satisfies the existing
  `@@unique([companyId, dprNumber])`.
- BOQ-line ownership is checked before anything is written: a line in another project is refused
  naming both. A line with no BOQ reference is accepted and marked as moving nothing (FR-007).
- Over-scope is flagged, never refused (FR-006) — the existing `exceedsScope` column.
- A second report for a date already covered is accepted and the existing one named (US1 AC8).
- A future work date is refused; one before the project's start date is accepted and the
  discrepancy reported (FR-025).
- A presence line with a served quantity below a full day requires a remark (FR-030c).
- Attachments go through `StorageService`, with `detectContentType` / `describeStoredFile` and
  `contentDispositionFor` from `src/common/storage/file-type.ts` — all written this session, so a
  download arrives named and typed rather than as a bare UUID.

### Phase D — the lifecycle (FR-010 to FR-024)

`submit`, `approve`, `returnToDraft`, `reverse`, `remove`.

- `approve` calls `BoqService.updateDoneQty`, which exists, is exported from `ProjectsModule` for
  this caller, and has had no caller since August. Phase D is where that wiring finally closes.
- All of a report's increments or none (FR-013): one transaction, and **bounded statements** — the
  lines are grouped and incremented together rather than looped, because this session watched 132
  sequential round trips exceed the 5 s transaction budget and return a bare 500.
- At most once (FR-014): the status transition and the increments are in the same transaction, and
  the transition is conditional on the current status, so a concurrent second approval loses.
- Relative increments only (FR-015): `{ increment: … }`, never a figure read earlier in the same
  operation. Two reports measuring one BOQ line concurrently must both land.
- The approver may not be the author (FR-012a, decision D2).
- `reverse` subtracts exactly what the approval added and returns the report to draft, recording
  actor, time and reason (FR-019), and may not drive any counter below zero (FR-021).
- **FR-020 is a billed-quantity floor.** It did not say so when this plan was written — it then
  required refusal for "a report whose measurement has been claimed on a bill", a condition no
  implementation can determine, and `checklists/silent-failure.md` CHK029 caught the divergence and
  the requirement was rewritten. The reasoning, which came first, is research §4: no bill line references a daily work report anywhere in the
  schema, so "this report's measurement has been billed" is not a question the database can answer
  today. What it can answer is whether reversing would drop a BOQ line's done quantity below the
  quantity already billed against it on a non-draft bill — `ClientBillLine` on a `submitted` or
  `certified` `ClientBill`, or `RABillLine` reaching the same BOQ line through a work-order award
  line on a `submitted` or `approved` `RABill`. That is a stronger invariant than a per-report link
  would be, and it is available now. The weaker half — naming *which* report's measurement a given
  bill line consumed — waits for 023, and research §4 says so rather than letting FR-020 look
  finished.

### Phase E — reading, and the contract to 023 (FR-026, FR-027, FR-032 to FR-039c, FR-015b)

- `list` with project, date-range and status filters, ordered by work date, server-paginated with a
  total count that does not depend on the page (FR-026).
- `findOne` returning each line beside its BOQ line's scope, done, pending and period target
  (FR-027), reusing `BoqService`'s existing projection rather than recomputing it.
- `DwrPeriodFiguresService` — the 023 contract. Per BOQ line: approved **within** the range,
  approved **before** it, and the sum. Three properties that each needed deciding:
  - **Aggregated, never stored.** 018 research §3 decided exactly this for cumulative billed
    quantity, and its reasoning transfers without modification: a second running total beside
    `doneQty` is a reconciliation bug waiting for a month-end.
  - **Attributed by work date, not approval date** (FR-036) — a report approved late belongs to the
    day it describes, and a billing period is a period of work.
  - **Every BOQ line present, including zeros** (FR-037) — so nothing composing a bill can drop a
    line by failing to find it, which is the silent-failure shape this repository keeps meeting.
  - `reconcile(projectId)` for FR-039: the difference between each line's stored `doneQty` and the
    sum of approved measurement against it, at an exact tolerance (FR-039a). The aggregate is the
    check on the counter; FR-039 exists because `doneQty` is denormalised and therefore capable of
    drifting.
  - `repair(boqItemIds, reason)` for FR-039c — explicit, permissioned, audited with the previous
    value, and **never automatic**. It needs an **absolute** set on `BoqService`, distinct from
    `updateDoneQty`'s relative increment and reachable only from here: FR-015 forbids writing a
    figure read earlier, and FR-015b records repair as its sole exception, because a relative
    increment cannot express "make this equal that" when the difference is what is being corrected. Decision D3 records why: the discrepancy is the only symptom of
    whatever moved the counter without a report, and a silent self-heal destroys that evidence each
    time it runs. The aggregate is authoritative and the counter is a cache of it (FR-039b).
- The logbook read (FR-032, FR-033) goes through a new `ProjectLogbookSource` on
  `ProjectSourcesRegistry`, registered by `PlantService.onModuleInit`. Research §5 explains why the
  direction is forced rather than chosen, and why the return type is a map.

### Phase F — controller, guards, and the isolation proof (FR-028, FR-029, FR-040)

- `DwrController` at `projects/:id/dwr` and `projects/dwr/:dwrId`, `Permission.DWR` on every route,
  `ProjectLockGuard` on every write (423, distinguishable from a 403 — the same caller may write
  once the project is unlocked).
- Company scoping through `withRlsContext`; another company's report is **not found**, not
  forbidden (FR-029), because a 403 confirms the row exists.
- `test/dwr-rls.e2e-spec.ts`: a `NOSUPERUSER NOBYPASSRLS` probe role, following
  `test/company-selection-rls.e2e-spec.ts` — **including its non-vacuity test that the probe role
  was actually created**, without which the whole suite passes against a superuser connection and
  proves nothing. That is precisely how the `42501` reached production.

## Test strategy

Planned here rather than left to tasks, because three of these tests are the feature's only defence
against a failure that looks like success.

| What | Where | Why it has to exist |
|---|---|---|
| Submit → `doneQty` unchanged; approve → increments; approve again → refused and does not move twice | `test/dwr.e2e-spec.ts` | **The 008 US5 acceptance test that has never been runnable.** 008 corrected its own first draft to move progress on approval rather than submission; nothing has ever checked that it does. |
| Reverse → every affected `doneQty` returns to its exact pre-approval value; the floor of FR-021 holds | `src/projects/dwr/dwr-reversal.spec.ts` + e2e | Reversal is the path that makes approval safe. An off-by-one here leaves a counter permanently wrong with nothing to notice. |
| A presence line with factors set to values other than 1 still yields the served quantity | `src/projects/dwr/dwr-quantity.spec.ts` | **The requirement most likely to rot silently.** All six factors default to 1, so their product is 1 — indistinguishable from one day served. A refactor that starts reading the factors would pass every test written the obvious way. This test sets them to 7 and asserts the answer is still the served quantity. |
| Three approved reports across two months plus one submitted: period sum, prior sum, exclusion of the submitted one, attribution by work date, and consecutive non-overlapping ranges summing to the line's own `doneQty` | `dwr-period-figures.service.spec.ts` + e2e | FR-034 to FR-039, and the identity in US6 AC6 is the one assertion that would catch an attribution bug in either direction. |
| A BOQ line with no approved measurement appears with zeros | same | FR-037. An omitted line is how a bill silently loses an item. |
| Two reports measuring one BOQ line, approved concurrently, both land | e2e | FR-015. A read-then-write would lose one, and the loss is invisible. |
| Tenant isolation under a role that cannot bypass it, plus the non-vacuity check | `test/dwr-rls.e2e-spec.ts` | FR-040. Both tables have carried `tenant_isolation` since August and it has never once been in force in a test run. |
| Every e2e suite closes its app and disconnects any `PrismaClient` it constructs | already enforced by `src/common/prisma/e2e-teardown.spec.ts` | It scans sources and names the offending file. Both new suites must satisfy it. |

Unit tests are colocated per the constitution. The two e2e suites are additive; nothing in the
existing 36 suites changes.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| One `CHECK` constraint appended to a generated migration, where the constitution says migrations are generated and never hand-edited | The invariant is *exactly one of `actualQty` and `servedQty` is non-null, and which one matches `paymentMode`*. Prisma's schema language cannot express a constraint spanning two columns and an enum, so there is no generated form of it. The constitution's intent is that migrations are not authored by hand instead of being generated — this one is generated and then has a single additive statement appended, which is visible in review and reversible. | **A service-level invariant alone** was rejected: it is one `prisma.dWRTask.create` away from being bypassed, and the thing it protects is the quantity that moves a billed counter. The whole point of D1 was to stop a quantity being right by coincidence; leaving its one hard rule to a convention in a service would reintroduce exactly that. A unit test on the service proves the service, not the table. |
| `actualQty` becomes nullable, loosening a `NOT NULL` | A presence-paid line has no measured quantity. The honest representation of "this line is not measured" is absence, not zero — zero is a legitimate measured quantity. | **Keeping `NOT NULL` and storing 0** was rejected because it makes "not measured" and "measured as nothing" the same value, and the client's real sheets contain both. **Storing the served quantity in both columns** was rejected as two copies of one fact, which is the pattern 018 research §3 already refused. |

## Constitution re-check, after Phase 1 design

Re-evaluated against the design in [research.md](./research.md), [data-model.md](./data-model.md)
and [contracts/dwr-api.md](./contracts/dwr-api.md):

- **I — boundaries**: holds. One cross-module read, through the registry, registered from the
  `plant` side because `PlantModule` already imports `ProjectsModule` and the reverse is the cycle
  006 T058/T059 recorded. No cross-schema join and no second copy of a logbook reading.
- **II — DTOs**: holds, and strengthened: the create DTO is two shapes so a presence line cannot
  carry factors at all.
- **III — configuration**: holds. Refusal codes in one file; the number format and page size in
  config.
- **IV — isolation**: holds, and is the only principle this feature *adds* proof for rather than
  merely satisfying. `test/dwr-rls.e2e-spec.ts` is a deliverable.
- **V — auth**: holds. Existing permission, existing guard, no new secret.
- **VI — migrations**: holds with the one deviation tracked above, on empty tables, with no
  backfill.

No gate fails. The two deviations are tracked rather than waived.
