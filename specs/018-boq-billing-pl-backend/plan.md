# Implementation Plan: BOQ, Billing and Project P&L (018, backend)

**Branch**: `004-dashboard-backend` · **Date**: 2026-09-16
**Spec**: [spec.md](./spec.md) (clarified 2026-09-16) · **Decisions**: [research.md](./research.md)
· **Shapes**: [data-model.md](./data-model.md)

## Summary

Client billing is untethered from the BOQ: a `Revenue` row carries a description, an amount, a date
and a status, so nothing can answer whether what was billed matches what was measured. This feature
gives bills lines that reference BOQ items, gives the BOQ a rate to price them at, and rolls the
result up against project cost to produce the P&L the client asked for in Note 12.

## Technical Context

**Language**: TypeScript 5, NestJS 10, Prisma 5.22 over multi-schema Postgres
**Storage**: `projects` schema throughout — this feature adds no cross-schema table
**Testing**: jest unit + e2e, both required. `npm run lint` is `eslint --fix` **repo-wide**; scope
eslint to touched files
**Scale**: a project has hundreds of BOQ lines and tens of bills; a company has tens of projects. The
group view is the only place where a careless query becomes O(projects × bills).

## Constitution Check

| Principle | How this plan satisfies it |
|---|---|
| **I — module boundaries (NON-NEGOTIABLE)** | Every new table is in `projects`, owned by the projects module. The P&L roll-up needs `labour`, `inventory` and `plant` and reaches none of them: it extends `ProjectSourcesRegistry`, the inversion 008 already built and shipped, so those modules register with this one rather than being imported. |
| **II — DTOs mandatory** | Bill composition, submission, certification, retention release and the summary query all take DTO classes, including the single-field ones. |
| **III — centralized configuration** | Cost categories, the group-view page size and the P&L category ordering are constants, following `src/approvals/default-chains.ts`. |
| **IV — RLS** | Five new tables, each with hand-authored `ENABLE` + `FORCE` + `tenant_isolation` in its own migration, and an e2e that proves isolation under a `NOSUPERUSER NOBYPASSRLS` probe **and checks the proof is not vacuous**. |
| **016 reuse** | FR-009 abandons and re-raises through the spine rather than mutating a completed approval. No second gate. |

**No violations.** The one place this plan comes close is the P&L roll-up, and §4 of research.md
records why the registry rather than a join is the answer.

## Phase ordering, and why

**Phase 1 is the rate.** Nothing else can be built: FR-002 prices from a rate the BOQ does not have.

**Phases 2–4 are the billing spine** — client bills, subcontractor bills, and the cumulative
quantities both depend on. These are assumption-free: nothing in them turns on the three
clarifications recorded in the spec.

**Phase 5 is the P&L roll-up**, which needs Phases 2–4 to have anything true to report.

**Phases 6–8 are the assumption-dependent parts** — variations, retention release, certification —
deliberately last. Each of the three was resolved by a recorded assumption rather than by the client,
and putting them last means overturning one costs a phase rather than the feature. That is the whole
reason for the ordering and it should not be rearranged for convenience.

**Phase 9 is verification**: RLS with its vacuousness check, the boundary test in both directions,
and the quickstart passes.

## Project Structure

```
src/projects/
├── billing/
│   ├── client-bills.service.ts        # US1: compose, submit, certify
│   ├── client-bills.controller.ts
│   ├── ra-bill-lines.service.ts       # US2: measured lines, retention, deductions
│   ├── billing-error-codes.ts
│   └── dto/
├── pnl/
│   ├── project-pnl.service.ts         # US3: monthly and cumulative, by category
│   ├── project-pnl.controller.ts      # US4: the group view, from the same method
│   └── dto/
└── portfolio/project-sources.registry.ts   # EXTENDED, not replaced
```

## What this plan deliberately does not do

- **It does not touch `Revenue`.** Money received and a claim made are different facts; collapsing
  them would make one word mean two things on the same screen.
- **It does not store cumulative billed quantity.** Research §3: a second running total beside
  `doneQty` is a reconciliation bug waiting for a month-end.
- **It does not build a variation approval workflow.** 016 already owns approvals; if a variation
  needs one, it is an action type, not a new mechanism.

## Amendment — 2026-09-29, client bug review: item 14 (FR-010a, FR-010b, FR-011a)

### What changed in the spec

Item 14 asks for a monthly labour wages summary per project "similar to staff payroll", and a total
monthly expense sheet per project "for client billing reference".

**Most of this item was already covered, and the amendment is correspondingly small.** That was
checked against the code before anything was specified:

- `labour.LabourPaymentSheet` is per project, per period, per engagement type, with `grossTotal`,
  `deductionTotal` and `netTotal`.
- `labour.PaymentSheetLine` carries `workerId`, `daysWorked`, `overtimeHours`, `resolvedRate`,
  `rateSource` and `grossWage` per worker.
- This plan's FR-010 and FR-013 already produce the monthly labour cost and reconcile it to those
  sheets.

So a per-project, per-worker wage register in the shape of a staff payroll **already exists**. Two
narrow things did not.

### D12 — the monthly roll-up is a derived view over sheets, and it apportions

`LabourPaymentSheet` covers `periodFrom` to `periodTo`, supplied by the caller. Nothing makes that a
calendar month. Under a fortnightly cycle a month contains two or three sheets, and a month boundary
falls inside one of them.

FR-010a is therefore a view, not a table: for a project and a calendar month, the union of every sheet
overlapping the month, itemised per worker.

**Apportionment is on days worked inside the month, not on elapsed calendar days.** `PaymentSheetLine`
already carries `daysWorked`, and the muster rows behind it carry dates, so the days falling inside the
month are knowable exactly. Pro-rating by calendar days would invent a figure — a worker who worked
four days of a fortnight all in the first week is not 50% attributable to each month, and a labour cost
that disagrees with the muster is worse than one that is merely coarse.

FR-010a requires the apportionment be **stated on the view**. A figure the reader cannot account for is
the thing this feature exists to remove.

### D13 — the roll-up computes nothing

FR-010b: no wage is recomputed. The view reads `grossWage` and the deduction figures as the sheet
recorded them. A sheet corrected later corrects every view over it, and there is exactly one place a
wage is computed.

This is why the roll-up is not a table. A stored roll-up would be a second figure for the same wage,
and the two would disagree the first time a sheet was reopened — which the spec's own edge case says
happens.

### D14 — the export is a document, and it carries its production date

FR-011a. The client's phrase is "for client billing reference", which means it is quoted to a client,
which means it leaves the system and outlives the screen.

It carries the project, the month, the figures as shown, and **the date it was produced**. The date is
not decoration: the spec's edge case is a payment sheet reopened and re-approved after a month was
exported, and the production date is the only thing that lets two exports of the same month be told
apart. Without it, the older document is indistinguishable from the current position and somebody
quotes it.

Format follows the repository's existing export pattern rather than introducing one.

### Where this sits against the existing phases

Phases 1-9 are unchanged. This is appended, not interleaved, because the roll-up reads the monthly
labour figure that Phase 5 produces:

| Phase | Work | Requirements |
|---|---|---|
| 10 | The monthly roll-up view over `LabourPaymentSheet` and `PaymentSheetLine`, with apportionment stated | FR-010a, FR-010b |
| 11 | The monthly position export, carrying project, month, figures and production date | FR-011a |

Phase 10 depends on Phase 5 (the project P&L) for the category total it itemises, and on nothing else.
It touches no table.

### Constitution re-check

| Principle | Assessment |
|---|---|
| **I. Schema-per-module boundaries** | The roll-up reads `labour`'s tables. `projects` must not join them — it goes through the labour module's service, as FR-013's existing reconciliation already does. No new cross-schema query. |
| **II. Validated DTO contracts** | The roll-up's query parameters — project, year, month — are a validated DTO with bounded month and year. |
| **VI. Observability & safe migrations** | **No migration.** Both requirements are read paths over existing tables, which is why this amendment adds two phases and no schema change. |

### Risks

| Risk | Consequence | Mitigation |
|---|---|---|
| Apportionment disagrees with the sheet's own totals | The month's labour cost does not reconcile to FR-013's figure | SC-007 asserts the apportioned sum to the rupee, with a straddling sheet in the fixture |
| A contractor-engaged month has no per-worker disbursement to list | An empty view that looks broken | The spec's edge case names this; the view states the engagement type rather than rendering nothing |
| The export is taken as current after a sheet is reopened | A client is quoted a superseded figure | D14's production date |

### Phase status

**Next**: `/speckit-tasks` for phases 10-11. Phases 1-9 have 55 tasks, none started; phases 6-8 rest
on assumptions awaiting the client and are deliberately last.
