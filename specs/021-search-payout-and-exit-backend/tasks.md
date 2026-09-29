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

- [ ] T001 Create `src/search/` with `search.module.ts`, and a module doc comment stating that this
  module **owns no tables and issues no queries** — it is the only shape Principle I permits for
  something spanning four schemas, and a module with no models reads as unfinished when it is not.
- [ ] T002 Define `SearchSource` in `src/search/search-source.interface.ts` per contracts Part 1:
  `register`, `permission`, and `search(ctx, companyId, term, limit)`. **`ctx` and `companyId` are
  parameters, not something the implementation chooses** — an implementation that ignores them is then
  visible in review rather than invisible in a closure.
- [ ] T003 Define `SearchResult` and `SearchResponse` in `src/search/dto/` per data-model.md. A result
  is an identifying summary plus an `href` — never a domain object, which is what keeps this module
  from learning business rules.
- [ ] T004 `SearchSourcesRegistry` in `src/search/search-sources.registry.ts`, mirroring
  `ProjectSourcesRegistry`. `searchAll` fans out with `Promise.all` — parallel is the performance claim
  NFR-001 rests on, since four queries then cost about the slowest rather than their sum.
- [ ] T005 **CRITICAL** In `searchAll`, check each source's `permission` **before** calling it, and
  contribute an empty list when the caller lacks it. Never gather-then-filter: a merged-then-filtered
  result leaks through counts and timing, and every register added later would have to remember to be
  filtered (FR-001c, plan D23).
- [ ] T006 **CRITICAL** Do **not** name a permission-denied register in `unavailableSources`. That
  field is inherited from the project registry where it means "we could not ask"; using it for "you
  may not see this register" discloses exactly what FR-002 forbids. Put the warning in a comment beside
  the field — the name invites the mistake.
- [ ] T007 Catch a throwing source and report it in `unavailableSources` instead. One register being
  down must not fail the whole search.
- [ ] T008 `SearchQueryDto` with `q` — **minimum 3 characters** and a bounded maximum — plus optional
  `companyId`, resolved the way every other 017/021 surface resolves it. Read the minimum from
  configuration, not a literal (Principle III).
- [ ] T009 A term shorter than the minimum is a **400, not an empty result**. The client needs to
  distinguish "keep typing" from "nothing matched", and it cannot if both are an empty list.
- [ ] T010 `GET /search?q=` in `src/search/search.controller.ts`, authenticated only. Per-register
  permission is applied per source, not on the route — a route-level guard would have to name one
  register's permission and be wrong for the other three.
- [ ] T011 Implement `SearchSource` for projects in `src/projects/portfolio/`: **prefix** match on
  `code`, **substring** match on `name`. Prefix on code because it is indexable and is how codes are
  typed; substring on name because "Tirupati" must find "Parth Tirupati Phase II", which is the whole
  point of the 2026-09-16 clarification (research §3).
- [ ] T012 Register it in `search.module.ts` and bound the per-source result count from the `limit`
  parameter — passed in rather than read from config by each source, so four implementations cannot
  disagree about the cap.
- [ ] T013 [P] Unit test for T011: found by full code, by partial code, by a name substring, and
  **not** found for a two-character term.
- [ ] T014 [P] e2e per quickstart pass 1: a project named "Parth Tirupati Phase II" with code
  `PRJ-014` is found by `Tirupati` with `matchedOn: "name"`, and by `PRJ-01` with `matchedOn: "code"`,
  and its `href` resolves.
- [ ] T015 **CRITICAL** [P] e2e per quickstart pass 3 — the pass that matters most and is easiest to
  get wrong. A caller lacking a register's permission must receive a response **byte-identical** to the
  same search where no matching record exists: the record absent, `unavailableSources` empty, nothing
  disclosed. Assert it for a **name** match as well as a code match, and for a record in another
  company. FR-001c exists because a name is not a weaker key for authorisation purposes.

---

## Phase 2: The other three registers (FR-001a)

Each is an independent implementation of an interface that exists by now, and each ships separately.

- [ ] T016 [P] `SearchSource` for vendors in `src/partners/vendors/`: prefix on `code`, substring on
  `name`.
- [ ] T017 [P] `SearchSource` for equipment in `src/plant/equipment/`: prefix on `code`, substring on
  `name`.
- [ ] T018 `SearchSource` for employees in `src/hr/employees/`: prefix on `employeeCode`, substring on
  `firstName` **and** `lastName` matched **independently, not concatenated**. Both are nullable, and a
  concatenation in the predicate is unindexable even for the prefix case and drops the rows a surname
  search needs (research §3).
- [ ] T019 [P] Unit test for T018 with an employee who has **only** a last name — the null-name case a
  concatenation would silently drop.
- [ ] T020 Register all three and confirm each applies its own module's permission.
- [ ] T021 [P] e2e per quickstart pass 2: one record in each of the four registers sharing a name
  token, found in one search, each carrying its own `register` and a working `href`.
- [ ] T022 [P] e2e per quickstart pass 6: make one source throw, confirm the other three still return
  and the failing register appears in `unavailableSources`. Asserting this beside T015 keeps both
  meanings of the field visible.

---

## Phase 3: Ranking and caps (FR-001b)

- [ ] T023 Two-tier sort on the merged list: records whose `code` matches the term **exactly** first,
  then everything else, with each tier keeping the order its sources returned. **Not a relevance
  score** — a weighted function across four heterogeneous registers gets tuned forever and cannot be
  tested, and the clarification declined to specify ordering beyond this one rule (plan D27).
- [ ] T024 [P] e2e per quickstart pass 4: a vendor with code `TIRU` outranks a project named "Tirupati
  Yard" when searching `TIRU`. Assert **only** the tier, not the order within it — a test pinning
  intra-tier order fails on unrelated changes and teaches the next person to loosen the wrong
  assertion.
- [ ] T025 Total and per-register caps from configuration; set `truncated: true` when a cap is hit.
- [ ] T026 [P] e2e per quickstart pass 5: more matches than the cap returns exactly the cap with
  `truncated: true` — the spec's "a search that would match thousands" edge case answered by admitting
  it rather than silently showing the first handful.

---

## Verification

- [ ] T027 **CRITICAL** Module-boundary spec for `src/search/`, following
  `src/approvals/spine-boundary.spec.ts`: a query from `src/search/` directly into `hr`, `partners`,
  `plant` or `projects` must fail the test. This module owning no tables is the entire design, and the
  way that erodes is one direct query added by someone who found the fan-out inconvenient.
- [ ] T028 `npx tsc --noEmit`, `npx eslint <touched files only>`, `npm test`, `npm run test:e2e`.
- [ ] T029 **Measure NFR-001** against production-scale data, not seed data, and record the p95. This
  is the measurement research §4's deferred `pg_trgm` decision is waiting on: the name substring match
  compiles to `ILIKE '%term%'` and no btree index serves it. If p95 exceeds 1 second, the ordered
  remedies are `pg_trgm` first, then a denormalised index behind the `SearchSource` seam. Do **not**
  adopt either pre-emptively — this product's precedent is to refuse an extension that buys nothing
  measured, and the measurement is this task.

---

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
