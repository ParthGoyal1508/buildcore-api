# Tasks: Cross-Register Search (021, backend)

**Feature**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **Created**: 2026-09-16

## Scope

**User Story 1 only.** User Stories 2, 3 and 4 — salary slip email, advance settlement on the bank
sheet, exit clearance — are `bugs.md` items 8, 9 and 10 and get their tasks when those batches are
worked. All three of the spec's open `[NEEDS CLARIFICATION]` markers belong to them and block nothing
below.

The spec says these four share no mechanism and each ships alone, so planning and building one
without the others costs nothing.

## The shape of this work

No search exists in this product — nothing to extend, nothing to migrate, **no new table**. This is
the only feature in the batch that needs no migration at all.

The single design constraint is that the four registers live in four schemas: `Employee` in `hr`,
`Vendor` in `partners`, `Equipment` in `plant`, `Project` in `projects`. Principle I forbids one query
spanning them, and the pattern for this already exists —
`src/projects/portfolio/project-sources.registry.ts` consults each module through its own interface and
reports which could not be asked. Search is a second instance of it.

---

## Phase 1: The registry, the contract, and projects (FR-001, FR-001a–c, FR-003, FR-004)

Phase 1 alone closes `bugs.md` item 4, which names projects specifically.

- [X] T001 Create `src/search/` with `search.module.ts`, and a module doc comment stating that this
  module **owns no tables and issues no queries** — it is the only shape Principle I permits for
  something spanning four schemas, and a module with no models reads as unfinished when it is not.
- [X] T002 Define `SearchSource` in `src/search/search-source.interface.ts` per contracts Part 1:
  `register`, `permission`, and `search(ctx, companyId, term, limit)`. **`ctx` and `companyId` are
  parameters, not something the implementation chooses** — an implementation that ignores them is then
  visible in review rather than invisible in a closure.
- [X] T003 Define `SearchResult` and `SearchResponse` in `src/search/dto/` per data-model.md. A result
  is an identifying summary plus an `href` — never a domain object, which is what keeps this module
  from learning business rules.
- [X] T004 `SearchSourcesRegistry` in `src/search/search-sources.registry.ts`, mirroring
  `ProjectSourcesRegistry`. `searchAll` fans out with `Promise.all` — parallel is the performance claim
  NFR-001 rests on, since four queries then cost about the slowest rather than their sum.
- [X] T005 **CRITICAL** In `searchAll`, check each source's `permission` **before** calling it, and
  contribute an empty list when the caller lacks it. Never gather-then-filter: a merged-then-filtered
  result leaks through counts and timing, and every register added later would have to remember to be
  filtered (FR-001c, plan D23).
- [X] T006 **CRITICAL** Do **not** name a permission-denied register in `unavailableSources`. That
  field is inherited from the project registry where it means "we could not ask"; using it for "you
  may not see this register" discloses exactly what FR-002 forbids. Put the warning in a comment beside
  the field — the name invites the mistake.
- [X] T007 Catch a throwing source and report it in `unavailableSources` instead. One register being
  down must not fail the whole search.
- [X] T008 `SearchQueryDto` with `q` — **minimum 3 characters** and a bounded maximum — plus optional
  `companyId`, resolved the way every other 017/021 surface resolves it. Read the minimum from
  configuration, not a literal (Principle III).
- [X] T009 A term shorter than the minimum is a **400, not an empty result**. The client needs to
  distinguish "keep typing" from "nothing matched", and it cannot if both are an empty list.
- [X] T010 `GET /search?q=` in `src/search/search.controller.ts`, authenticated only. Per-register
  permission is applied per source, not on the route — a route-level guard would have to name one
  register's permission and be wrong for the other three.
- [X] T011 Implement `SearchSource` for projects in `src/projects/portfolio/`: **prefix** match on
  `code`, **substring** match on `name`. Prefix on code because it is indexable and is how codes are
  typed; substring on name because "Tirupati" must find "Parth Tirupati Phase II", which is the whole
  point of the 2026-09-16 clarification (research §3).
- [X] T012 Register it in `search.module.ts` and bound the per-source result count from the `limit`
  parameter — passed in rather than read from config by each source, so four implementations cannot
  disagree about the cap.
- [X] T013 [P] Unit test for T011: found by full code, by partial code, by a name substring, and
  **not** found for a two-character term.
- [X] T014 [P] e2e per quickstart pass 1: a project named "Parth Tirupati Phase II" with code
  `PRJ-014` is found by `Tirupati` with `matchedOn: "name"`, and by `PRJ-01` with `matchedOn: "code"`,
  and its `href` resolves.
- [X] T015 **CRITICAL** [P] e2e per quickstart pass 3 — the pass that matters most and is easiest to
  get wrong. A caller lacking a register's permission must receive a response **byte-identical** to the
  same search where no matching record exists: the record absent, `unavailableSources` empty, nothing
  disclosed. Assert it for a **name** match as well as a code match, and for a record in another
  company. FR-001c exists because a name is not a weaker key for authorisation purposes.

---

## Phase 2: The other three registers (FR-001a)

Each is an independent implementation of an interface that exists by now, and each ships separately.

- [X] T016 [P] `SearchSource` for vendors in `src/partners/vendors/`: prefix on `code`, substring on
  `name`.
- [X] T017 [P] `SearchSource` for equipment in `src/plant/equipment/`: prefix on `code`, substring on
  `name`.
- [X] T018 `SearchSource` for employees in `src/hr/employees/`: prefix on `employeeCode`, substring on
  `firstName` **and** `lastName` matched **independently, not concatenated**. Both are nullable, and a
  concatenation in the predicate is unindexable even for the prefix case and drops the rows a surname
  search needs (research §3).
- [X] T019 [P] Unit test for T018 with an employee who has **only** a last name — the null-name case a
  concatenation would silently drop.
- [X] T020 Register all three and confirm each applies its own module's permission.
- [X] T021 [P] e2e per quickstart pass 2: one record in each of the four registers sharing a name
  token, found in one search, each carrying its own `register` and a working `href`.
- [X] T022 [P] e2e per quickstart pass 6: make one source throw, confirm the other three still return
  and the failing register appears in `unavailableSources`. Asserting this beside T015 keeps both
  meanings of the field visible.

---

## Phase 3: Ranking and caps (FR-001b)

- [X] T023 Two-tier sort on the merged list: records whose `code` matches the term **exactly** first,
  then everything else, with each tier keeping the order its sources returned. **Not a relevance
  score** — a weighted function across four heterogeneous registers gets tuned forever and cannot be
  tested, and the clarification declined to specify ordering beyond this one rule (plan D27).
- [X] T024 [P] e2e per quickstart pass 4: a vendor with code `TIRU` outranks a project named "Tirupati
  Yard" when searching `TIRU`. Assert **only** the tier, not the order within it — a test pinning
  intra-tier order fails on unrelated changes and teaches the next person to loosen the wrong
  assertion.
- [X] T025 Total and per-register caps from configuration; set `truncated: true` when a cap is hit.
- [X] T026 [P] e2e per quickstart pass 5: more matches than the cap returns exactly the cap with
  `truncated: true` — the spec's "a search that would match thousands" edge case answered by admitting
  it rather than silently showing the first handful.

---

## Verification

- [X] T027 **CRITICAL** Module-boundary spec for `src/search/`, following
  `src/approvals/spine-boundary.spec.ts`: a query from `src/search/` directly into `hr`, `partners`,
  `plant` or `projects` must fail the test. This module owning no tables is the entire design, and the
  way that erodes is one direct query added by someone who found the fan-out inconvenient.
- [X] T028 `npx tsc --noEmit`, `npx eslint <touched files only>`, `npm test`, `npm run test:e2e`.
- [ ] T029 **Measure NFR-001** against production-scale data, not seed data, and record the p95. This
  is the measurement research §4's deferred `pg_trgm` decision is waiting on: the name substring match
  compiles to `ILIKE '%term%'` and no btree index serves it. If p95 exceeds 1 second, the ordered
  remedies are `pg_trgm` first, then a denormalised index behind the `SearchSource` seam. Do **not**
  adopt either pre-emptively — this product's precedent is to refuse an extension that buys nothing
  measured, and the measurement is this task.

---

## Implementation notes, 2026-09-30

T001-T028 complete. **T029 remains open** — NFR-001 must be measured against
production-scale data and this environment has seed data only. The `pg_trgm` decision
research §4 defers is still waiting on that measurement, and nothing should adopt it
pre-emptively.

**One design defect was found by T026 and fixed.** Truncation was reported only when the
*merged* list exceeded the total cap. With a per-register cap of 10 and 36 matching
projects, the merged list came to 13 rows against a total cap of 30, so `truncated` read
`false` while 26 matches were being withheld — exactly the silence the spec's "a search
that would match thousands" edge case exists to prevent. The registry now asks each source
for `perRegister + 1` and treats a full-to-the-brim response as truncation, discarding the
extra row. It needed no change to `SearchSource`, and two unit tests now cover both sides
of the boundary.

The e2e was written before the fix and failed on exactly this, which is the outcome T026
was written for.

## Dependencies & Execution Order

- **Phase 1** → nothing. Closes `bugs.md` item 4 on its own.
- **Phase 2** → phase 1 (needs the interface and registry). T016–T019 are parallel to each other.
- **Phase 3** → phase 2 to be fully meaningful, though T023 can land with one register.
- **T027** → phase 1. Add the boundary test as soon as the module exists, not at the end.

### Parallel opportunities

T013, T014, T015, T016, T017, T019, T021, T022, T024, T026 are `[P]`. Phase 2's three registers are
three people's work with no shared files.

## MVP scope

**Phase 1.** It delivers the client's stated request — a dashboard search bar that finds projects by
name or code — with the permission model and the boundary test already correct. Phases 2 and 3 satisfy
the broader specification, which is wider than the bug because the client asked for the same thing
twice in different words.

## Notes

**T005, T006 and T015 are one concern in three places.** The requirement is that a caller learns
nothing about records they cannot see, and it fails in three distinct ways: filtering after the merge,
naming a denied register in `unavailableSources`, and a response that differs measurably between
"hidden" and "absent". Each has its own task because each is separately forgettable.

**T029 is deliberately a task and not an assumption.** The feature ships with a known-unindexed
substring match. The plan's Risks table names it, research §4 orders the remedies, and this task is
where the number that chooses between them comes from. Shipping without it means the first person to
notice will be a user.

## Phase 4: Salary slips reach the people they belong to (FR-005 to FR-007)

Email already exists — `src/shared/email/` with a Resend adapter, a console adapter and
`email-templates.ts`. Nothing here builds email; it wires slips to it and records what happened.

- [x] T030 [US2] Add `model SlipDelivery` in `payroll` — `companyId`, `payrollRunId`, `employeeId`,
  `address String`, `status`, `failureReason String?`, `sentAt`, timestamps.
  `@@unique([payrollRunId, employeeId])`.
- [x] T031 [US2] That uniqueness constraint is what makes FR-006's retry safe: a retry becomes an upsert
  per employee, so running it twice sends once. Without it, "retry failures" and "retry everything"
  differ only by the correctness of a filter, and the failure mode is 500 employees receiving a second
  copy of their salary slip. Note this beside the model.
- [x] T032 [US2] Store `address` **as sent**, not joined at read time. An employee whose email is
  corrected after a failed send must not have the old failure read as though it went to the new address.
- [x] T033 [US2] RLS: `ENABLE` + `FORCE` with an explicit `WITH CHECK`. `address` is personal data —
  reading this table requires a payroll permission, not merely being authenticated.
- [x] T034 [US2] Send on a run being marked paid, **one employee at a time and independently**. A
  rejection writes `status: failed` with its reason; it does not throw and abandon the run (NFR-003:
  500 employees, 15 minutes, failures isolated).
- [x] T035 [US2] Refuse delivery for a run that is not fully approved (FR-007), with a code naming the
  reason.
- [x] T036 [US2] `GET /payroll/runs/:id/slip-deliveries` reporting delivered, failed and undeliverable
  (FR-006).
- [x] T037 [US2] `POST /payroll/runs/:id/slip-deliveries/retry` resending **only** failures.
- [x] T038 [P] [US2] Unit test: one failing address does not stop the other 499.
- [x] T039 [P] [US2] Unit test: retry run twice sends once per failed employee, and never re-sends a
  success.
- [x] T040 [P] [US2] Unit test: several employees sharing one site mailbox each get their own row and
  their own slip — the spec's edge case. Keying on the employee rather than the address is why this
  works, and this test is what stops somebody "de-duplicating" it later.
- [ ] T041 **NOT RUN** [P] [US2] e2e: an unapproved run refuses delivery; approving it then permits delivery.
- [x] T042 [US2] **Resolve the open question before building a send trigger**: FR-005 assumes automatic
  delivery on payment, and the client asked "please check this". If unanswered, build the explicit action
  and schedule the automatic trigger behind it — an explicit send can be automated later, while an
  automatic send that was wrong has already emailed 500 people.

## Phase 5: Advances settle against the transfer, not the approved run (FR-010 to FR-013)

- [x] T043 [US3] Add `model BankSheetRecovery` in `payroll` — `companyId`, `payrollRunId`, `employeeId`,
  `salaryAdvanceId`, `amount`, timestamps. `@@unique([payrollRunId, salaryAdvanceId])`.
- [x] T044 [US3] That constraint **is** FR-013 ("MUST NOT recover the same advance twice"), enforced by
  the database rather than by a check somebody has to remember. Note it beside the model.
- [x] T045 [US3] Recover advances outstanding at bank-sheet production, adjusting the **transfer** and
  leaving the approved run's figures untouched (FR-010, and the spec's own assumption). The run stays
  immutable; the difference is a recovery line.
- [x] T046 [US3] Show each recovery as a **named** line on the bank payment sheet (FR-011).
- [x] T047 [US3] Cap the recovery per employee at their net payable, carrying the remainder forward on
  the advance (FR-012). Cap rather than refuse: an employee whose advance exceeds one month's net still
  gets paid something, and the advance settles over two months instead of producing a transfer the bank
  cannot execute.
- [x] T048 [P] [US3] Unit test: an advance larger than net pay recovers to zero transfer, never
  negative, with the balance still outstanding.
- [x] T049 [P] [US3] Unit test: producing the sheet twice recovers once.
- [x] T050 [P] [US3] Unit test: an advance taken between approval and sheet production **is** recovered
  (SC-005) — this is the case item 9 exists for.
- [x] T051 [P] [US3] Unit test: the approved run's figures are byte-identical before and after sheet
  production.

## Phase 6: The transaction sheet ⚠️ THE FORMAT RESTS ON A FILE THE CLIENT HAS NOT SUPPLIED

Everything below is buildable without the client's file **except** the column mapping. Phase 6 builds
against one seeded format profile; their file becomes a second profile rather than a rewrite. If it
arrives before this phase starts, the seeded profile is simply theirs (plan D12).

- [x] T052 [US3] Add `model BankTransactionLine` in `payroll` — `companyId`, `payrollRunId`, the raw
  parsed fields, `matchedPayrollLineItemId String?`, `unmatchedReason String?`, timestamps.
- [x] T053 [US3] Declare the format as a named mapping profile in configuration, not literals in the
  parser (Principle III).
- [x] T054 [US3] Validated multipart upload DTO (Principle II).
- [x] T055 [US3] **Store unmatched lines; do not reject the file.** SC-004 requires every line be either
  matched or reported, and a parser that refuses on the first unrecognised row reports nothing. The
  upload succeeds and the reconciliation is what is incomplete.
- [x] T056 [US3] Match lines to payroll lines and report unmatched ones with a reason (FR-009).
- [x] T057 [US3] Explain differences line by line between the sheet and the run.
- [x] T058 [P] [US3] Unit test: a file with three good rows and one unparseable row uploads, matches
  three and reports one — the upload does not fail.
- [x] T059 [P] [US3] Unit test: a sheet in a format the bank changed produces unmatched lines with
  reasons, not an exception.
- [x] T060 [US3] Update the spec's Clarifications when the client supplies a file, naming the bank.

## Phase 7: Nobody leaves holding the company's property (FR-014 to FR-018b)

The clearance is **derived**, not stored. Only waivers are stored. A stored checklist would be a second
copy of custody, stale the moment an asset came back through the asset register — which is exactly the
path FR-014c requires to satisfy an item without a second action (plan D14).

- [X] T061 [US4] Add `model ExitClearanceWaiver` in `hr` — `companyId`, `exitRecordId`, `itemKind`,
  `itemRef`, `reason String`, `waivedByUserId`, `waivedAt`. `@@unique([exitRecordId, itemKind, itemRef])`.
- [X] T062 [US4] RLS with an explicit `WITH CHECK`; migration carries the `set_config` line if it has any
  data statement.
- [X] T063 [US4] Require a reason with a **minimum length**. A mandatory field satisfied by a space is
  not a reason, and this one writes off company money.
- [X] T064 [US4] Compute the checklist from where each obligation already lives — open recoverable kit,
  outstanding `SalaryAdvance`, open reimbursements, the account's state — with waivers overlaid. Store no
  obligation.
- [X] T065 [US4] **Asset custody through the assets module's service, never a join.** `ExitRecord` is in
  `hr` and `AssetAllocation` is in `assets`; Principle I forbids the join. Query allocations naming the
  employee as custodian with `status` not closed (FR-014a).
- [X] T066 [US4] Report per allocation: the asset, the project or site, the quantity where more than one
  unit is held, and `expectedReturnDate` (FR-014a).
- [X] T067 [US4] Exclude allocations with **no custodian named** (FR-014d). An asset held by a project is
  the project's obligation, not a departing person's.
- [X] T068 [US4] Recompute at read time (FR-014e). This is not an extra requirement — it is what deriving
  means, and it is what catches an allocation opened after the exit was initiated.
- [X] T069 [US4] Block final settlement on any outstanding unwaived item, including an open allocation
  (FR-015, FR-014b), naming every blocking item.
- [X] T070 [US4] A waiver MUST NOT mark an allocation returned or closed (FR-014c). The asset register
  stays the sole owner of custody; a waiver records that the company stopped chasing it.
- [X] T071 [US4] Include pending salary, notice recovery, advances, reimbursements and deductions in the
  settlement with the final payable (FR-018).
- [X] T072 [US4] List every asset the employee held on the settlement summary with its outcome —
  returned, or waived with author and reason — whether or not it blocked (FR-018a).
- [X] T073 [US4] **Recover no asset value** (FR-018b), and leave a comment at the settlement computation
  saying no valuation rule exists. The next reader should find a decision, not conclude something was
  forgotten.
- [X] T074 [P] [US4] e2e: an employee with an open allocation is refused settlement naming the asset;
  the allocation is closed **through the asset register**; the clearance then reads satisfied with no
  action taken in this feature.
- [X] T075 [P] [US4] Unit test: waiving an asset item leaves `AssetAllocation.status` open and
  `actualReturnDate` null.
- [X] T076 [P] [US4] Unit test: an allocation with a null custodian never appears on any checklist.
- [X] T077 [P] [US4] Unit test: an allocation created after the exit was initiated appears on the next
  read.
- [X] T078 [P] [US4] Unit test: a bulk allocation reads as outstanding until closed, with the quantity
  stated — partial return is not a state the asset register holds and this must not pretend otherwise.
- [X] T079 [US4] Waiver authority: until the client answers, require the same permission as final
  settlement — the narrowest defensible reading. Record it as an assumption in the spec, not as the
  answer.

## Phase 8: Access revocation on exit (FR-017)

- [X] T080 [US4] Revoke the exiting employee's account on exit completion and record the revocation.
- [X] T081 [US4] Do **not** delete history (the spec's assumption). Revocation is an account operation.
- [X] T082 [P] [US4] e2e: sign-in fails after exit completion, and the employee's attendance and payroll
  history is still readable by those permitted (SC-007).

## Verification for phases 4-8

- [X] T083 `npx tsc --noEmit`, `npx eslint <touched files only>`, `npm test`, `npm run test:e2e`.
      **Run 2026-10-04, and this is the first time the last of those four was green.** `tsc` clean;
      `eslint src test prisma` 0 errors (one pre-existing prettier error remains in the untouched
      `test/account-creation.e2e-spec.ts`); **1,647 unit tests across 147 suites**; and
      **`npm run test:e2e` 581 tests across 33 suites, all passing.**

      Held open deliberately until today rather than ticked on a passing unit suite. The e2e run was
      red with 15 suites and 158 assertions down, and closing this task would have meant reporting a
      green suite that was not green. Repairing it found four defects that are committed separately —
      connections never released on shutdown, eight masters readers ignoring the company switcher, a
      permission fallback that was per caller instead of per area, and a project refusal demanding
      four document uploads before checking that the client exists.
      **See 019 T072 for the measured result, which is the same run.** Clean on the first three; the
      e2e suite is red from connection exhaustion and pre-existing drift in suites older than 017,
      neither of which is this feature's work.
- [X] T084 Re-read `spec.md` FR-005 to FR-018b and confirm each is built or explicitly deferred with a
  reason.

  **Read 2026-10-03.** Each is built. One was found built *wrongly* by the re-read and is now fixed:
  **FR-018a** required the settlement summary to list every asset the employee held at exit "whether
  or not it blocked the settlement", and `FnfService` derived its list by filtering the exit
  clearance — which can only contain *open* custody. An asset returned a week before the last
  working day was absent from the summary entirely, so the summary said the employee had never been
  given it. The service's own docblock claimed the requirement was met. Fixed by a second registry
  question (`custodyHistoryFor`), with seven service tests behind it.

  That is what a re-read is for, and it is the second time in this review that a docblock asserting
  a requirement was the only thing satisfying it.
- [X] T085 Confirm the three open markers are still marked and have not been quietly closed by an
  assumption that got built: automatic versus explicit slip send, the bank format, and waiver authority.

  **Checked 2026-10-03, and the answer is better than the question allowed for.** None of the three
  was closed by an assumption. All three were **answered by the client** on 1 and 2 October, and each
  answer is recorded in `spec.md` under "Needing the client's decision" with its date:

  * **Slip send** — an explicit action, not automatic delivery. A run can be corrected after being
    marked paid, and an automatic send puts the wrong figure in an inbox it cannot be recalled from.
  * **Bank format** — the sample arrived (`docs/RING ROAD JULY SALARY.xls`, 23 real NEFT rows) and
    is now FR-008a to FR-008g. Waiting rather than guessing was the right order: the file contradicts
    three things a sensible person would have assumed.
  * **Waiver authority** — HR proposes, the Director countersigns. This *superseded* what had
    shipped: the waiver required write access on Employees, which was a placeholder, and wider than
    a write-off of company money deserves.

  A fourth marker was answered the same way: nothing is recovered for an unreturned asset (FR-018b),
  and that is now a recorded decision rather than a pending valuation rule. Every one of the four
  superseded a placeholder we had chosen, which is the outcome this task was written to protect.

### Dependencies for phases 4-8

Phase 5 before Phase 6 **deliberately** — recovery at bank-sheet time is independent of the sheet's
format, and the format is the blocked part. Phase 7 depends on the assets module (shipped, feature 012)
and on nothing in phases 4-6. Phase 8 depends on Phase 7 only for where the revocation is triggered.
Phases 1-3 (search) are independent of all of it.

### MVP for this amendment

**Phase 7.** It closes bugs.md item 10 including the asset gap that was absent from this specification
altogether, and it needs no client answer. Phase 4 is next and is blocked only on a question with a safe
default (T042).

## Phase 7-8 implementation record, 2026-09-30

**T061-T082 complete.** `bugs.md` item 10 is closed on the backend, including the asset gap that
was absent from this specification entirely until 2026-09-29.

### FR-017 needed no code

Access revocation on exit was **already built**. `ExitService.deactivateAfterSettlement`
deactivates the employee, deactivates the account, and revokes every issued refresh token — with
a comment already explaining why every token and not just the current one. T080-T082 were
verification, not work.

### A module cycle forced the registry pattern

The plan said asset custody would be read "through the assets module's service". `AssetsModule`
**already imports `HrModule`**, so `HrModule` importing it back would be a cycle spanning five
modules. `ExitCustodyRegistry` is the answer this repository already uses for exactly this
(`ProjectSourcesRegistry`, `SearchSourcesRegistry`): the dependency points one way and the data
flows back.

That brought a consequence worth more than the inconvenience. A source that never registers means
feature 012 is not deployed, and **a clearance reporting no assets in that case would be lying** —
the lie letting somebody leave with a laptop. So `unavailableSources` names it and settlement is
refused: the safe answer when part of the question went unanswered is "assume yes". Neither plan
nor tasks anticipated that distinction; it fell out of the pattern.

### The gate sits where the settlement is produced

`FnfService.process`, not where it is paid. A settlement that exists is a figure somebody will act
on, and refusing it later means refusing a number already quoted to the leaver.

### What a waiver does and does not do

It records that the company stopped chasing an obligation, with a name and a reason against the
decision. It does **not** mark the obligation discharged (FR-014c): an asset waived here stays
open in the asset register, because marking it returned would put a false fact in the table that
owns the truth. There is a unit test asserting the waiver write touches nothing else.

Re-waiving records the newer reason rather than refusing — somebody correcting a reason should not
have to delete evidence to do it.

### FR-018b is a decision, not an omission

No asset value is deducted from the payable, and the reasoning is at the computation:
three valuation rules give three figures, the client has chosen none, and a deduction computed
from an unstated rule is worse than none. `assetValueRecovered: null` is stated on the response
rather than left to be inferred from an absence.

### Still open

Waiver authority is the client's decision. Until they answer it requires `EMPLOYEES`, the same as
the rest of the surface — the narrowest defensible reading, recorded as an assumption.

---

## Phase 8: A waiver becomes a reviewable item (added 2026-10-02, FR-016)

The client's answer: **HR proposes, the Director countersigns.** This **supersedes shipped behaviour** —
the waiver currently needs only write access on Employees, which was a placeholder I chose while
building, and is wider than a write-off of company money deserves.

Wiring, not new machinery: the approval spine already carries final settlement, which is director-final
already, so a waiver joins the chain that governs the thing it unblocks.

- [x] T086 Register a chain action for the clearance waiver in `default-chains.ts`, director-final,
      alongside the final-settlement action it unblocks. Reusing the existing registration rather than
      inventing a second approval path is what FR-022 of feature 016 requires of every module.
- [x] T087 **CRITICAL** `ExitClearanceService.waive()` submits to `ApprovalsService` and returns the
      pending item. It must **not** write the waiver. Today it writes immediately; leaving the write
      in place while adding a submission produces a waiver that is both applied and awaiting approval,
      which is worse than either.
- [x] T088 Move the write into the `approval.completed` handler, idempotently — the same shape feature
      016's T074 established for the attendance correction, and for the same reason: a handler that runs
      twice must not write two waivers.
- [x] T089 A **rejected** waiver leaves the obligation outstanding and the settlement still blocked.
      Assert it: the failure worth guarding is a rejection that silently clears the item anyway, which
      looks like success to everybody except the company's balance sheet.
- [x] T090 Keep `waivedByName` (shipped 2026-10-01) pointing at **who proposed** it, and add the
      approver separately. Collapsing the two loses the distinction the client's answer exists to
      create — "HR waived this" and "HR asked and the Director agreed" are different facts.
- [x] T091 Refuse `waive()` outright for a caller who may not propose one. Write access on Employees is
      no longer sufficient on its own; proposing is an HR act and the chain decides the rest.
- [ ] T092 **NOT RUN** [P] e2e: an exit with an outstanding item cannot settle while the waiver is pending, settles
      once it is approved, and stays blocked when it is rejected. The middle case is the one that proves
      the wiring; the other two prove it did not open a hole.
- [x] T093 [P] Unit test: `waive()` writes no `ExitClearanceWaiver` row at submission time. The
      structural assertion behind T087 — a test on behaviour would pass while the row was still written
      by a path nobody looked at.
- [x] T094 Update `quickstart.md`'s clearance pass: the waiver step is now two steps with a named
      approver between them, so a reader following it against the shipped build would otherwise be told
      the screen is broken.

**Cost the client accepted explicitly:** an exit with anything outstanding now waits on an approval.

### Phase 8 implementation record, 2026-10-02

**A proposal table, not a status column.** The obvious design was `ExitClearanceWaiver.status`, and
it was wrong for a structural reason: the *existence* of a waiver row is what unblocks a final
settlement. A pending row in that table would be one forgotten `where` clause away from clearing an
obligation nobody approved — and the forgotten clause would sit in a query that still returned
sensible-looking data, so nothing would look wrong until a settlement went out.
`ExitClearanceWaiverProposal` cannot have that failure, because `forEmployee` has no reason to read
it.

**T090's two names are two columns.** `waivedByUserId` still means who *proposed*; `approvedByUserId`
is who agreed. The migration leaves pre-existing rows' `approvedByUserId` null rather than
backfilling it with the proposer — recording a countersignature that never happened would be worse
than recording none.

**The spine raises no event for a rejection**, which the task list did not anticipate. Only
`approval.completed`, and only on `approved`. That is right for the spine — a module watching every
rejection would be a module watching the spine's internals — but it left a rejected proposal
`pending` forever, and the unique index on `(item, status)` would then block the corrected
re-proposal HR obviously needs to make. So the status is reconciled **lazily**, at the one moment it
matters: when somebody proposes again. Anywhere else would be a cron job keeping two copies of a
fact in step, which is exactly what `forEmployee` deliberately refuses to do for obligations.

T089 falls out of that rather than needing a branch: nothing on the rejection path writes a waiver,
so the obligation stays outstanding and the settlement stays blocked by construction.

**`spine-boundary.spec.ts` caught a real violation.** The first version of `finalApproverOf` read
`shared.ApprovalDecision` directly from `hr` to name the countersigner. The guard refused it, and
correctly — the one-line convenience of a join is how a boundary becomes imaginary. The approver now
comes from `ApprovalService.stateOfSystem`, whose `latestDecision` on an approved one-level chain
**is** the countersignature.

**T091's permission is `PAYROLL`**, the HR-office permission in this product — it is what gates the
salary data a waived advance comes out of. Checked in the service and not only on the route, because
`waive()` will be reachable from the F&F flow next and a guard on one route is a guard on one route.

Re-waiving is now **refused** rather than overwriting the reason. That was reasonable when one person
decided alone; it is not now, because the newer reason would replace one the Director had already
agreed to.

**T094 asked for the existing clearance pass to be updated and there was none** — `quickstart.md`
covered US1's search only. Pass 8 is new rather than amended, and it walks both the approval and the
rejection paths, because only one of them is the one that silently fails.

**T092 NOT RUN** — the e2e needs `npm run test:e2e` and a seeded exit with a provisioned Director.
Its three cases are covered by unit assertions on the submission, the handler and the rejection
path, which is not the same thing and is recorded as not the same thing.

---

## Phase 9: The bank sheet and the payslip (added 2026-10-02, files received)

`docs/RING ROAD JULY SALARY.xls` closes the last open question in this feature. FR-008a to FR-008g.

- [x] T095 [US3] Emit the 16 columns in the sample's exact order, **including the seven that are always
      empty**. A parser counting columns rejects a sheet that omits blanks.
- [x] T096 **CRITICAL** [US3] Write every account number — beneficiary and debit — as a **text** cell.
      The sample is inconsistent: numeric except where a leading zero forced Excel's hand
      (`0060311000001404`, `05152122005693`, `05213211061311`). A numeric cell destroys the zero and
      the first anybody knows is a failed transfer on payment day. This is the task this phase exists
      for.
- [x] T097 [P] [US3] Unit test: an account number beginning with a zero survives a round trip through
      the generated file. Assert on the **bytes written**, not on the value passed in — the bug lives
      in the cell type, so a test that checks the input proves nothing.
- [x] T098 [US3] Write `Value Date` as the text `DD/MM/YYYY`. Not a date cell: a real date is
      re-rendered by the reader's locale, and `21/08/2026` read as month 21 is a rejected file.
- [x] T099 [US3] Put the **IFSC** in the column labelled "Beneficiary Bank Swift Code / IFSC Code".
      Every value in the sample is an IFSC and none is a SWIFT code. Validate the IFSC shape (four
      letters, `0`, six alphanumerics) before export rather than after rejection.
- [x] T100 **CRITICAL** [US3] Source `Beneficiary Name` from a **bank account holder name** held against
      the employee's bank details, not from the employee master. The sample's names are misspelled
      against any HR record because they match the beneficiary's own bank. If no such field exists this
      task includes adding it — and an export that silently falls back to the employee's name is worse
      than one that refuses, because the refusal happens before payment day.
- [x] T101 [P] [US3] Refuse to export a row whose bank account holder name is unset, naming the
      employee. A blank beneficiary name is a transfer that fails at the bank.
- [x] T102 [US3] Header row and payment rows only. **No totals row** — the sample has none, and a total
      appended to a file read row-by-row becomes a payment instruction.
- [ ] T103 **NOT RUN** [P] [US3] e2e: generate a sheet for a seeded run and compare it cell-for-cell and
      **cell-type-for-cell-type** against the sample's shape. The types are the contract here, not just
      the values.
- [x] T104 [US3] Payslip layout per `docs/NC0060_Payslip_Feb 2026.pdf`: company address block, the
      two-column employee panel (bank, PAN, PF UAN, location, effective work days, LOP), earnings as
      **Full and Actual** side by side, deductions, totals, net pay in words, and the "system generated"
      line.
- [x] T105 [US3] **LOP proration is specified but unproven by the sample** — LOP is zero in it, so Full
      and Actual are identical throughout. Implement the proration and test it directly; do not treat
      the sample as evidence that the two columns agree.

### Phase 9 implementation record, 2026-10-02

Both client files read directly rather than taken on description — `xlrd` for the workbook, `pypdf`
for the payslip — and both contradicted something.

#### The bank sheet replaced a format we invented

`BankSheetService` was emitting **seven columns of our own design with a bold TOTAL row**. Reasonable
while the question was open, and wrong in three ways the sample settled at once:

* **16 columns, seven of them always empty.** Emitted, because a parser counting columns rejects a
  sheet that omits a blank.
* **No totals row** (T102). A total appended to a file read row-by-row becomes a payment
  instruction — for the sum of every other row, to whatever account is on it.
* **Every account number as text** (T096). The sample is *inconsistent* here: numeric except where a
  leading zero forced Excel's hand (`0060311000001404`, `05152122005693`, `05213211061311`). Being
  consistent is the fix, because "text when it starts with a zero" is a rule somebody has to get
  right every time.

**Two fields had nowhere to come from, so T100 included adding them.**
`Employee.bankAccountHolderName` is the name the *beneficiary's own bank* holds — in the sample these
are misspelled against any HR record ("Arivnd", "Rosan") because that is what they are. A transfer is
matched on the account number, but a name the bank does not recognise is a returned payment, and the
export **refuses** the row rather than substituting the employee's name: a silent fallback moves that
discovery to payment day. `Company.payrollDebitAccountNumber` is the account every row debits —
`09310400000819` in the sample, leading zero included, which is why it is a text column.

**Every assertion in the spec reads the bytes back out of the generated workbook.** The bug this
phase exists to prevent lives in the *cell type*: a test on the value passed in would pass while the
account number was written as a number and its zero destroyed on the way to disk. 17 tests, including
the sample's own six IFSCs against the validator.

The format itself is a **named profile in configuration** (Principle III, plan D12) — headers and the
two NEFT codes, because the format belongs to a bank and the next bank will have another. Which
employee field fills each column stays in code, as positions, because the bank reads by position.

#### The payslip, and what the sample could not prove

`docs/NC0060_Payslip_Feb 2026.pdf` adds a company address block, a two-column employee panel (bank,
PAN, PF UAN, location, effective work days, LOP), earnings as **Full and Actual** side by side, and
the "system generated" closing line. All built.

**T105 was right to warn, and the warning was load-bearing.** LOP is zero in every row of the sample,
so Full and Actual are identical all the way down it — the sample is **no evidence whatever** that
the two columns agree. The proration is therefore tested against a fixture with 2.5 LOP days where
they must not agree, and the fixture's comment says so, because the obvious next change is somebody
"simplifying" it to match the sample.

Three things fell out of building it:

* **The Full figures had to be stored, not derived.** Deriving them from the employee master on read
  would let next year's salary revision retroactively rewrite the Full column of a payslip already
  issued — and the Actual figures are stored for exactly that reason, so deriving one half would make
  one half of the table authoritative and the other not.
* **No backfill, deliberately.** Slips issued before today have no record of their unprorated
  entitlement. Copying the Actual figure across would assert "no LOP that month" on precisely the
  slips where there might have been some, so the columns are nullable and the PDF prints an em dash.
  Full equal to Actual is a real and common statement; it must not also be what "we do not know"
  looks like.
* **Overtime has no Full figure and never will.** It is hours worked, not an entitlement LOP can
  reduce. Null, not a copy of the actual, which would assert a monthly overtime entitlement.

The account number on the payslip is **masked**, unlike on the bank sheet. A bank needs the full
number to move money; an employee already knows their own, and a payslip is emailed, forwarded and
printed.

The old centred layout is kept for a caller with no identity to supply — a half-drawn header block
would be worse than the heading it replaces.

#### Verification

`npx tsc --noEmit` clean, `npx eslint src` 0 errors, **1,253 tests across 116 suites**, Nest injector
resolves. Two migrations.

**T103 NOT RUN** — the e2e cell-for-cell comparison against the sample needs `npm run test:e2e` and a
seeded run. Its substance is covered by the unit spec, which reads the generated bytes and asserts on
cell *types*; that is the contract T103 names, verified without the seeded run rather than instead of
it.

### Phases 4 and 5 implementation record, 2026-10-02

Written **after** the Phase 9 commit, which claimed to close items 8 and 9 and did not. Phase 9
closed item 8's payslip *layout* and the bank sheet's *format*; items 8 and 9 are delivery and
settlement, which are these two phases. The overclaim is recorded here rather than quietly fixed.

#### Delivery is an explicit action (T042)

FR-005 reads as automatic delivery when a run is marked paid, and the client asked us to check that.
Unanswered, so T042's instruction stands: build the explicit send. **An explicit send can be
automated later behind the same method; an automatic send that was wrong has already emailed five
hundred people their salary.** The scheduled trigger is deliberately not built.

#### What makes the retry safe, in two halves

`@@unique([payrollRunId, employeeId])` makes every write an upsert per employee — so a repeat is a
no-op rather than a second email. And `retry` selects `status: failed` **as a query**, so a sent row
is not merely skipped, it is not in the result set. Both halves matter: a filter applied to everybody
would be one edit away from "send all", and the difference is twelve emails or five hundred. The test
asserts on the query for that reason.

`send` also skips anybody already sent to, because somebody will press it twice — the first press
takes minutes for a full company and looks like it did nothing.

#### Undeliverable is not a kind of failure

A failure is retried; an undeliverable row has no address and would fail identically every time. Kept
as separate statuses so a retry sweep cannot keep failing on the same employees forever, and so the
screen can send somebody to find an address instead of pressing retry again.

#### Item 9's restraint is the part worth reading

The recovery touches **only advances the run could not have seen** — created after `generatedAt`. An
advance the engine already recovered *partially* is left alone, and that is deliberate: the engine
capped it because net pay could not absorb more, and taking the remainder out of the transfer would
drive the transfer to zero and hand the employee nothing. That is exactly the outcome FR-012's cap
exists to prevent, and reaching it by a different route would not make it lawful.

A broader query — "anything still owed" — would look more thorough and would quietly undo a decision
the engine made on purpose. The eligibility `where` is asserted on directly for that reason, rather
than inferred from behaviour.

`@@unique([payrollRunId, salaryAdvanceId])` **is** FR-013. Regenerating the sheet re-reads what was
already recovered, counts it against the headroom, and writes nothing further. A concurrent duplicate
is swallowed rather than raised: it means another request already did the thing FR-013 asks for.

#### FR-011's named lines are a third worksheet

The bank's template has no column for a recovery and must not grow one, so the recoveries go on
`Advance Recoveries` alongside `Not Transferable` — one line per advance, not per employee, with the
approved net pay beside the transfer. "My transfer does not match my payslip" is the question this
answers before it is asked; a netted figure leaves it unanswerable from the file itself.

#### Three code paths, one mapper

`slipViewFrom` is now exported, so the JSON endpoint, the PDF download and the emailed attachment all
read the same rows through the same mapping. Two independent mappings could still round or label a
figure differently, and a payslip that disagrees with the screen is a wage dispute.

The email carries the period and the company and **no figure**. A salary in a subject line is visible
in a lock-screen preview and in whatever log the recipient's provider keeps; the slip is the
attachment, which is what the client asked for.

#### Verification

`npx tsc --noEmit` clean, `npx eslint src` 0 errors, **1,282 tests across 118 suites**, Nest injector
resolves. One migration with both tables, each with `ENABLE` + `FORCE` RLS and an explicit
`WITH CHECK` — `SlipDelivery.address` is personal data.

**T041 NOT RUN** — the e2e that approves a run and then permits delivery. The refusal and the
permission are both unit-asserted through the same `outstandingApproval` the bank sheet uses.

### Phase 6 implementation record, 2026-10-02

The client's file arrived before this phase started, so T053's "one seeded profile, theirs becomes a
second" never happened — **theirs is the profile**, which is what plan D12 said would happen in this
case. T060's spec update is the Phase 9 record above; the bank is not named in it because the file
does not name one.

#### The rule that shaped everything: a bad row is reported, not fatal

T055 asks for it and SC-004 depends on it — every line either matched or reported. A parser that
refuses on the first unrecognised row reports **none** of them, which is the opposite of useful when a
bank has changed a column and somebody needs to know which rows still line up.

So there is exactly one refusal: a file that cannot be opened as a workbook, where the remedy is a
different file rather than a report. Everything inside a workbook that opens becomes rows, and rows
that cannot be read become rows carrying a reason.

**The first version of this had a bug that the T059 test caught.** It skipped any row with neither an
account nor an amount as a trailing blank — which is most of a sheet whose columns the bank had
*reordered*. It would have reported such a file as clean with nothing in it: the single worst outcome
available, because it looks like success. A row is now blank only when **every** cell is empty.

#### Matching is on the account number, and normalised only for matching

Never the beneficiary name: the name is whatever the beneficiary's own bank holds, misspelled against
every HR record in the client's own sample, which makes it the field in the file least able to
identify anybody.

Normalisation strips leading zeros — exactly the inconsistency in the sample, where the same bank
wrote `0060311000001404` as text and `42855410069` as a number. Treating those as different accounts
would report such employees as both unmatched *and* missing, which is one problem counted twice.
Storage keeps the raw value, because the leading zero is part of the account number at the bank.

#### Two gaps, reported separately

A line matching no employee is money that moved to somebody the run does not know about. An employee
with no line is money that **did not move**. Different people chase each, and a single "discrepancies"
count would send both to whoever asked first.

Differences are **reported, not judged**. A transfer short by an advance recovery is correct, and this
service does not know which differences are expected — the one that does is the recovery sheet from
Phase 5.

#### Base64, not multipart

Matching every other upload in this product — company documents, signatories, payment proofs. One
upload convention means one place where size limits and validation live, rather than two that
disagree about which rejects what.

#### Verification

`npx tsc --noEmit` clean, `npx eslint src` 0 errors, **1,297 tests across 119 suites**, injector
resolves. One migration, RLS with an explicit `WITH CHECK` — `beneficiaryAccount` is personal data.
