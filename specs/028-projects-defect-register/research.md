# Research: Projects defect register (028)

Six decisions that needed reasoning rather than a preference. Everything else was settled with the user before the spec existed and is recorded in `spec.md`'s Assumptions.

---

## §1 — What uniqueness means for a bill with no work order

**Decision**: `@@unique([workOrderId, billNumber])` on `RABill`, **plus a service-level rule that an RA bill cannot be created without a work order**.

**Rationale**: Postgres does not collide NULLs, so the constraint alone leaves every work-order-less bill unconstrained — the same silent hole, moved. The rule the database cannot express is therefore held one layer up, deliberately, in one place. This is honest rather than clever: the constraint covers what it can, and a single guard covers what it cannot.

Checked before choosing it: `RaBillsService.compose` already types `workOrderId: string`, and only the package path passes `?? null`. So requiring it closes a hole rather than removing a capability — verified against the live data, where every RA bill has one.

**Alternatives considered**:

- *A partial unique index* (`WHERE "workOrderId" IS NOT NULL`). Correct in SQL and **unreachable**: Prisma cannot express it, so the migration would have to be hand-edited, which Principle VI forbids. Breaking a non-negotiable principle to paper over a gap a guard closes properly is a bad trade.
- *A sentinel work order id.* Makes the constraint work and makes every read lie — a bill would claim to belong to a work order that is not a work order.
- *Leaving it unconstrained and documenting it.* This is what the original defect was. The whole reason it shipped is that the nullable case was never decided.

---

## §2 — Where the retired deduction values go

**Decision**: copy into the package's columns where a package exists; **where none exists, leave the values in place and make the fields read-only**. Do not drop the columns in this feature.

**Rationale**: an RA bill composed through the bill sheet before packages existed has no package to migrate into. Dropping its columns would delete a figure a person can see on screen today, and nothing would be able to answer where it went. Read-only preserves the record and still closes the second input, which is what FR-004 actually requires.

**Alternatives considered**: creating a package for every orphan bill to migrate into (invents a document nobody issued); dropping the columns outright (irreversible, and the one genuinely unsafe step available in this feature).

---

## §3 — Why the two approval subjects are one phase

**Decision**: `ACTION_WORK_ORDER_AWARD` and `ACTION_PURCHASE_RATE_CHANGE` ship together.

**Rationale**: there is **no approval chain anywhere in `src/inventory`** — the module has never had one. The award needs the same thing. Standing the machinery up once and registering two subjects against it is a smaller change than doing it twice in two features, and it forces one answer to "who approves" rather than two that drift.

**Alternatives considered**: the award alone, with the rate change deferred — rejected because Phase D then depends on a chain that does not exist and would have to stub it.

---

## §4 — Why the agreed rate is not a column on `Item` or on `Vendor`

**Decision**: a table keyed `[companyId, vendorId, itemId, effectiveFrom]`, `effectiveTo` null meaning current, shaped on `settings.HireRate`.

**Rationale**: a rate has a history and the history is the point. FR-015 says an approved change applies **from approval forward** and does not restate purchases already made — which is only answerable if the rate carries the period it applied to. A column holds one value and loses the previous one, so "what was the agreed rate in August" becomes unanswerable the moment a rate changes. `HireRate` already solved this exact shape in `settings`, including the convention that an open end means current, so this follows a precedent rather than inventing one.

**Alternatives considered**: `Item.standardRate` (one rate for all vendors — contradicts the user's "per vendor"); `Purchase`'s own last row as the de-facto rate (a deleted or corrected purchase would silently move the agreed rate).

---

## §5 — Why the immutable rate is enforced in the service and not the DTO

**Decision**: the service compares the submitted rate against the agreed one and refuses a difference, on **both** create and `PATCH /purchases/:id`.

**Rationale**: a DTO can only omit the field, and omission is not refusal. `PATCH /purchases/:id` exists and accepts a rate from any caller today, so a form that disables the input leaves the rule enforced nowhere a determined or scripted caller must pass. The spec says this in FR-013 and the test asserts it through the endpoint for the same reason.

There is a second, quieter reason to refuse rather than silently overwrite: `stock.service.ts` recomputes a **weighted average on every receipt**, so a rate accepted and then replaced would move the valuation of stock already held without anybody being told.

---

## §6 — The debit note's number, and what a debit note is

**Decision**: a new `DEBIT_NOTE` entry in `CodeSeriesType`, allocated through `CodeSeriesService` **at the moment a debit is raised**, and stored on the debit row. No new table.

**Rationale**: `BillPackageDebit` already carries `groupHeading` — "grouped rather than listed flat, because the heading is how the register is read" — which is precisely the unit the client's sample document covers (*Debit Note–Box Culvert Casting*). The grouping already exists; what is missing is a number on it and a renderer for it. Adding a `DebitNote` parent table would be a fourth new table to express a grouping the data already has.

Allocated at raise rather than at print, because a number allocated when a PDF is produced is a different number each time it is produced, and the register and the document would then disagree about which debit is which.

**Alternatives considered**: a `DebitNote` parent row (a table for a grouping that exists); numbering at render (the register and the document diverge); deriving a number from the package (a debit outlives the package it is recovered on — `recoveredOnPackageId` is nullable until applied).
