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
├── research.md          ← Phase 0, six decisions
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

- **Phase 0 — research**: complete → [research.md](./research.md), six decisions, zero unresolved.
- **Phase 1 — design**: complete → [data-model.md](./data-model.md),
  [contracts/documents-and-letters.md](./contracts/documents-and-letters.md),
  [quickstart.md](./quickstart.md).
- **Post-design constitution re-check**: PASS — the design introduces no cross-schema query, every
  new table is RLS-covered, and the one PII kind is excluded structurally rather than by convention.

**Next**: `/speckit-tasks`. Expect a task count near 016's and a phased breakdown — the two document
stores are independent of the letter restructure and can ship first.
