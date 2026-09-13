# Tasks: Approval Spine (Backend)

**Input**: Design documents from `/specs/016-approval-spine-backend/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/approval-service.md](./contracts/approval-service.md)

**Tests**: Jest unit + e2e are installed and used (707 unit tests pass on this branch). Real tests
are expected for the acceptance scenarios. Note: 9 punch tests in `test/my-workspace.e2e-spec.ts`
fail on main — **confirmed pre-existing and unrelated**; do not chase them.

**Gate**: `checklists/module-boundary.md` is a reviewer-owned artifact with 22 unchecked items.
`/speckit-implement` reads its markers and must not modify them.

**The one thing to keep hold of**: the spine never reads a module's schema and no module reads the
spine's. Every task below is written so that staying inside that rule is the easy path.

---

## Phase 1: Foundational — the spine alone

**Nothing consumes it yet. This phase changes no existing behaviour.**

- [X] T001 Add `ApprovalChain`, `ApprovalLevel`, `RoleSlotMapping`, `ApprovalInstance` and
      `ApprovalDecision` to `prisma/schema.prisma` in the **`shared`** schema, per
      [data-model.md](./data-model.md). No foreign key to any business-module table — that absence
      is the design (research.md §1), so add a schema comment saying so where a future reader will
      meet it (checklist CHK016)
- [X] T002 Add the unique and partial-unique constraints: `ApprovalInstance (entityType, entityId)`
      where non-terminal; `ApprovalDecision (approvalInstanceId, actorUserId)` partial;
      `ApprovalDecision (approvalInstanceId, position)`; `ApprovalLevel (chainId, position)` and
      `(chainId, slotKey)`. The partial unique is what enforces FR-021a under a race — a
      service-layer check reads-then-writes and loses (research.md §3)
- [X] T003 Add index `ApprovalInstance (companyId, state, currentPosition)` — the approval queue is
      the hottest read in this feature
- [X] T004 Generate the migration and hand-author the RLS policies for all five tables, matching the
      shape used by existing `shared` tables
- [X] T005 [P] Add `APPROVAL_DECISION`, `APPROVAL_REFUSED` and `APPROVAL_CHAIN_CONFIG` to
      `AuditEntityType`
- [X] T006 [P] Create `src/approvals/approval-error-codes.ts` with the five distinguishable refusal
      codes from [contracts/approval-service.md](./contracts/approval-service.md). They are separate
      because they have separate remedies; a single `403` sends people to fix the wrong thing
- [X] T007 Create `src/approvals/approvals.module.ts` exporting `ApprovalService`
- [X] T008 Implement `ChainsService` (FR-001, FR-001a) in `src/approvals/chains.service.ts`: chain
      and level CRUD, slot mapping read/write
- [X] T009 Implement the unsatisfiable-chain guard in `ChainsService`: refuse a slot mapping under
      which two levels of any active chain resolve to the same role, naming both levels (FR-021b).
      **At mapping time, not at decision time** — the failure it prevents is silent, total, and
      discovered only when work stops
- [X] T010 Implement `ApprovalService.submit()` — resolve the active chain, refuse a duplicate live
      instance, throw a *configuration* fault (not a 403) when no chain exists (FR-001b)
- [X] T011 Implement `ApprovalService.decide()` (FR-002, FR-004, FR-005, FR-006, FR-020) —
      authority via slot mapping, advance or terminate, require a reason for reject and return,
      increment `returnCount` on resubmission
- [X] T012 Implement the FR-021a refusal in `decide()`: a person who has already decided on this
      item may not decide again, returning `APPROVAL_ALREADY_DECIDED` distinct from
      `APPROVAL_NOT_AUTHORISED`. Super Admin holds every permission, so this is the common case, not
      the edge case
- [X] T013 Emit `approval.completed` on the event bus at final approval, carrying only
      `(entityType, entityId, companyId, instanceId)`. The spine must not call any module
      (checklist CHK009, CHK010)
- [X] T013a Include in every state the fields the interface needs but cannot compute (FR-010,
      FR-011): `canActNow`, `levelLabel`, `awaitingUserName`, and `inertReason` with its four
      values. `already_decided` is knowable only here — without it the interface must tell a Super
      Admin they lack permission, which is false
- [X] T014 [P] Implement `stateOf()` and `statesOf()` — the batch form is what every list must use
      (contract Part 1; checklist CHK018)
- [X] T015 [P] Implement `abandon()` so a cancelled item closes its chain instead of waiting forever
      (research.md §1)
- [X] T015a Implement `reassign(instanceId, toUserId, reason)` — move a pending item to another
      holder of the same level (FR-019). **Not a convenience.** Because FR-021a forbids a second
      decision by the same person, this is the only way an item stalled by thin staffing can move,
      and the analyze pass found it had no task at all. Administrative act only; an approver may not
      use it to skip their own level
- [X] T015b [P] Audit every reassignment, and unit-test that an approver cannot reassign an item
      currently awaiting themselves
- [X] T016 Implement `queueFor()` — resolve the caller's roles to slots, find pending instances at a
      matching level, and **exclude items they have already decided on**. A queue listing work you
      are forbidden to action trains people to ignore the queue
- [X] T017 Write every refused decision to `AuditLogEntry` as `APPROVAL_REFUSED` with the attempted
      action and the reason for refusal (FR-003)
- [X] T018 [P] Unit tests for `ChainsService`: chain resolution, slot mapping, and the unsatisfiable
      guard refusing with both level names
- [X] T019 Unit tests for `decide()`: each of the five refusal codes, advance, terminate, return and
      resubmit, and `returnCount`
- [X] T020 Unit test proving one person cannot decide twice **under concurrency** — two simultaneous
      decisions by the same actor, exactly one recorded. This is the test that proves the index is
      doing the work rather than the service
- [X] T021 [P] Unit tests for `queueFor()`: excludes already-decided items, respects slot mapping,
      pages

**Checkpoint**: the spine is complete and tested in isolation. Nothing else in the product has
changed.

---

## Phase 2: US1 — Attendance exceptions onto the spine (P1)

**Goal**: an out-of-geofence or face-mismatch punch moves Employer → HR → Director instead of being
resolved in one step.

**Independent test**: raise an exception, walk it through all three levels, confirm state and actor
after each.

- [ ] T022 [US1] Seed a default `attendance_exception` chain with three levels
      (`first_approver`, `hr`, `final`) and the `settings` copy needed to map slots to roles
- [ ] T023 [US1] Change `src/hr/attendance-exceptions/attendance-exceptions.controller.ts` to submit
      an exception into the chain on detection (FR-012), supplying `subject` and `href` at submit time —
      **the spine cannot read the punch to build them** (checklist CHK003)
- [ ] T024 [US1] Replace the single-step `resolve` endpoint with a decision through
      `ApprovalService.decide()`, keeping the route so the interface changes once rather than twice
- [ ] T025 [US1] Subscribe to `approval.completed` in the `hr` module and apply the outcome to the
      punch. The handler MUST be idempotent — it will be redelivered (research.md §8)
- [ ] T026 [US1] Make the punch's effective status read from the spine rather than a local column
      where the two could disagree (FR-007); `ApprovalInstance.state` is authoritative (research.md §8)
- [ ] T027 [US1] Data migration: backfill historical single-step resolutions as completed
      single-level instances, so old and new render through one path (research.md §7)
- [ ] T028 [US1] e2e spec in `test/` covering spec US1 scenarios 1–5, including the refusal when
      somebody without the level's authority attempts to approve
- [ ] T029 [P] [US1] Unit test for the idempotent completion handler: apply the same event twice,
      assert one effect

**Checkpoint**: spec US1 fully delivered. The feature is useful at this point even if nothing else
is built.

---

## Phase 3: US2 — Payroll runs itself, then waits (P1)

- [ ] T030 [US2] Add unique `(companyId, period, isFnf)` and `createdBySchedule` to `PayrollRun`,
      with a migration. **Idempotency comes from this constraint, not from the scheduler being
      careful** (research.md §4)
- [ ] T031 [US2] Implement `createRunsForPreviousPeriod()` (FR-013, FR-014) in
      `payroll-runs.service.ts` — computes every active company's run with advances and deductions
      applied, absorbing the duplicate case via the constraint
- [ ] T032 [US2] Create `src/payroll/runs/payroll-schedule.cron.ts` mirroring
      `ReminderEvaluationCron` exactly: thin `@Cron` calling the service, errors logged not
      rethrown, timezone `Asia/Kolkata` so "the 1st" means the 1st locally
- [ ] T033 [US2] Add the cron expression and timezone to configuration, not as literals
      (Principle III)
- [ ] T034 [US2] Submit each created run into the `payroll_run` chain
- [ ] T035 [US2] Hold `bank-sheet.service.ts` until the chain completes, refusing with the
      outstanding level named (FR-015)
- [ ] T036 [US2] Implement `isPeriodUnderReview(companyId, date)` as an exported payroll method —
      `hr` must never read `payroll` tables (research.md §5, checklist CHK012)
- [ ] T037 [US2] Restrict attendance edits for a period under review to the HR-mapped role (FR-016),
      calling the method above
- [ ] T038 [US2] Emit an invalidation **event** when attendance in a reviewed period changes, and
      restart the run's chain on receipt (FR-017). This direction is an event because no answer is
      needed; the lock above is a call because one is
- [ ] T039 [US2] Unit tests: scheduled creation is idempotent across a repeat fire, a restart, and a
      manual trigger racing the schedule
- [ ] T040 [US2] e2e covering spec US2 scenarios 1–6: held bank sheet, non-HR edit refused, HR edit
      permitted and chain restarted, sheet produced after full approval
- [ ] T041 [P] [US2] Unit test that `hr` code contains no Prisma access to `payroll` tables

**Checkpoint**: spec US2 delivered. Payroll is scheduled and gated.

---

## Phase 4: US3 + US4 — Attribution and the queue surface (P2)

- [ ] T042 [US3] Include latest action, actor name and time (FR-008) in the state returned by
      `stateOf()` and `statesOf()`, resolving names for deactivated users too
- [ ] T043 [US3] Implement `GET /approvals/:entityType/:entityId/history` (FR-009), with the
      **owning module** deciding whether the caller may view the item — the spine cannot know
- [ ] T044 [US4] Implement `GET /approvals/queue` and `GET /approvals/queue/count` as separate
      endpoints. The badge appears on every screen and must not pull the queue
- [ ] T045 [US4] Implement `POST /approvals/:instanceId/decide` with a DTO — mandatory even for a
      two-field body (Principle II; this codebase has already been bitten by DTO-less params)
- [ ] T046 [P] [US4] DTOs for chain and slot-mapping endpoints, guarded by `SETTINGS`
- [ ] T047 [US4] e2e for the queue: only actionable items, correct ages, paging, and the count
      agreeing with the list

---

## Phase 5: US5 — Final authority (P3)

- [ ] T048 [US5] Make the Director-final action set configuration (FR-018a), defaulting to the four
      the client named: payment release, payroll run approval, money-committing letters, final
      settlement
- [ ] T049 [US5] Enforce that a director-final action does not take effect until Super Admin
      approves, whatever preceded
- [ ] T050 [US5] Expose the gate for feature 017 to consume for work orders, LOIs and purchase
      orders — **017 must not build its own**, or the same decision acquires two mechanisms
- [ ] T051 [US5] e2e for spec US5 scenarios 1–4, including the held action when no Super Admin is
      active (which should be unreachable, since the system refuses to deactivate the last one —
      the test exists to prove it)

---

## Phase 6: Reconciliation and hardening

- [ ] T052 Implement the reconciliation sweep: report orphaned instances (item gone) and drifted
      items (module status lags the spine). Both are the same kind of drift and belong in one job
      (research.md §1, §8)
- [ ] T053 [P] Audit chain and slot-mapping changes as `APPROVAL_CHAIN_CONFIG`
- [ ] T054 [P] RLS tests for `ApprovalInstance` and `ApprovalDecision` **as a non-super-admin
      caller** — this is the one place a policy mistake leaks another company's pending work into a
      user's queue
- [ ] T054a Verify FR-022 explicitly: every module **not** migrated in this feature still approves
      exactly as before. Run the existing indent, asset-request, muster-roll and RA-bill approval
      e2e specs unchanged and confirm they pass untouched. The analyze pass found this requirement
      had no task, and "we did not mean to change it" is not evidence that we did not
- [ ] T055 Add the Principle I guard from quickstart Pass 10 as a script, then **deliberately
      introduce a violation and confirm it fails** (checklist CHK008). A guard nobody has seen fail
      is not known to work
- [ ] T056 [P] `npx tsc --noEmit`
- [ ] T057 [P] `npx eslint <touched files>` — **not** `npm run lint`, which is `eslint --fix`
      repo-wide
- [ ] T058 `npm test` — 707 passing before this feature; expect the 9 known punch failures unchanged
- [ ] T059 `npm run build`
- [ ] T060 Work quickstart passes 1–10. **Passes 2 and 3 are the ones that prove this feature is
      control rather than ceremony**; if only two are run, run those

---

## Dependencies

```
Phase 1 (T001-T021) ──▶ everything. The spine must exist first.

T001 ─▶ T002 ─▶ T003 ─▶ T004        (schema before constraints before RLS)
T006 ─▶ T010, T011, T012            (codes before the service that returns them)
T008 ─▶ T009 ─▶ T010                (chains before the guard before submit)
T011 ─▶ T012 ─▶ T013 ─▶ T016

Phase 2 (US1) and Phase 3 (US2) are independent of each other.
Phase 4 depends on Phase 1 only.
Phase 5 depends on Phase 1; T050 is consumed by feature 017.
T055 depends on all module changes being in place.
```

## Parallel opportunities

- T005, T006 — different files, no shared edits.
- T014, T015 — different service methods.
- T018, T021, T029, T041, T053, T054 — test files.
- T056, T057 — independent checks.

T010–T013 and T016 all touch `approvals.service.ts` in sequence: **not** parallel.

## MVP scope

**Phase 1 + Phase 2 (T001–T029)** is the minimum that delivers something real: attendance exceptions
move through a genuine chain instead of one person's single click, and the client's first note is
satisfied. Phase 3 is where the money is, and is not optional in practice — only separable.

---

## Implementation note — Phase 1, 2026-09-13

Phase 1 (T001–T021) is complete and verified. Phases 2–6 are untouched. Every deviation from
`data-model.md`, `contracts/approval-service.md` and the task text is recorded below; where a design
document was wrong rather than merely silent, that is said plainly.

### Verification actually performed

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx eslint <touched files>` | 0 errors, 1 warning (`_userRoles` unused — **pre-existing on HEAD**) |
| `npm test` | **753/753 passing, 76/76 suites** (707 before this phase; +46 new) |
| `npm run build` | clean, 504 files |
| `test/approvals.e2e-spec.ts` | **13/13 passing** against the real database |
| `npm run test:e2e` (full) | 288 passed, 37 failed in `plant`/`dashboard`/`assets` |

**The 37 e2e failures are pre-existing.** Verified by stashing this entire branch, regenerating the
Prisma client from `HEAD`, and re-running those three suites: **37 failed there too, the same count**.
They concern migration-seeded master data (equipment categories, asset grades) and the reminders
engine, none of which this feature touches. Note also that the 9 punch failures the task preamble
warned about **now pass** — fixed by `04b4e94` since that note was written.

### Deviations from data-model.md

1. **`round` added to `ApprovalInstance` and `ApprovalDecision`, and both decision uniques scoped by
   it.** `data-model.md` specifies plain uniques on `(approvalInstanceId, actorUserId)` and
   `(approvalInstanceId, position)`. **As written, those break FR-005 and FR-020**: a returned item
   restarts from position 1, so resubmission must let the same people decide at the same levels
   again, and a plain unique makes that impossible — the chain could be walked once and never again.
   Scoping both by `round` keeps "again after a return" legitimate while keeping "twice in one pass"
   impossible. A side benefit: both are now plain Prisma uniques rather than hand-authored partials.

2. **`companyId` denormalised onto `ApprovalLevel` and `ApprovalDecision`**, neither of which has it
   in `data-model.md`. Both reach their company through a parent, so the alternative was an RLS
   policy with an `EXISTS` subquery — which would have been the only policy of that shape in eleven
   schemas, and the one a future table copies wrongly. Both columns are write-once, set in the same
   transaction as the row they are copied from, and no code path moves a chain or a decision between
   companies. Precedent: `labour.GangMember.isActive`, denormalised for the same reason.

3. **`returned` counts as live in the "one live instance per item" partial index.** `data-model.md`
   says "where state is not terminal" without enumerating; the state diagram loops `returned` back to
   `pending`, so it is not terminal. Excluding it would let a module submit a second instance for an
   item already mid-correction. Terminal is `approved`, `rejected`, `abandoned`.

4. **`ApprovalLevel.label` added** (nullable). FR-010 requires the level's label, and a company may
   define a slot outside the canonical three; without a column such a level renders as a raw key.

5. **`ApprovalInstance.delegatedToUserId` / `delegationReason` added, in a second migration**
   (`20260913111203_approval_reassignment`). FR-019 had no data model, no plan entry and — until the
   analyze pass — no task, so this is new design rather than a change to existing design. It is
   needed because **authority in this model comes from holding a role, not from being assigned a
   task**: "reassign to another holder of the same level" would otherwise be a no-op, since every
   holder can already act. The case FR-019 actually exists for is the stall FR-021a creates — the
   sole holder of a level's role having already decided earlier in the chain — and clearing that
   requires granting one named person authority at one level. It does **not** bypass FR-021a: a
   delegate who already decided this round is still refused by the unique index. Proven end-to-end in
   `test/approvals.e2e-spec.ts` ("stalls a chain a single person cannot complete").

### Deviations from contracts/approval-service.md

6. **`stateOf` and `statesOf` take a `viewer`.** The contract signatures omit it, but `canActNow` and
   `inertReason` are inherently caller-dependent — the contract is incomplete rather than different.
   `viewer` may be null, in which case `canActNow` is false and `inertReason` is null: "may this
   caller act" has no answer when there is no caller, and inventing `false` with a reason would have
   the interface explain a refusal nobody received.

7. **The view carries four fields beyond those T013a names** — `awaitingRoleName`,
   `awaitingHolderCount`, `totalLevels`, `round`. `awaitingUserName` alone cannot be honest: a level
   maps to a *role*, so naming one of five holders would be a guess presented as a fact. It is
   therefore populated only when exactly one person holds the role (or when a reassignment names
   somebody), and `awaitingRoleName` is always present.

8. **Four refusal codes beyond the contract's five**: `APPROVAL_CHAIN_NOT_CONFIGURED` and
   `APPROVAL_ALREADY_SUBMITTED` for `submit()`, which the contract describes in prose but leaves
   unnamed; `APPROVAL_REASSIGN_FORBIDDEN` for FR-019; `APPROVAL_CHAIN_UNSATISFIABLE` for FR-021b.

### Changes outside `src/approvals/`

9. **`AuthenticatedUser.roleIds` added** (`src/auth/authenticated-user.ts`). An approval level
   resolves to a `roleId`; checking authority by id means the spine never reads `settings.UserRole`
   from a `shared` table, which is the cross-schema query Principle I forbids. Matching on role
   *names* — already present — would silently unmap every chain the day somebody tidies a role name.

10. **`UsersService.findActiveHoldersOfRole` added.** The one question the spine cannot answer itself:
    who holds the role a level resolves to. `UsersModule` already owns every other user-to-role
    question (`countByRoleId`, `clearRoleAssignment`) for exactly this reason.

11. **`displayNameOf` added to `src/users/user-summary.ts`**, deliberately a *different* composition
    from `toUserSummary`, which is left byte-identical because it is what the Users list already
    renders. The difference is `displayName`, preferred for approval history: a Super Admin or
    vendor-facing login has no `hr.Employee` to take a name from, and "approved by (blank)" is worse
    than any fallback.

12. **`module-bucket-mapping.ts` updated — and this was not optional.** An existing unit test asserts
    that *every* `AuditEntityType` value maps to a module bucket, so T005's three new values failed it
    until mapped. `APPROVAL_DECISION`/`APPROVAL_REFUSED` fold into `hr` (the precedent `REMINDER` and
    `REPORT_EXPORT` set, and where attendance exceptions genuinely belong); `APPROVAL_CHAIN_CONFIG`
    goes to `settings`, being literally a change to who may approve what. Revisit when payroll and
    inventory migrate — the row's `changes` JSON carries the item's own `entityType`.

13. **`ApprovalsModule` registered in `AppModule`** with no controllers and no consumers, so the DI
    graph resolves at boot rather than at the first module migration.

### Two things the task list assumed that turned out not to hold

14. **T020 could not be a unit test.** The task says "Unit test proving one person cannot decide twice
    under concurrency". A mocked Prisma client cannot prove a unique index does anything — it can only
    prove the service *asks* the question, which is the one thing that does not matter under a race.
    T020 is therefore realised in `test/approvals.e2e-spec.ts` against the real database, firing two
    genuinely concurrent `decide()` calls and asserting **one** surviving `ApprovalDecision` row and
    `currentPosition === 2`. The unit suite additionally covers the service's translation of both
    `P2002` variants into the right refusal. FR-021 (two different approvers racing at one level) is
    proven the same way.

15. **Tenant isolation is not observable on a local developer database.** The local `prisma` role is a
    Postgres **superuser**, and Postgres exempts superusers from every RLS policy unconditionally —
    `ENABLE` and `FORCE` do not apply to them and no error is raised. This is already known to the
    codebase: `src/common/prisma/rls-preflight.ts` warns about it and refuses to boot in production.
    The e2e test therefore asserts unconditionally that all five policies **exist and are FORCEd**
    (queried from `pg_policy`), and asserts the isolation itself only where the role can enforce it,
    printing a loud warning otherwise so a green run is never mistaken for evidence. **T054's RLS
    tests (Phase 6) will need a NOSUPERUSER, NOBYPASSRLS role to mean anything.**

### Still open, by design

- No HTTP surface. `/approvals/*` is T044–T046 (Phase 4).
- `checklists/module-boundary.md` remains at 0/22 — reviewer-owned, deliberately untouched.
- The quickstart's ten manual passes have not been run; nothing here has been opened in a browser.
- `research.md` §4's recorded risk stands unchanged: **the cron will not fire on a Render instance
  that suspends when idle.** No task in this feature can fix it.
