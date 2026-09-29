# Phase 0 Research: Cross-Register Search (021, User Story 1)

Scope: User Story 1 only. Salary slip delivery, advance settlement and exit clearance are `bugs.md`
items 8, 9 and 10 and are researched when those batches are worked.

---

## §1 — How one search spans four schemas without breaking Principle I

**Decision.** A source registry in `src/search/`, holding one `SearchSource` implementation per
register, each living in and querying only its own module. The search module owns no tables and issues
no queries.

**Rationale.** `Employee` is in `hr`, `Vendor` in `partners`, `Equipment` in `plant`, `Project` in
`projects`. Principle I forbids a query spanning them, so the only question is where the merge happens
— and the answer already exists in this codebase. `src/projects/portfolio/project-sources.registry.ts`
consults each contributing module through a per-module interface, merges in memory, and reports which
sources could not be asked. Search is the same shape with four sources instead of two.

Reusing an established pattern matters more than usual here, because the alternative designs all look
locally reasonable and each would be the first of its kind in this product.

**Alternatives considered.**

- *A database view spanning the four schemas.* Postgres permits it; Principle I does not, and it would
  put the cross-boundary read in the place hardest to notice.
- *A search service that queries all four directly.* The violation, just written in TypeScript instead
  of SQL.
- *Each register exposing its own search endpoint, with the client fanning out.* Moves the merge to the
  browser, which then owns ranking, permission-shaped empty results and four failure modes. The spec
  requires one box that does not need to know which module owns the answer.

---

## §2 — Whether to build a denormalised search index

**Decision.** No. Four parallel capped queries, merged in memory. Revisit only on a failed measurement.

**Rationale.** An index table in `shared`, maintained by domain events, is the textbook answer and
would give one indexed query and clean ranking. Its cost is a second source of truth for every name and
code in the product, and its failure mode is silent — a missed event leaves a renamed project findable
only by its old name, with nothing to surface the drift. Against that it needs a backfill across four
registers, event wiring in four modules and a reconciliation sweep.

Four queries in `Promise.all` cost about the slowest of the four rather than their sum, and each is
capped. At this product's data scale that is comfortably inside NFR-001's one second.

**Reversibility, stated deliberately.** Every caller reaches the registers through the registry, so the
index can be introduced behind the `SearchSource` interface without touching a caller. That seam is the
main reason it is safe to decline the index now.

---

## §3 — Match strategy without a trigram index

**Decision.** Prefix match on code, substring match on name, minimum term length of 3 from
configuration.

**Rationale.** Postgres is available without `pg_trgm` (§4), so a substring match compiles to
`ILIKE '%term%'`, which no btree index can serve.

Code takes a prefix match because it is both indexable and faithful to how codes are typed — somebody
holding a vendor code knows how it begins. Name takes a substring match because it must not: "Tirupati"
has to find "Parth Tirupati Phase II", and a prefix match would return nothing, which is the 2026-09-16
clarification's entire purpose.

The minimum length is the mitigation for the spec's own edge case that name matching makes
thousands-row results likely. Two characters against every name in four registers is that case on every
keystroke; a floor of 3 is cheaper and more honest than paginating a result nobody wanted.

**On `Employee` specifically.** There is no single name column — `firstName` and `lastName` are both
nullable. The source matches each independently rather than concatenating them in the predicate: a
concatenation is unindexable even for the prefix case, and produces nothing that someone searching a
surname actually needs.

**Alternatives considered.**

- *Substring on code too.* Rejected: it gives up the one indexable predicate in the feature for a
  behaviour nobody asked for.
- *Prefix on name.* Rejected: it fails the clarification's motivating example.
- *Full-text search (`tsvector`).* Word-boundary matching, which is wrong for this data — codes and
  site names are not prose, and "Tirupat" would match nothing.

---

## §4 — `pg_trgm`, and why the answer is "not yet" rather than "no"

**Decision.** Deferred, with an explicit trigger: adopt it if NFR-001's 1-second p95 fails against
production-scale data.

**Rationale.** A trigram index is the correct fix for §3's unindexed substring match. This product has
form for refusing an extension on stated grounds — `geofence.util.ts` declines PostGIS because adopting
a geospatial extension *"would be a new architectural dependency requiring its own constitution
amendment to buy nothing"*.

Applied here the same test gives a different verdict eventually and the same verdict now. `pg_trgm`
would buy something real, unlike PostGIS for a single point-to-point distance. But it buys it only at a
data scale this product has not reached and, more to the point, **has never measured**. Committing a
constitution amendment and a migration to speed up a query nobody has timed is the wrong order.

**Consequence.** The slow query ships. It is named in the plan's Risks table rather than left for
someone to discover, and the remedy is ordered: measure, then `pg_trgm`, then §2's index table.

---

## §5 — Not disclosing what the caller cannot see

**Decision.** Each source checks its own module's permission and returns an empty list when the caller
lacks it. The merged response cannot distinguish that from a genuine miss.

**Rationale.** FR-002 requires that the response not reveal the existence of records outside the
caller's company or permissions, and FR-001c requires the same scoping for name matches as for code
matches. Both fail under a gather-then-filter design: result counts and timing differ measurably
between "exists but hidden" and "does not exist", and every register added later must remember to be
filtered.

**The trap worth naming.** The inherited registry pattern has an `unavailableSources` field for "we
could not ask this module". Reusing it to report "you lack permission for this register" would disclose
precisely what FR-002 forbids. The field stays for undeployed modules only, and the e2e asserts that a
caller lacking a register's permission receives a response indistinguishable from one where that
register held no match.

---

## Open items deliberately left to `/speckit-tasks`

- Whether the four `SearchSource` implementations land in one commit or four. Four is the plan's phase
  2, and the task list is where that is confirmed against the interface actually landing in phase 1.
- Whether the per-register cap is uniform or per-source. Uniform until someone has a reason; the reason
  would come from measurement that does not exist yet.
