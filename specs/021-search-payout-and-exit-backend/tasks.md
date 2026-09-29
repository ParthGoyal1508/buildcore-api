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

- [ ] T030 [US2] Add `model SlipDelivery` in `payroll` — `companyId`, `payrollRunId`, `employeeId`,
  `address String`, `status`, `failureReason String?`, `sentAt`, timestamps.
  `@@unique([payrollRunId, employeeId])`.
- [ ] T031 [US2] That uniqueness constraint is what makes FR-006's retry safe: a retry becomes an upsert
  per employee, so running it twice sends once. Without it, "retry failures" and "retry everything"
  differ only by the correctness of a filter, and the failure mode is 500 employees receiving a second
  copy of their salary slip. Note this beside the model.
- [ ] T032 [US2] Store `address` **as sent**, not joined at read time. An employee whose email is
  corrected after a failed send must not have the old failure read as though it went to the new address.
- [ ] T033 [US2] RLS: `ENABLE` + `FORCE` with an explicit `WITH CHECK`. `address` is personal data —
  reading this table requires a payroll permission, not merely being authenticated.
- [ ] T034 [US2] Send on a run being marked paid, **one employee at a time and independently**. A
  rejection writes `status: failed` with its reason; it does not throw and abandon the run (NFR-003:
  500 employees, 15 minutes, failures isolated).
- [ ] T035 [US2] Refuse delivery for a run that is not fully approved (FR-007), with a code naming the
  reason.
- [ ] T036 [US2] `GET /payroll/runs/:id/slip-deliveries` reporting delivered, failed and undeliverable
  (FR-006).
- [ ] T037 [US2] `POST /payroll/runs/:id/slip-deliveries/retry` resending **only** failures.
- [ ] T038 [P] [US2] Unit test: one failing address does not stop the other 499.
- [ ] T039 [P] [US2] Unit test: retry run twice sends once per failed employee, and never re-sends a
  success.
- [ ] T040 [P] [US2] Unit test: several employees sharing one site mailbox each get their own row and
  their own slip — the spec's edge case. Keying on the employee rather than the address is why this
  works, and this test is what stops somebody "de-duplicating" it later.
- [ ] T041 [P] [US2] e2e: an unapproved run refuses delivery; approving it then permits delivery.
- [ ] T042 [US2] **Resolve the open question before building a send trigger**: FR-005 assumes automatic
  delivery on payment, and the client asked "please check this". If unanswered, build the explicit action
  and schedule the automatic trigger behind it — an explicit send can be automated later, while an
  automatic send that was wrong has already emailed 500 people.

## Phase 5: Advances settle against the transfer, not the approved run (FR-010 to FR-013)

- [ ] T043 [US3] Add `model BankSheetRecovery` in `payroll` — `companyId`, `payrollRunId`, `employeeId`,
  `salaryAdvanceId`, `amount`, timestamps. `@@unique([payrollRunId, salaryAdvanceId])`.
- [ ] T044 [US3] That constraint **is** FR-013 ("MUST NOT recover the same advance twice"), enforced by
  the database rather than by a check somebody has to remember. Note it beside the model.
- [ ] T045 [US3] Recover advances outstanding at bank-sheet production, adjusting the **transfer** and
  leaving the approved run's figures untouched (FR-010, and the spec's own assumption). The run stays
  immutable; the difference is a recovery line.
- [ ] T046 [US3] Show each recovery as a **named** line on the bank payment sheet (FR-011).
- [ ] T047 [US3] Cap the recovery per employee at their net payable, carrying the remainder forward on
  the advance (FR-012). Cap rather than refuse: an employee whose advance exceeds one month's net still
  gets paid something, and the advance settles over two months instead of producing a transfer the bank
  cannot execute.
- [ ] T048 [P] [US3] Unit test: an advance larger than net pay recovers to zero transfer, never
  negative, with the balance still outstanding.
- [ ] T049 [P] [US3] Unit test: producing the sheet twice recovers once.
- [ ] T050 [P] [US3] Unit test: an advance taken between approval and sheet production **is** recovered
  (SC-005) — this is the case item 9 exists for.
- [ ] T051 [P] [US3] Unit test: the approved run's figures are byte-identical before and after sheet
  production.

## Phase 6: The transaction sheet ⚠️ THE FORMAT RESTS ON A FILE THE CLIENT HAS NOT SUPPLIED

Everything below is buildable without the client's file **except** the column mapping. Phase 6 builds
against one seeded format profile; their file becomes a second profile rather than a rewrite. If it
arrives before this phase starts, the seeded profile is simply theirs (plan D12).

- [ ] T052 [US3] Add `model BankTransactionLine` in `payroll` — `companyId`, `payrollRunId`, the raw
  parsed fields, `matchedPayrollLineItemId String?`, `unmatchedReason String?`, timestamps.
- [ ] T053 [US3] Declare the format as a named mapping profile in configuration, not literals in the
  parser (Principle III).
- [ ] T054 [US3] Validated multipart upload DTO (Principle II).
- [ ] T055 [US3] **Store unmatched lines; do not reject the file.** SC-004 requires every line be either
  matched or reported, and a parser that refuses on the first unrecognised row reports nothing. The
  upload succeeds and the reconciliation is what is incomplete.
- [ ] T056 [US3] Match lines to payroll lines and report unmatched ones with a reason (FR-009).
- [ ] T057 [US3] Explain differences line by line between the sheet and the run.
- [ ] T058 [P] [US3] Unit test: a file with three good rows and one unparseable row uploads, matches
  three and reports one — the upload does not fail.
- [ ] T059 [P] [US3] Unit test: a sheet in a format the bank changed produces unmatched lines with
  reasons, not an exception.
- [ ] T060 [US3] Update the spec's Clarifications when the client supplies a file, naming the bank.

## Phase 7: Nobody leaves holding the company's property (FR-014 to FR-018b)

The clearance is **derived**, not stored. Only waivers are stored. A stored checklist would be a second
copy of custody, stale the moment an asset came back through the asset register — which is exactly the
path FR-014c requires to satisfy an item without a second action (plan D14).

- [ ] T061 [US4] Add `model ExitClearanceWaiver` in `hr` — `companyId`, `exitRecordId`, `itemKind`,
  `itemRef`, `reason String`, `waivedByUserId`, `waivedAt`. `@@unique([exitRecordId, itemKind, itemRef])`.
- [ ] T062 [US4] RLS with an explicit `WITH CHECK`; migration carries the `set_config` line if it has any
  data statement.
- [ ] T063 [US4] Require a reason with a **minimum length**. A mandatory field satisfied by a space is
  not a reason, and this one writes off company money.
- [ ] T064 [US4] Compute the checklist from where each obligation already lives — open recoverable kit,
  outstanding `SalaryAdvance`, open reimbursements, the account's state — with waivers overlaid. Store no
  obligation.
- [ ] T065 [US4] **Asset custody through the assets module's service, never a join.** `ExitRecord` is in
  `hr` and `AssetAllocation` is in `assets`; Principle I forbids the join. Query allocations naming the
  employee as custodian with `status` not closed (FR-014a).
- [ ] T066 [US4] Report per allocation: the asset, the project or site, the quantity where more than one
  unit is held, and `expectedReturnDate` (FR-014a).
- [ ] T067 [US4] Exclude allocations with **no custodian named** (FR-014d). An asset held by a project is
  the project's obligation, not a departing person's.
- [ ] T068 [US4] Recompute at read time (FR-014e). This is not an extra requirement — it is what deriving
  means, and it is what catches an allocation opened after the exit was initiated.
- [ ] T069 [US4] Block final settlement on any outstanding unwaived item, including an open allocation
  (FR-015, FR-014b), naming every blocking item.
- [ ] T070 [US4] A waiver MUST NOT mark an allocation returned or closed (FR-014c). The asset register
  stays the sole owner of custody; a waiver records that the company stopped chasing it.
- [ ] T071 [US4] Include pending salary, notice recovery, advances, reimbursements and deductions in the
  settlement with the final payable (FR-018).
- [ ] T072 [US4] List every asset the employee held on the settlement summary with its outcome —
  returned, or waived with author and reason — whether or not it blocked (FR-018a).
- [ ] T073 [US4] **Recover no asset value** (FR-018b), and leave a comment at the settlement computation
  saying no valuation rule exists. The next reader should find a decision, not conclude something was
  forgotten.
- [ ] T074 [P] [US4] e2e: an employee with an open allocation is refused settlement naming the asset;
  the allocation is closed **through the asset register**; the clearance then reads satisfied with no
  action taken in this feature.
- [ ] T075 [P] [US4] Unit test: waiving an asset item leaves `AssetAllocation.status` open and
  `actualReturnDate` null.
- [ ] T076 [P] [US4] Unit test: an allocation with a null custodian never appears on any checklist.
- [ ] T077 [P] [US4] Unit test: an allocation created after the exit was initiated appears on the next
  read.
- [ ] T078 [P] [US4] Unit test: a bulk allocation reads as outstanding until closed, with the quantity
  stated — partial return is not a state the asset register holds and this must not pretend otherwise.
- [ ] T079 [US4] Waiver authority: until the client answers, require the same permission as final
  settlement — the narrowest defensible reading. Record it as an assumption in the spec, not as the
  answer.

## Phase 8: Access revocation on exit (FR-017)

- [ ] T080 [US4] Revoke the exiting employee's account on exit completion and record the revocation.
- [ ] T081 [US4] Do **not** delete history (the spec's assumption). Revocation is an account operation.
- [ ] T082 [P] [US4] e2e: sign-in fails after exit completion, and the employee's attendance and payroll
  history is still readable by those permitted (SC-007).

## Verification for phases 4-8

- [ ] T083 `npx tsc --noEmit`, `npx eslint <touched files only>`, `npm test`, `npm run test:e2e`.
- [ ] T084 Re-read `spec.md` FR-005 to FR-018b and confirm each is built or explicitly deferred with a
  reason.
- [ ] T085 Confirm the three open markers are still marked and have not been quietly closed by an
  assumption that got built: automatic versus explicit slip send, the bank format, and waiver authority.

### Dependencies for phases 4-8

Phase 5 before Phase 6 **deliberately** — recovery at bank-sheet time is independent of the sheet's
format, and the format is the blocked part. Phase 7 depends on the assets module (shipped, feature 012)
and on nothing in phases 4-6. Phase 8 depends on Phase 7 only for where the revocation is triggered.
Phases 1-3 (search) are independent of all of it.

### MVP for this amendment

**Phase 7.** It closes bugs.md item 10 including the asset gap that was absent from this specification
altogether, and it needs no client answer. Phase 4 is next and is blocked only on a question with a safe
default (T042).
