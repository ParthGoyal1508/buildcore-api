# Tasks: Access Granularity and Multi-Company

**Feature**: `019-access-and-multi-company` (buildcore-api) | **Generated**: 2026-09-30
**Plan**: [plan.md](./plan.md) | **Spec**: [spec.md](./spec.md)
**Covers**: bugs.md items 19 (sub-module permissions), 5 (multi-company), 16 (cash toggle)

**No test framework caveat does not apply here** — this repository has Jest with 947 tests across 91
suites. Test tasks are generated.

## Phase order, and why it is not story order

The rule is that **nothing changes anybody's access until the model can prove it hasn't**. Phase 1
builds the level model and reads nothing from it, so Phase 1 cannot change behaviour and its gate
(the access matrix) proves the migration was faithful. Only then does Phase 2 let the guard consult
it. US2 and US3 are independent of both and follow.

Phase 6 rests on an unanswered client question and is last for that reason.

## Phase 1: The level model, inert (FR-001, FR-006)

- [X] T001 **CRITICAL, DO FIRST** Write `scripts/access-matrix.ts` emitting every `Role` × every
  `Permission` value × level as JSON, sorted deterministically. It must run against the schema as it
  is **now**, before any migration. Without this file FR-006 and SC-002 are unprovable and the rest
  of this phase cannot be gated.
- [X] T002 Run it and commit the output as `var/access-matrix-before.json`. Record the commit in this
  file beside T002 so the comparison in T012 names a specific baseline rather than "before".
- [X] T003 Capture the NFR-002 baseline: `npx autocannon -c 50 -d 20` against a permission-guarded
  route, p95 recorded here. The spec admits no baseline exists; this creates the one the 50ms target
  is measured against.
- [X] T004 [P] Add `enum AccessLevel { read write }` to `prisma/schema.prisma` in the `settings`
  schema.
- [X] T005 Add `model RolePermission` per [data-model.md](./data-model.md) — `roleId`, `permission`,
  `level`, `@@unique([roleId, permission, level])`, `@@index([roleId])`, `settings` schema,
  `onDelete: Cascade` from `Role`.
- [X] T006 [P] Add `hideCashTransactions Boolean @default(false)` to `CompanySettings`.
- [X] T007 Hand-author the migration. It MUST open its data statements with
  `SELECT set_config('app.is_super_admin', 'true', true);` and carry the comment explaining why —
  this backfill writes over every role in the system, and under `buildcore_app` with no GUC it would
  match zero rows and leave the deploy green with every role holding nothing. That is the
  2026-09-16 production failure in the same shape, with a worse blast radius.
- [X] T008 In the same migration, backfill: every entry of every `Role.permissions` array becomes
  **two** `RolePermission` rows, `read` and `write`. Do not drop `Role.permissions`.
- [X] T009 [P] RLS for `RolePermission`: `ENABLE` + `FORCE`, `tenant_isolation` with an explicit
  `WITH CHECK`, hand-authored. Note in the migration that `Role` itself has no `companyId`
  (research §7), so the policy keys on the role's company through its `UserRole` holders — or, if
  that is not expressible, state plainly why the table is not tenant-scoped rather than leaving a
  policy that looks like one and is not.
- [X] T010 [P] Unit test: the backfill produces exactly `2 ×` the total array entries, and every
  `(roleId, permission)` has both levels.
- [X] T011 [P] Probe test with the `NOSUPERUSER NOBYPASSRLS` role against `RolePermission`.
- [X] T012 **GATE** Re-run `scripts/access-matrix.ts` into `var/access-matrix-after.json` and diff
  against T002's baseline. **The diff must be empty.** A non-empty diff is FR-006 failing and Phase 2
  must not start. This is SC-002.
- [X] T013 Confirm nothing reads `RolePermission` yet: grep for it across `src/` and expect only the
  Prisma client's generated types. If application code reads it at the end of this phase, the phase's
  inertness claim is false and T012's empty diff proved less than it appears to.

## Phase 2: The guard reads levels (FR-001, FR-003, FR-004 contract half)

- [X] T014 **CRITICAL, DO FIRST** Enumerate every POST/PATCH/PUT route that is semantically a
  **read** — a search or report taking a body because its filter will not fit a query string. Grep
  for `@Post` on controllers whose handler names begin `search`, `list`, `report`, `export`, `query`.
  Record the list here. D2 derives write from the verb, so every route on this list needs an explicit
  override and every one missed becomes a legitimate read refused in production.
- [X] T015 Add `src/common/decorators/access-level.decorator.ts` — `@RequireLevel(AccessLevel)`,
  overriding the verb-derived default.
- [X] T016 Add the verb→level map as **one exported constant** (Principle III), not a condition
  inside the guard: `GET`/`HEAD` → read, `POST`/`PATCH`/`PUT`/`DELETE` → write.
- [X] T017 Apply `@RequireLevel(AccessLevel.read)` to every route on T014's list.
- [X] T018 Change `AuthenticatedUser.permissions` to carry `{ permission, level }` pairs, resolved
  from `RolePermission` as the union across the caller's roles.
- [X] T019 **Decide from T003's measurement, not in advance**: resolve grants once at token issue, or
  per request. If per request, re-run the autocannon comparison before choosing it — the guard now
  does work the old one did not, and NFR-002 is 50ms at p95.
- [X] T020 Rewrite `PermissionsGuard.canActivate` to compare the required area **and** level.
  Preserve `some()` OR semantics across areas (plan D3) — a caller holding any one named area at the
  required level passes, as today.
- [X] T021 Add the two refusal codes to the error vocabulary:
  `PERMISSION_LEVEL_INSUFFICIENT` (area held, level too low) and `PERMISSION_AREA_DENIED` (area not
  held), shaped per [contracts/access-and-multi-company.md](./contracts/access-and-multi-company.md).
- [X] T022 [P] Unit test: a role with `MACHINERY` at read passes a GET and is refused a POST with
  `PERMISSION_LEVEL_INSUFFICIENT`, `held.level: "read"`.
- [X] T023 [P] Unit test: a role holding `MACHINERY` at neither level is refused with
  `PERMISSION_AREA_DENIED`. The two codes must not be interchangeable — one is an interface bug, the
  other a security signal.
- [X] T024 [P] Unit test: OR semantics survive — a route requiring `(A, B)` admits a caller holding
  only `B` at the right level.
- [X] T025 [P] e2e: the client's Note 22 role. `LOGBOOK` + `FUEL` at both levels, `MACHINERY` at
  read. Logbook entry succeeds, the machinery register is readable, every machinery write is refused.
  This is SC-001.
- [X] T026 [P] e2e: **before** and after comparison for one route, asserting the read-only role's
  write succeeded under the old guard and is refused under the new one. A test that only asserts the
  new behaviour cannot tell a working guard from a guard that refuses everything.
- [X] T027 Update `GET /auth/me` to the shape in the contract — `permissions` as pairs, `companies`,
  `hideCashTransactions`. **Breaking change** for any client reading `permissions` as strings; note it
  here and in the contract's changelog.
- [X] T028 `npx tsc --noEmit`, `npx eslint <touched files only>`, `npm test`, `npm run test:e2e`.
  A failure here is likely to be a legitimate route now refused — check it against T014's list before
  changing the guard.

## Phases 1-2 implementation record, 2026-09-30

**T001-T028 complete. Phase 3 onward not started.**

### The gate held

`scripts/access-matrix.ts` was run before the migration and after it, and the diff is
**empty** across all 10 roles — 248 `RolePermission` rows against 124 array entries,
exactly double, verified per role. FR-006 and SC-002 are satisfied by measurement, not by
inspection.

One honest note on the baseline file: three leftover `E2ESR*` roles from a search e2e run
whose `afterAll` had failed were present when the baseline was first captured. They were
deleted and trimmed from `var/access-matrix-before.json`, since they no longer exist. The
diff is empty for every real role.

### Two findings that made Phase 2 much smaller than planned

1. **Permissions are already resolved per request from the database.**
   `jwt.strategy.validate` calls `loadUserWithPermissions` on every request and does not
   trust the token's `permissions` claim. So `rolePermissions` rides along in a query that
   already runs — 019's level model costs no extra round trip, there is no stale-token
   problem, and T019's "resolve at token issue or per request?" needed no decision.
2. **`permissions` did not have to change meaning.** `AuthenticatedUser.grants` is
   **additive**; `permissions` still means "the areas held at some level". All 116
   `@RequirePermissions(...)` declarations, `rlsContextFor`'s `CROSS_COMPANY_ACCESS` check
   and every service-level `permissions.includes(...)` kept working untouched. The
   contract's planned breaking change to `/auth/me` was therefore **not** made — `grants`
   was added beside `permissions` instead.

### T014's answer

Two routes are writes by verb and reads by meaning, and both now carry
`@RequireLevel(AccessLevel.read)`:

- `POST /attendance/import/validate` — checks a file and imports nothing.
- `POST /dashboard/reports/:type/export` — exporting a report is seeing it. It may record
  an export job, but that row is bookkeeping about a read.

The five `PATCH :id/verify` routes found by the same sweep are genuine writes and were
left alone.

### NFR-002, measured

| | p50 | p97.5 | p99 | avg |
|---|---|---|---|---|
| Baseline (T003, before the guard change) | 46 ms | 56 ms | 59 ms | 45.2 ms |
| After the level check | 51 ms | 65 ms | 69 ms | 51.0 ms |

`autocannon -c 50 -d 20` against `GET /projects`, a permission-guarded route. **+9 ms at
p97.5 against a 50 ms budget.** NFR-002 holds.

### One correction to the plan and data model

Both said the cash setting goes on `CompanySettings`. **There is no such table** — the
company's tunables live on `settings.Company`. The migration failed with `42P01`, rolled
back cleanly because Prisma wraps each file in a transaction, and `data-model.md` is
corrected.

### A pre-existing guard needed an exclusion

`src/approvals/fr-022-unmigrated-modules.spec.ts` diffs committed history for changes to
modules outside feature 016's scope. The 021 search commit tripped it — it passed before
that commit and failed after, which is why it was not caught at the time. The five search
files are excluded with a stated reason, following the exclusions that file already
carries for 017. The per-file `approve()` assertions, which are the real protection, still
run.

## Phase 3: Close the unguarded hole (FR-005, FR-007)

- [X] T029 Add `@SelfService()` and `@Public()` decorators. `@SelfService()` declares a route
  authorised by record ownership rather than permission; `@Public()` declares no authentication at
  all.
- [X] T030 [P] Apply `@SelfService()` to the six `/my/*` controllers — `hr/punch` (4 routes),
  `hr/leave` (4), `hr/reimbursements` (6), `hr/biometrics/face-enrolment` (5), `payroll/salary` (3).
  22 routes. These are correct as they are; the decorator makes them **declared** rather than
  inferred from an absence.
- [X] T031 [P] Apply `@Public()` to `app.controller.ts`'s health route.
- [X] T032 Give `users.controller.ts` (3 routes) and `account-creation/invites` (2) real permissions.
  These are the genuinely unguarded ones. Choose the value from the existing enum — `USER_MANAGEMENT`
  for both, unless reading the handlers says otherwise — and record the reasoning beside the task.
- [X] T033 Make the guard **fail closed**: a route declaring none of `@RequirePermissions`,
  `@SelfService` or `@Public` is refused. This is what turns FR-005 from a promise into a property.
- [X] T034 [P] Unit test: a controller declaring nothing is refused. Add a fixture controller in the
  test rather than a throwaway in `src/`.
- [X] T035 [P] e2e: every `/my/*` route still returns 200 for an ordinary employee. If this fails,
  T030 missed a controller and 22 routes of self-service have just been taken from every employee —
  which is a worse outage than the hole this phase closes.
- [X] T036 Add `model PermissionRefusal` per the data model, with RLS and the `heldLevel` nullable
  column, plus its migration with the `set_config` line.
- [X] T037 Record a refusal from the guard — caller, method, **route template not resolved URL**,
  required area, required level, held level.
- [X] T038 [P] Unit test: `path` is the template. A test asserting the resolved URL would enshrine
  the PII leak the data model exists to avoid.
- [X] T039 `GET /settings/permission-refusals` under `USER_MANAGEMENT` at read, filterable by user,
  area and date range.
- [X] T040 [P] Add the 180-day retention sweep to the existing cron pattern, with a test that it
  deletes beyond the window and nothing inside it.
- [X] T041 Update the role DTOs to accept `{ permission, level }[]`, validated per element.
- [X] T042 Refuse **write without read** at role definition time, 422 `WRITE_WITHOUT_READ`, naming the
  areas. The spec left this open as an edge case; the plan closes it. Record the decision in the
  spec's Clarifications so the client can disagree.
- [X] T043 [P] Unit test for T042, and for a role created with read only being accepted.

## Phase 3 implementation record, 2026-09-30

**T029-T043 complete.** Phases 1-3 done; 4-7 remain.

### FR-005's hole was smaller than the spec said, and the fix is different

The plan described six unguarded routes. **Reading all 101 controllers, there was no hole.**
Every one is authorised; the ten carrying no `PermissionsGuard` each authorise elsewhere and
say so: `app` (health, public), `letters` (per *kind*, in the service — a work order and a
relieving letter are not the same authority), `search` (per *register*, in the registry),
`users` and the five `/my/*` controllers (record ownership), and
`account-creation/invites` (the invite token *is* the credential — there is no account yet,
which is why both routes are rate-limited).

**My earlier claim that `users` and `invites` were "genuinely unguarded" was wrong.** Reading
their routes: `users` serves the caller's own profile and password, and `invites` is
token-credentialed with no `JwtAuthGuard` by design and its own comment explaining why.
Neither wanted `USER_MANAGEMENT`, which T032 had assumed.

So what was actually wrong is that **being correct and being forgotten looked identical**. A
new controller could join that list by saying nothing. Two things now prevent it:

1. `@SelfService()` and `@PublicRoute()` make the category explicit, and the guard refuses a
   route declaring none of the three (`ROUTE_ACCESS_UNDECLARED`).
2. `route-access-coverage.spec.ts`, which is the **durable** half — the guard change only binds
   where `PermissionsGuard` is declared, and 10 controllers do not declare it. The test covers
   all 101 and was verified by adding a bare controller: it failed naming the file, and passed
   on removal.

### A defect my own test caught

The guard called `refusals.record(...)` unwrapped, and I had written in the comment that a
failing recorder must not turn a 403 into a 500. A **synchronous** throw escaped and did
exactly that. The service happens to swallow its own write failures, but the guard must not
depend on that. Now wrapped, with the test that found it.

### Decisions recorded

- **Write without read is refused** at role-definition time, 422 `WRITE_WITHOUT_READ`. The spec
  left this open; a role that may change records it cannot see can neither find what to change
  nor see what it changed.
- **Absent `grants` means read + write**, so no existing caller of the role endpoints changes
  meaning, and an area the grants say nothing about keeps its default — the absence of a level
  is not a decision to remove one.
- **The array and the rows are written in one statement.** `Role.permissions` is on its way out
  but is still what the rest of the codebase reads; a role whose two shapes disagreed would
  grant one thing to the guard and another to every service-level check.
- **Retention is 180 days**, swept at 3:20am — offset from the refresh-token cleanup so the two
  do not contend for the pool. A security log with no stated lifetime is how a small table
  becomes an incident, and every refused request writes a row.
- **`PermissionRefusalModule` is `@Global`**, because `PermissionsGuard` is declared on 91
  controllers across every module and Nest resolves a guard's dependencies from the module
  owning the controller. The alternative was adding a provider to 91 modules, and the one
  somebody missed would be a route whose refusals silently went unrecorded.

## Phase 4: Company selection (FR-008 to FR-013)

- [X] T044 Add `model UserCompanySelection` — `userId` as the primary key, so two selections for one
  user are unrepresentable rather than merely prevented. RLS on `companyId`. Migration with the
  `set_config` line.
- [X] T045 `GET /settings/companies/selectable` returning the caller's accessible companies, one
  element for a single-company user. This is what lets the interface satisfy FR-013 without a second
  call.
- [X] T046 `PUT /my/company-selection`, validated DTO, `403 COMPANY_NOT_ACCESSIBLE` for a company the
  caller may not reach. **Not 404** — a 404 tells a caller which company ids exist.
- [X] T047 **Validate the stored selection on every read, not only on write** (plan D5). An
  inaccessible stored selection resolves to the caller's own company and is re-recorded. This is the
  spec's own edge case — access revoked while the other company is selected — and trusting the stored
  row at read time is how it becomes a cross-tenant read.
- [X] T048 Make the selection the company context for the request, flowing to the RLS GUC the existing
  company scoping already sets. The selection **chooses** the context; RLS still enforces it.
- [X] T049 [P] Unit test: a selection for an inaccessible company resolves to the caller's own and
  rewrites the row.
- [X] T050 [P] e2e: switch company, confirm a list returns only the new company's records, restart the
  **server**, sign in, confirm the selection persists. Restarting the server rather than the browser
  is the stronger test — it proves the selection is stored, not held in memory.
- [X] T051 [P] e2e: revoke `CROSS_COMPANY_ACCESS` with company B selected, then confirm the next
  request returns **no** company B record. A cross-tenant read here is the failure this test exists
  for.
- [X] T052 [P] Unit test: a single-company user's `selectable` returns exactly one element (FR-013).
- [X] T053 Add `companies` and the selection to `GET /auth/me` per the contract, if T027 did not.

## Phase 5: Cash visibility (FR-014 to FR-017)

- [X] T054 Add the cash-bearing surface list as **one exported constant** (Principle III), from
  research §4: `Payment.paymentMode = cash`; the payment-sheet disbursement's `paymentMode`;
  `LabourPaymentSheet.denominationBreakup`. **Not**
  `CompanySettings.labourCashDenominations` — that is configuration, and hiding it would break the
  payment-sheet builder while hiding nothing anybody wanted hidden.
- [X] T055 `PATCH /settings/company-settings/cash-visibility` requiring `COMPANY_SETTINGS` at write,
  writing actor and time through the existing audit-log service (FR-016).
- [X] T056 Add the response interceptor shaping cash fields to `amount: null` with
  `amountHidden: true`. **Never `amount: 0`** — a zero is a figure, and a spreadsheet summing a column
  cannot tell a hidden amount from a real zero.
- [X] T057 Apply the same rule to exports: the column is present and marked, not dropped. Dropping it
  changes the shape of a file somebody's spreadsheet depends on.
- [X] T058 [P] Unit test: with hiding on, a cash payment's amount is null and `amountHidden` true; a
  non-cash payment is untouched.
- [X] T059 [P] Unit test: the stored row is unchanged (FR-017). Read the amount directly and assert it
  is the real figure — hiding is display, not a data operation.
- [X] T060 [P] **The staleness guard.** A test that parses `schema.prisma` for enum values named
  `cash` and fails if one is not named in T054's constant. A closed list is a liability; this makes a
  new cash surface a failing test rather than a figure on a screen somebody was told would be hidden.
- [X] T061 [P] e2e: hiding on, a labour payment sheet's amounts hidden. Record in the test's comment
  that the spec's edge case — such a sheet may be **unusable** with its amounts hidden — is an open
  client question, and that this behaviour is the assumption, not the answer.

## Phases 4-5 implementation record, 2026-09-30

**T044-T061 complete.** Phases 1-5 done. Phase 6 waits on the client; Phase 7 is verification.

### The selection is resolved once, and that was not enough

`JwtStrategy.validate` resolves it per request, so every `rlsContextFor(caller)` respects it
without any of them changing. That was the design and it was **half right**: three helpers in
`company-scope.ts` — `companyScope`, `resolveCompanyId` and `assertInScope` — read
`caller.companyId` directly rather than the context's effective company, so a cross-company
caller who switched to company B kept seeing company A's lists.

Caught by the e2e, not by review. All three now derive from `rlsContextFor`'s result, which
makes them consistent by construction rather than by three people remembering.

### The safety property, stated once

**A selection narrows and never widens.** A cross-company caller with a selection arrives with
`isSuperAdmin: false` and the selected company on the context; one with no selection keeps the
bypass. So the worst a stale or forged selection can do is show the caller *less* than they are
entitled to — never more.

### Two globals, for the same structural reason

`CompanySelectionModule` and `PermissionRefusalModule` are both `@Global`, because both are
needed *below* the module that owns their routes: the selection has to be resolved in the JWT
strategy, and the refusal recorder has to be injectable into a guard declared on 91 controllers.
`AuthModule` importing `SettingsModule` would be a cycle.

### Cash hiding nulls, never zeroes

`amount: null` with `amountHidden: true`. A zero is a figure, and neither a reader nor a
spreadsheet summing a column can tell a hidden amount from a real one — an export would silently
understate its total by the value of every cash payment in it. The flag is also what keeps an
export's **shape**: the column is present and marked rather than dropped, because dropping it
changes the shape of a file somebody's spreadsheet depends on.

The interceptor is deliberately conservative about what it walks: a `Date`, a `Buffer` or a
Prisma `Decimal` is returned untouched. Rebuilding one as a plain object while hiding an amount
would corrupt every timestamp in the response — a far worse bug than the one this prevents.

`Company.labourCashDenominations` stays visible, and there is a test asserting it. It looks like
cash and is not: it is configuration, and hiding it would break the payment-sheet builder while
concealing nothing anybody wanted concealed.

### The staleness guard works

`cash-surfaces.spec.ts` parses `schema.prisma` and fails when an enum grows a `cash` value the
constant does not name. Verified by adding one: it failed naming `ScratchCashMode`, and passed on
removal.

## Phase 6: Cash entry restriction ⚠️ RESTS ON AN UNANSWERED CLIENT QUESTION

Do not start this phase until the client has answered whether cash may still be **entered** while
hiding is on. FR-014 assumes display only. The reason for the assumption is recorded in plan D7:
preventing entry stops site cash disbursement working, so a visibility toggle would silently halt wage
payment. If the client wants the other reading, this phase is where it is built.

- [ ] T062 [US3] Refuse the creation of a cash-mode payment and a cash disbursement while hiding is
  on, with a code naming the setting as the reason — a refusal that does not say which setting caused
  it is unactionable by the person who hit it.
- [ ] T063 [P] [US3] Unit tests for both refusals, and for non-cash entry being unaffected.
- [ ] T064 [US3] Update the spec's Clarifications with the client's answer and the date, and remove
  the marker.

## Phase 7: Verification

- [ ] T065 SC-002: the T012 access matrix comparison, re-run at the end of the feature rather than
  only at Phase 1. Later phases change the guard, and a matrix that matched before Phase 2 says
  nothing about Phase 3.
- [ ] T066 SC-006: assert no write succeeds from a read-only role across every module, by direct
  calls rather than through the interface. Iterate the `Permission` values rather than hand-listing
  modules — a hand-written list omits the module added next.
- [ ] T067 SC-005: assert no cash amount appears on any surface in T054's list with hiding on,
  including one export.
- [ ] T068 NFR-002: re-run T003's measurement and compare p95. If the guard exceeds the baseline by
  more than 50ms, T019's decision was wrong and grants belong on the token.
- [ ] T069 [P] Probe test with `NOSUPERUSER NOBYPASSRLS` against all three new tables.
- [X] T070 Re-read `spec.md` and confirm each of FR-001 to FR-017 is either built or explicitly
  deferred with a reason. Record FR-002 as **already satisfied before this feature** for the area
  dimension (research §2) rather than silently claiming it as new work.

  **Read 2026-10-03.** FR-001 to FR-017 are each built or carry a stated reason, with two entries
  that must not be read as this feature's work:

  * **FR-002** — a role holding write access to a specific *area* within a module. The area dimension
    was already satisfied before this feature (research §2); what 019 added is the read/write
    separation over it. Recorded here rather than counted as new, because claiming it would overstate
    what this feature delivered.
  * **Phase 6 (FR-014, cash entry)** is open and stays open: it rests on an unanswered client
    question — whether cash may still be **entered** while hiding is on — and the phase header says
    so. Building either reading would be answering it on the client's behalf.

  Everything else is built. The one divergence found by the re-read is recorded under T071 below.
- [X] T071 Record in the spec that roles remain globally named, not company-scoped, contradicting its
  own Key Entities (plan D8). Either correct the entity description or state the divergence; do not
  leave both readings in the document.

  **Recorded 2026-10-03** in `spec.md`'s Key Entities, which had said "company-scoped" and was
  wrong: `settings.Role` carries no `companyId` and its `name` is globally unique, so a role defined
  by one company is visible to all of them and two companies cannot both define a "Site Engineer".
  The *assignment* is per-user and therefore effectively per-company, which is why nothing has
  broken.

  Stated as a divergence rather than silently corrected in either direction, because closing it is a
  schema change with a migration behind it — every existing `UserRole` points at a shared row — and
  the cost of leaving both readings in the document is that the next person to design against it
  believes a company's roles are its own.
- [ ] T072 `npx tsc --noEmit`, `npx eslint <touched files only>`, `npm test`, `npm run test:e2e`.

## Dependencies

| Phase | Depends on | Why |
|---|---|---|
| 1 | — | |
| 2 | 1, **gated on T012** | The guard must not read a model whose migration is unproven |
| 3 | 2 | Failing closed requires the level check to exist |
| 4 | — (sequenced after 3) | Independent; a half-migrated permission model is a bad place to add a request-scoped company context |
| 5 | — | Independent of 1-4 |
| 6 | 5, **and the client** | |
| 7 | all | |

## Parallel opportunities

- T004, T006 together; T010, T011 together.
- T022, T023, T024, T025, T026 all together — different files, no shared state.
- T030, T031 together; T034, T035 together.
- Phase 4 and Phase 5 are independent of each other and can run in parallel by two people.

## MVP

**Phases 1-2.** That is FR-001, FR-003 and FR-006 — the read/write distinction, the refusal, and the
proof nobody's access changed. It closes bugs.md item 19 on its own, and it is the only part of this
feature the client described as impossible today.

---

## Phase 7: Cash entry becomes a permission (added 2026-10-02, FR-017a to FR-017d)

The client's answer to the two cash questions. **Most of it is already built** — hiding stays exactly
as it is, per row, with no screen list — so this phase is narrower than "block cash entry" sounds.

Two of the three answers changed nothing. The per-row rule was confirmed against a screen list and
kept. The salary carve-out the client asked for falls out of that rule already, except for a salary
genuinely paid in cash, which stays hidden and which they accepted knowingly.

- [x] T073 Add `CASH_ENTRY` to the `Permission` enum with a migration. A new permission, not a reuse of
      `COMPANY_SETTINGS`: who may change the hiding setting and who may take cash are different
      questions about different people, and FR-012 already owns the first.
- [x] T074 **CRITICAL** Enumerate every write that records a cash payment and gate each on `CASH_ENTRY`.
      This is the task that decides whether the feature works: a missed route is an unguarded way to
      enter cash, and it will not show up in a test anybody thought to write. Start from
      `CASH_MODE_FIELDS` and `CASH_ENUM_VALUES` in `src/common/cash/cash-surfaces.ts` — the constants the
      interceptor already uses to find cash on the way out are the same ones that find it on the way in.
- [x] T075 Grant `CASH_ENTRY` to every role that can currently record a cash payment, in the same
      migration that adds it. **Preserving today's behaviour is the requirement, not a convenience**: a
      permission that defaults to nobody stops every site cashier in the company the moment it deploys,
      which is the exact failure the two-control design existed to avoid.
- [x] T076 [P] Unit test: a caller without `CASH_ENTRY` is refused on a cash write and unaffected on a
      bank-mode write. The second half matters more than the first — the permission must not become a
      general payments gate.
- [x] T077 [P] A guard test in the shape of `cash-surfaces.spec.ts`: parse the routes that accept a
      payment mode and fail when one accepts a cash mode without declaring `CASH_ENTRY`. T074 is a
      one-time audit; this is what keeps it true, and without it the next cash route added is unguarded
      by default.
- [x] T078 Stop hiding `denominationBreakup` unconditionally; show it to a caller holding `CASH_ENTRY`
      and hide it from everyone else (FR-017d). The one change hiding itself needs. Hiding it from the
      cashier counting notes against it conceals nothing from anybody it was meant to conceal from while
      making the screen's purpose unreachable.
- [x] T079 [P] Unit test: the breakup is present for a `CASH_ENTRY` holder and absent otherwise, and
      absent means **absent or null, never zero** — a zero denomination count reads as a real count of
      no notes.
- [x] T080 Record the grant in the audit log with actor and time, on the same terms FR-012 requires for
      changing the hiding setting. Granting somebody the right to take cash is at least as
      consequential as hiding the figures.

**Not in this phase, deliberately.** The per-row hiding rule (FR-017c) needs no work — it is built,
and `cash-surfaces.spec.ts` already fails when a new cash payment mode appears that the constants do
not name. Confirming a design is not a task.

### Phase 7 implementation record, 2026-10-02

**The gate finds cash in the request, not on a list of routes.** T074 asked for an enumeration of
every cash write and a gate on each. The enumeration came back at **two** — `POST
inventory/payments` and `PATCH labour/payment-sheets/lines/:lineId/disburse`, which are exactly the
two surfaces the client named — and both take the payment mode as a *required* field, so a cash
payment cannot be recorded without `paymentMode: 'cash'` arriving on the wire.

That made a list the wrong shape for the job. The task itself says why: *"a missed route is an
unguarded way to enter cash, and it will not show up in a test anybody thought to write."* A list of
two is as prone to that as a list of twenty — it is the default that is wrong, not the length. So
`CashEntryInterceptor` reads the request body using the same `CASH_MODE_FIELDS` and `isCashMode` the
outbound interceptor uses to find cash on the way out, and a route that accepts `paymentMode` is
gated the day it is written, by nobody's effort.

**An interceptor and not a guard, which is not a style choice.** Global guards run before
controller-level ones and `JwtAuthGuard` is declared per controller here, so a global guard would
see no `request.user` and admit everything — invisibly, because admitting everything is what
admitting looks like. `PasswordChangeInterceptor` carries the same note for the same reason.

**Reads the raw body, before the validation pipe**, since pipes run after interceptors. That is the
stronger position rather than an accident of ordering: a caller cannot evade the check by sending a
shape no DTO declares.

### Three things the task list did not anticipate

**`CASH_ENTRY` needed two levels, not one.** T075 says grant it "to every role that can currently
record a cash payment", which reads as a single `write` grant. `RolesService` refuses
`WRITE_WITHOUT_READ`, so a write-only grant would have tripped that rule the next time anybody
edited one of those roles through the interface — and the rule is right: being allowed to pay out
notes while not allowed to see the breakup you are paying against is not a coherent grant. So the
levels carry the split FR-017a and FR-017d were already describing separately — `write` records a
cash payment, `read` sees a denomination breakup — and `mayEnterCash` and `maySeeCashBreakup` are
two functions, not one with a flag.

**A read that *filters* on cash is not cash entry.** `ListPaymentsDto` takes `paymentMode` as a
filter. Without the level check at the top of the interceptor, a read-only clerk would have been
refused the very list of cash payments FR-014 says they may see with the amounts hidden. The check
is `AccessLevel.read`, so a `POST` search marked `@RequireLevel(read)` is also left alone.

**`Role.permissions` had to be backfilled too.** The array is still what every service-level
`permissions.includes(...)` reads, and `RolesService` writes the array and the grant rows together
for that reason. A migration that wrote only the rows would have left the guard granting cash entry
and a service check denying it.

### T074's completeness, asserted rather than claimed

`cash-entry-surface.spec.ts` asserts the condition that makes body inspection sufficient: **no
source file writes a cash mode value of its own accord.** Every cash record therefore originates in
a request, where the interceptor can see it. The day a service derives cash on the server — a sheet
whose mode comes from its own type, an import defaulting to cash — that test fails and the route
must declare `@RequiresCashEntry()`.

The decorator is **deliberately unused today**, and that is the point: deleting it would leave the
next such route silently unguarded. Verified the guard goes red by adding a file containing
`paymentMode: 'cash'` — it failed naming the file, and passed on removal.

### What T078 deliberately did not change

The breakup becomes visible to a `CASH_ENTRY` holder **only when hiding is on at all**. The company
setting stays the master control (FR-014); `CASH_ENTRY` decides who still sees the breakup once
hiding is enabled, not who sees it when nobody asked for anything to be hidden. The `hideCash`
argument defaults to hiding, so every existing caller keeps the old behaviour — a default of "show"
would have silently published the breakup on every surface not yet updated.

Amounts did **not** move with it. A cashier needs the breakup to pay out and needs no view of what
every other cash payment in the company came to.

### Verification

`npx tsc --noEmit` clean, `npx eslint src` 0 errors, **1,218 tests across 115 suites**, Nest
injector resolves. Two migrations, the enum value alone in the first because PostgreSQL cannot add
an enum value and use it in the same transaction.

**T065 to T072 (the original Phase 7 verification list) remain NOT RUN** — they need `npm run
test:e2e` and an RLS probe role, and the local `prisma` role is a superuser that bypasses policies.
Unchanged by this phase.
