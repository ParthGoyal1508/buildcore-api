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
