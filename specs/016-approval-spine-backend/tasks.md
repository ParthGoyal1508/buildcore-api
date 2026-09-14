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

- [X] T022 [US1] Seed a default `attendance_exception` chain with three levels
      (`first_approver`, `hr`, `final`) and the `settings` copy needed to map slots to roles
- [X] T023 [US1] Change `src/hr/attendance-exceptions/attendance-exceptions.controller.ts` to submit
      an exception into the chain on detection (FR-012), supplying `subject` and `href` at submit time —
      **the spine cannot read the punch to build them** (checklist CHK003)
- [X] T024 [US1] Replace the single-step `resolve` endpoint with a decision through
      `ApprovalService.decide()`, keeping the route so the interface changes once rather than twice
- [X] T025 [US1] Subscribe to `approval.completed` in the `hr` module and apply the outcome to the
      punch. The handler MUST be idempotent — it will be redelivered (research.md §8)
- [X] T026 [US1] Make the punch's effective status read from the spine rather than a local column
      where the two could disagree (FR-007); `ApprovalInstance.state` is authoritative (research.md §8)
- [X] T027 [US1] Data migration: backfill historical single-step resolutions as completed
      single-level instances, so old and new render through one path (research.md §7)
- [X] T028 [US1] e2e spec in `test/` covering spec US1 scenarios 1–5, including the refusal when
      somebody without the level's authority attempts to approve
- [X] T029 [P] [US1] Unit test for the idempotent completion handler: apply the same event twice,
      assert one effect

**Checkpoint**: spec US1 fully delivered. The feature is useful at this point even if nothing else
is built.

---

## Phase 3: US2 — Payroll runs itself, then waits (P1)

- [X] T030 [US2] Add unique `(companyId, period, isFnf)` and `createdBySchedule` to `PayrollRun`,
      with a migration. **Idempotency comes from this constraint, not from the scheduler being
      careful** (research.md §4)
- [X] T031 [US2] Implement `createRunsForPreviousPeriod()` (FR-013, FR-014) in
      `payroll-runs.service.ts` — computes every active company's run with advances and deductions
      applied, absorbing the duplicate case via the constraint
- [X] T032 [US2] Create `src/payroll/runs/payroll-schedule.cron.ts` mirroring
      `ReminderEvaluationCron` exactly: thin `@Cron` calling the service, errors logged not
      rethrown, timezone `Asia/Kolkata` so "the 1st" means the 1st locally
- [X] T033 [US2] Add the cron expression and timezone to configuration, not as literals
      (Principle III)
- [X] T034 [US2] Submit each created run into the `payroll_run` chain
- [X] T035 [US2] Hold `bank-sheet.service.ts` until the chain completes, refusing with the
      outstanding level named (FR-015)
- [X] T036 [US2] Implement `isPeriodUnderReview(companyId, date)` as an exported payroll method —
      `hr` must never read `payroll` tables (research.md §5, checklist CHK012)
- [X] T037 [US2] Restrict attendance edits for a period under review to the HR-mapped role (FR-016),
      calling the method above
- [X] T038 [US2] Emit an invalidation **event** when attendance in a reviewed period changes, and
      restart the run's chain on receipt (FR-017). This direction is an event because no answer is
      needed; the lock above is a call because one is
- [X] T039 [US2] Unit tests: scheduled creation is idempotent across a repeat fire, a restart, and a
      manual trigger racing the schedule
- [X] T040 [US2] e2e covering spec US2 scenarios 1–6: held bank sheet, non-HR edit refused, HR edit
      permitted and chain restarted, sheet produced after full approval
- [X] T041 [P] [US2] Unit test that `hr` code contains no Prisma access to `payroll` tables

**Checkpoint**: spec US2 delivered. Payroll is scheduled and gated.

---

## Phase 4: US3 + US4 — Attribution and the queue surface (P2)

- [X] T042 [US3] Include latest action, actor name and time (FR-008) in the state returned by
      `stateOf()` and `statesOf()`, resolving names for deactivated users too
- [X] T043 [US3] Implement `GET /approvals/:entityType/:entityId/history` (FR-009), with the
      **owning module** deciding whether the caller may view the item — the spine cannot know
- [X] T044 [US4] Implement `GET /approvals/queue` and `GET /approvals/queue/count` as separate
      endpoints. The badge appears on every screen and must not pull the queue
- [X] T045 [US4] Implement `POST /approvals/:instanceId/decide` with a DTO — mandatory even for a
      two-field body (Principle II; this codebase has already been bitten by DTO-less params)
- [X] T046 [P] [US4] DTOs for chain and slot-mapping endpoints, guarded by `SETTINGS`
- [X] T047 [US4] e2e for the queue: only actionable items, correct ages, paging, and the count
      agreeing with the list

---

## Phase 5: US5 — Final authority (P3)

- [X] T048 [US5] Make the Director-final action set configuration (FR-018a), defaulting to the four
      the client named: payment release, payroll run approval, money-committing letters, final
      settlement
- [X] T049 [US5] Enforce that a director-final action does not take effect until Super Admin
      approves, whatever preceded
- [X] T050 [US5] Expose the gate for feature 017 to consume for work orders, LOIs and purchase
      orders — **017 must not build its own**, or the same decision acquires two mechanisms
- [X] T051 [US5] e2e for spec US5 scenarios 1–4, including the held action when no Super Admin is
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

---

## Implementation note — Phase 2, 2026-09-14

Phase 2 (T022–T029) is complete. **Attendance exceptions now travel Employer → HR → Director**;
the client's first note is satisfied. Phases 3–6 are untouched.

### Verification actually performed

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx eslint <changed files>` | 0 errors, 0 warnings |
| `npm test` | **774/774 passing, 77/77 suites** (753 after Phase 1; +21 here) |
| `npm run build` | clean, 507 files |
| `test/attendance-exceptions.e2e-spec.ts` | **8/8** — US1 scenarios 1–5 through the real HTTP route |
| `test/my-workspace.e2e-spec.ts` | **93/93** |
| `npm run test:e2e` (full) ×3 | 37 pre-existing failures each time — **the Phase 1 baseline, unmoved** |

### The endpoint's contract has changed, deliberately

`POST /workspace-admin/attendance-exceptions/:punchId/resolve` keeps its route and its verbs, so the
interface changes once rather than twice — but three things about it are different, and the web half
must know:

1. **A decision is now one level, not the end.** Confirming at level 1 of 3 advances the chain; the
   punch stays `pending`. Only the final approval confirms it.
2. **The response shape is `{ punch, approval }`**, not a bare punch. `approval` is the
   `ApprovalInstanceView` from Phase 1 — or `null` for a punch that never entered a chain.
   `GET` on the collection returns rows of the same shape, and a new `GET /:punchId` returns one.
3. **`reason` is required for `rejected` and `returned`** (FR-006), refused with
   `APPROVAL_REASON_REQUIRED`. Before 016 a rejection could be recorded with no explanation, which is
   the rejection an employee cannot act on. `returned` is new.

`my-workspace.e2e-spec.ts`'s exception block asserted the old single-step contract and was rewritten.
Those tests were not "broken" — they were pinning down the behaviour this feature exists to replace.

### Decisions taken where the plan was silent

1. **Only the `final` slot is seeded (T022).** The chain *shape* is knowable — the client described
   Employer → HR → Director — and `final` resolves to Super Admin because the client settled that on
   2026-09-13. `first_approver` and `hr` are **not** guessable: neither "HR Office" nor "Site
   Incharge" exists as a role, which is the whole reason role slots were introduced (research.md §2).

   The consequence is deliberate and it is an operational one worth stating plainly: **until an
   administrator maps those two slots, an attendance exception cannot be decided.** The refusal names
   the cause (`APPROVAL_SLOT_UNMAPPED`, a configuration fault, not a 403) rather than failing
   silently. Inventing a default would hand the right to approve attendance to whichever role
   happened to sound closest, which is worse than a loud gap — but it does mean this feature is not
   finished on deployment day until somebody visits the settings screen that Phase 4 builds.

2. **A failed submission never fails the punch (T023).** Feature 003's FR-007 — a punch failing
   verification is still recorded — is not weakened into "unless the approval chain is
   misconfigured". Somebody physically at work must not lose a day's pay to a settings gap, so a
   submit failure is logged and swallowed and the punch keeps its local `pending`. Covered by a test
   that makes `submit` throw and asserts the punch survives.

3. **Rejection and return reach the punch synchronously; only completion is an event.** The contract
   emits `approval.completed` on final approval only, and extending it would have been scope. It is
   not needed: a decision taken through this module's own endpoint returns the new state to the
   caller, so `decide()` applies every outcome directly. The event handler covers decisions taken
   elsewhere — Phase 4's cross-module queue — and both paths are idempotent, so converging is
   harmless.

4. **`PunchService.listPendingExceptions` and `resolveException` were deleted, not deprecated.** A
   second, still-wired path that resolved an exception without consulting the chain would not be dead
   code; it would be a bypass around the control this feature exists to create.

5. **The backfill parks history on an inactive `attendance_exception_legacy` chain (T027).** A
   backfilled instance needs a real chain to point at, and making it inactive means it accepts no new
   items, is invisible to the FR-021b guard, and cannot collide with the live chain on the
   `(companyId, actionType) WHERE isActive` partial unique index. A resolution whose
   `resolvedByUserId` is null gets an instance but **no decision row** — the verdict was recorded, who
   reached it was not, and inventing an actor would put a name against a judgement that person may
   never have made.

   The migration matched 0 rows locally, which proves only that it parses. It was additionally run
   against fabricated historical rows: instance state, subject, originator (the employee's own
   account, via `hr.Employee.userId`), the decision's actor, and **idempotency across a second run**
   were all verified before this was committed.

### One flaky test, reported rather than papered over

Across three full `test:e2e` runs, `attendance-exceptions.e2e-spec.ts` failed **once**, on
`walks all three levels`, with a `401` from a token minted in `beforeAll`. It passes in isolation, in
a pair with `my-workspace`, and in the other two full runs.

A 401 there means `loadUserWithPermissions` found no user — the row was momentarily unreadable.
Ruled out: token expiry (the whole run takes 21s against a 15-minute access token), and cross-suite
deletion (every suite's cleanup is id-scoped; none deletes by prefix or predicate). Not ruled out: a
transient failure under twelve suites each holding their own Nest app and connection pool. **This is
recorded as a known flake rather than claimed fixed**, because I could not reproduce it and a fix I
cannot verify is worse than a documented one I can.

### Changed outside the feature's own files

- `ResolveExceptionDto` gained `returned` and an optional `reason`.
- `CompaniesService` resolves the Super Admin role and hands it to
  `ChainsService.seedDefaultsForCompany` inside its existing creation transaction — the spine never
  reads `settings.Role` itself.
- `SettingsModule` and `HrModule` now import `ApprovalsModule`.
- Three `CompaniesService` specs needed a `role` delegate on their Prisma mock;
  `punch.service.spec.ts` needed an `approvals` mock and an employee name.

---

## Implementation note — Phase 3, 2026-09-14

Phase 3 (T030–T041) is complete. **Payroll is now scheduled and gated**: a run is drawn up on the
1st, cannot reach a bank transfer sheet without three recorded approvals, and its inputs cannot be
changed underneath the people reviewing it. 44 of 64 tasks done; Phases 4–6 remain.

### Verification actually performed

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx eslint <changed files>` | 0 errors, 0 warnings |
| `npm test` | **801/801 passing, 79/79 suites** (774 after Phase 2; +27 here) |
| `npm run build` | clean, 512 files |
| `test/payroll-approval.e2e-spec.ts` | **8/8** — US2 scenarios 1–6 |
| `npm run test:e2e` (full) | 37 pre-existing failures — **baseline unmoved**; all four 016 suites pass |

### T030 was wrong, and following it would have been a regression

The task says to add a unique constraint on `(companyId, period, isFnf)`. **That constraint already
exists in a better form and the specified one would break F&F settlements.**
`PayrollRun_companyId_period_regular_key` is a *partial* unique — `(companyId, period)
WHERE "isFnf" = false` — added by feature 005 with a comment explaining exactly why: there is one
regular run per period but **many F&F runs, one per exiting employee**. A plain compound unique on
all three columns would permit only one F&F run per period and so forbid the second employee exit in
a month.

So T030 added `createdBySchedule` only. The idempotency the task wanted is already guaranteed, by an
index that was right the first time.

### Two other schema changes, both about not lying

- **`ApprovalInstance.originatorUserId` is now nullable.** A scheduled run has no person behind it,
  and the column is a real foreign key — so the choice was between a nullable column and attributing
  the run to an arbitrary account. The view renders `originatorName` as **"The system"** rather than
  "Unknown user", because unknown reads as missing data when in fact it is precisely known.
- **`Caller.userId` is now `string | null`**, for the same reason: the scheduler is a system actor
  and `AuditLogEntry.accountId` is a foreign key. Note `tsconfig.json` has `strictNullChecks: false`,
  so this documents the contract rather than enforcing it — which is why it is stated in the type
  and in a comment rather than relied upon.

`Caller` also gained `roleIds`, so the attendance write path can ask "is this caller HR" — a question
answered by the chain's slot mapping, because there deliberately is no HR permission to check.

### The event had a real race, found by the e2e

`emit()` does not await asynchronous listeners. The first run of US2 scenario 4 failed because the
HTTP response came back before the chain had restarted — and that window is not a test artefact: in
it, a director can approve figures that have already changed underneath them. Fixed by `emitAsync`,
awaited. Awaiting is not asking payroll for an answer (the listener swallows its own failures and
returns nothing); it is refusing to report the edit as done while the consequence FR-017 promises is
still outstanding.

### Decisions taken where the plan was silent

1. **A missing chain never blocks run creation.** If `submit` fails, the run is still created and the
   failure logged. Refusing to create it would mean nobody gets paid because nobody has configured an
   approver yet — and no control is lost, because the bank sheet is held regardless.
2. **One company's failure does not stop the sweep.** A sweep that abandoned twelve companies because
   the first had a configuration problem would turn a small fault into an outage. The result object
   reports created / already-present / failed separately.
3. **`isPeriodUnderReview` is false when a run never entered a chain.** A configuration gap is not a
   licence to edit, but refusing *every* attendance edit on account of one would be worse, and the
   bank sheet is still held either way.
4. **The lock does not apply to a paid run**, and lifts once the chain completes. A correction after
   approval is a different problem, already governed by the payroll lock day.
5. **Period arithmetic is done in the business timezone, not UTC.** `2026-09-01T00:30` in
   Asia/Kolkata is `2026-08-31T19:00Z`; subtracting a month from the UTC date yields July and pays
   the wrong month's wages. There are explicit tests for this boundary and for the January rollover.
6. **`HrModule` and `PayrollModule` now form a declared cycle** (`forwardRef` both ways). Attendance
   asks payroll whether a period is under review; payroll's engine reads attendance. Both directions
   are exported service calls, which is what Principle I requires — so Nest is told about the cycle
   rather than the boundary being broken to avoid it. Verified by booting the app (`app.e2e-spec`).

### T041's guard was proven by breaking it

`src/hr/hr-payroll-boundary.spec.ts` derives the forbidden set from `schema.prisma` — every model
carrying `@@schema("payroll")` — so a payroll model added next year is covered without anybody
remembering to update the test. It also asserts it found something, because a guard that silently
matches nothing is worse than no guard.

It was then **deliberately broken**: a `this.prisma.payrollRun.findFirst()` was added to
`attendance-admin.service.ts`, the test failed naming the exact file and delegate, and it passed
again on revert. This is the CHK008 discipline applied early — a guard nobody has seen fail is not
known to work.

### The risk this phase cannot close

`research.md` §4 and the cron's own doc comment both say it plainly: **the production API is deployed
on an instance class that suspends when idle, and a suspended instance runs no schedule.** T032 is
built and tested, and it will still not fire on the 1st until the deployment changes.

Two things mitigate rather than solve that: `createRunsForPreviousPeriod` is independently callable
(the manual path remains), and `PayrollRun.createdBySchedule` makes the difference between automation
and handwork visible, so an operator can *see* whether the schedule is firing rather than assume it.
**SC-003 — "created without human action on the 1st, for 3 consecutive months" — cannot be satisfied
on the current infrastructure.**

---

## Implementation note — Phase 4, 2026-09-14

T042–T047 are done and committed. `tsc --noEmit` clean, eslint clean on every touched file, **810
unit tests across 79 suites**, `nest build` clean at 516 files, and a new
`test/approvals-queue.e2e-spec.ts` at **19/19**. The full e2e baseline is unmoved.

This is the phase that makes Phases 2 and 3 usable. Until `first_approver` and `hr` are bound to
roles, nothing on those chains can be decided by anybody, and `PUT /approvals/slot-mappings` is the
only way to bind them.

### T042 was already satisfied, and saying so is the honest answer

`stateOf` and `statesOf` have carried `latestDecision` — action, actor id, resolved actor name, time,
level label — since T013a in Phase 1, and `namesFor` never filtered on account status, so a
deactivated actor already resolved. Rather than write code to satisfy a task that was already met,
Phase 4 added the tests that were missing: four unit tests and one e2e that **deactivates a real
account mid-suite** and asserts the history still names them. The unit test can only assert the
absence of a status filter; the e2e is the one that actually proves it.

One genuine gap did surface under T042, from Phase 3: `queueFor` reported `requestedByName: 'Unknown
user'` for a scheduled payroll run. `toView` had been corrected to say "The system" but the queue had
not, so the same item read two different ways depending on which screen you were on. Fixed, with
`ApprovalQueueEntry.requestedById` made `string | null` to match.

### T043 needed a data model the spec did not have

US3 scenario 4 requires that a user who may not view a record is refused its history. The spine
cannot evaluate that: it has never read the item, holds no relation through which to read it, and
deliberately never will (research.md §1). There was nothing on `ApprovalInstance` to decide against.

`ApprovalInstance.viewPermission` was added, **required**, migration
`20260914080116_approval_view_permission` — added nullable, backfilled from the chain's action type,
then set `NOT NULL`, because the table is not empty after Phase 2's backfill. Making it required is
the point: the type change failed compilation at all four existing submit sites, which is exactly how
a module that forgets to declare who may read its items should find out, rather than by quietly
publishing its rejection reasons to every colleague in the company.

The rule is two additive clauses:

- the caller holds the permission the owning module declared, **or**
- the caller took part in the chain — originator, any decision actor, or the current delegate.

The second clause is not a convenience. Whoever raised a correction must be able to read why it was
returned, and the reason lives behind a permission they were never going to hold. Without it the two
people most entitled to an explanation are the two who cannot get one.

It is deliberately **coarse**: a permission cannot express "this site's exceptions only". It is the
rule the spec actually states ("subject to their permission to view that record"), and it is strictly
tighter than the alternative of leaving the endpoint open to every authenticated colleague. Where a
module needs item-level scoping it should render history through its own endpoint.

A new refusal code, `APPROVAL_VIEW_FORBIDDEN`, separate from `APPROVAL_NOT_AUTHORISED` — being unable
to *read* and being unable to *decide* have different remedies, and collapsing them would have the
interface offer approval rights to somebody who only wanted to read.

An item that was never submitted returns `[]`, not a refusal, and that check runs **before**
authorisation. "This has never been in a chain" is not a secret, and 403-vs-empty on an id the caller
already holds tells them nothing they did not know.

### Decisions taken where the contract was silent

1. **No `APPROVALS` permission, on any endpoint that decides.** Authority is the slot mapping,
   resolved per item. A permission value would be a second source of truth about who may approve, and
   the two would disagree the first time one was changed without the other. Only the four
   configuration endpoints are guarded, by `SETTINGS` — defining a chain is a settings act, not an
   approval one. The e2e asserts the separation directly: the site approver decides on real money
   every day and still gets 403 from `GET /approvals/chains`.
2. **`GET /approvals/slot-mappings` returns every canonical slot, mapped or not.** Returning only the
   rows that exist would render an unmapped slot as an absent row, which is the one failure mode of
   this feature that never resolves itself. It has to be visible as a gap.
3. **Role *names* are not resolved there.** `Role` lives in the `settings` schema and the spine may
   not read it (Principle I). The settings screen already holds the role list it needs to render the
   ids, so the alternative would have been a cross-schema query to save the web a lookup it has
   already done.
4. **`PUT /approvals/chains/:id` requires the body's action type to match the chain's.** Changing it
   is not an edit of this chain but the creation of a different one, leaving the original active and
   unmentioned.
5. **`DELETE /approvals/chains/:id` deactivates rather than deletes**, and is included beyond the
   contract's list because `deactivateChain` was otherwise unreachable over HTTP and a settings
   screen needs to be able to turn a chain off. Items already travelling the chain continue under it.
6. **`limit` out of range is a 400, not a silent clamp.** The service still clamps defensively, but a
   caller who asks for 5000 rows is told, rather than receiving 100 and drawing a conclusion about
   how much work is outstanding.

### What the e2e is for

Nineteen tests over the real HTTP routes, against a real database. The ones that would not have been
caught anywhere else:

- the badge count and the list **agree** — they are separate endpoints precisely so the badge is
  cheap, and being separate is exactly why they can drift;
- a decided item leaves the deciding caller's queue *and* appears in the next level's;
- cursor paging returns a different row on the second page;
- `{ action: 'reject', resaon: 'typo' }` is a 400 rather than an unexplained rejection — Principle
  II's whitelist earning its place;
- a deactivated account is still named in history.

The queue fixtures submit instances whose `entityId` points at nothing at all. That is not a
degenerate fixture: the spine stores the pair and never dereferences it, so a queue that renders them
correctly is the opacity of research.md §1 being demonstrated rather than asserted.

### Still open after this phase

The web half of 016 remains entirely unwritten, so the settings screen these endpoints exist for does
not exist yet. **The slots are still unmapped in every real company**, and an attendance exception
still cannot be decided in production until somebody maps them.

---

## Implementation note — Phase 5, 2026-09-14

T048–T051 are done and committed. `tsc --noEmit` clean, eslint clean on every touched file,
**827 unit tests across 79 suites**, `nest build` clean at 516 files, and
`test/director-final.e2e-spec.ts` at **6/6** covering US5 scenarios 1–4. Full e2e baseline unmoved
at 37 pre-existing failures in the same three suites.

### T048 — where "configurable without a code change" actually lives

FR-018a is satisfied by `ApprovalChain.isFinalAuthorityRequired`: a per-company row an
administrator edits through the Phase 4 settings endpoints. That is the authority. The new
`approvals.directorFinalActionTypes` config entry is **not** the authority — it is the default
applied when a company is created, and the fail-closed set consulted when nothing is configured at
all.

FR-018's four become six action types: `payment_release`, `payroll_run`, `letter_work_order`,
`letter_loi`, `letter_purchase_order`, `final_settlement`. The three letters are kept separate
rather than collapsed into one "money-committing letter", because FR-018a's unit of configuration
*is* the action type — collapsing them would mean a company that wants purchase orders gated but not
LOIs cannot say so.

The list is written literally in `config.ts` rather than imported from `src/approvals`, because
configuration must not depend on the feature that reads it. `config.spec.ts` asserts it against the
constants in `default-chains.ts`, so the duplication cannot drift — the test is the link, and it is
the only reason the duplication is acceptable.

### T049 — two enforcement points, because one would be trusted

**At definition:** a chain marked director-final must have a final-authority level, and that level
must be the **last** one. A chain declared director-final with no director level would complete with
every level approved and no director having seen it — the worst version of the failure, because
nothing looks wrong. A director gate in the middle would let levels below it decide *after* the final
word had been given, which is not what "final" means.

**At the gate:** `mayTakeEffect` checks for a recorded approval at the final level **in the current
round**, not for the right chain shape. A chain defined before this rule existed, or edited by a
direct database write, satisfies a shape check with nobody having approved — and "whatever preceded"
in FR-018 is exactly the case where everything looks complete. The round check matters too: a
returned-and-resubmitted item is a new round, and a director who approved figures that have since
been corrected has not approved these.

### T050 — one gate, and it is the payroll gate too

`ApprovalService.mayTakeEffect` / `assertMayTakeEffect` is the single method every module calls
before doing the irreversible thing. Feature 017 must consume it for work orders, LOIs and purchase
orders; the constants it imports are in `default-chains.ts` so that "must consume" is checkable
rather than merely requested.

To keep that true rather than aspirational, `PayrollScheduleService.outstandingApproval` was
rewritten as a thin wrapper over it. It previously had its own logic. An approval rule with two
implementations is a rule enforced in one place and not the other, and the place it is missed is
found by the money having already moved. Payroll keeps its own *vocabulary* — the bank sheet still
refuses with `PAYROLL_RUN_NOT_APPROVED` — but not its own answer.

Three new codes. `APPROVAL_NOT_SUBMITTED` is the fail-closed one, and it is deliberately **narrow**:
an action type outside the director-final set with no instance passes the gate untouched, because
FR-022 forbids this feature changing behaviour for modules it never migrated, and refusing there
would break every unmigrated approval in the product on the day it deployed. `APPROVAL_NOT_COMPLETE`
and `APPROVAL_DIRECTOR_REQUIRED` cover the rest. All three refuse with **409, not 403** — the caller
is not forbidden from releasing payments; the payment is not yet releasable, and a 403 would send
them asking for permissions they already hold.

### T051 — scenario 4 is unreachable, so it is proven twice over

US5 scenario 4's stated precondition, no active user holding Super Admin, cannot be reached through
the API: `UsersAdminService.assertNotLastSuperAdmin` refuses to deactivate, delete or reassign the
last one, and three tests in `users-admin.service.spec.ts` already prove that. Those are not
duplicated here.

What *is* reachable is the same failure by the other route — a chain level mapped to a role nobody
holds. The e2e maps a slot to an empty role, submits, and asserts the item is **accepted and held**
with `awaitingHolderCount: 0`. Zero is not "waiting patiently"; it is an item that will never move,
and the module is told so rather than left to infer it. `assertMayTakeEffect` also logs an error in
that case, because the person who hits the refusal is not the person who can fix it.

### Two migrations, and one of them is the reason this phase carries risk

`20260914100000_director_final_default_chains` seeds a one-level director chain for
`payment_release` and the three letter types and `final_settlement`, for companies that already
exist. `seedDefaultsForCompany` now does the same for new ones. Without it, feature 017's first work
order would be a configuration fault in every company at once.

`20260914103000_seed_live_chains_for_existing_companies` is the one that matters. The
attendance-exception and payroll-run chains have been seeded on company *creation* since Phase 1, so
only companies created since then have them — and that asymmetry stopped being cosmetic this phase.
`payroll_run` is one of FR-018's named action types, so the gate now **refuses a run with no approval
instance** rather than waving it through. Without a chain there is nothing to submit into, and
without this migration no pre-existing company could produce a bank transfer sheet at all. Verified
against the local database: 8 companies, 24 levels each for the two three-level chains, idempotent
on rerun.

**The chains alone are not enough, and this is the deployment risk.** A level resolves to a role
through `RoleSlotMapping`, and neither migration creates one — which of a company's roles is its "HR"
is a decision only that company can make, and guessing would hand the right to approve payroll to
whichever role a heuristic happened to pick.

So, stated plainly: **on the day this deploys, no existing company can produce a bank transfer sheet
until an administrator maps `first_approver`, `hr` and `final` through the settings screen.** That is
what FR-015 and FR-018 require and it is the correct behaviour, but it is a hard change and it will
be discovered by payroll if it is not done first. The web half of 016, which builds that screen, is
still unwritten.
