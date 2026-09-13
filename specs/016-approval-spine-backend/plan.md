# Implementation Plan: Approval Spine (Backend)

**Branch**: `016-approval-spine-backend` | **Date**: 2026-09-13 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/016-approval-spine-backend/spec.md`

## Summary

Five client notes describe one mechanism: a record moves through named people in a fixed order,
everyone can see who acted, and somebody has the last word. The system today has approval
*permissions* and single-step resolutions, but no concept of a sequence and no concept of a decision
that is final.

This plan adds a **cross-module approval spine** in the `shared` schema that references the items it
governs opaquely, plus a scheduled payroll run and an attendance lock during payroll review. Chain
levels name configurable **role slots** rather than roles, so two companies may staff the same chain
differently. One person may not decide twice on the same item — a rule that only matters because the
final authority resolved to Super Admin, which holds every permission.

**Migration is per module, not all at once.** Attendance exceptions first; every other module keeps
its existing single-step approval until its turn.

## Technical Context

**Language/Version**: TypeScript 5.x, NestJS 10, Node 22

**Primary Dependencies**: Prisma 5.22, `@nestjs/schedule` (installed, two crons already in use),
`@nestjs/event-emitter` (installed, the Principle I fan-out seam). **Nothing new.**

**Storage**: PostgreSQL, multi-schema. New tables in `shared`. No new schema.

**Testing**: Jest unit + e2e, both present and used. 707 unit tests pass on this branch. Real tests
are expected for the acceptance scenarios. Note: 9 punch tests in `test/my-workspace.e2e-spec.ts`
fail on main (duplicate punch-in returns 500 not 409) — **confirmed pre-existing and unrelated**.

**Target Platform**: Render. **The instance suspends when idle, and a cron does not fire on a
suspended instance** — see Risks.

**Project Type**: Backend service.

**Performance Goals**: Spec NFR-001 — 150 concurrent attendance actions, p95 under 2s read / 4s
approval write. Unverified; no load test exists.

**Constraints**: Principle I (NON-NEGOTIABLE) forbids cross-schema queries. The spine spans seven
modules. This single constraint determines the entire design — see research.md §1.

**Scale/Scope**: 5 new tables, 1 new module, ~4 changed modules, 2 enum additions, 1 cron.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | Assessment |
|---|---|
| **I. Schema-Per-Module Boundaries (NON-NEGOTIABLE)** | The binding constraint. The spine owns tables in `shared` and holds only opaque `(entityType, entityId)` references — no FK, no join into any module. Modules reach it through the exported `ApprovalService`; completion fans out on the event bus, which the principle names for exactly this. Quickstart Pass 10 greps for violations. **Pass** — and the design exists because of this article, not despite it. |
| **II. Validated DTO Contracts (NON-NEGOTIABLE)** | Every endpoint takes a DTO, including the two-field decide body. The codebase has already been bitten by DTO-less `@Query()` params slipping past the global `ValidationPipe`; small bodies get DTOs for that reason. **Pass.** |
| **III. Centralized Configuration** | Cron expression, timezone and the Director-final action set are configuration, not literals. FR-018a requires the final-authority set to change without a code change. **Pass.** |
| **IV. Multi-Tenant Isolation (NON-NEGOTIABLE)** | Every new table is company-scoped with an RLS policy. `ApprovalInstance` is read by ordinary users on the queue path, so its policy must be right for non-super-admin callers — the one place a mistake would leak one company's pending work into another's queue. Called out in data-model.md and tested. **Pass, with attention.** |
| **V. AuthN/AuthZ & Secrets** | Authority comes from the chain's slot mapping, deliberately *not* a new permission value — two sources of truth about who may approve is the failure this avoids. Refused attempts are audited. **Pass.** |
| **VI. Observability & Safe Migrations** | Additive migration: new tables, two nullable columns, enum additions. No destructive change. `PayrollRunStatus` deliberately unchanged. Refusals and configuration changes are audited. **Pass.** |

No violations. Nothing for Complexity Tracking.

## Project Structure

### Documentation

```text
specs/016-approval-spine-backend/
├── spec.md
├── plan.md              # This file
├── research.md          # 7 decisions; §1 is the one everything follows from
├── data-model.md        # 5 new tables, 2 changed models
├── quickstart.md        # 10 passes
├── contracts/
│   └── approval-service.md   # in-process contract + HTTP surface
└── checklists/
    └── requirements.md
```

### Source Code

```text
src/approvals/                      # NEW — the spine, owns the `shared` tables
├── approvals.module.ts
├── approvals.service.ts            # submit, decide, stateOf, statesOf, abandon, queueFor
├── approvals.controller.ts         # /approvals/*
├── chains.service.ts               # chain + slot-mapping definition and validation
├── dto/
└── approval-error-codes.ts         # distinguishable refusals (contracts Part 1)

src/payroll/
├── runs/payroll-schedule.cron.ts   # NEW — mirrors ReminderEvaluationCron
├── runs/payroll-runs.service.ts    # CHANGED — scheduled creation, isPeriodUnderReview()
└── runs/bank-sheet.service.ts      # CHANGED — held until the chain completes

src/hr/
├── attendance-exceptions/          # CHANGED — first module onto the spine
└── attendance/                     # CHANGED — HR-only edit under review

prisma/
├── schema.prisma                   # CHANGED — 5 tables, 2 models, 1 enum
└── migrations/                     # NEW — additive, plus RLS policies
```

## Approach

### Phase order

1. **The spine alone** — tables, service, contract, chain definition. Nothing consumes it yet, and it
   is fully testable in isolation.
2. **Attendance exceptions onto it**, including backfilling historical resolutions as completed
   single-level instances so history renders through one path (research.md §7).
3. **Payroll**: scheduled creation, the chain, the bank-sheet hold, the attendance lock.
4. **Audit, queue and hardening**.

Each phase is releasable. Phase 1 changes no existing behaviour at all.

### What deliberately does not change

Existing single-step approvals — `MaterialIndent.approvedByUserId` and its five siblings — keep
working untouched (spec FR-022). Migrating seven modules in one change would produce a release
nobody can review or roll back safely.

## Risks

| Risk | Handling |
|---|---|
| **The cron never fires in production.** Render suspends the instance when idle; a suspended instance runs no schedule. | The service method is independently callable and the manual path stays. Recorded in research.md §4 and quickstart's closing note. **This is an infrastructure decision that this feature cannot solve** and must not be assumed solved. |
| No FK to the governed item; a deleted item orphans its chain. | Soft-delete is already the norm; `abandon()` closes chains explicitly; a reconciliation sweep reports orphans. Accepted cost of Principle I (research.md §1). |
| N+1 against the spine from every list in the product. | `statesOf` batch method in the contract, and quickstart Pass 9 asserts the query count. This will otherwise be got wrong by the third module to migrate. |
| RLS on `ApprovalInstance` read by ordinary users. | Explicit non-super-admin policy tests. A mistake leaks another company's pending work into a user's queue. |
| A company maps two slots to one role, stalling every item in that chain. | Refused at mapping time with the conflicting levels named (FR-021b). The failure it prevents is silent, total and discovered only when work stops. |
| Slot mapping changes mid-chain. | Authority resolves at decision time, deliberately; the audit records who actually decided, so history stays truthful either way (research.md §2). |
| **Two writes, one boundary.** A decision commits in `shared` and the item's own status update fails. | `ApprovalInstance.state` is authoritative; module status is derived (research.md §8, added after the module-boundary checklist asked). The `approval.completed` handler must be idempotent and a reconciliation sweep reports drift. Chosen over an outbox because the failing write is a status column with replayable effects. |
| Attendance lock blocks legitimate corrections. | The lock is scoped to periods under review and HR retains the right; an edit invalidates approvals rather than being refused outright. |

## Verification

`npx tsc --noEmit`, `npx eslint <touched files>` (**not** `npm run lint` — that is `eslint --fix`
repo-wide), `npm test`, `npm run build`, then the ten passes in [quickstart.md](./quickstart.md).

Pass 2 (one person cannot decide twice) and Pass 3 (unsatisfiable chain refused) are the two that
prove this feature is control rather than ceremony. If only two passes are run, run those.
