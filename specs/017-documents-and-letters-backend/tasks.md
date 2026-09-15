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

- [ ] T019 [P] [US2] DTOs for requirement configuration in `src/projects/documents/dto/`
- [ ] T020 [US2] Implement requirement CRUD in `src/projects/documents/project-documents.service.ts`,
      guarded by `SETTINGS` for writes and `PROJECTS` for reads
- [ ] T021 [US2] Implement `readinessFor(companyId, projectIds[])` returning a `Map` — **one query**
      for the whole list (research §4). The single-project form may exist beside it but the list must
      not use it
- [ ] T022 [US2] Export `readinessFor` from the projects module so the dashboard reads it through a
      service method, never by querying `projects.ProjectDocumentRequirement` (Principle I)
- [ ] T023 [US2] Allow a project to be created with documents incomplete (FR-009) — readiness is
      reported, never enforced at creation
- [ ] T024 [P] [US2] Unit-test `readinessFor` with 50 projects and assert the **query count is 1**
- [ ] T025 [US2] e2e in `test/project-documents.e2e-spec.ts`: readiness in the list, a project created
      incomplete, and requirement configuration refused without `SETTINGS`

**Checkpoint**: both document stores are done. **This is a sensible place to stop and deploy.**

---

## Phase 5: The letter restructure ⚠️ RISKIEST PHASE — own commit, own gate

**Purpose**: make letters able to address a vendor without `recruitment` learning about `partners`.

**Nothing in this phase adds a feature.** It is structural, it touches shipped behaviour, and it must
be verified as a regression before any letter story builds on it.

- [ ] T026 Add `model LetterKind` to the `settings` schema per data-model.md — `companyId String?`
      (nullable = product-shipped), `key`, `label`, `requiresSignature`, `requiresApproval`,
      `approvalActionType`, with `@@unique([companyId, key])`
- [ ] T026a Hand-author `CREATE UNIQUE INDEX "LetterKind_shipped_key" ON "settings"."LetterKind"("key")
      WHERE "companyId" IS NULL`. **Without this the composite unique is not enough**: Postgres treats
      NULLs as distinct, so two product-shipped kinds could share a key and T029's backfill would have
      two candidate rows to match (CHK014, data-model.md)
- [ ] T026b Enforce FR-011a in `src/settings/letter-kinds/` — a company-defined kind may not reuse a
      product-shipped key, code `LETTER_KIND_KEY_RESERVED`. Unit-test it. Two kinds answering to one
      key leave every lookup ambiguous with no stated precedence
- [ ] T027 Seed the 5 existing `LetterType` values as `LetterKind` rows with keys **byte-identical** to
      the enum values, plus the 10 FR-010 adds. Seed the 3 commercial kinds with
      `requiresApproval: true` and `approvalActionType` matching `ACTION_LETTER_WORK_ORDER` / `_LOI` /
      `_PURCHASE_ORDER`. **This runs inside the migration, not `prisma/seed.ts`** (research §7):
      T029's backfill depends on it having run, and `seed.ts` wipes data and must never touch
      production. Must be safe to re-apply
- [ ] T028 Migration step 1 — add **nullable** `letterKindId` to `LetterTemplate` and
      `GeneratedLetter`. Prisma cannot add a required column to a populated table (research §1)
- [ ] T029 Migration step 2 — backfill `letterKindId` by matching the existing `letterType` enum value
      to the seeded key, then `SET NOT NULL` and add the foreign key with `onDelete: Restrict`
- [ ] T030 Migration step 3 — drop the `letterType` column and `enum LetterType`
- [ ] T031 Move `GeneratedLetter` from `recruitment` to `shared` and rename to `IssuedLetter`:
      `ALTER TABLE "recruitment"."GeneratedLetter" SET SCHEMA "shared"` plus the rename, and
      regenerate the Prisma client (research §2)
- [ ] T032 Add `subjectType String?` / `subjectId String?` to `IssuedLetter`, plus `signatoryId`,
      `appliedSignatureRef`, `countersignedRef`, `countersignedAt`. Keep `employeeId` / `candidateId`
      untouched so Recruitment's behaviour does not change
- [ ] T033 Hand-author the CHECK constraint enforcing **exactly one addressing form** per row
      (data-model.md). Without it "who is this letter for?" stops having one answer
- [ ] T034 Hand-author RLS for `LetterKind`, `Signatory` and `IssuedLetter`. `LetterKind` needs the
      `ReminderRule` variant that also admits `"companyId" IS NULL`
- [ ] T035 **REGRESSION GATE** — run the full existing suite and confirm Recruitment's offer and
      appointment letters still issue, render and list exactly as before. If anything here fails, the
      move is wrong; do not proceed into Phase 6 with it red
- [ ] T036 [P] Unit-test that every `LetterKind.approvalActionType` string **equals** a constant
      exported from `src/approvals/default-chains.ts`. Two files agreeing today is not a guarantee
      they agree after the next edit
- [ ] T037 e2e: prove the CHECK constraint refuses a row with both addressing forms and a row with
      neither

**Checkpoint**: letters can address anything, Recruitment is unbroken, and the enum is gone.

---

## Phase 6: US3 — Fifteen kinds, drafted once, issued many times (P1)

- [ ] T038 [P] [US3] DTOs for issue and reissue in `src/letters/dto/`
- [ ] T039 [US3] Implement `template-resolver.ts` — resolves variables for a kind, and **refuses any
      restricted `DocumentType` structurally** so the rule holds for kinds nobody has defined yet
      (research §6). Code `DOCUMENT_TYPE_RESTRICTED`
- [ ] T040 [US3] Implement `LettersService.issue()` in `src/letters/letters.service.ts` per contract
      Part 1, rendering through the existing storage path
- [ ] T041 [US3] Gate issue on 016: when the kind's `requiresApproval` is true, call
      `ApprovalService.assertMayTakeEffect`. **Do not reimplement the check** (FR-015a) — reuse 016's
      `APPROVAL_NOT_COMPLETE` code rather than inventing one
- [ ] T042 [US3] Implement `reissue()` — supersede, never overwrite; both versions stay retrievable
      (FR-014)
- [ ] T043 [US3] Implement `LettersController` per contract Part 2. There is **no single `LETTERS`
      permission** — the guard resolves per kind, for the same reason 016 has no `APPROVALS`
      permission
- [ ] T044 [P] [US3] Unit-test that the resolver refuses a restricted type **for a letter kind created
      at test time**, not only for the seeded ones
- [ ] T045 [P] [US3] Unit-test that `issue()` calls `assertMayTakeEffect` for gated kinds and does not
      for ungated ones
- [ ] T046 [US3] e2e in `test/letters.e2e-spec.ts`: a work order refused `409 APPROVAL_NOT_COMPLETE`
      while its chain is pending, then issued after the director approves

---

## Phase 7: US5 — New kinds without a developer (P2)

- [ ] T047 [P] [US5] DTOs for letter-kind and template CRUD
- [ ] T048 [US5] Implement letter-kind CRUD in `src/settings/letter-kinds/`, guarded by `SETTINGS`
- [ ] T049 [US5] Refuse deleting a kind while issued letters reference it — `409 LETTER_KIND_IN_USE`.
      The FK `onDelete: Restrict` is the real guard; the service check is the legible message
- [ ] T050 [US5] Point `LetterTemplate` CRUD at `letterKindId` instead of the dropped enum
- [ ] T051 [P] [US5] e2e: define a brand-new kind **without a code change**, issue a letter of it, then
      fail to delete the kind

---

## Phase 8: US4 — Signed, and the signed copy comes back (P2)

- [ ] T052 [P] [US4] Add `model Signatory` to the `settings` schema and its DTOs
- [ ] T053 [US4] Implement signatory CRUD with signature-image upload through `StorageService`
- [ ] T054 [US4] Apply the signature at issue for kinds with `requiresSignature`, and record **both**
      `signatoryId` and `appliedSignatureRef` — the graphic as applied (research §5)
- [ ] T055 [US4] Implement countersigned-copy upload (FR-017) and the issued-vs-executed distinction
      (FR-018)
- [ ] T056 [P] [US4] Unit-test FR-013 directly: issue with signatory A, **replace A's graphic**,
      re-render the original letter, assert it still carries the signature as applied. This is the
      test that catches a `signatoryId`-only implementation
- [ ] T057 [US4] e2e: issue → download → upload countersigned → confirm both remain distinguishable

---

## Phase 9: US7 — Proof that the money moved (P2)

- [ ] T058 [P] [US7] Add a payment-proof attachment to the existing payment record, through
      `StorageService`
- [ ] T059 [US7] Report which payments lack a proof (FR-021)
- [ ] T060 [P] [US7] e2e: attach a proof, list payments missing one

---

## Phase 10: US6 — Letters where the work is (P3)

- [ ] T061 [US6] Implement `GET /letters?subjectType=&subjectId=` — returns the opaque pair,
      **never resolves it** into a vendor or project (research §2)
- [ ] T062 [US6] Expose a service method so project and candidate screens list their letters through
      the letters module rather than querying `shared.IssuedLetter` (Principle I)
- [ ] T063 [P] [US6] e2e: letters listed for a project and for a candidate

---

## Phase 11: Reminders, boundaries and verification

- [ ] T064 Implement the company-document expiry rule with `@ReminderRule()` in
      `src/settings/company-documents/company-document.reminder-rule.ts`, **replacing** the relevant
      placeholder in `src/dashboard/reminders/unbuilt-module.rules.ts` rather than adding a parallel
      rule (FR-005)
- [ ] T065 [P] Boundary test in `src/letters/letters-boundary.spec.ts`, copying
      `src/approvals/spine-boundary.spec.ts`. **Both directions**: `src/letters/` must not query
      `partners` / `projects` / `inventory` tables, and no business module may query
      `shared.IssuedLetter`
- [ ] T066 Prove the boundary by breaking it in both directions, confirming T065 fails each time, then
      reverting. A guard that has never failed has not been shown to work
- [ ] T067 RLS e2e in `test/documents-rls.e2e-spec.ts`: create a `NOSUPERUSER NOBYPASSRLS` probe role,
      grant it the five new tables, run **unfiltered** raw SQL, expect zero cross-tenant rows.
      Template: `test/approvals-rls.e2e-spec.ts`
- [ ] T068 Check T067 for vacuousness — disable the policy, confirm rows **do** appear, restore
      `ENABLE` + `FORCE`. A superuser bypasses RLS unconditionally, which is what made every pre-016
      RLS test in this repo vacuous
- [ ] T069 Work quickstart Passes 1–3, 6, 7, 8 (company documents, approval gate, signature freeze,
      kind-in-use)
- [ ] T070 Quickstart Pass 4: **50 projects**, count queries against the project-document table,
      expect one. Three projects in development hide an N+1 perfectly
- [ ] T071 Quickstart Pass 5: define a **new** letter kind and confirm Aadhaar is still refused. If it
      is not, the restriction was written into the kinds that existed at build time
- [ ] T072 Quickstart Passes 9 and 10 (RLS proof, boundary both ways) — these are T065–T068 executed
      as a final gate rather than in isolation
- [ ] T073 `npx tsc --noEmit`, `npx eslint <touched files only>`, `npm test`. Report **actual
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
