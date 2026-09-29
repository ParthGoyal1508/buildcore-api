# Quickstart Validation: Cross-Register Search (021, US1)

Scope is User Story 1. Each pass is runnable alone and proves one property that would otherwise
regress quietly.

---

## Pass 1 — a project is findable by name, which is the bug as written

Create a project named "Parth Tirupati Phase II" with code `PRJ-014`. Search `Tirupati` and confirm it
comes back with its code, a reachable `href`, and `matchedOn: "name"`.

This is `bugs.md` item 4 in one assertion: somebody at head office found a project without knowing its
code. The 2026-09-16 clarification exists for this case and a substring match is required for it —
`Tirupati` is in the middle of that name, so a prefix match returns nothing (research §3).

Then search `PRJ-01` and confirm the same project returns with `matchedOn: "code"`.

## Pass 2 — all four registers answer the same box

Seed one employee, one vendor, one piece of equipment and one project whose names all contain a shared
token. Search it once and confirm four results, each carrying its own `register` and a reachable
`href`.

Then search an employee's surname and confirm it is found. `firstName` and `lastName` are both nullable
and matched independently rather than concatenated, so seed an employee with **only** a last name and
confirm that one is found too — the null-name case is the one a concatenation would silently drop.

## Pass 3 — the caller is told nothing about what they cannot see

This is the pass that matters most, and the easiest to get wrong.

Take a caller with `PROJECTS` and without `EMPLOYEES`. Seed an employee whose name matches the term
exactly. Search it and confirm:

1. The employee is **absent** from `results`.
2. `unavailableSources` is **empty** — it must not name `employee`. Reporting "you may not see this
   register" discloses the existence of what FR-002 forbids disclosing, and the registry's inherited
   field name invites exactly that mistake (research §5).
3. The response is **byte-identical** to the same search run when no matching employee exists at all.

Repeat for a record belonging to another company and confirm the same three properties. Then confirm it
holds for a **name** match as well as a code match — FR-001c exists because a name is not a weaker key
for authorisation purposes, and gather-then-filter designs leak here first.

## Pass 4 — exact code beats name

Seed a vendor with code `TIRU` and a project named "Tirupati Yard". Search `TIRU` and confirm the
vendor is **first**, `matchedOn: "code"`, ahead of the project matched only by name.

Nothing else about the ordering is asserted, because nothing else is specified (D27). A test that
pinned the order within a tier would fail on an unrelated change and teach the next person to loosen
the wrong assertion.

## Pass 5 — the caps are honest and the floor is a refusal

Seed more matching records than the cap. Search and confirm `truncated: true` and the result count at
the cap — not silently trimmed.

Then search a two-character term and confirm a **400**, not an empty result. The client needs to
distinguish "keep typing" from "nothing matched", and it cannot if both are an empty list.

## Pass 6 — one register being down does not fail the search

Make one source throw. Confirm the other three still return, and the failing register appears in
`unavailableSources`.

This is the field's legitimate use, and asserting it here alongside pass 3 keeps both meanings visible:
a module that could not be asked is reported, a register the caller may not see is not.

## Pass 7 — the boundary holds

Add a query from `src/search/` directly into `hr`, `partners`, `plant` or `projects` and confirm the
module-boundary spec fails, following `src/approvals/spine-boundary.spec.ts`.

`src/search/` owning no tables is the whole design (data-model.md). The way that erodes is one direct
query added by someone who found the fan-out inconvenient.

---

## What these passes cannot cover

- **NFR-001's one-second target.** Nothing here measures it, and the spec says plainly it is unverified
  because no search existed to measure. Pass 5 bounds the result size; it says nothing about latency
  against production-scale data, which is the measurement research §4's `pg_trgm` decision is waiting
  on.
- **Whether the unindexed name match is fast enough.** The same gap, stated from the other side. It is
  the known risk of this feature and the plan's Risks table names the ordered remedies.
- **Whether four registers is the right four.** The spec names these four; the registry makes a fifth
  an implementation of an existing interface rather than a change to search.
