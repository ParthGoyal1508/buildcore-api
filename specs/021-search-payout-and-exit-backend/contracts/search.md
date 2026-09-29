# Contract: Cross-Register Search (021, User Story 1)

Scope: User Story 1 only. The payout and exit halves are contracted when `bugs.md` items 8, 9 and 10
reach their batches.

---

## Part 1 — the interface every register implements

```ts
/**
 * One register's contribution to search. Implemented INSIDE the owning module —
 * `src/hr/employees/`, `src/partners/vendors/`, `src/plant/equipment/`,
 * `src/projects/portfolio/` — and registered with `SearchSourcesRegistry`.
 *
 * `src/search/` holds the registry and never queries anything itself (Principle I).
 */
export interface SearchSource {
  /** Stable key, also the `register` value on every result this source returns. */
  readonly register: 'employee' | 'vendor' | 'equipment' | 'project';

  /**
   * The permission this register requires. The registry checks it BEFORE calling
   * `search`, and a caller without it gets an empty contribution — never an entry
   * in `unavailableSources`, which would disclose the register's existence
   * (research §5).
   */
  readonly permission: Permission;

  /**
   * Match `term` against this register's code (prefix) and name (substring).
   *
   * `ctx` and `companyId` are PARAMETERS, not something the implementation
   * chooses: an implementation that ignores them is visible in review, and the
   * e2e enumerates registered sources and asserts each refuses an unauthorised
   * caller (plan Risks).
   */
  search(
    ctx: RlsContext,
    companyId: string,
    term: string,
    limit: number,
  ): Promise<SearchResult[]>;
}
```

The `limit` is passed in rather than read from configuration by each source, so four implementations
cannot disagree about the cap and the registry can shrink it when merging.

## Part 2 — the registry

```ts
/** `SearchSourcesRegistry` (search) — mirrors `ProjectSourcesRegistry`. */
register(source: SearchSource): void;

/**
 * Fan out to every registered source the caller may use, in parallel, and merge.
 *
 * Parallel is the performance claim NFR-001 rests on: four queries cost about the
 * slowest rather than their sum (research §2). A source that throws is caught and
 * reported in `unavailableSources` — one register being down must not fail the
 * whole search.
 */
searchAll(
  caller: AuthenticatedUser,
  ctx: RlsContext,
  companyId: string,
  term: string,
): Promise<SearchResponse>;
```

## Part 3 — HTTP surface

| Method | Path | Guard | Notes |
|---|---|---|---|
| `GET` | `/search?q=<term>` | authenticated only | Per-register permission is applied per source, not on the route (D23). A route-level guard would have to name one register's permission and would be wrong for the other three |

### Query

| Field | Notes |
|---|---|
| `q` | Required. **Minimum 3 characters** (configuration), maximum bounded. A shorter term is a 400, not an empty result — the client should say "keep typing", and it cannot distinguish those otherwise |
| `companyId` | Optional, for a cross-company caller. Resolved the way every other 017/021 surface resolves it |

### Response

```jsonc
{
  "results": [
    {
      "register": "project",
      "id": "clx…",
      "code": "PRJ-014",
      "label": "Parth Tirupati Phase II",
      "sublabel": "in progress",
      "matchedOn": "code",
      "href": "/dashboard/projects/clx…"
    }
  ],
  "truncated": false,
  "unavailableSources": []
}
```

**Ordering**: every result whose code matches the term exactly comes first (FR-001b); within each tier
the sources' own order is kept. Deliberately not a relevance score — D27.

**`truncated`** says a cap was hit. The spec's "a search that would match thousands of records" edge
case is answered by admitting it rather than by silently returning the first handful.

**An empty `results` with an empty `unavailableSources`** is the only response for a term that matched
nothing *and* for a term whose only matches are in registers the caller cannot see. That
indistinguishability is FR-002, and it is asserted rather than assumed (quickstart pass 3).

---

## What this contract deliberately does not include

- **Per-register endpoints.** The spec requires one box that does not need to know which module owns
  the answer. Registers keep their own list endpoints; those are not search.
- **Pagination.** `truncated` plus a cap, not an offset. Paging a merged, two-tier-ranked list across
  four independently-queried registers means either re-querying all four per page or holding state, and
  nothing in the spec asks to walk past the top matches — FR-004 asks that the record be *reachable*,
  which a match plus an `href` satisfies.
- **A relevance score.** D27.
- **Anything in User Stories 2–4.** `bugs.md` items 8, 9 and 10, later batches.
