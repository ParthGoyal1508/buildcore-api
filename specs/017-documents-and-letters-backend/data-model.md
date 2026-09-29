# Data Model: Documents and Letters (017, backend)

**Date**: 2026-09-15 · Decisions behind these shapes: [research.md](./research.md)

Five new models, two changed, one enum removed. Schema placement is not cosmetic here — it is what
keeps Principle I true — so each model states its schema and why.

---

## New: `CompanyDocument` — `settings`

The company's statutory papers. Deliberately a field-for-field copy of `EmployeeDocument`
(schema.prisma:2037), because five document models already share that shape.

| Field | Type | Notes |
|---|---|---|
| `id` | `String @id @default(cuid())` | |
| `companyId` | `String` | → `Company`, `onDelete: Cascade` |
| `documentTypeId` | `String` | → `DocumentType` (the existing `settings` master) |
| `fileRef` | `String` | Opaque key into `StorageService`. Never a path the client supplies. |
| `documentNumber` | `String?` | The GSTIN/PAN/TAN itself, when the document carries one. |
| `expiresAt` | `DateTime? @db.Date` | Required for kinds that expire (FR-004, enforced in service) |
| `supersedesId` | `String?` | Self-relation. FR-006: retain, never replace. |
| `uploadedByUserId` | `String` | |
| `uploadedAt` | `DateTime @default(now())` | |

**Indexes**: `@@unique([companyId, documentTypeId, supersedesId])` — a company holds one *current*
document per kind, with superseded ones retained beside it. `@@index([expiresAt])` for the reminder
sweep. `@@schema("settings")`.

> **Why the unique includes `supersedesId`.** A plain `@@unique([companyId, documentTypeId])` would
> make FR-006 impossible — uploading a renewed GST certificate would have to delete the old one.
> Including the supersession pointer lets exactly one row have `supersedesId = NULL` (the current
> one) while the history stacks behind it. This is the same reasoning behind 016's partial unique
> index on live approval instances; if Postgres-level enforcement of "exactly one current" is wanted,
> that becomes a partial unique index `WHERE "supersedesId" IS NULL`, hand-authored.

---

## New: `ProjectDocumentRequirement` — `projects`

Which document kinds a project must have. FR-007 names six: LOI, work order, insurance, mining
permission, labour insurance, BOQ.

| Field | Type | Notes |
|---|---|---|
| `id` | `String @id @default(cuid())` | |
| `companyId` | `String` | Requirements are per company, not global |
| `documentTypeId` | `String` | **Not** an FK — `DocumentType` is in `settings` |
| `isMandatory` | `Boolean @default(true)` | **The strength FR-007b asks for, already here.** True = mandatory, refuses project creation (FR-009). False = advisory, reported outstanding, never blocking |

> **The `documentTypeId` is a bare string on purpose.** A foreign key from `projects` into
> `settings.DocumentType` is declared data and would be permitted, but resolving it to a *name* for
> display is a cross-schema read, which Principle I forbids. The projects module therefore receives
> type names from the settings module through an exported method and joins them in memory. Recording
> this here because a future reader will otherwise "fix" the missing relation.

**Indexes**: `@@unique([companyId, documentTypeId])`, `@@schema("projects")`.

> **Amended 2026-09-16 (bug 3).** `isMandatory` shipped inert: it filtered readiness and nothing
> else, and the column comment in `schema.prisma` still says "readiness is reported, never enforced
> at creation" — which FR-009's reversal makes false. **That comment must be rewritten with the
> enforcement, not left to contradict the behaviour.** No migration: the column, its default and its
> DTO field all already exist, which is the one piece of luck in this bug.
>
> The meaning of `false` does change. It used to mean *counted toward nothing*; it now means
> *advisory — reported outstanding, never blocking*. See plan D12 for why that is served by new
> fields on the readiness shape rather than by widening the two that shipped.

---

## New: `StagedProjectDocument` — `projects`

A document uploaded *before* the project it belongs to exists. Added 2026-09-16 by bug 3: FR-009
requires mandatory documents to arrive with the creation request and no project to be created
without them, and `POST /projects` is a JSON endpoint while a document is a file. Plan D10 records
the two cheaper bridges and why both were rejected.

| Field | Type | Notes |
|---|---|---|
| `id` | `String @id @default(cuid())` | This is the `stagedDocumentId` the client holds |
| `companyId` | `String` | |
| `documentTypeId` | `String?` | Null = supplementary, exactly as on `ProjectDocument` |
| `documentType` | `String` | The free-text label, carried through to the created row |
| `fileRef` | `String` | The blob in `common/storage`, unchanged mechanism |
| `filePath` | `String?` | |
| `uploadedBy` | `String` | Who staged it. **An authorisation input, not just attribution** (FR-009c, plan D10a): `create` refuses a reference whose `uploadedBy` is not the calling user. Never make this nullable |
| `createdAt` | `DateTime @default(now())` | What the sweep measures |

**Indexes**: `@@index([companyId, createdAt])` — the sweep's access path, and the only query that
reads the table in bulk. `@@schema("projects")`.

**Lifecycle**: created by `POST /projects/document-uploads`; consumed and deleted by
`ProjectsService.create` in the same transaction that writes the `ProjectDocument` rows and the
`Project`; otherwise deleted with its blob by the scheduled sweep once older than the configured
staging window. A row consumed by a creation is never left behind — the delete is in the
transaction, so a failed creation strands neither a project nor a staged row.

> **This table is the cost of bug 3.** It exists only because the gate must refuse *before* a project
> row exists. If the client ever accepts a draft project instead, this table and its sweep are the
> first things to delete.

---

## Changed: `ProjectDocumentReadiness` (shape, not a table)

Amended 2026-09-16. The three shipped fields keep counting the mandatory set and only the mandatory
set, so the figure already on the portfolio list does not move. Three fields are added for the
advisory half (plan D12):

| Field | Meaning |
|---|---|
| `required`, `present`, `missingTypeIds` | **Unchanged** — mandatory kinds only |
| `advisoryRequired`, `advisoryPresent`, `advisoryMissingTypeIds` | The advisory half, reported outstanding and never blocking |

---

## New: `LetterKind` — `settings`

Replaces `enum LetterType` (research §1). A kind is a row so that FR-011 (new kinds without a code
change) and FR-022 (refuse deletion while referenced) are both structural.

| Field | Type | Notes |
|---|---|---|
| `id` | `String @id @default(cuid())` | |
| `companyId` | `String?` | **Nullable.** `NULL` = a kind this product ships for everyone; a value = one company defined it. Same nullable-tenant pattern as `ReminderRule`. |
| `key` | `String` | Stable identifier — `offer`, `letter_work_order`. What code and the 016 action types match on. |
| `label` | `String` | What a human sees. Editable; `key` is not. |
| `requiresSignature` | `Boolean @default(false)` | FR-016: signature application is per kind |
| `requiresApproval` | `Boolean @default(false)` | FR-015a: true for work order, LOI, purchase order |
| `approvalActionType` | `String?` | The 016 action type to gate on — `letter_work_order` etc. |
| `isActive` | `Boolean @default(true)` | |

**Indexes**: `@@unique([companyId, key])` for company-authored kinds, plus a **hand-authored partial
unique index** for product-shipped ones, and `@@schema("settings")`:

```sql
CREATE UNIQUE INDEX "LetterKind_shipped_key" ON "settings"."LetterKind"("key")
  WHERE "companyId" IS NULL;
```

> **Why the composite unique is not enough on its own** (raised as CHK014, and a real defect in the
> first draft of this document). Postgres treats NULLs as **distinct** in a unique index, so
> `@@unique([companyId, key])` permits two rows of `(NULL, 'offer')` — two product-shipped kinds
> sharing a key, which makes the Phase 5 backfill's "match the enum value to the seeded key"
> ambiguous and therefore unsafe.
>
> The nullable-tenant precedent this model cited, `ReminderRule`, sidesteps the problem by making
> `ruleKey` **globally** unique (`20260903152658_reminders_engine/migration.sql:57`). That answer does
> not transfer: reminder rules are declared in code and are global, whereas letter kinds are authored
> by tenants, and a global unique on `key` would stop two different companies each defining a kind
> keyed `site_transfer`. The partial index gives the shipped set its own uniqueness without
> constraining tenants against each other.

**Shadowing is forbidden, so resolution stays unambiguous.** A company-authored kind MUST NOT reuse a
product-shipped `key`. Without that rule, resolving `offer` for a company that defined its own
`offer` has two candidate rows and needs a precedence rule nobody has written. Enforced in the
service with `LETTER_KIND_KEY_RESERVED`; see spec FR-011a.

**Seeded rows**: the five existing enum values (`offer`, `appointment`, `confirmation`, `relieving`,
`experience`) plus the ten FR-010 adds. The three commercial kinds are seeded with
`requiresApproval: true` and an `approvalActionType` matching what 016 already declares in
`src/approvals/default-chains.ts` — these strings must agree, and a test should assert they do rather
than trusting two files to stay in step.

---

## New: `Signatory` — `settings`

| Field | Type | Notes |
|---|---|---|
| `id` | `String @id @default(cuid())` | |
| `companyId` | `String` | |
| `name`, `title` | `String` | Printed beneath the signature |
| `signatureRef` | `String` | Storage key for the graphic |
| `isActive` | `Boolean @default(true)` | Someone leaves; their letters stay valid |

`@@schema("settings")`.

---

## Changed: `GeneratedLetter` → `IssuedLetter`, moved `recruitment` → `shared`

The structural change (research §2). Existing columns keep their meaning; the move and the additions
are what let a letter address a vendor without `recruitment` learning about `partners`.

| Field | Change | Notes |
|---|---|---|
| `letterType` | **removed** | Replaced by `letterKindId` |
| `letterKindId` | **new**, FK → `LetterKind`, `onDelete: Restrict` | FR-022 becomes the database's job |
| `employeeId`, `candidateId` | unchanged | Recruitment's behaviour continues untouched |
| `subjectType`, `subjectId` | **new**, both `String?` | Opaque. `vendor`, `project`, `purchase`. **Never dereferenced.** |
| `signatoryId` | **new**, `String?` | Who signed |
| `appliedSignatureRef` | **new**, `String?` | The graphic *as applied*. Frozen — see research §5 |
| `countersignedRef` | **new**, `String?` | FR-017: the executed copy that comes back |
| `countersignedAt` | **new**, `DateTime?` | FR-018 renders "issued" vs "executed" from this |
| `renderedRef`, `version`, `isSuperseded`, `issuedAt`, `issuedBy` | unchanged | |

**Check constraint** (hand-authored, not expressible in Prisma):

```sql
CHECK (
  (("employeeId" IS NOT NULL OR "candidateId" IS NOT NULL) AND "subjectId" IS NULL)
  OR (("employeeId" IS NULL AND "candidateId" IS NULL) AND "subjectId" IS NOT NULL)
)
```

Exactly one addressing form per row. Without it the two forms drift and "who is this letter for?"
stops having one answer.

`@@schema("shared")`.

---

## Changed: `LetterTemplate` — stays in `settings`

`letterType` → `letterKindId` (FK). Everything else unchanged. It does not move: a template is
company configuration and `settings` is where it belongs.

---

## Changed: `DocumentType` — `settings`

One new field: `isRestricted Boolean @default(false)`.

The enforcement point for FR-024. The template variable resolver refuses restricted types
**structurally** (research §6), so no template — including kinds nobody has defined yet — can render
an Aadhaar. Seeded `true` for Aadhaar and nothing else.

---

## Removed: `enum LetterType`

Dropped after the backfill. Five values migrate to `LetterKind` rows keyed identically, so no
behaviour changes for Recruitment.

---

## Row-level security

Every new table — `CompanyDocument`, `ProjectDocumentRequirement`, `LetterKind`, `Signatory`,
`IssuedLetter` — gets, in hand-authored SQL in its own migration:

```sql
ALTER TABLE "<schema>"."<Table>" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "<schema>"."<Table>" FORCE  ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "<schema>"."<Table>"
  USING ("companyId" = current_setting('app.current_company_id', true)
         OR current_setting('app.is_super_admin', true) = 'true');
```

`FORCE` matters: without it the table owner bypasses its own policy. `LetterKind` needs the
`ReminderRule` variant that also admits `"companyId" IS NULL`, since product-shipped kinds belong to
every tenant.

**Proof, not assertion.** 016 established that a Postgres superuser bypasses RLS unconditionally, so
every prior RLS "test" in this repo had been vacuous. The e2e proof must run as a dedicated
`NOSUPERUSER NOBYPASSRLS` role issuing raw unfiltered SQL, and must be checked for vacuousness by
disabling the policy and confirming rows *do* appear. Reuse `test/approvals-rls.e2e-spec.ts` as the
template.
