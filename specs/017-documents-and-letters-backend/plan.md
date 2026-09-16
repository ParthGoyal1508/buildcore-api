# Implementation Plan: Documents and Letters (backend)

**Branch**: `017-documents-and-letters-backend` | **Date**: 2026-09-15 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/017-documents-and-letters-backend/spec.md`, clarified
2026-09-15 (three decisions: signature is an image; commercial letters are always approval-gated;
Aadhaar stays under promoted controls).

## Summary

Three things that do not exist, and one that exists in the wrong shape.

**Do not exist**: a store for a company's statutory documents (the registration *numbers* are on
`Company` already; the certificates behind them have nowhere to live), an enumeration of which
project documents are *required*, and any notion of a signatory or an applied signature.

**Wrong shape**: letters. `LetterTemplate` (settings) and `GeneratedLetter` (recruitment) exist and
work, but `enum LetterType` has five values and FR-010 needs fifteen, FR-011 needs new kinds without
a code change, and the new kinds are addressed to vendors, projects and purchases — none of which a
model in the `recruitment` schema may reference under Principle I.

So the work divides cleanly: two new document stores that copy an existing five-times-repeated
pattern, and one structural change to letters that has to be done carefully because Recruitment's
shipped behaviour rides on it.

## Technical Context

**Language/Version**: TypeScript 5.x on Node, NestJS 10

**Primary Dependencies**: `@nestjs/*`, Prisma 5.22 (multiSchema), `nestjs-prisma`,
`@nestjs/event-emitter`, `@nestjs/schedule`, `class-validator`

**Storage**: PostgreSQL, multi-schema. Document bytes go through the existing
`src/common/storage/` service (`storage.service.ts`, `blob-cipher.ts`, local and S3 adapters) — this
feature adds **no** second storage path.

**Testing**: Jest — unit specs beside sources, e2e in `test/` against a real database. Real tests are
expected for every behavioural requirement.

**Target Platform**: Linux server (Render), Postgres (Neon)

**Project Type**: Web service (NestJS API), paired with a Next.js frontend planned separately.

**Performance Goals**: Company-document completeness and project-document readiness each resolve in
**one** query regardless of row count (research §4). No per-row approval or document lookups.

**Constraints**: Constitution Principles I–VI, all NON-NEGOTIABLE except VI. RLS on every new table,
hand-authored. `npm run lint` is `eslint --fix` repo-wide — scope eslint to touched files.

**Scale/Scope**: 8 required company document kinds, 6 required project document kinds, 15 letter
kinds, 7 user stories. Comparable in size to 016 (67 tasks); expect to implement in waves.

## Constitution Check

| Principle | Assessment |
|---|---|
| **I. Schema-per-module boundaries** (NON-NEGOTIABLE) | **The load-bearing one here.** `GeneratedLetter` currently sits in `recruitment` and 017 makes it address vendors (`partners`), projects (`projects`) and purchases (`inventory`). Resolved by moving it to `shared` and giving it an **opaque** `subjectType`/`subjectId` it never dereferences — 016's spine pattern, applied again. `CompanyDocument` goes to `settings` beside `Company` and `DocumentType`; project readiness stays in `projects` and is read through an exported service method. No cross-schema query is introduced. |
| **II. Validated DTO contracts** (NON-NEGOTIABLE) | Every endpoint takes a DTO class, including single-field bodies. Upload endpoints validate kind, expiry presence (FR-004) and size before touching storage. |
| **III. Centralized configuration** (NON-NEGOTIABLE) | Required kind sets (8 company, 6 project) and the reminder lead time are configuration, not literals in services — following 016's `default-chains.ts` precedent. The letter kind list becomes **data**, which is FR-011's whole point. |
| **IV. Multi-tenant isolation & PII** (NON-NEGOTIABLE) | Every new table gets `ENABLE` + `FORCE` row-level security and a `tenant_isolation` policy in hand-authored SQL, never in `schema.prisma`. Aadhaar is PII and gets more: `DocumentType.isRestricted` excludes it from the template resolver structurally, and retrieval is audit-logged (research §6). 016 proved its RLS with a `NOSUPERUSER NOBYPASSRLS` probe role; the same proof is expected here rather than an assertion. |
| **V. AuthN/AuthZ & secrets** | Company documents, signed letters and payment proofs are permission-gated (FR-023). Commercial letter issue is gated by 016's chain (FR-015a) — consumed, not reimplemented. |
| **VI. Observability & safe migrations** | The `LetterKind` and schema-move migrations touch populated tables, so both follow nullable → backfill → constrain (research §1). Audit writes go through the existing write-only `AuditLogService` and are read back through feature 004's Activity Log. |

**Gate result**: PASS. One principle (I) required a structural decision rather than a note, and that
decision is research §2. No violation requires justification in Complexity Tracking.

## Project Structure

### Documentation (this feature)

```
specs/017-documents-and-letters-backend/
├── spec.md
├── plan.md              ← this file
├── research.md          ← Phase 0, seven decisions
├── data-model.md        ← Phase 1
├── contracts/
│   └── documents-and-letters.md
├── quickstart.md        ← Phase 1
└── checklists/requirements.md   (16/16)
```

### Source Code (repository root)

```
src/
├── settings/
│   ├── company-documents/          NEW — CompanyDocument, completeness, expiry rule
│   │   ├── company-documents.controller.ts
│   │   ├── company-documents.service.ts
│   │   ├── company-document.reminder-rule.ts
│   │   └── dto/
│   ├── letter-kinds/               NEW — the data-driven kind master (FR-011, FR-022)
│   └── signatories/                NEW — named signatory + signature image (FR-016)
├── letters/                        NEW — cross-cutting, mirrors src/approvals/
│   ├── letters.controller.ts
│   ├── letters.service.ts          issue, supersede, countersign, render
│   ├── template-resolver.ts        refuses restricted document types (FR-024)
│   └── dto/
├── projects/
│   └── documents/                  EXTENDED — required kinds, readiness batch
└── common/storage/                 UNCHANGED — reused as-is
```

**Structure Decision.** `letters/` sits at `src/` top level rather than inside a business module,
deliberately mirroring `src/approvals/`. A letter is addressed to a vendor, a project, an employee or
a candidate; placing it inside any one of those modules would make the other three reach across a
boundary. The same reasoning put the approval spine where it is, and the same discipline applies:
this module stores `(subjectType, subjectId)` and never resolves it.

`company-documents`, `letter-kinds` and `signatories` go under `src/settings/` because all three are
company configuration and `settings` already owns `Company` and `DocumentType`.

## Complexity Tracking

No constitutional violation requires justification. Two items are recorded as *cost*, not violation:

| Item | Why it is accepted |
|---|---|
| `IssuedLetter` carries two addressing forms — `employeeId`/`candidateId` and `subjectType`/`subjectId` | The spec requires Recruitment's existing behaviour to continue unchanged. Collapsing to one form would rewrite working queries for tidiness. A check constraint enforces exactly one form per row so the two cannot drift into ambiguity. |
| Moving a model between Prisma schemas | `ALTER TABLE … SET SCHEMA` on a populated table, with the Prisma client regenerated. Done because leaving it in `recruitment` would require a Principle I violation on the first commercial letter. |

## Phase status

- **Phase 0 — research**: complete → [research.md](./research.md), seven decisions, zero unresolved.
  (§7 added 2026-09-15 after `checklists/migration.md` found a question this document had deferred
  and `/speckit-tasks` had not answered.)
- **Phase 1 — design**: complete → [data-model.md](./data-model.md),
  [contracts/documents-and-letters.md](./contracts/documents-and-letters.md),
  [quickstart.md](./quickstart.md).
- **Post-design constitution re-check**: PASS — the design introduces no cross-schema query, every
  new table is RLS-covered, and the one PII kind is excluded structurally rather than by convention.

**Next**: `/speckit-tasks`. Expect a task count near 016's and a phased breakdown — the two document
stores are independent of the letter restructure and can ship first.

---

## Amendment — 2026-09-16 (Clarifications session of the same date)

Design for FR-001a, FR-003a and FR-025. Scoped as an amendment rather than a new plan because the
three are gaps between what this document specified and what shipped, not new capability.

### D1 — `completenessFor` drops the code filter and partitions in memory

The shipped query is `where: { companyId, code: { in: REQUIRED_COMPANY_DOCUMENT_CODES } }`, which is
why a supplementary document is stored and then invisible. **The filter is removed**: the query
fetches every `DocumentType` for the company with its current document joined, and the split into
required-present / required-missing / supplementary happens in memory against
`REQUIRED_COMPANY_DOCUMENT_CODES`.

This is deliberately the *simpler* query, not a more complex one. It stays **one query**, so
research §4 and the T016 query-count assertion hold unchanged — and T016 gains a case proving the
count is still one when supplementary types exist, because "one query" is the property that would
silently rot first. The cost is fetching the company's full type master (33 rows in the seeded demo)
instead of eight; a second query to fetch the supplementary half would be the worse trade.

### D2 — `supplementary` is a third list, not a widened `present`

`CompanyDocumentCompleteness` gains `supplementary: CompanyDocumentView[]`. It is NOT merged into
`present`, because `present` is what the completeness figure counts and merging would make an
unrelated trade licence move a compliance number. The web schema takes it with a `.default([])` so a
client deployed ahead of the server degrades to today's behaviour rather than failing to parse.

### D3 — materialising a required type is a company-documents route, not a document-types one

FR-003a's obvious implementation is to call the existing `POST /settings/document-types` from the
documents screen. **It is rejected**: that controller is guarded by `Permission.EMPLOYEES` and this
one by `Permission.COMPANY_SETTINGS`, so the affordance would be invisible to exactly the
administrator the requirement is written for — someone who administers the company's statutory papers
and has no reason to hold the employee-records permission.

Instead the company-documents controller gains a route that materialises a **required** kind by its
code, with the name and flags taken from `REQUIRED_COMPANY_DOCUMENT_KINDS` rather than from the
request. A code outside that set is refused. This cannot become a general document-type creation
backdoor around `EMPLOYEES`: the caller supplies no name, no code of their choosing and no flags —
only which of the eight declared kinds to bring into existence. Idempotent, so two administrators
clicking at once produce one type rather than a unique violation.

### D4 — `companyIdFor()` is copied, not invented

`company-documents.controller.ts` and `signatories.controller.ts` take `@Query('companyId')` on every
route and resolve it through the same private `companyIdFor(caller, requested)` helper that
`letter-kinds.controller.ts` and `project-documents.controller.ts` already carry: a cross-company
caller may name any company and is refused with a 400 if they name none; a company-scoped caller gets
their own and cannot name another. Row-level scoping is unchanged — `assertInScope` and RLS already
enforce it, and this decides only *which* company's list is being asked for.

Deliberately duplicated in a fourth and fifth file rather than extracted to a shared helper. Three
copies is where extraction usually pays, but the two existing copies are in different modules
(`settings`, `projects`) and the shared home for it would be `common/`, where it would become a
dependency of every controller that ever needs company scoping — a larger commitment than this
amendment should make on its own. Recorded here so the next person to touch it has the reason rather
than the impression of carelessness.

### Web (see the companion plan)

All four 017 screens, not merely company documents: none of the typed clients sends `companyId`
today, so the two controllers that already accept it are also being called single-company.
`CompanyProvider` is mounted **per page** on the four 017 pages rather than on
`app/dashboard/settings/layout.tsx` — the layout wraps every settings section, and `employee-setup`
already mounts its own provider, so hoisting would render two company selectors on that page.

### Phase status

- **Post-amendment constitution re-check**: PASS. No new table, no new cross-schema query — D3 reads
  and writes `settings.DocumentType` from a `settings` controller. Principle II holds: the new route
  takes a DTO. Principle III holds: the eight kinds stay in `src/settings/document-kinds.ts` and the
  new route reads them rather than restating them.

---

## Amendment — 2026-09-16 (second), FR-007a

The write endpoint has existed since this feature shipped. What made the screen read-only was that
nothing told it which kinds could be required, so the only way to name one was to know a document
type's internal identifier. `DocumentType.scope` removed that obstacle; this is the wiring.

### D5 — `availableTypes` is filtered in `projects`, not by changing what `settings` returns

`listRequirements` already calls `DocumentTypesService.listForCompany(companyId)` for name
resolution, so the rows are in hand and the addition costs no query. They are filtered to
`company | both` **in the projects service**, from the `scope` already on each row.

`listForCompany` is deliberately left alone. `hr` depends on it returning everything — it resolves
an employee's document types by id, and a scope filter there would silently drop rows that already
exist on employee records. The decision about what may be *required of a project* belongs to the
surface making that offer, not to the method that fetches the master.

No Principle I concern either way: `projects` reaches `settings` through an exported service method
and never queries `settings.DocumentType` itself, which is why
`ProjectDocumentRequirement.documentTypeId` is a bare string (research §3).

### D6 — the picker offers what is not already required

Filtered from `availableTypes` minus the current set. The backend deduplicates a set sent with one
kind twice — a client mistake it declines to fail a whole configuration over — but an interface that
offers an option which silently does nothing is a different problem, and belongs fixed where the
offer is made.

### D7 — the defaults become the company's set on the first save, with no new endpoint

`setRequirements` already replaces rather than merges, so a screen that loads whatever `GET` returned
and PUTs it back does exactly the right thing for a company running on defaults: the six shipped
kinds land as six rows. `usingDefaults` is already in the response and is what the screen says it
with. **No backend change for this at all**; recorded here because "the first save adopts the
defaults" sounds like it needs one.

### D8 — one materialiser, two callers, each constrained to its own declared set

`undefinedCodes` names a required kind the company has no document type for. On Company Documents
that state now has an action behind it; leaving it actionless here would be the same gap we just
closed, one screen over.

`POST /company-documents/required-kinds/:code` cannot serve it: it is guarded by `COMPANY_SETTINGS`
and validates against `REQUIRED_COMPANY_DOCUMENT_KINDS`, so a `SETTINGS` holder configuring project
paperwork is refused twice over — once by the guard and once by the code list.

So the creation moves into `DocumentTypesService.defineDeclaredKind(ctx, companyId, kind, actor)`,
which owns `settings.DocumentType` and takes an already-resolved `RequiredDocumentKind`. It performs
**no code-set validation of its own** — each caller resolves against the set it is entitled to:

- `CompanyDocumentsService.defineRequiredKind` against `REQUIRED_COMPANY_DOCUMENT_KINDS`, under
  `COMPANY_SETTINGS`. Its existing refusal test stands unchanged.
- The project requirements surface against `REQUIRED_PROJECT_DOCUMENT_KINDS`, under `SETTINGS`.

That is the whole permission argument, kept intact on both sides: neither caller can materialise a
kind the other owns, and neither can invent one. A shared method validating against the union of both
sets would quietly hand each surface the other's list.

### Phase status

- **Post-amendment constitution re-check**: PASS. No new table, no migration, no cross-schema query —
  `projects` reaches `settings` through exported service methods it already injects. Principle II
  holds: the new route takes a path parameter validated against configuration, and the existing PUT
  already has its DTO. Principle III holds: both declared sets stay in `src/settings/document-kinds.ts`.
