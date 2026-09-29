# Implementation Plan: Cross-Register Search (021, backend)

**Branch**: `021-search-payout-and-exit-backend` | **Date**: 2026-09-16 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/021-search-payout-and-exit-backend/spec.md`, clarified
2026-09-16 (search matches name as well as code).

## Scope of this plan

**This plan covers User Story 1 only — cross-register search.**

`bugs.md` is being worked in batches of four, and only item 4 (*"Add a search bar on the dashboard to
quickly find projects"*) falls in the first batch. User Stories 2, 3 and 4 — salary slip email, advance
settlement on the bank sheet, and the exit clearance gate — are `bugs.md` items 8, 9 and 10 and belong
to later batches. They are **not planned here**, and all three of the spec's open
`[NEEDS CLARIFICATION]` markers belong to them, not to search.

The spec itself says these four share no mechanism and each ships on its own, so planning one without
the others costs nothing.

## Summary

There is no search of any kind in this product. Nothing to extend, nothing to migrate — which makes
this the smallest of the four specs in this batch and the only one that adds a capability rather than
changing one.

The single design problem is that the four registers live in four different schemas: `Employee` in
`hr`, `Vendor` in `partners`, `Equipment` in `plant`, `Project` in `projects`. Principle I forbids one
query spanning them. The answer is not new: this codebase already has a **source registry** for
exactly this shape of problem — `project-sources.registry.ts` consults each contributing module through
its own interface and reports which sources could not be asked. Search is a second instance of that
pattern, not a new one.

The 2026-09-16 clarification widened matching from code to code **and name**, which is where the real
cost sits — a code is short, unique and indexable, and a name is none of those.

## Technical Context

**Language/Version**: TypeScript 5.x on Node, NestJS 10

**Primary Dependencies**: `@nestjs/*`, Prisma 5.22 (multiSchema), `nestjs-prisma`, `class-validator`.
**No new dependency**, and see D26 on the Postgres extension deliberately not adopted.

**Storage**: PostgreSQL, multi-schema. No new table — see D24.

**Testing**: Jest — unit specs beside sources, e2e in `test/` against a real database.

**Target Platform**: Linux server (Render), Postgres (Neon)

**Project Type**: Web service (NestJS API), paired with a Next.js frontend planned separately.

**Performance Goals**: NFR-001 — results within 1s at p95 across the full register. **Unverified**;
no search exists to measure, and the spec says this must be held against production-scale data rather
than seed data. D26 is where this target and the match strategy collide.

**Constraints**: Constitution Principles I–VI. Principle I is the binding one and it shapes the whole
design. Every register's own company and permission scoping must be applied *by that register*, never
by filtering a merged result (FR-001c).

**Scale/Scope**: One user story, four registers, one new module, no migration. The smallest plan in
this batch.

## Constitution Check

| Principle | Assessment |
|---|---|
| **I. Schema-per-module boundaries** (NON-NEGOTIABLE) | **The load-bearing one.** Four registers, four schemas, and no query may span them. `src/search/` owns no tables and queries nothing; it holds a registry of four `SearchSource` implementations, each living in and querying only its own module. Merging happens in memory. This is `project-sources.registry.ts`'s pattern applied a second time. |
| **II. Validated DTO contracts** (NON-NEGOTIABLE) | `SearchQueryDto` validates the term with a minimum length (D25) and a maximum, and bounds the per-register result count. |
| **III. Centralized configuration** (NON-NEGOTIABLE) | Minimum term length, per-register cap and total cap are configuration, not literals in the service. |
| **IV. Multi-tenant isolation & PII** (NON-NEGOTIABLE) | **No new table, so no new RLS policy** — each source queries under the existing RLS context of its own module, so isolation is inherited rather than re-implemented. Employee names are PII and search returns them; the permission gate is per-source (D23), and an empty result for an inaccessible record is indistinguishable from an empty result for a nonexistent one (FR-002). |
| **V. AuthN/AuthZ & secrets** | Each source applies its own module's permission. A caller with `PROJECTS` and not `EMPLOYEES` searches projects and not employees, in the same request, and is told nothing about the employees they cannot see. |
| **VI. Observability & safe migrations** | No migration at all. This is the only feature in the batch that needs none. |

**Gate result**: PASS. Principle I required a structural decision and the structure already existed.

## Project Structure

### Documentation (this feature)

```text
specs/021-search-payout-and-exit-backend/
├── spec.md
├── plan.md              ← this file (User Story 1 only)
├── research.md          ← Phase 0
├── data-model.md        ← Phase 1 (no tables — read it for why)
├── contracts/
│   └── search.md
├── quickstart.md        ← Phase 1
└── checklists/requirements.md
```

### Source Code (repository root)

```text
src/search/                         # NEW — owns no tables, queries nothing
├── search.module.ts
├── search.controller.ts            # GET /search
├── search.service.ts               # fan-out, merge, rank
├── search-sources.registry.ts      # mirrors project-sources.registry.ts
├── search-source.interface.ts      # the contract every register implements
└── dto/

src/hr/employees/                   # CHANGED — implements SearchSource
src/partners/vendors/               # CHANGED — implements SearchSource
src/plant/equipment/                # CHANGED — implements SearchSource
src/projects/portfolio/             # CHANGED — implements SearchSource
```

**Structure Decision.** `src/search/` at top level, mirroring `src/approvals/` and `src/letters/`, for
the same reason each of those is there: it serves every register and belongs inside none of them.
Unlike those two it owns **no tables at all**, which is worth stating in the module's own doc comment —
a module with no models looks unfinished and is not.

## Approach

### Phase order

1. **The registry and the contract**, with one register wired (projects). Deliverable and directly
   useful: `bugs.md` item 4 names projects specifically, so phase 1 alone closes the client's request.
2. **The other three registers** — employees, vendors, equipment. Each is an independent implementation
   of an interface that already exists by then, and each can ship separately.
3. **Ranking and caps** (FR-001b's exact-code-first rule, the result limits).

Phase 1 satisfies the bug as written. Phases 2 and 3 satisfy the specification, which is broader
because the client asked for the same thing twice in different words (spec US1's rationale).

### What deliberately does not change

- **No register changes its own queries or indexes for search's benefit** beyond adding its
  `SearchSource` implementation. A register's own list endpoints are untouched.
- **No denormalised index.** D24.

## Key decisions

### D23 — permission and company scoping happen inside each source, never after the merge

The tempting shape is to gather everything and filter the merged list. It is **wrong**, and FR-001c
was written to forbid it: a merged-then-filtered result leaks through timing and through result counts,
and every new register added later has to remember to be filtered.

Each `SearchSource` runs under the caller's own RLS context and checks its own module's permission
before querying. A source the caller cannot use returns an empty list and the merge cannot tell that
apart from "found nothing" — which is exactly FR-002's requirement that the response not disclose the
existence of records outside the caller's reach.

The registry's `unavailableSources` notion, inherited from the project registry, is reused for a
genuinely different case: a register whose module is not deployed. It must **not** be used to report
"you lack permission for this register", because that reports the existence of what the caller may not
see. Written down because the existing pattern's field name invites exactly that mistake.

### D24 — no search index table; fan out to four queries instead

A denormalised `shared.SearchIndex`, maintained by domain events, would give one indexed query and
clean ranking. Rejected for now:

- It introduces a **second source of truth** for names and codes, and the failure mode is silent: a
  missed event means a renamed project is findable only by its old name, and nothing surfaces the drift.
- It needs backfill for every existing row in four registers, plus event wiring in four modules, plus
  a reconciliation sweep — more work than the thing it optimises.
- Four indexed queries in parallel, each capped, is well inside NFR-001's 1-second target at this
  product's scale. `Promise.all` across four schemas costs roughly the slowest of the four, not their sum.

Recorded as reversible: if NFR-001 fails against production-scale data, the index is the answer and the
`SearchSource` interface is already the seam to put it behind, because every caller goes through the
registry rather than to the registers.

### D25 — code matches by prefix, name matches by substring, and the term has a floor

Without `pg_trgm` (D26) a substring match is `ILIKE '%term%'`, which cannot use a btree index. So:

- **Code**: prefix match. Index-usable, and it is how people actually type a code — they know how it
  starts, not what is in the middle of it.
- **Name**: substring match. "Tirupati" must find "Parth Tirupati Phase II", and a prefix match would
  not. This is the query that does not use an index, and it is accepted as the cost of the 2026-09-16
  clarification.
- **Minimum term length** of 3, from configuration. The spec's own edge case says name matching makes
  a thousands-row result likely, and a two-character substring against every name in four registers is
  that edge case on every keystroke. A floor is cheaper and more honest than paginating a result nobody
  wanted.

`Employee` has no single name column — `firstName` and `lastName` are both nullable. The source matches
each independently rather than concatenating, because a concatenation in the predicate is unindexable
even for the prefix case and produces nothing a person searching for a surname needs.

### D26 — `pg_trgm` is not adopted here, and the reason is recorded rather than implied

A trigram index is the correct long-term answer to D25's unindexed substring match, and this product
has form for refusing an extension on exactly these grounds: `geofence.util.ts` declines PostGIS with
the note that adopting a geospatial extension *"would be a new architectural dependency requiring its
own constitution amendment to buy nothing"*.

The same test applied here gives a different answer eventually and the same answer now. It would buy
something real — an indexed substring match, which D25 concedes it lacks — but only at a data scale
this product has not reached and has never measured. Adopting it now would mean a constitution
amendment and a migration to speed up a query nobody has timed.

**So it is deferred with a trigger, not dismissed**: if NFR-001's 1-second p95 fails against
production-scale data, `pg_trgm` is the first thing to try and D24's index table is the second. The
measurement comes first, which is the part this product has consistently not done.

### D27 — exact code match ranks first, and nothing else about ordering is specified

FR-001b is one rule: a record whose code exactly matches the term outranks records matched only by
name. Implemented as a two-tier sort on the merged list — exact-code tier, then everything else —
with the order inside each tier left to whatever the sources returned.

Deliberately not a relevance score. A weighted scoring function across four heterogeneous registers is
a thing that gets tuned forever and cannot be tested, and the clarification explicitly declined to
specify ordering beyond this single rule.

## Complexity Tracking

No constitutional violation requires justification. One item is recorded as cost:

| Item | Why it is accepted |
|---|---|
| A module with no models, no tables and no queries of its own | It is the only shape Principle I permits for something that must span four schemas. `src/approvals/` and `src/letters/` set the precedent for a top-level cross-cutting module; this one goes further by owning no data at all, which reads as incomplete and is the point. |

## Risks

| Risk | Handling |
|---|---|
| **The unindexed name substring match is slow at real scale, and NFR-001 was never measured.** | Named in D25 and D26 with an explicit trigger and two ordered remedies. The `SearchSource` seam means either remedy is applied behind the interface without touching a caller. |
| A new register is added later and forgets its permission check, leaking rows into search. | The `SearchSource` interface takes the caller and the RLS context as parameters rather than letting an implementation choose — a source that ignores them is visible in review, and the e2e enumerates registered sources and asserts each refuses an unauthorised caller. |
| `unavailableSources` is used to report a permission failure, disclosing what the caller may not see. | Called out in D23. The e2e asserts a caller lacking a register's permission gets a response indistinguishable from one where that register held no match. |
| Search becomes the place every module hangs a new lookup, and `src/search/` slowly learns about business rules. | It owns no tables, and the interface returns an identifying summary plus a route — not a domain object. A source that wants to return more is a source that wants a different endpoint. |

## Verification

`npx tsc --noEmit`, `npx eslint <touched files>` (**not** `npm run lint` — that is `eslint --fix`
repo-wide), `npx jest <touched specs>`, and the e2e suite against a real database. The boundary test
matters here as much as in 017: a query from `src/search/` into any business schema must fail the
module-boundary spec, following `src/approvals/spine-boundary.spec.ts`.

## Phase status

- **Phase 0 — research**: [research.md](./research.md)
- **Phase 1 — design**: [data-model.md](./data-model.md), [contracts/search.md](./contracts/search.md),
  [quickstart.md](./quickstart.md)
- **Post-design constitution re-check**: PASS — no new table, no migration, no cross-schema query, and
  isolation inherited from each register rather than re-implemented.

**Next**: `/speckit-tasks` for User Story 1. User Stories 2–4 are planned when `bugs.md` items 8, 9
and 10 reach their batches.

## Amendment — 2026-09-29: User Stories 2, 3 and 4 (bugs.md items 8, 9, 10)

### Scope

This plan previously covered User Story 1 — search — only, and said US2 to US4 would be planned "when
bugs.md items 8, 9 and 10 reach their batches". They have. FR-005 to FR-018b are planned here, including
the asset-custody requirements added to the spec on 2026-09-29.

### What already exists

| Piece | Where |
|---|---|
| Transactional email, adapter-selected | `src/shared/email/` — `resend-email.adapter.ts`, `console-email.adapter.ts`, `email-templates.ts` |
| Payroll runs and their lines | `payroll.PayrollRun` (2473), `payroll.PayrollLineItem` (2525) |
| Advances and their recovery | `hr.SalaryAdvance` (2443) |
| Exit records and the F&F run | `hr.ExitRecord` (2359) with `fnfPayrollRunId` |
| Asset custody | `assets.AssetAllocation` (5477) with `custodianEmployeeId`, `status`, `expectedReturnDate`, `actualReturnDate` |

So none of the three stories needs new infrastructure. Email exists and is unwired to slips; advances
exist and are recovered at payroll rather than at bank-sheet time; the exit record exists with no
clearance gate.

### D9 — a slip delivery is a record, and a failure is a row rather than a log line

FR-006 requires reporting employees whose slip could not be delivered, and retrying only those.
`payroll.SlipDelivery { payrollRunId, employeeId, address, sentAt, status, failureReason }`, unique on
`(payrollRunId, employeeId)`.

The uniqueness constraint is what makes FR-006's retry safe: retrying is an upsert per employee, so a
retry that runs twice sends once. Without it, "retry failures" and "retry everything" differ only by
the correctness of a filter, and the failure mode is 500 employees receiving a second copy of their
salary slip.

`address` is stored as sent, not joined at read time. An employee whose email is corrected after a
failed send must not have the failure read as though it went to the new address.

### D10 — delivery is per-employee isolated, and one bad address stops nothing

NFR-003: 500 employees within 15 minutes, failures isolated. Each send is independent and records its
own outcome; a rejection is a row with `status: failed`, not a thrown error that abandons the run.

The spec's edge case — a shared site address several employees use — is why `SlipDelivery` is keyed on
the employee and not the address. Several employees legitimately resolving to one mailbox is a
configuration the client may well have, and it must not look like a duplicate.

### D11 — the transaction sheet is parsed against one configured format, and unmatched lines are kept

FR-008 and FR-009. `payroll.BankTransactionLine`, one row per line of the uploaded sheet, each either
matched to a `PayrollLineItem` or held unmatched with the reason.

**Unmatched lines are stored, not rejected.** SC-004 requires every line be either matched or reported,
and a parse that refuses the file on the first unrecognised row reports nothing. The upload succeeds and
the reconciliation is the thing that is incomplete.

The format is one configured mapping, per the spec's assumption, not automatic detection.

### D12 — item 9 cannot be finished without a file, and the plan says where that stops being true

The open marker asks which bank and what sheet format. Per the 2026-09-29 decision, this is planned and
phased last.

What is buildable without the answer: the upload endpoint, `BankTransactionLine`, the matching rule
against payroll lines, the unmatched report, and the difference explanation. What is **not**: the column
mapping itself, which is a fixture of somebody's real spreadsheet.

So Phase 6 builds against a declared mapping with a single seeded profile, and the client's file becomes
a second profile rather than a rewrite. If the file arrives before Phase 6 starts, the seeded profile is
simply theirs.

### D13 — advance recovery at bank-sheet time adjusts the transfer, never the approved run

FR-010 to FR-013, and the spec's assumption says this plainly. The payroll run's figures stay as
approved; the recovery is a line on the bank payment sheet.

`payroll.BankSheetRecovery { payrollRunId, employeeId, salaryAdvanceId, amount }`, unique on
`(payrollRunId, salaryAdvanceId)` — which is FR-013 ("MUST NOT recover the same advance twice") enforced
by the database rather than by a check somebody has to remember.

FR-012's "no negative transfer, carry the balance forward" is a per-employee cap at the net payable, with
the unrecovered remainder left outstanding on the advance. Capping rather than refusing matters: an
employee whose advance exceeds one month's net still gets paid something, and the advance settles over
two months instead of producing a transfer nobody can execute.

### D14 — the exit clearance is a derived checklist with stored waivers, not a stored checklist

FR-014 to FR-018b. The obligations are computed from where they already live — open `AssetAllocation`
rows, unreturned recoverable kit, outstanding `SalaryAdvance`, open reimbursements, the account's state.
Only the **waiver** is stored: `hr.ExitClearanceWaiver { exitRecordId, itemKind, itemRef, reason,
waivedBy, waivedAt }`.

This is FR-014c read into the design. A stored checklist would be a second copy of custody, and it would
be stale the moment an asset was returned through the asset register — which is precisely the path
FR-014c requires to satisfy the item without a second action. Deriving means "returned in the asset
module" and "satisfied here" are the same fact rather than two facts that have to be kept in step.

FR-014e's "recompute at read time" is therefore not an extra requirement; it is what deriving means. It
is stated in the spec because a reader of the requirement alone would not know that.

### D15 — assets reach the clearance through the assets module, never by a join

`ExitRecord` is in `hr`; `AssetAllocation` is in `assets`. Principle I forbids the join. The clearance
calls the assets module's service for allocations naming the employee as custodian and not closed —
the same shape as this repository's other cross-schema reads.

`custodianEmployeeId` is nullable and indexed with `companyId`, so the query is cheap and FR-014d — no
custodian, not an obligation — is the natural reading rather than a filter somebody adds.

### D16 — no asset value is recovered, and the code should make that visible

FR-018b. The final settlement includes no figure derived from an unreturned asset. A waiver records that
it was written off, with a name against it.

The plan notes this explicitly because the absence is a decision, not an omission: the next person to
read the settlement computation should find a comment saying no valuation rule exists rather than
concluding one was forgotten.

### Phases

| Phase | Work | Requirements |
|---|---|---|
| 4 | `SlipDelivery`, per-employee isolated send on run-paid, undeliverable report, retry-failures-only, refusal for an unapproved run | FR-005 to FR-007 |
| 5 | `BankSheetRecovery`, recovery at sheet production, named lines, the net cap with carry-forward, the double-recovery constraint | FR-010 to FR-013 |
| 6 ⚠️ | Transaction sheet upload, `BankTransactionLine`, matching, unmatched report, one seeded format profile — **the mapping rests on a file the client has not supplied** | FR-008, FR-009 |
| 7 | Derived exit clearance, `ExitClearanceWaiver`, the settlement gate, asset custody through the assets service, the settlement summary listing every asset with its outcome | FR-014 to FR-018b |
| 8 | Access revocation on exit completion, recorded | FR-017 |

Phase 5 before Phase 6 deliberately: recovery at bank-sheet time is independent of the sheet's *format*,
and the format is the part that is blocked.

### Constitution re-check

| Principle | Assessment |
|---|---|
| **I. Schema-per-module boundaries** | `SlipDelivery`, `BankTransactionLine` and `BankSheetRecovery` in `payroll`; `ExitClearanceWaiver` in `hr`. Asset custody read through the assets module's service (D15), never joined. |
| **II. Validated DTO contracts** | The upload is a validated multipart DTO with a declared format profile. The waiver requires a reason with a minimum length — a mandatory field satisfied by a space is not a reason. |
| **IV. Multi-tenant isolation & PII** | All four tables get `ENABLE` + `FORCE` RLS with explicit `WITH CHECK`, probe-verified. `SlipDelivery.address` is personal data and is readable only under a payroll permission. |
| **V. AuthN/AuthZ** | Waiver authority is the third open client question. Until answered it requires the same permission as final settlement — the narrowest defensible reading, and recorded as such. |
| **VI. Observability & safe migrations** | Four additive tables, no backfill, no change to `PayrollRun` or `ExitRecord`. Every migration sets `app.is_super_admin` transaction-locally. |

### Risks

| Risk | Consequence | Mitigation |
|---|---|---|
| A retry re-sends to everybody | 500 employees receive a duplicate salary slip | D9's `(payrollRunId, employeeId)` uniqueness makes a send an upsert |
| An advance is recovered twice | An employee is short-paid | D13's `(payrollRunId, salaryAdvanceId)` uniqueness, enforced by the database |
| A recovery exceeds net pay | A negative transfer the bank cannot execute | FR-012's cap with carry-forward |
| The clearance is stale against the asset register | Settlement blocked for a returned asset, or allowed for an unreturned one | D14 derives rather than stores; nothing to go stale |
| Slips sent for a run later corrected | Employees hold a slip that no longer matches | The spec's edge case; FR-007 gates on full approval and the delivery record carries `sentAt` so a corrected run's slips are identifiable |

### Phase status

**Next**: `/speckit-tasks` for phases 4-8. Phases 1-3 (search, 29 tasks) are not started and are
independent of all of the above.
