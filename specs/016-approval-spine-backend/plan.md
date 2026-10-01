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

---

## Amendment — 2026-09-16, client bug review: bug 2

Design for the re-aimed User Story 1 and for FR-012 and FR-012a–e. Feature 020's hard punch refusal
(its FR-013) is what forced this: the spine's first consumer was the attendance exception, and under
020 there is no longer an exception to consume.

The survey found bug 2's second half **mostly built and one screen short**, and its first half
**cheap but behaviour-changing on a shipped route**.

**Already built.** `hr.AttendanceModification` exists with precisely the columns FR-012a names —
`employeeId`, `date`, `actorUserId`, `before` (Json), `after` (Json), `reason`, `createdAt` — and
`attendance-admin.service.ts:324` writes one inside the same transaction as every edit. The import
path goes through the same service rather than around it, so it logs too. `GET /attendance/modifications`
reads them back for the admin Modifications Modal. So FR-012a and FR-012e are **already satisfied**,
including for Super Admin, because the log is written by the code path rather than gated on the
actor's role. No migration.

**The actual gaps** are three, and they are smaller than bug 2 sounded and differently placed.

### D14 — FR-012c is the real work: the employee has no attendance surface to reflect into

There is no `my/attendance` controller. The employee's own view of their attendance is
`GET /my/punch/history` (`punch.controller.ts:91`), which returns `AttendanceMonth` — every date with
its computed status, and nothing about how that status came to be.

So `AttendanceMonth`'s per-day shape gains a `modifications` array carrying actor **name**, time,
before, after and reason, resolved by `AttendanceHistoryService` from `AttendanceModification` rows
for that employee and month. One query for the month, joined in memory against the days already being
built — never per day, which is the N+1 this plan's Risks table already names for the spine and which
applies identically here.

The actor's *name*, not their id: the requirement is that the employee can see who changed their
attendance, and a cuid does not tell them that. This is the same argument that put labels rather than
ids in 017's FR-009 refusal.

Permission-wise this needs no new guard — `my/punch/*` is already the caller's own data by
construction, and an employee reading their own modification history is the requirement, not a
disclosure. But `reason` is free text written by an administrator who did not know the employee would
read it, which is worth saying out loud in the task rather than discovering later.

### D15 — the correction enters the chain, which changes a shipped route's behaviour

`POST /attendance` today marks or corrects an employee-day and applies it immediately, subject to the
payroll lock. FR-012 now requires a manual correction to enter the spine instead of taking effect in
one step.

This is the one genuinely invasive part of bug 2. It is handled the way research §7 handled attendance
exceptions: the route keeps its path and its DTO, and what changes is that it submits to
`ApprovalsService` and returns the pending instance rather than the applied row. The write itself
moves into the `approval.completed` handler, which already must be idempotent (Risks, "Two writes, one
boundary").

Two consequences to carry into tasks rather than leave implicit:

- **The `AttendanceModification` row is written on apply, not on submit.** A correction that is
  rejected never modified anything, and logging it as a modification would make the log disagree with
  the attendance. The submission is recorded as an approval instance, which is where a rejected
  correction correctly lives.
- **The payroll lock and the chain are independent gates and both remain.** FR-016 restricts edits
  during payroll review to HR; FR-012 routes corrections through the chain. An HR correction during
  review passes the first and still enters the second. Neither subsumes the other.

`ACTION_ATTENDANCE_EXCEPTION` in `default-chains.ts` is the existing chain key, and the existing
mapping is reused rather than renamed. Renaming a chain key means migrating live instances and slot
mappings for a vocabulary improvement; the key becomes slightly inaccurate and that is the cheaper
error. Recorded so the mismatch reads as a decision.

### D16 — FR-012d needs one filter; FR-012b needs one honest caveat

`ModificationsQueryDto` takes `employeeId`, `from`, `to` and paging. FR-012d adds "for any **actor**",
which is one optional `actorUserId` field and one `where` clause. Trivial, and worth doing because an
audit that cannot ask "what did this person change" answers the wrong half of the question.

FR-012b says the log must be immutable and not deletable while the attendance exists. No route
deletes one, and none is being added — so the requirement holds by construction for every path a user
has. **The caveat**: `AttendanceModification.employee` carries `onDelete: Cascade`, so hard-deleting
an employee deletes their modification history. Soft-delete is the norm in this product, so this is
latent rather than live, and changing the cascade would strand rows referencing a gone employee. It
is recorded as an accepted limit in the Risks table below rather than silently left to a reader who
assumes "append-only" means "survives everything".

### What deliberately does not change

- The `AttendanceModification` table, its columns, and the write at `attendance-admin.service.ts:324`.
  Bug 2's logging half is built; this amendment adds a reader, a filter and a caveat, not a store.
- The attendance exception queue's *mechanism*. 020 removes its input, not its machinery. The reconciler
  and the historical backfill (research §7) stay exactly as specified — the history they render is real
  and predates the refusal decision.

### Risks — added by this amendment

| Risk | Handling |
|---|---|
| **`POST /attendance` stops applying immediately, and callers expect it to.** | The route's response changes from an applied row to a pending instance. Every consumer — the admin daily view, the import commit path, any test asserting the row — must be found before this ships, not after. The import path is the one that will be missed: it calls the service, not the route. |
| Hard-deleting an employee cascades away their attendance modification log. | Accepted. Soft-delete is the norm, so no live path reaches it. Recorded rather than fixed: breaking the cascade strands rows against a deleted employee, which is the worse of the two. |
| A supervisor's correction is the only route to attendance for a day 020 refused, and it stands on their assertion alone. | Not a code risk — it is the residual risk the client accepted on 2026-09-16, and the chain plus the employee-visible log are the controls chosen against it. Named here so it is not mistaken for an oversight. |

### Phase status

- **Post-amendment constitution re-check**: PASS, with no new table and no migration. Principle I
  holds: `AttendanceModification` is read from `hr` by `hr`, and the spine is reached through
  `ApprovalsService` as every other consumer reaches it. Principle II holds: the one new query field
  gets its DTO property with a validator. Principle IV holds: the employee-visible modification list
  is the caller's own data on a `my/*` route, and no new table needs an RLS policy. Principle VI
  holds: additive to `AttendanceMonth`, which the web schema takes with a `.default([])` so a client
  deployed ahead of the server degrades to today's view.
- **Phase order**: this work belongs in **phase 2** as specified above ("attendance exceptions onto
  the spine"), because D15 is the same migration that phase describes, now aimed at corrections. D14
  and D16 are independent of the spine entirely and can ship before phase 1.

## Amendment — 2026-09-29, client bug review: item 7 (FR-018a corrected, FR-018b, FR-018c)

### What changed in the spec

Item 7 asks that "every critical action across the system requires Director-level approval". The
decision on 2026-09-29 was to **keep the named, configurable set** rather than widen it — a literal
reading halts daily work and cannot be tested, because nothing defines "critical". Three requirements
followed:

- **FR-018a corrected.** It claimed "the client confirmed these four". They have not; they have twice
  asked for the broad reading. The four are now stated as this product's proposal.
- **FR-018b** (new): changing the director-final set is itself a director-final action, recorded with
  actor, time, and the set before and after.
- **FR-018c** (new): the full set must be reportable — every action type the system knows of, and for
  each whether it is director-final.

### The finding that shapes this amendment

`directorFinalActionTypes` is **configuration, not data**. `approvals.service.ts:107` reads it from
`configService.get<ApprovalsConfig>('approvals')`, which resolves
`process.env.APPROVALS_DIRECTOR_FINAL_ACTIONS` with a six-element literal default in
`src/common/configs/config.ts:368`, guarded by `config.spec.ts` against `default-chains.ts`.

That satisfies FR-018a only in its weakest sense. An env var is "no code change" but it is also:

- **a redeploy**, so the client cannot change it themselves;
- **global**, so the client's two companies cannot differ;
- **unauditable**, so FR-018b's "the set before and after" has nowhere to be recorded;
- **not reportable**, so FR-018c cannot list what the system knows of versus what is gated.

So FR-018b and FR-018c are not additions on top of the current mechanism — they require the set to
become stored data. That is the whole of this amendment.

### D23 — the set becomes a table, and config becomes its seed

`settings.DirectorFinalAction { companyId, actionType, isFinal, updatedAt, updatedBy }`, unique on
`(companyId, actionType)`.

The config list stops being the source of truth and becomes the **seed** for a company's first row set
and the fallback when a company has no row for an action type. Keeping it as the fallback rather than
deleting it matters: a new action type registered by a later feature must have a defined answer before
anybody configures it, and the safe answer is the one the client already accepted.

`config.spec.ts`'s existing assertion against `default-chains.ts` stays. It is now guarding the seed
rather than the live set, which is still worth guarding — a seed that disagrees with the chains it
seeds produces a company whose first configuration is wrong.

### D24 — editing the set goes through the spine, as action type `director_final_set_change`

FR-018b says the edit is itself director-final, so it is an ordinary chain item with one level mapped
to `SLOT_FINAL`. No new mechanism: the spine already holds an item pending, records the decision, and
refuses a decision from the wrong role.

The `before` and `after` sets are held on the pending item's payload, which is what makes FR-018b's
record possible at all — the decision log records that the change was approved, and the payload
records what the change was.

**`director_final_set_change` is itself seeded as director-final**, and the seed is the only way it
gets that way. If it were configurable by the same mechanism it governs, the first act of anybody who
wanted to bypass the gate would be to remove the gate on removing gates.

### D25 — FR-018c reports the union, not the table

"Every action type the system knows of" is not the table's contents — the table holds only what
somebody has configured. It is the union of: the registered chain action types, the seeded defaults,
and any row in the table. An action type present in none of the three does not exist; one present in
the registry with no row and no seed reports as **not gated**, and reports *why* — because nothing
configures it, which is different from somebody having decided it needs no director.

That distinction is the point of FR-018c. A list that showed "not final" for both cases would hide
exactly the gap the client is asking about.

### Phases

| Phase | Work | Requirements |
|---|---|---|
| 9 | `DirectorFinalAction` table, RLS, seed from config per existing company. `approvals.service` reads the table with the config fallback. No behaviour change — the seed reproduces today's set | FR-018a |
| 10 | `director_final_set_change` action type, its default chain level at `SLOT_FINAL`, the edit endpoint submitting to the spine, the before/after payload | FR-018b |
| 11 | The union report (D25), readable under `COMPANY_SETTINGS` at read | FR-018c |

Phase 9 is inert by construction: if the seed is right, nothing changes, and if the seed is wrong,
phase 9 is where that is discovered rather than phase 10.

### Risks

| Risk | Consequence | Mitigation |
|---|---|---|
| The seed omits an action type currently gated by the env var | An action silently stops needing the director | Phase 9's gate is a comparison of the resolved set per company against `APPROVALS_DIRECTOR_FINAL_ACTIONS` before and after, not a green deploy |
| The seeding migration writes under RLS with no GUC | Every company seeded with nothing, deploy green, every gate silently gone | `set_config('app.is_super_admin','true',true)` — this is the 2026-09-16 failure shape, and here it would remove approval gates rather than merely leave a column unset |
| `director_final_set_change` becomes editable | The gate on the gate can be removed | D24 — seeded only, never listed as configurable |

### Phase status

**Next**: `/speckit-tasks` for phases 9-11. Phases 1-7 are complete; phase 8 (item 2) has 20 tasks
outstanding and does not block this amendment — they touch attendance, not the chain configuration.
