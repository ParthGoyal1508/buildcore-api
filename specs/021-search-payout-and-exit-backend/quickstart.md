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

---

## Pass 8 — a clearance waiver is two steps with a named approver between them

Added 2026-10-02 (Phase 8, FR-016). **T094 asked for the existing clearance pass to be updated and
there was none** — this quickstart covered US1's search only. So this is new rather than amended,
and it is here because a reader who tries the waiver against the shipped build and expects one step
will conclude the screen is broken.

1. Initiate an exit for an employee holding an open asset allocation.
2. `GET /hr/employees/:id/exit-clearance` — the allocation is listed, `settleable` is `false`.
3. As a caller holding **`PAYROLL`**, `POST .../exit-clearance/waivers` with a kind, a ref and a
   reason. Expect `200` carrying **both** the clearance and a `pending` approval item.
   * **The clearance still shows the item unwaived and `settleable: false`.** This is the step most
     likely to be read as a failure. It is not: HR has proposed, and nothing is written yet.
   * As a caller holding only `EMPLOYEES`, the same call is `403 EXIT_WAIVER_NOT_PROPOSABLE`. Write
     access on employee records used to be enough; a write-off of company money is not something a
     site administrator puts in front of the Director alone.
4. `POST .../exit-clearance/waivers` again for the same obligation →
   `409 EXIT_WAIVER_ALREADY_PENDING`. Two items in the Director's queue for one decision.
5. Attempt the final settlement → still `400 EXIT_CLEARANCE_OUTSTANDING`, naming the allocation.
6. As the Director, approve the item in the approvals queue.
7. `GET` the clearance again — the item now carries a waiver whose **author is the HR proposer** and
   whose `approvedByUserId` is the Director. Two names, because "HR waived this" and "HR asked and
   the Director agreed" are different facts. `settleable` is `true`.
8. Settle. It succeeds.

**Then the rejection path, which is the one worth doing deliberately:**

9. Repeat steps 1–3 on a second employee, and **reject** the item instead.
10. `GET` the clearance — the obligation is still outstanding, still unwaived, and the settlement is
    still refused. A rejection that silently cleared the item would look like success to everybody
    except the company's balance sheet.
11. Propose again with a better reason. It is **accepted**, not refused as a duplicate. The spine
    raises no event for a rejection, so the proposal's status is reconciled against the spine at
    this moment — see `settleStaleProposal`.

**What this pass cannot cover:** the asset register is untouched throughout (FR-014c), and
confirming that needs a second read against `assets` rather than anything on this screen.
