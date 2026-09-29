# Data Model: Cross-Register Search (021, User Story 1)

## No new tables. No new columns. No migration.

This document exists to say that deliberately, because a data model that is simply absent reads as an
oversight.

Search adds **no persisted state**. It reads the four registers through their own modules' service
methods and merges the results in memory (research §1). The reasons it owns nothing:

- **Principle I.** `Employee` (`hr`), `Vendor` (`partners`), `Equipment` (`plant`) and `Project`
  (`projects`) are in four schemas. Anything search stored about them would either duplicate them
  across a boundary or require a query that spans one.
- **A second source of truth is a liability here**, not an optimisation. Research §2 declines a
  denormalised index for exactly this reason, and the failure mode — a renamed project findable only by
  its old name, with nothing surfacing the drift — is the kind that lives for months.
- **Isolation is inherited rather than re-implemented.** Each source queries under its own module's
  existing RLS context, so there is no new policy to write, get wrong, or prove.

---

## The shapes that do exist (in memory only)

### `SearchResult`

What a source returns and what the endpoint emits. An identifying summary plus a route — never a domain
object, which is what keeps `src/search/` from learning business rules (plan Risks).

| Field | Type | Notes |
|---|---|---|
| `register` | `'employee' \| 'vendor' \| 'equipment' \| 'project'` | FR-003's "which register each result belongs to" |
| `id` | `string` | |
| `code` | `string` | The register's own code |
| `label` | `string` | What a person reads. Employee name, vendor name, equipment name, project name |
| `sublabel` | `string \| null` | One disambiguating fact — a project's status, an employee's site. For the spec's edge case of two projects with the same name |
| `matchedOn` | `'code' \| 'name'` | Drives FR-001b's ranking and tells the interface why a row is in the list |
| `href` | `string` | FR-004's "the full record is reachable" |

### `SearchResponse`

| Field | Type | Notes |
|---|---|---|
| `results` | `SearchResult[]` | Exact-code matches first (FR-001b), then everything else |
| `truncated` | `boolean` | A cap was hit. The spec's "a search that would match thousands" edge case, answered honestly rather than by silently showing the first twenty |
| `unavailableSources` | `string[]` | Registers whose module is **not deployed**. See the warning below |

> **`unavailableSources` must never carry a permission failure.** It is inherited from
> `project-sources.registry.ts`, where it means "we could not ask". Using it for "you may not see this
> register" would disclose the existence of what FR-002 forbids disclosing. A register the caller
> lacks permission for contributes an empty list and says nothing — indistinguishable from a genuine
> miss (research §5). The field name invites the mistake, which is why it is written here as well as in
> the plan.

---

## What each register is matched on

No index is added to any register for search's benefit. These are the columns the sources read:

| Register | Code column (prefix match) | Name columns (substring match) |
|---|---|---|
| `Employee` (`hr`) | `employeeCode` | `firstName`, `lastName` — **both nullable**, matched independently rather than concatenated (research §3) |
| `Vendor` (`partners`) | `code` | `name` |
| `Equipment` (`plant`) | `code` | `name` |
| `Project` (`projects`) | `code` | `name` |

All four already carry `@@index([companyId])`, which bounds every one of these queries to a single
company before the match predicate runs. That is what makes four unindexed substring matches tolerable
at this product's scale, and it is the property research §4's deferred `pg_trgm` decision rests on.
