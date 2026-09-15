# Contract: Documents and Letters (017, backend)

**Date**: 2026-09-15 · Shapes: [data-model.md](../data-model.md) · Decisions: [research.md](../research.md)

Two parts: the service methods other modules may call (Part 1) and the HTTP surface the web half
consumes (Part 2). Part 1 exists because Principle I makes exported service methods the *only* way a
module reaches another module's data — so what is exported is a boundary, not a convenience.

---

## Part 1 — Service methods across module boundaries

### `CompanyDocumentsService` (settings)

```ts
/** Which required kinds this company holds and which it lacks (FR-003). ONE query. */
completenessFor(companyId: string): Promise<{
  requiredKinds: { documentTypeId: string; name: string; isRestricted: boolean }[];
  present: string[];          // documentTypeIds
  missing: string[];          // documentTypeIds
  expiringSoon: { documentTypeId: string; expiresAt: Date }[];
}>;
```

Exported so the dashboard can render KYC completeness without reading `settings.CompanyDocument`
itself. Never takes a `caller`-supplied company id from a query string — the company comes from the
authenticated context (the guarantee `EmployeesService.requireByUserId` documents for `/my/*`).

### `ProjectDocumentsService` (projects)

```ts
/** Readiness for MANY projects at once (FR-008). ONE query. Never call this per row. */
readinessFor(companyId: string, projectIds: string[]): Promise<
  Map<string, { required: number; present: number; missingTypeIds: string[] }>
>;
```

The batch form is the contract. A single-project form may exist beside it, but the project **list**
must use this one — the N+1 it prevents is invisible until a company has enough projects to notice,
and 016 has the precedent (`statesOf`) plus a query-count test to keep it honest.

### `LettersService` (shared)

```ts
/** Issue a letter. Refuses if the kind requires approval and the chain is incomplete (FR-015a). */
issue(input: {
  companyId: string;
  letterKindKey: string;
  subject: { employeeId: string } | { candidateId: string }
         | { subjectType: string; subjectId: string };   // exactly one form
  variables: Record<string, string>;
  signatoryId?: string;
}, caller: AuthenticatedUser): Promise<IssuedLetterView>;

/** FR-014: supersede, never overwrite. Returns the new version; the old remains retrievable. */
reissue(letterId: string, variables: Record<string, string>, caller: AuthenticatedUser): Promise<IssuedLetterView>;
```

`issue()` calls `ApprovalService.assertMayTakeEffect({ actionType, entityType, entityId, companyId })`
when the kind's `requiresApproval` is true. It **must not** re-implement the check: 016 owns that
question and 017 consumes the answer.

---

## Part 2 — HTTP surface

### Company documents

| Method | Path | Guard | Notes |
|---|---|---|---|
| `GET` | `/company-documents` | `COMPANY_SETTINGS` | Current documents plus completeness (FR-003) |
| `POST` | `/company-documents` | `COMPANY_SETTINGS` | Upload. Refuses a kind that expires without `expiresAt` (FR-004) |
| `GET` | `/company-documents/:id/download` | `COMPANY_SETTINGS` | **Audit-logged** before bytes are returned (FR-024) |
| `DELETE` | `/company-documents/:id` | `COMPANY_SETTINGS` | Supersede semantics — never a hard delete (FR-006) |

`GET /company-documents` returns, for each required kind, whether it is present — so the client
renders the missing list without computing it. The missing list is the server's answer, not the
browser's inference.

### Project document requirements

| Method | Path | Guard | Notes |
|---|---|---|---|
| `GET` | `/projects/document-requirements` | `PROJECTS` | The configured required kinds |
| `PUT` | `/projects/document-requirements` | `SETTINGS` | Configure them |
| `GET` | `/projects?include=documentReadiness` | `PROJECTS` | Readiness **in the list** — one query (FR-008) |

### Letter kinds, templates, signatories

| Method | Path | Guard | Notes |
|---|---|---|---|
| `GET`/`POST`/`PUT` | `/letter-kinds` | `SETTINGS` | FR-011: a new kind is data, not a deploy |
| `DELETE` | `/letter-kinds/:id` | `SETTINGS` | `409 LETTER_KIND_IN_USE` while letters reference it (FR-022) |
| `GET`/`POST`/`PUT` | `/signatories` | `SETTINGS` | Signature image upload (FR-016) |

### Letters

| Method | Path | Guard | Notes |
|---|---|---|---|
| `POST` | `/letters` | per kind | Issue. `409 APPROVAL_NOT_COMPLETE` when the chain is unfinished |
| `POST` | `/letters/:id/reissue` | per kind | FR-014 supersede |
| `POST` | `/letters/:id/countersigned` | per kind | Upload the executed copy (FR-017) |
| `GET` | `/letters?subjectType=&subjectId=` | per kind | FR-019: letters where the work is |
| `GET` | `/letters/:id/download` | per kind | Renders as issued (FR-013) |

> **"per kind" is not vagueness.** There is no single `LETTERS` permission, for the same reason 016
> has no `APPROVALS` permission: a work order and a relieving letter are not the same authority. The
> guard resolves from the kind being acted on. The *approval* question is separate again and is
> answered by 016's chain, not by a permission.

### Error codes

Machine-readable, because clients must branch on a stable identifier rather than on prose — the
contract 015 established with `SESSION_EXPIRED` and 016 extended.

| Code | Meaning |
|---|---|
| `DOCUMENT_EXPIRY_REQUIRED` | FR-004: this kind expires; `expiresAt` was absent |
| `DOCUMENT_TYPE_RESTRICTED` | A restricted type was referenced from a template (FR-024) |
| `LETTER_KIND_IN_USE` | FR-022: issued letters still reference this kind |
| `LETTER_SUBJECT_AMBIGUOUS` | Both addressing forms supplied, or neither |
| `APPROVAL_NOT_COMPLETE` | **Reused from 016 unchanged.** Not a new code — the gate is 016's and so is its vocabulary |

---

## What this contract deliberately does not include

- **No audit-log read endpoint.** FR-024's retrieval log is written through the existing write-only
  `AuditLogService` and read through feature 004's `GET /activity-log`, which already buckets
  approval and document entity types. 016 T063 established that adding a parallel read surface would
  contradict a ratified 001 clarification and duplicate a shipped feature.
- **No second approval gate.** `requiresApproval` on a kind selects *which* 016 action type applies;
  it never decides the outcome.
- **No endpoint that resolves `subjectId`.** The letters module stores the pair and returns it. A
  caller that needs a vendor's name asks `partners`. This is the same opacity 016 relies on, and the
  boundary test that guards it should be copied too (`src/approvals/spine-boundary.spec.ts`).
