# Research: Documents and Letters (017, backend)

**Date**: 2026-09-15 · **Spec**: [spec.md](./spec.md)

Seven decisions. Four are forced by things that already exist in this codebase rather than by
preference, and saying which is which matters: a decision forced by existing structure can be
revisited cheaply if that structure changes, while a decision made on judgement cannot.

§7 was added on 2026-09-15 after the migration checklist (CHK031) found that this document had
deferred a question to `/speckit-tasks` which `/speckit-tasks` then did not answer.

---

## §1 — `LetterType` becomes a table, not a longer enum

**Decision.** Replace `enum LetterType` with a `LetterKind` row set in the `settings` schema, keyed
by a stable string. The five existing enum values are seeded as rows with their current keys, and
`LetterTemplate` and `GeneratedLetter` gain a `letterKindId` foreign key.

**Rationale.** FR-011 requires defining a new letter kind *without a code change*. A Prisma enum
cannot satisfy that: every new kind is a schema edit, a migration and a deploy. The spec asks for
fifteen kinds today and explicitly anticipates more, so the enum would be a migration treadmill.
FR-022 — refuse deleting a kind while issued letters reference it — is also a foreign key with
`onDelete: Restrict` once kinds are rows, and a hand-written guard against an enum otherwise.

There is a second, quieter reason. A kind is not just a name: FR-016 says signature application is
configured *per kind*, and FR-015a says three specific kinds are approval-gated. Those are
attributes, and attributes belong on a row, not on an enum value with a lookup table bolted beside
it.

**Migration path** (the part that makes this non-trivial, so it is stated rather than assumed):

1. Create `LetterKind`, seed the five existing keys.
2. Add nullable `letterKindId` to `LetterTemplate` and `GeneratedLetter`.
3. Backfill by matching the existing `letterType` enum value to the seeded key.
4. `SET NOT NULL`, add the FK.
5. Drop the `letterType` column and the enum.

Steps 2–4 are the same nullable → backfill → constrain shape 016 used for `viewPermission`, and for
the same reason: Prisma cannot add a required column to a populated table.

**Alternatives considered.** *Extend the enum to fifteen values* — rejected, contradicts FR-011.
*Keep the enum and add a parallel "custom kinds" table* — rejected, two sources of truth for what a
letter kind is, and every query becomes a union.

---

## §2 — Letters move to `shared` and carry an opaque subject

**Decision.** `GeneratedLetter` moves from the `recruitment` schema to `shared` and is renamed
`IssuedLetter`. It keeps its existing `employeeId` and `candidateId` columns, and gains a nullable
opaque pair `subjectType` / `subjectId` for the commercial kinds. A check constraint requires
exactly one addressing form per row.

**Rationale.** This is the decision the feature turns on, and it is forced by Principle I.

`GeneratedLetter` lives in `recruitment` because every letter kind that existed was a recruitment
letter. Feature 017 adds work orders, LOIs, purchase orders, indents, service orders, service bills
and maintenance bills. Those are addressed to **vendors** (`partners`), **projects** (`projects`) and
**purchases** (`inventory`). A model in `recruitment` that stores a vendor id is either a
cross-schema foreign key or a cross-module query, and Principle I forbids the second outright.

`shared` is where 016 put the approval spine for exactly this reason, and the opaque-subject pattern
is 016's too: the spine stores `(entityType, entityId)` and **never dereferences it**
(016 research §1). The same discipline applies here — the letters module must never resolve
`subjectId` into a vendor or a project. Whatever needs a vendor's name at render time receives it as
a supplied variable, not as a join.

**Why the existing columns stay.** The spec's Assumptions say "existing offer and appointment letter
behaviour in Recruitment continues unchanged; this feature extends the mechanism rather than
replacing it." Dropping `employeeId`/`candidateId` in favour of the opaque pair would be a rewrite of
working behaviour for tidiness, and would silently change what Recruitment's existing queries return.
Two addressing forms is the cost of not breaking a shipped feature; the check constraint is what
stops them drifting into ambiguity.

**Alternatives considered.** *Leave `GeneratedLetter` in `recruitment` and add a second model for
commercial letters* — rejected: two letter mechanisms is precisely what FR-010's single kind list and
the spec's "extends rather than replaces" both forbid, and the template builder would have to target
both. *Add a new `documents` schema* — rejected: `shared` already exists for cross-cutting concerns
and a new schema means new RLS plumbing, new grants, and a boundary nobody else observes yet.

---

## §3 — `CompanyDocument` in `settings`; project readiness stays in `projects`

**Decision.** `CompanyDocument` is a new model in the `settings` schema, owned by a new
`src/settings/company-documents/` module. Project document requirements are owned by the existing
projects module and their readiness is exposed through an **exported service method**, never a
cross-schema read.

**Rationale.** `Company` and `DocumentType` are both already in `settings`, and a company's statutory
papers are company configuration in the same sense its GSTIN is. The model copies `EmployeeDocument`
(schema.prisma:2037) field for field — `documentTypeId`, `fileRef`, `documentNumber`, `expiresAt
@db.Date`, `uploadedByUserId`, `uploadedAt`, `@@unique([owner, documentTypeId])`,
`@@index([expiresAt])` — because five other document models already share that shape and a sixth
that differs would be the one people get wrong.

Project documents are a different matter: `ProjectDocument` already exists in `projects` (1466). FR-007
and FR-008 are about *which kinds are required* and *whether a project has them*, which is projects'
own business. The dashboard and the project list read that through a method the projects module
exports.

**What this rules out.** Nothing in `settings` may query `projects.ProjectDocument`, and nothing in
`projects` may query `settings.CompanyDocument`. Where a screen needs both — a readiness summary
across the company and its projects — the composing happens in the controller from two service calls,
not in a query.

---

## §4 — Completeness is computed in one query, never per row

**Decision.** Both FR-003 (which required company kinds are present or missing) and FR-008 (project
document readiness, visible **in the list** without opening each project) are answered by a single
grouped query over the owning module's own table, returning a map keyed by owner id.

**Rationale.** FR-008 names the failure directly: readiness must be visible in the list. The obvious
implementation asks "is this project ready?" once per row, which is an N+1 that only hurts once a
company has enough projects to matter — by which time it is in production.

016 met the identical requirement with `statesOf(actionType, entityIds[], viewer)`, a batch form
beside a single form, and its unit test asserts the query **count** rather than the result, so a
future refactor that reintroduces the N+1 fails a test instead of merely getting slower. The same
shape and the same test discipline apply here:

- `CompanyDocumentsService.completenessFor(companyId)` → one query, returns present/missing kinds.
- `ProjectDocumentsService.readinessFor(projectIds[])` → one query, returns a `Map<projectId, …>`.

**Alternatives considered.** *A denormalised `isReady` column maintained on write* — rejected: it can
drift from the documents it summarises, and the reconciliation machinery 016 needed to detect exactly
that kind of drift is not worth building here when one grouped query is correct by construction.

---

## §5 — The signature is a stored image, bound at issue and frozen with the letter

**Decision.** A `Signatory` row in `settings` holds a named person, their title and a `fileRef` to
their signature graphic. `IssuedLetter` records `signatoryId` **and** the `fileRef` that was actually
applied, copied at issue time.

**Rationale.** Clarified 2026-09-15: the signature is an image, not a DSC. The subtlety is FR-013 —
a previously issued letter must render **as it was issued**, regardless of later changes. If the
letter stored only `signatoryId`, then replacing a signatory's graphic (they left; the scan was
retaken) would retroactively change every letter they ever signed. Storing the `fileRef` that was
applied makes the issued letter immutable in the way FR-013 requires, and FR-016a's "record which
signatory's image was applied" is then literally true rather than approximately.

This mirrors `renderedRef` on the existing model: the rendered artefact is kept, not regenerated.

**Alternatives considered.** *Reference the signatory only* — rejected, breaks FR-013. *Burn the
signature into the PDF and keep nothing* — rejected, FR-016a needs to name the signatory afterwards.

---

## §6 — Aadhaar is excluded structurally, not by documentation

**Decision.** `DocumentType` gains a boolean `isRestricted`. A restricted type is excluded from the
template variable resolver **by the resolver itself**, so a template cannot reference it even if a
template author names it; retrieval goes through a dedicated path that writes an
`AuditEntityType.DOCUMENT_RETRIEVED` entry before returning bytes.

**Rationale.** FR-024 says Aadhaar must never be rendered into a letter. A comment saying so is not
an enforcement mechanism — the next template author has no reason to read it. Making the resolver
refuse restricted types means the rule holds for templates that do not exist yet, which is the only
version of this that survives contact with FR-011's "define a new kind without a code change".

Audit goes through the existing `AuditLogService` (`src/auth/audit-log.service.ts`), which is
**write-only** by a ratified 001 clarification; the entries are read back through feature 004's
Activity Log (`GET /activity-log`, already shipped and guarded by `DASHBOARD`). 017 adds no audit
read surface of its own — 016 T063 established that doing so would contradict that clarification and
duplicate a shipped feature.

**A caveat worth stating.** `isRestricted` on the *type* is a blunt instrument: it restricts the kind,
not the instance. That is the right granularity for Aadhaar, where every instance is equally
regulated. It would be the wrong granularity if some company documents of a given kind were sensitive
and others were not — and if that requirement appears, this is the decision to revisit.

---

## §7 — The `LetterKind` seed runs in a migration, not in `seed.ts`

**Decision.** Seeded kinds are inserted by the migration that creates the table, idempotently
(`ON CONFLICT DO NOTHING` against the uniqueness rules in §1), not by `prisma/seed.ts`.

**Rationale.** This was left open in the first draft of this document and nothing downstream picked
it up — raised as CHK031. It is not a free choice:

- The Phase 5 backfill matches each existing `letterType` enum value to a seeded key. If the seed has
  not run, the backfill matches nothing and `SET NOT NULL` fails. A migration guarantees the ordering;
  `seed.ts` does not.
- `prisma/seed.ts` **wipes** users, punches, enrolments and audit rows, and must never run against
  production. Making a production-critical seed depend on a file that is unsafe to run in production
  would be a trap for whoever deploys this.
- 016 set the precedent for exactly this reason: `20260914103000_seed_live_chains_for_existing_companies`
  exists because pre-existing companies needed chains before the feature could work at all.

**Consequence for tasks.** T027 must be part of the migration sequence, before T029's backfill, and
must be safe to re-apply.

---

## Open items deliberately left to `/speckit-tasks`

- Ordering between the `LetterKind` migration and the `GeneratedLetter` schema move. Both touch the
  same table; whether they are one migration or two is a task-level call, not a design one.
