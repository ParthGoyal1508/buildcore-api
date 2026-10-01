---

description: "Task list for 017 Documents and Letters (backend)"
---

# Tasks: Documents and Letters (backend)

**Input**: Design documents from `specs/017-documents-and-letters-backend/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md) (clarified 2026-09-15),
[research.md](./research.md) (seven decisions), [data-model.md](./data-model.md),
[contracts/documents-and-letters.md](./contracts/documents-and-letters.md),
[quickstart.md](./quickstart.md) (10 passes)

**Tests**: REQUIRED. This repo has jest unit + e2e and real tests are expected for every behavioural
requirement. `npm run lint` is `eslint --fix` **repo-wide** — every lint step below means
`npx eslint <touched files>`, never `npm run lint`.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelisable — different files, no dependency on an incomplete task
- **[Story]**: US1–US7 from spec.md

## Phase ordering, and why it is not story order

The two document stores (US1, US2) are **independent of the letter restructure** and ship first, so
the feature delivers value before the risky part begins.

**Phase 5 is the dangerous one.** Moving `GeneratedLetter` between Prisma schemas is
`ALTER TABLE … SET SCHEMA` on a populated table that Recruitment's shipped offer and appointment
letters ride on. It gets its own phase, its own regression gate, and its own commit — mixing it into
feature work is how a migration failure becomes indistinguishable from a feature bug.

---

## Phase 1: Setup

**Purpose**: configuration and the one schema field everything else keys off

- [X] T001 Create `src/settings/company-documents/` and `src/letters/` module skeletons per plan.md,
      registered in their parent modules but exporting nothing yet
- [X] T002 [P] Add `REQUIRED_COMPANY_DOCUMENT_KINDS` (8 kinds: GST, PF, ESIC, labour licence, PAN,
      TAN, Aadhaar, cancelled cheque) and `REQUIRED_PROJECT_DOCUMENT_KINDS` (6: LOI, work order,
      insurance, mining permission, labour insurance, BOQ) to `src/settings/document-kinds.ts` —
      configuration, not literals in services (Principle III, following `src/approvals/default-chains.ts`)
- [X] T003 [P] Add `documents.expiryReminderLeadDays` to `src/common/configs/config.interface.ts` and
      `config.ts`, using `??` not `||` so an explicitly empty env value means "none" (016's lesson)
- [X] T004 Add `isRestricted Boolean @default(false)` to `model DocumentType` in `prisma/schema.prisma`
      and migrate. Seed `true` for Aadhaar only — this single field is what FR-024 is enforced by
      (research §6). The seed MUST be **idempotent** (`ON CONFLICT DO NOTHING` / guarded update) so
      re-applying the migration cannot flip an operator's later change back (CHK029)

---

## Phase 2: Foundational (blocks every story)

**⚠️ No story work begins until this phase is complete.**

- [X] T005 Add `model CompanyDocument` to `prisma/schema.prisma` in the `settings` schema, copying
      `EmployeeDocument` (~line 2037) field for field, plus `supersedesId String?` self-relation
      (data-model.md)
- [X] T006 Add `model ProjectDocumentRequirement` to the `projects` schema. `documentTypeId` is a
      **bare String, not a foreign key** — resolving it to a name would be a cross-schema read
      (research §3). Add a comment saying so, or a future reader will "fix" the missing relation
- [X] T007 Hand-author the RLS migration for both new tables: `ENABLE` + `FORCE` + a
      `tenant_isolation` policy. Never in `schema.prisma` (Principle IV). Copy the exact shape from
      `prisma/migrations/20260904200001_project_assets_rls_policies/migration.sql`
- [X] T008 Hand-author the partial unique index `CREATE UNIQUE INDEX … ON "settings"."CompanyDocument"
      ("companyId","documentTypeId") WHERE "supersedesId" IS NULL` — Prisma cannot express the
      predicate, and without it FR-006's retain-don't-replace makes "which is current?" ambiguous

**Checkpoint**: both document tables exist, are tenant-isolated, and enforce one-current-per-kind.

---

## Phase 3: US1 — The company's statutory papers (P1) 🎯 MVP

**Goal**: all 8 required kinds stored, retrievable, and the missing ones named.

**Independent test**: upload 7 of 8; `GET /company-documents` names the 8th.

- [X] T009 [P] [US1] DTOs in `src/settings/company-documents/dto/` — upload, list query. Mandatory
      even for small bodies (Principle II)
- [X] T010 [US1] Implement `CompanyDocumentsService.upload()` in
      `src/settings/company-documents/company-documents.service.ts`, storing bytes through the
      existing `StorageService`. **No second storage path** (plan.md)
- [X] T011 [US1] Refuse an upload of an expiring kind with no `expiresAt`, code
      `DOCUMENT_EXPIRY_REQUIRED` (FR-004)
- [X] T012 [US1] Implement `completenessFor(companyId)` returning present / missing / expiringSoon —
      **one query** (research §4, contract Part 1)
- [X] T013 [US1] Implement supersede-on-replace: the previous document is retained, not deleted —
      **including its stored file**, not merely its row (FR-006)
- [X] T013a [US1] Implement the restricted-kind purge: superseded versions of a restricted document
      kind are removed, row and blob, once `documents.restrictedRetentionDays` has elapsed (FR-006a).
      Add that setting to `config.ts` beside the expiry lead time. FR-006's retain-indefinitely rule is
      correct for a GST certificate and a growing liability for an Aadhaar scan (CHK018)
- [X] T014 [US1] Implement `CompanyDocumentsController` per contract Part 2, guarded by
      `COMPANY_SETTINGS`
- [X] T015 [US1] Audit-log every download **before** bytes are returned, through the existing
      write-only `AuditLogService`. Add **no** audit read endpoint — 016 T063 established that
      reading is feature 004's Activity Log (research §6)
- [X] T016 [P] [US1] Unit-test `completenessFor` and assert the **query count is 1**, not merely the
      result. Precedent: the Pass 9 block in `src/approvals/approvals.service.spec.ts`. A result-only
      test passes an N+1
- [X] T017 [P] [US1] Unit-test that superseding retains the old row and leaves exactly one current
- [X] T018 [US1] e2e in `test/company-documents.e2e-spec.ts`: upload 7 of 8, assert the 8th is named;
      assert `DOCUMENT_EXPIRY_REQUIRED`; assert a non-permitted caller is refused (FR-023)

**Checkpoint**: US1 ships alone. Quickstart Passes 1–3 pass.

---

## Phase 4: US2 — A project cannot start half-documented (P1)

**Goal**: required project kinds configurable, readiness visible in the **list**.

- [X] T019 [P] [US2] DTOs for requirement configuration in `src/projects/documents/dto/`
- [X] T020 [US2] Implement requirement CRUD in `src/projects/documents/project-documents.service.ts`,
      guarded by `SETTINGS` for writes and `PROJECTS` for reads
- [X] T021 [US2] Implement `readinessFor(companyId, projectIds[])` returning a `Map` — **one query**
      for the whole list (research §4). The single-project form may exist beside it but the list must
      not use it
- [X] T022 [US2] Export `readinessFor` from the projects module so the dashboard reads it through a
      service method, never by querying `projects.ProjectDocumentRequirement` (Principle I)
- [X] T023 [US2] Allow a project to be created with documents incomplete (FR-009) — readiness is
      reported, never enforced at creation
- [X] T024 [P] [US2] Unit-test `readinessFor` with 50 projects and assert the **query count is 1**
- [X] T025 [US2] e2e in `test/project-documents.e2e-spec.ts`: readiness in the list, a project created
      incomplete, and requirement configuration refused without `SETTINGS`

**Checkpoint**: both document stores are done. **This is a sensible place to stop and deploy.**

---

## Phase 5: The letter restructure ⚠️ RISKIEST PHASE — own commit, own gate

**Purpose**: make letters able to address a vendor without `recruitment` learning about `partners`.

**Nothing in this phase adds a feature.** It is structural, it touches shipped behaviour, and it must
be verified as a regression before any letter story builds on it.

- [X] T026 Add `model LetterKind` to the `settings` schema per data-model.md — `companyId String?`
      (nullable = product-shipped), `key`, `label`, `requiresSignature`, `requiresApproval`,
      `approvalActionType`, with `@@unique([companyId, key])`
- [X] T026a Hand-author `CREATE UNIQUE INDEX "LetterKind_shipped_key" ON "settings"."LetterKind"("key")
      WHERE "companyId" IS NULL`. **Without this the composite unique is not enough**: Postgres treats
      NULLs as distinct, so two product-shipped kinds could share a key and T029's backfill would have
      two candidate rows to match (CHK014, data-model.md)
- [X] T026b Enforce FR-011a in `src/settings/letter-kinds/` — a company-defined kind may not reuse a
      product-shipped key, code `LETTER_KIND_KEY_RESERVED`. Unit-test it. Two kinds answering to one
      key leave every lookup ambiguous with no stated precedence
- [X] T027 Seed the 5 existing `LetterType` values as `LetterKind` rows with keys **byte-identical** to
      the enum values, plus the 10 FR-010 adds. Seed the 3 commercial kinds with
      `requiresApproval: true` and `approvalActionType` matching `ACTION_LETTER_WORK_ORDER` / `_LOI` /
      `_PURCHASE_ORDER`. **This runs inside the migration, not `prisma/seed.ts`** (research §7):
      T029's backfill depends on it having run, and `seed.ts` wipes data and must never touch
      production. Must be safe to re-apply
- [X] T028 Migration step 1 — add **nullable** `letterKindId` to `LetterTemplate` and
      `GeneratedLetter`. Prisma cannot add a required column to a populated table (research §1)
- [X] T029 Migration step 2 — backfill `letterKindId` by matching the existing `letterType` enum value
      to the seeded key, then `SET NOT NULL` and add the foreign key with `onDelete: Restrict`
- [X] T030 Migration step 3 — drop the `letterType` column and `enum LetterType`
- [X] T031 Move `GeneratedLetter` from `recruitment` to `shared` and rename to `IssuedLetter`:
      `ALTER TABLE "recruitment"."GeneratedLetter" SET SCHEMA "shared"` plus the rename, and
      regenerate the Prisma client (research §2)
- [X] T032 Add `subjectType String?` / `subjectId String?` to `IssuedLetter`, plus `signatoryId`,
      `appliedSignatureRef`, `countersignedRef`, `countersignedAt`. Keep `employeeId` / `candidateId`
      untouched so Recruitment's behaviour does not change
- [X] T033 Hand-author the CHECK constraint enforcing **exactly one addressing form** per row
      (data-model.md). Without it "who is this letter for?" stops having one answer
- [X] T034 Hand-author RLS for `LetterKind`, `Signatory` and `IssuedLetter`. `LetterKind` needs the
      `ReminderRule` variant that also admits `"companyId" IS NULL`
- [X] T035 **REGRESSION GATE** — run the full existing suite and confirm Recruitment's offer and
      appointment letters still issue, render and list exactly as before. If anything here fails, the
      move is wrong; do not proceed into Phase 6 with it red
- [X] T036 [P] Unit-test that every `LetterKind.approvalActionType` string **equals** a constant
      exported from `src/approvals/default-chains.ts`. Two files agreeing today is not a guarantee
      they agree after the next edit
- [X] T037 e2e: prove the CHECK constraint refuses a row with both addressing forms and a row with
      neither

**Checkpoint**: letters can address anything, Recruitment is unbroken, and the enum is gone.

---

## Phase 6: US3 — Fifteen kinds, drafted once, issued many times (P1)

- [X] T038 [P] [US3] DTOs for issue and reissue in `src/letters/dto/`
- [X] T039 [US3] Implement `template-resolver.ts` — resolves variables for a kind, and **refuses any
      restricted `DocumentType` structurally** so the rule holds for kinds nobody has defined yet
      (research §6). Code `DOCUMENT_TYPE_RESTRICTED`
- [X] T040 [US3] Implement `LettersService.issue()` in `src/letters/letters.service.ts` per contract
      Part 1, rendering through the existing storage path
- [X] T041 [US3] Gate issue on 016: when the kind's `requiresApproval` is true, call
      `ApprovalService.assertMayTakeEffect`. **Do not reimplement the check** (FR-015a) — reuse 016's
      `APPROVAL_NOT_COMPLETE` code rather than inventing one
- [X] T042 [US3] Implement `reissue()` — supersede, never overwrite; both versions stay retrievable
      (FR-014)
- [X] T043 [US3] Implement `LettersController` per contract Part 2. There is **no single `LETTERS`
      permission** — the guard resolves per kind, for the same reason 016 has no `APPROVALS`
      permission
- [X] T044 [P] [US3] Unit-test that the resolver refuses a restricted type **for a letter kind created
      at test time**, not only for the seeded ones
- [X] T045 [P] [US3] Unit-test that `issue()` calls `assertMayTakeEffect` for gated kinds and does not
      for ungated ones
- [X] T046 [US3] e2e in `test/letters.e2e-spec.ts`: a work order refused `409 APPROVAL_NOT_COMPLETE`
      while its chain is pending, then issued after the director approves

---

## Phase 7: US5 — New kinds without a developer (P2)

- [X] T047 [P] [US5] DTOs for letter-kind and template CRUD
- [X] T048 [US5] Implement letter-kind CRUD in `src/settings/letter-kinds/`, guarded by `SETTINGS`
- [X] T049 [US5] Refuse deleting a kind while issued letters reference it — `409 LETTER_KIND_IN_USE`.
      The FK `onDelete: Restrict` is the real guard; the service check is the legible message
- [X] T050 [US5] Point `LetterTemplate` CRUD at `letterKindId` instead of the dropped enum
- [X] T051 [P] [US5] e2e: define a brand-new kind **without a code change**, issue a letter of it, then
      fail to delete the kind

---

## Phase 8: US4 — Signed, and the signed copy comes back (P2)

- [X] T052 [P] [US4] Add `model Signatory` to the `settings` schema and its DTOs
- [X] T053 [US4] Implement signatory CRUD with signature-image upload through `StorageService`
- [X] T054 [US4] Apply the signature at issue for kinds with `requiresSignature`, and record **both**
      `signatoryId` and `appliedSignatureRef` — the graphic as applied (research §5)
- [X] T055 [US4] Implement countersigned-copy upload (FR-017) and the issued-vs-executed distinction
      (FR-018)
- [X] T056 [P] [US4] Unit-test FR-013 directly: issue with signatory A, **replace A's graphic**,
      re-render the original letter, assert it still carries the signature as applied. This is the
      test that catches a `signatoryId`-only implementation
- [X] T057 [US4] e2e: issue → download → upload countersigned → confirm both remain distinguishable

---

## Phase 9: US7 — Proof that the money moved (P2)

- [X] T058 [P] [US7] Add a payment-proof attachment to the existing payment record, through
      `StorageService`
- [X] T059 [US7] Report which payments lack a proof (FR-021)
- [X] T060 [P] [US7] e2e: attach a proof, list payments missing one

---

## Phase 10: US6 — Letters where the work is (P3)

- [X] T061 [US6] Implement `GET /letters?subjectType=&subjectId=` — returns the opaque pair,
      **never resolves it** into a vendor or project (research §2)
- [X] T062 [US6] Expose a service method so project and candidate screens list their letters through
      the letters module rather than querying `shared.IssuedLetter` (Principle I)
- [X] T063 [P] [US6] e2e: letters listed for a project and for a candidate

---

## Phase 11: Reminders, boundaries and verification

- [X] T064 Implement the company-document expiry rule with `@ReminderRule()` in
      `src/settings/company-documents/company-document.reminder-rule.ts`, **replacing** the relevant
      placeholder in `src/dashboard/reminders/unbuilt-module.rules.ts` rather than adding a parallel
      rule (FR-005)
- [X] T065 [P] Boundary test in `src/letters/letters-boundary.spec.ts`, copying
      `src/approvals/spine-boundary.spec.ts`. **Both directions**: `src/letters/` must not query
      `partners` / `projects` / `inventory` tables, and no business module may query
      `shared.IssuedLetter`
- [X] T066 Prove the boundary by breaking it in both directions, confirming T065 fails each time, then
      reverting. A guard that has never failed has not been shown to work
- [X] T067 RLS e2e in `test/documents-rls.e2e-spec.ts`: create a `NOSUPERUSER NOBYPASSRLS` probe role,
      grant it the five new tables, run **unfiltered** raw SQL, expect zero cross-tenant rows.
      Template: `test/approvals-rls.e2e-spec.ts`
- [X] T068 Check T067 for vacuousness — disable the policy, confirm rows **do** appear, restore
      `ENABLE` + `FORCE`. A superuser bypasses RLS unconditionally, which is what made every pre-016
      RLS test in this repo vacuous
- [X] T069 Work quickstart Passes 1–3, 6, 7, 8 (company documents, approval gate, signature freeze,
      kind-in-use)
- [X] T070 Quickstart Pass 4: **50 projects**, count queries against the project-document table,
      expect one. Three projects in development hide an N+1 perfectly
- [X] T071 Quickstart Pass 5: define a **new** letter kind and confirm Aadhaar is still refused. If it
      is not, the restriction was written into the kinds that existed at build time
- [X] T072 Quickstart Passes 9 and 10 (RLS proof, boundary both ways) — these are T065–T068 executed
      as a final gate rather than in isolation
- [X] T073 `npx tsc --noEmit`, `npx eslint <touched files only>`, `npm test`. Report **actual
      numbers**; if something fails, say so with the output rather than summarising it as passing

---

## Dependencies & Execution Order

- **Phase 1 → 2**: setup then tables. Nothing else starts first.
- **Phases 3, 4**: US1 and US2 are independent of each other and of everything after. **Ship here.**
- **Phase 5**: blocks Phases 6–10 entirely. Nothing letter-shaped can be built until the restructure
  is green, and T035 is the gate.
- **Phase 6** blocks 7, 8 and 10 (all need `issue()`); **Phase 9** (US7) depends on nothing in the
  letter chain and can be done any time after Phase 2.
- **Phase 11**: after all desired stories.

### Parallel opportunities

- T002, T003 together; T016, T017 together; T024 alone; T044, T045 together; T052 with T047.
- US1 and US2 can proceed in parallel with different people after Phase 2.
- US7 (Phase 9) can run in parallel with the whole letter chain.

---

## Implementation Strategy

**MVP = Phases 1–3.** Company documents alone answer the question that started this feature: there is
nowhere to put a GST certificate. That ships without touching letters at all.

**Second increment = Phase 4.** Project readiness. Still no structural risk.

**Then stop and decide.** Phase 5 is a schema move on a populated table that shipped behaviour rides
on. It is worth doing — leaving `GeneratedLetter` in `recruitment` forces a Principle I violation on
the first commercial letter — but it should begin deliberately, not by momentum from Phase 4.

---

## Notes

- 016's experience, worth carrying: a test that never presses the button reports silent failure with
  complete confidence; a request counter watching the wrong URL reports perfect behaviour and an
  empty screen identically. Where a test asserts an absence, prove the test can see a presence.
- Commit after each phase. Phase 5 gets its own commit regardless.
- Do not push.

### Implementation note — Phases 1–3, 2026-09-15

Shipped: the company statutory document store. 8 required kinds, completeness reported in
one query, renewal retaining its predecessor, permission-gated and audit-logged retrieval,
tenant-isolated at the database.

**Reading the precedent changed two tasks before a line was written.** `DocumentType`
already carries `hasExpiry`, `needsNumber` and `isMandatory`, and is **per company** — so
T002's "required kinds" are `DocumentType.code` values matched across companies, not a new
concept, and T011's expiry rule reads `hasExpiry` rather than inventing a second flag. A
kind the company never defined a type for is reported missing with a null
`documentTypeId`, which is a different problem from "defined but not uploaded" and the
interface has to tell them apart.

**The supersession design was wrong twice before it was right, and both migrations were
rolled back locally rather than patched forward.**

1. First attempt: `supersedesId` pointing *backwards* at the replaced document, with a
   partial unique index `WHERE "supersedesId" IS NULL`. That pins "current" to the
   **oldest** version forever — the first upload is the only row that never replaced
   anything. The index would have been enforcing the opposite of the intent.
2. Second attempt: flip the pointer forward. Correct semantically, but it creates a
   chicken-and-egg on insert — the new row cannot be current until the old one is not, and
   the old one cannot point at a row that does not exist yet. Postgres unique *indexes*
   cannot be deferred, so there is no ordering that satisfies it.
3. What shipped: a state column, `isCurrent`, with the partial index predicated on it.
   Demote, then insert, inside the single transaction `withRlsContext` already opens. This
   is the shape 016 used to guarantee one live approval per item, and it was available the
   whole time.

The data-model.md description of the pointer survived review, the checklist pass, and a
commit before the database refused it. Worth remembering that a constraint reads as
plausible right up until something executes it.

**T008 is proven by the database, not by the service.** The e2e writes straight past the
service with `isCurrent: true` on a kind that already has one, and asserts the unique
violation. A service-level "is there already a current one?" passes a single-threaded test
and loses the race two concurrent uploads create.

**T016 asserts the query count**, not the result — `expect(calls).toEqual(['documentType.findMany'])`.
Eight required kinds, one query. A result-only assertion passes an N+1 happily.

Verification: **861/861 unit** (83 suites, up from 855), **7/7** in
`test/company-documents.e2e-spec.ts`, 94/94 across the neighbouring e2e suites,
`npx tsc --noEmit` clean, `npx eslint` clean on touched files only.

Not done, and not started: Phase 4 (T019–T025, project document readiness) and Phase 5
onward (the `GeneratedLetter` schema move). `ProjectDocumentRequirement` exists as a table
because Phase 2 creates it; nothing reads or writes it yet.

---

## Implementation note — Phase 4 (2026-09-15)

**T019–T025 done. 20 queries became 2, and one schema gap had to be closed first.**

### `ProjectDocument` could not answer the question readiness asks

`ProjectDocumentRequirement.documentTypeId` holds a `settings.DocumentType.id`, but the document
table it had to be matched against carried only `documentType String` — free text, no vocabulary,
written by nothing (008 created the table and never built its endpoints). Two people typing
"Work Order" and "work order" would have been filing against different kinds, and readiness would
have quietly disagreed with itself.

So Phase 4 adds `ProjectDocument.documentTypeId String?` (migration
`20260915163715_project_document_type_link`, an additive nullable column and one index). Nullable is
load-bearing rather than lenient: **null is what "supplementary" means** — US2 acceptance scenario 5
requires a document answering no required kind to be accepted and filed, and a second boolean saying
the same thing would be a flag that could contradict the column beside it. This is scope Phase 4 did
not name, and without it T021 has nothing to join on.

### T021/T024 ship **two** constant queries, not one — deliberately

The task says one. The implementation is the required set, then the documents held against it across
the whole page: two statements, and the test asserts the call list is **identical for 1 project and
for 50** rather than merely short.

Collapsing them to one would take hand-written SQL, and `grep -rn '\$queryRaw' src/` returns nothing
— this repository has no raw SQL anywhere. Introducing its first instance to save one constant query
is the worse trade. The invariant the requirement protects is O(1) in projects, and quickstart Pass 4
states it operationally ("count queries against the project-document table: expect one"), which the
implementation meets exactly. *Identical for 1 and for 50* is also the stronger assertion: `=== 1`
passes a version that grows, as long as it starts at one.

### The vacuous pass readiness would otherwise have reported

A company that has configured no requirements would report **every project complete** — a readiness
figure that is vacuously true, which is worse than no figure because it looks like an answer. So
`readinessFor` falls back to the six FR-007 shipped kinds when the configured set is empty, resolved
through `DocumentTypesService.listForCompany` (an exported service method — `DocumentType` is in
`settings` and Principle I forbids reading it directly).

It falls back only when the set is **empty**, never when it holds no mandatory rows: a company that
deliberately marked every requirement optional has configured something, and the defaults overriding
that would silently undo their decision. Both branches are unit-tested, because the difference
between them is invisible in the result.

### Route order is a real trap, so the e2e proves it

`GET /projects/document-requirements` is a literal path that `ProjectsController`'s `GET /projects/:id`
will swallow — Nest matches in controller-registration order. The failure is not an error but a
plausible-looking *"project document-requirements not found"*: a routing fault wearing a data fault's
clothes. `ProjectDocumentsController` is registered first in `projects.module.ts`, and the e2e asserts
it rather than trusting the comment that says so.

### Verified

- **874/874 unit tests, 84 suites** (up from 861/83) — 13 new in `project-documents.service.spec.ts`
- **8/8** in the new `test/project-documents.e2e-spec.ts`; 36/36 across projects + both document suites
- `npx tsc --noEmit` clean; `npx eslint` clean on touched files (never `npm run lint`)
- One transient e2e failure appeared in a single combined run and did not reproduce in five more.
  Rather than shrug at it, both document e2e specs now salt their fixture names with a random tail as
  well as the clock — suites run in parallel against one database, and two entering `unique()` in the
  same millisecond would collide on a name a unique index protects.
- **Not caused here**: `plant`, `assets` and `dashboard` e2e fail on this machine (37 tests) against
  local database state — the QA seed roles are absent and the migration-seeded master categories are
  short (6 of 10). `dashboard` was confirmed to fail identically with every Phase 4 change stashed.

Phase 5 onward is untouched. `ProjectDocument` has a readiness key now; nothing writes it yet, because
the upload endpoint belongs to 008's unbuilt US8.

---

## Phase 12: Amendment of 2026-09-16 — FR-001a, FR-003a, FR-025

Gaps between what this spec required and what shipped, found during manual verification. No new
table, no migration, no data movement. See `plan.md` § Amendment for D1–D4.

**Independent test**: as a cross-company caller, name a company, file a document of a kind outside
the required eight, confirm it is listed and the completeness count is unmoved; then materialise a
required kind that has no type and upload against it.

### FR-001a — a supplementary document is stored *and visible*

- [X] T077 [US1] Remove the `code: { in: REQUIRED_COMPANY_DOCUMENT_CODES }` filter from
  `completenessFor()` in `src/settings/company-documents/company-documents.service.ts` and partition
  the result in memory into `present` / `missing` / `supplementary`. `present` and `missing` keep
  measuring the required eight **only** — a supplementary document must not be able to move a
  compliance figure (D2).
- [X] T078 [US1] Add `supplementary: CompanyDocumentView[]` to `CompanyDocumentCompleteness` and to
  the contract in `contracts/documents-and-letters.md`.
- [X] T079 [P] [US1] Unit test: a company holding one required and one non-required document reports
  the first in `present`, the second in `supplementary`, and a completeness count of 1 — not 2.
- [X] T080 [US1] **Extend T016's query-count assertion** rather than writing a second test: assert
  the statement count is still exactly one when supplementary types exist. "One query" is the
  property most likely to rot here, and a result-only test passes an N+1 happily (research §4).
- [X] T081 [P] [US1] e2e in `test/company-documents.e2e-spec.ts`: upload against a non-required type
  and confirm it comes back in `supplementary` — the regression that proves the stored-and-invisible
  bug is gone.

### FR-003a — materialise a required kind that has no type

- [X] T082 [US1] Add `POST /company-documents/required-kinds/:code` to
  `src/settings/company-documents/company-documents.controller.ts`, guarded by the controller's
  existing `COMPANY_SETTINGS`. Name, flags and label come from `REQUIRED_COMPANY_DOCUMENT_KINDS`
  (Principle III) — **the request body supplies none of them** (D3).
- [X] T083 [US1] Service method: idempotent (returns the existing type if one is already defined for
  the code), and refuses a code outside `REQUIRED_COMPANY_DOCUMENT_CODES` with a named error code.
- [X] T084 [P] [US1] Unit test proving the refusal — **this is the test that matters**: a caller
  holding `COMPANY_SETTINGS` but not `EMPLOYEES` must not be able to reach arbitrary document-type
  creation through this route. Assert an unlisted code is refused, and that the created row's name
  and flags come from configuration regardless of what the request contains.
- [X] T085 [P] [US1] e2e: materialise a missing required kind, then upload against it in the same
  session; and calling it twice yields one type, not a unique violation.

### FR-025 — name the company

- [X] T086 Add `@Query('companyId')` and a private `companyIdFor(caller, requested)` to
  `src/settings/company-documents/company-documents.controller.ts`, copied from
  `src/settings/letter-kinds/letter-kinds.controller.ts`. All routes: list, history, upload,
  download, and T082's new one.
- [X] T087 [P] The same for `src/settings/signatories/signatories.controller.ts`, replacing its
  current bare `caller.companyId` guard.
- [X] T088 [P] e2e: a cross-company caller naming company B gets B's documents; naming none is
  refused with 400; a company-scoped caller naming another company does not receive it. The third
  case is the one that would be a data leak if `companyIdFor` were copied wrong.

### Verification

- [X] T089 `npx tsc --noEmit`, `npx eslint <touched files only>`, `npm test`, `npm run test:e2e`.
  Report **actual numbers**; the baseline to beat is 917 unit / 89 suites and 435 e2e / 22 suites.

### FR-001b — a kind of the company's own (added 2026-09-16, after browser verification)

- [X] T090 [US1] `DocumentTypeScope` enum and `DocumentType.scope`, defaulting to `both` — the only
  value that cannot hide an existing row from a screen already showing it.
- [X] T091 [US1] `scopeForCode()` in `src/settings/document-kinds.ts`: ONE rule, shared by the
  migration backfill, the required-kind materialiser, both seeders and the demo seed.
- [X] T092 [US1] Migration `20260916120000_document_type_scope` — column plus a three-statement
  backfill, one file so it is one transaction.
- [X] T093 [P] [US1] `document-type-scope.spec.ts` parses the migration SQL and fails if it stops
  agreeing with `scopeForCode()`. Asserts the code COUNT first, so a regex that stopped matching
  cannot pass over three empty lists.
- [X] T094 [US1] Scope the two read paths: Employee Setup lists `employee|both`, `availableKinds`
  lists `company|both`.
- [X] T095 [US1] `POST /company-documents/types` under `COMPANY_SETTINGS` — always company-scoped,
  code derived from the name, `isRestricted` never from the request.
- [X] T096 [P] [US1] e2e: the created kind is offerable immediately AND absent from the employee
  master. The second half is the one that would be a silent authorization hole.
- [X] T097 [US1] Set scope at creation in `DocumentTypesService.seedDefaultsForCompany` and the demo
  seed, with a unit test. **Found by reseeding and reading the result**: the migration backfill only
  reaches rows that existed when it ran, so without this every company created afterwards got its
  seventeen employee defaults listed in Company Documents beside the GST certificate.

### FR-007a — the requirement surface reports what may be required (2026-09-16, second amendment)

- [X] T098 [US2] Move the declared-kind creation into
  `DocumentTypesService.defineDeclaredKind(ctx, companyId, kind, actor)` — it owns
  `settings.DocumentType`. Takes an already-resolved `RequiredDocumentKind` and does **no code-set
  validation of its own**; each caller validates against the set it is entitled to (plan D8).

  **Already built; verified 2026-10-01 rather than re-done.** `DocumentTypesService.defineDeclaredKind`
  exists with exactly this signature, takes an already-resolved `RequiredDocumentKind`, and validates
  no code set of its own — confirmed by reading it, not by the comment claiming it.

- [X] T099 [US2] `CompanyDocumentsService.defineRequiredKind` delegates to it, still resolving
  against `REQUIRED_COMPANY_DOCUMENT_KINDS`. Its existing refusal test must pass **unchanged** — if
  it needs editing, the permission boundary moved and that is the bug.

  **Already built; verified 2026-10-01.** `CompanyDocumentsService.defineRequiredKind` resolves
  against `REQUIRED_COMPANY_DOCUMENT_KINDS` and delegates. The condition this task set is the
  interesting part and it holds: the existing refusal test at
  `company-documents.service.spec.ts:451` passes **unedited**, so the permission boundary did not
  move — which is what the task said would be the bug.

- [X] T100 [US2] `listRequirements` returns `availableTypes`, filtered to `company | both` from the
  `scope` already on the rows it fetches. Do NOT add a scope filter to `listForCompany`: `hr`
  resolves employee document types through it and would silently lose rows (plan D5).
- [X] T101 [P] [US2] Unit test: `availableTypes` excludes an employee-scoped kind and includes a
  `both`-scoped one, and `listRequirements` still makes the same number of calls it did before —
  the addition is a mapping over rows already fetched, and a follow-up query is what a later
  "small refactor" would introduce.
- [X] T102 [US2] `POST /projects/document-requirements/kinds/:code` under `Permission.SETTINGS`,
  resolving against `REQUIRED_PROJECT_DOCUMENT_KINDS` and delegating to T098. A code outside that
  set is refused.
- [X] T103 [P] [US2] Unit test for T102's refusal — **the one that matters**: a `SETTINGS` holder
  must not be able to reach the company's declared kinds, or arbitrary type creation, through this
  route. Assert a company-only code (`GST`) is refused here, and that the created row's name, flags
  and scope come from configuration.
- [X] T104 [P] [US2] e2e in `test/project-documents.e2e-spec.ts`: read the set, add a requirement,
  toggle one to optional, remove one, save, read it back; then materialise an undefined project kind
  and confirm it becomes requirable. Include the case the screen depends on — a company running on
  defaults whose first save writes the six rows.
- [X] T105 `npx tsc --noEmit`, `npx eslint <touched files only>`, `npm test`, `npm run test:e2e`.
  Baseline to beat: 933 unit / 90 suites, 445 e2e / 22 suites.

---

## Phase 13: Amendment of 2026-09-16 — client bug review, bug 3 (FR-007b–d, FR-008a, FR-009a–e)

Bug 1 (company documents) produces **no tasks**: FR-001–FR-006 and FR-023 are already built and the
spec needed no change.

Bug 3 is not shaped the way it reads. `ProjectDocumentRequirement.isMandatory` already exists, is
already in the DTO, and already filters readiness — the per-kind strength needs **no migration**. What
does not exist is any endpoint that creates a `ProjectDocument` at all: the model is read by
`readinessFor` and written by nothing. **The gate is the small part; the upload path it gates is the
part that does not exist.** Plan D9–D13 and research §8.

Ordering: the upload path (T106–T112) before the gate (T118–T124), because a gate over a path nobody
can use is untestable. The staging table sits between them.

### The missing upload and list path (plan D9, FR-008a)

- [X] T106 [US2] Add `POST /projects/:projectId/documents` to
  `src/projects/documents/project-documents.controller.ts` under `Permission.PROJECTS` — multipart,
  one file. Register it **after** `projects/document-requirements` and mind `GET /projects/:id`: this
  is the third path under the route-order trap Phase 4 already documents, and `projects.module.ts`
  carries the note.
- [X] T107 [US2] `ProjectDocumentsService.upload` writes a `ProjectDocument`, bytes through
  `src/common/storage/` unchanged. `documentTypeId` **optional** on the request: supplied files
  against a required kind, omitted files supplementary — which is already what null means on the
  column, so this adds no vocabulary.
- [X] T108 [P] [US2] Unit test: a document with no `documentTypeId` is accepted and stored as
  supplementary. This is US2 acceptance scenario 5, which has never been executable because nothing
  created a `ProjectDocument`.
- [X] T109 [US2] Add `GET /projects/:projectId/documents` returning **every** document on the
  project — required and supplementary alike (FR-008a). Do **not** filter by
  `documentTypeId: { in: required }`: that is precisely the filter that made supplementary company
  documents invisible and produced amendment D1. The same mistake is available here.
- [X] T110 [P] [US2] Unit test for T109 asserting a supplementary document is in the list. Name it so
  its purpose survives: this is the D1 regression, one screen over.
- [X] T111 [P] [US2] Extend `test/project-documents.e2e-spec.ts`: upload against a required kind,
  confirm readiness shrinks; upload with no type, confirm it appears in the list and does **not**
  change the readiness figure.
- [X] T112 [US2] Rewrite the `documentTypeId` doc comment on `ProjectDocument` in
  `prisma/schema.prisma` if it still implies nothing writes the column.

### `StagedProjectDocument` (plan D10, research §8)

- [X] T113 [US2] Add `StagedProjectDocument` to `prisma/schema.prisma` in the `projects` schema per
  data-model.md: `companyId`, `documentTypeId?`, `documentType`, `fileRef`, `filePath?`,
  `uploadedBy`, `createdAt`, `@@index([companyId, createdAt])`.
- [X] T114 [US2] Migration: create the table plus `ENABLE` + `FORCE` RLS and a `tenant_isolation`
  policy in hand-authored SQL — never in `schema.prisma`. Additive, so no backfill.
- [X] T115 [P] [US2] RLS proof with the `NOSUPERUSER NOBYPASSRLS` probe role, following 016 and the
  other tables in this feature. A policy asserted rather than proved is the failure this repo already
  decided not to repeat.
- [X] T116 [US2] `POST /projects/document-uploads` under `Permission.PROJECTS` (FR-009b) returning
  `stagedDocumentId`, recording `uploadedBy` from the caller.
- [X] T117 [US2] Staging window in configuration, not a literal (Principle III), beside this
  feature's reminder lead time. Then the sweep: delete rows older than the window **with their
  blobs** (FR-009d). Decide here whether it is a new scheduled rule or a case on the existing reminder
  sweep — research's open item; cheap either way, and the task list is the place it was deferred to.

### The creation gate (plan D11, FR-009, FR-009a, FR-009e)

- [X] T118 [US2] `ProjectDocumentsService.assertMandatoryKindsSatisfied(ctx, companyId, stagedIds)`
  per contracts Part 1. Refuses with `PROJECT_DOCUMENTS_MANDATORY_MISSING` naming each missing kind's
  **label**, never its id — a refusal naming internal identifiers is one the reader cannot act on,
  which is the same argument that produced FR-007a.
- [X] T119 [US2] `CreateProjectDto` gains `stagedDocumentIds: string[]`, validated. `ProjectsService`
  already injects `ProjectDocumentsService` for readiness (`projects.service.ts:166`), so this adds no
  dependency and no cross-schema query.
- [X] T120 [US2] `ProjectsService.create` calls T118 **before** writing anything, then converts staged
  rows to `ProjectDocument` rows and deletes them **inside the same transaction** as the `Project`
  insert (FR-009e). A failed creation must strand neither a project nor a staged row, and must not
  consume a reference that then cannot be retried.
- [X] T121 [US2] Enforce the authorisation of a staged reference (FR-009c, plan D10a): `create`
  refuses a `stagedDocumentId` whose `uploadedBy` is not the calling user, with
  `PROJECT_STAGED_DOCUMENT_UNKNOWN` — **the same code as a nonexistent id**, so the refusal does not
  confirm that another user's staged document exists. `uploadedBy` becomes an authorisation input
  here, not just attribution; the schema comment must say so, because a column read for access control
  needs different care from one read for display.
- [X] T122 [P] [US2] Unit test for T121 — the security test of this amendment: user B cannot consume
  user A's staged reference, and cannot distinguish that refusal from a nonexistent id. Add the
  cross-company case.
- [X] T123 [US2] FR-007d: refuse marking a kind mandatory while the company has no document type for
  it, code `PROJECT_DOCUMENT_KIND_NOT_DEFINED`, with the type definable in place via the existing
  `POST kinds/:code` (T102). The PUT already refuses an unknown type; this is the same refusal at a
  different strength.
- [X] T123a [P] [US2] **FR-007c's permission separation**, which had no task until
  `/speckit-analyze` found it (finding C1). Assert that a caller holding `PROJECTS` but **not**
  `SETTINGS` — a Project Manager who may upload a project's documents — is refused when changing the
  required set or a kind's mandatory marking. This is US2 acceptance scenario 8, and it is the
  assertion standing between the gated party and their own gate. Letter-suffixed to avoid renumbering,
  following T013a and T026a/b.
- [X] T124 [P] [US2] e2e for the gate, following quickstart pass 8: refuse a creation with a mandatory
  kind unattached and **assert no project row exists afterwards** — a gate that refuses the response
  while writing the row is the failure this asserts against. Then stage, create, and confirm the
  project exists, the document is attached, and the staged row is gone.
- [X] T125 [US2] Confirm the gate holds on every path that writes a project, not only the route
  (spec Assumptions, SC-002a). Enumerate the paths — `prisma/seed.ts`, any script, any test helper —
  and state in the task's closing note which were found, so the list is auditable rather than assumed.

### The advisory split (plan D12, FR-007b)

- [X] T126 [US2] `ProjectDocumentReadiness` gains `advisoryRequired`, `advisoryPresent`,
  `advisoryMissingTypeIds`. The existing `required`/`present`/`missingTypeIds` keep counting the
  mandatory set **and only** the mandatory set — that figure is already rendered on the portfolio list
  and must not move.
- [X] T127 [US2] `mandatoryTypeIdsFor` already selects `isMandatory` per row, so both partitions come
  from the query it already runs. Keep it **one statement** for the whole page: research §4 and the
  existing query-count assertion both depend on it.
- [X] T128 [P] [US2] Unit test: advisory kinds appear in the advisory fields and do **not** change
  `required` or `present`; and the query count is still one at 50 projects. The query count is the
  property that would rot silently.
- [X] T129 [US2] Rewrite the `isMandatory` doc comment in `prisma/schema.prisma`. It currently reads
  *"FR-009 lets a project exist before its papers are complete; readiness is reported, never enforced
  at creation"* — which FR-009's reversal makes **false**. Also rewrite the `isMandatory` description
  in `dto/project-document-requirement.dto.ts`, which says an optional kind counts toward nothing;
  after T126 it counts toward the advisory figures.
- [X] T130 [US2] Update the `@Put()` and `@Get()` `@ApiOperation` descriptions in
  `project-documents.controller.ts`. The PUT currently states *"Configuring requirements never blocks
  project creation (FR-009): readiness is reported, not enforced"* — the opposite of what it now does.
  Stale API documentation on the route that implements the reversal is worse than none.

### Verification

- [X] T131 `npx tsc --noEmit`, `npx eslint <touched files only>`, `npm test`, `npm run test:e2e`.
  Baseline to beat: 933 unit / 90 suites, 445 e2e / 22 suites.
- [ ] T132 Walk `checklists/staging-gate.md` and record, per item, whether the requirement it
  questions is now answered. Do **not** tick the boxes — that file is reviewer-owned. CHK043–CHK046
  (staged-upload authorisation) are answered by FR-009b–c and T121–T122; most of the rest are for the
  reviewer to judge.

### Notes on this phase

**What is genuinely new versus what was already there.** `isMandatory` existed and was inert — it
filtered readiness and nothing else. No migration is needed for the strength itself. Three comments
in three files assert the pre-reversal rule and are now false (T112, T129, T130); they are tasks
rather than cleanup because a comment stating the opposite of the code is how the next reader is
misled.

**The staging table is the cost of the word "cannot."** It exists only because FR-009 says no project
is created, which means the documents must exist before the project does. Research §8 records the two
cheaper designs that were rejected — multipart creation, and a draft project. If the client later
accepts a draft project, T113–T117 and T121 are the first things to delete.

**T121 is the security task of this amendment.** A staged reference is a bearer token for stored bytes
with no project to authorise it against. It was missed in the first pass of the plan and found by the
requirements-quality review, which is the reason that review happened.

## Phase 13 implementation record, 2026-09-30

**T106-T131 complete.** T132 is reviewer work on `checklists/staging-gate.md` and is not mine to
tick. `bugs.md` item 3 is closed on the backend.

### The phase was shaped as the tasks predicted

`isMandatory` already existed and needed **no migration**. What did not exist was any endpoint that
created a `ProjectDocument` — the model was read by readiness and written by nothing, so FR-008's
"which documents does this project hold" had only one possible answer. The gate was the small part.

### A boundary violation I caught in my own first draft

`labelsForTypeIds` and `assertTypeExists` queried `settings.DocumentType` directly. That is the
table this module may not read — the same reason `documentTypeId` is a bare string here rather than a
foreign key (Principle I). Both now go through `DocumentTypesService.listForCompany`, as the rest of
the file already did. Caught reading the diff, not by a test, which is worth noting: no test would
have failed.

### T112 needed no change

The `documentTypeId` comment does **not** imply nothing writes the column — it explains why the
column exists and why it is nullable, both still true. The task's condition did not apply.

### T125's audit: three writers, one deliberate bypass

`ProjectsService.create` (gated), its controller (which calls that service), and
`prisma/seed-demo.ts`, which writes through Prisma directly. The seeder is correct to bypass: it
builds a fixture rather than acting for a user, and requiring it to stage a document for every
mandatory kind would make the seed depend on the configuration it exists to describe. The reasoning
is now a comment at that line, so a fourth writer must either use the service or say why not.

### The staged-upload authorisation

`uploadedBy` is checked on use, not merely recorded, and all three failure modes — nonexistent id,
another user's id, another company's id — give **the same code**. A distinct "forbidden" would
confirm the other user's staged document exists, which is exactly what FR-009c forbids. There is a
test asserting the two refusals are indistinguishable in both code and status, because that is the
half that is easy to get wrong.

### A test double that would have proved the opposite of the code

The requirement double in `project-document-gate.spec.ts` initially ignored its `where` clause. The
gate asks only for `isMandatory: true`, so a double returning everything made an advisory kind look
like it blocked a creation — and the test asserting advisory kinds *don't* block was failing against
correct code. The double now honours the clause.

### Three comments that stated the opposite of the code

`isMandatory` in `schema.prisma`, the `@Put()` description, and the `isMandatory` DTO description all
asserted the pre-reversal rule. They were tasks rather than cleanup for a reason: a comment stating
the opposite of the code is how the next reader is misled, and all three sat on the routes that
implement the reversal.
