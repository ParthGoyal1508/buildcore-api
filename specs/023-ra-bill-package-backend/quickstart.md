# Quickstart: Running-Account Bill Package (023)

How to prove this feature works against a running database. Endpoint shapes are in
[contracts/bill-package-api.md](./contracts/bill-package-api.md); the tables are in
[data-model.md](./data-model.md).

## Prerequisites

```bash
npm install && npm run migrate:dev && npm run seed && npm run start:dev
```

A project with a BOQ, and **approved daily work reports** across at least three periods — feature
022 is what records them, and its own quickstart is how to get them. Without approved measurement
every proposed quantity is zero, which is a valid but uninformative bill.

Two baselines, because three passes below are about them:

```bash
# What 022 says was approved in the period this bill will claim.
curl -s "$API/projects/$PROJECT/dwr/period-figures?from=2025-12-21&to=2026-01-20" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool | head -30
```

```bash
# Nothing in the billing chain has ever held a row. Confirmed 2026-10-05: all four zero.
npx prisma db execute --stdin <<'SQL'
SELECT (SELECT count(*) FROM projects."ClientBill") cb,
       (SELECT count(*) FROM projects."RABill") rb,
       (SELECT count(*) FROM projects."BillPackage") bp;
SQL
```

---

## Pass 1 — Compose, and the count that must match

Open a package for `2025-12-21` to `2026-01-20`.

**Expect**: 201, a sequence number, and **one proposed line per BOQ line in the project** — each at
the quantity 022 reports as approved in that period, and lines with no measurement present at
`0.000` rather than omitted.

Count them against the BOQ tree. **The two counts must be equal** (FR-003). An assertion that the
lines "look right" passes just as happily over a short list, and a bill missing an item is a smaller
invoice that gets paid.

Then open the same project and period again. **Expect** the *existing* package, not a second
(FR-007). Then open `2026-01-10` to `2026-02-10`. **Expect** 409 `BILL_PERIOD_OVERLAPS`, naming the
first package — a day's measurement claimed on two bills is claimed twice.

## Pass 2 — Reduce, over-claim, and the two reasons

1. Accept a line unchanged. **Expect** no reason required and `varianceQty` `0.000`.
2. Reduce a line with no reason. **Expect** 400 `BILL_CLAIM_NEEDS_REASON`.
3. Reduce it with *"30 % deduction — shoulder slope, staff not available"*. **Expect** 200, the
   reason stored, `varianceQty` negative, `overClaimed` false.
4. Raise a line **above** what 022 approved, with a reason. **Expect** 200 and `overClaimed` **true**
   (decision D2) — accepted, because the site does work the paperwork has not caught up with, and
   refusing would record the claim nowhere.
5. Raise one with no reason. **Expect** 400.

## Pass 3 — The abstract, against the client's own figures

Compose a package whose work done is exactly **18,41,686**.

**Expect**, from the real RA-12:

| Figure | Value |
|---|---|
| CGST | 1,65,752 |
| SGST | 1,65,752 |
| IGST | 0 — the row exists and is blank |
| Retention @ 5 % | 92,084 |
| TDS @ 2 % | 36,834 |
| Payable | 11,39,971 |

**This pass is the single most informative test in the feature**, and the reason is worth stating. An
assertion that "9 % was applied" is satisfied by 9 % of *anything* — of the post-retention figure, of
the tax-inclusive total, of the cumulative rather than the period amount. Only the real document's own
numbers are satisfied by 9 % of the right thing. A rate applied to the wrong base is the defect that
survives every unit test written the obvious way.

Also confirm `taxBasis.decidedBy` is `derived_from_gstin` when both parties carry registration
numbers, and `from_project_flag` when one does not — a bill decided by the fallback is one somebody
should look at (research §5).

## Pass 4 — The frozen cumulative position, which is the whole of D1

1. Compose and **issue** a package for December. Note its `uptoDate` work-done figure.
2. Approve a *new* daily work report **inside December's period** — late, as happens.
3. Re-read December's issued package. **Expect** every figure unchanged (FR-044, D1). The package
   agrees with the signed copy the client holds.
4. Compose January's package. **Expect** its `uptoPrevious` to equal December's stored `uptoDate` —
   read, not recomputed (FR-014).
5. Call the understatement report. **Expect** December named, with the line and the amount it
   understated by.

Step 5 is why D1 is safe. Freezing without it would trade a reconciliation problem for a silent
revenue leak: the late measurement belongs to a billed period, so it falls to the next bill — or to
no bill at all if nobody looks.

## Pass 5 — Measurement sheets and the footer identity

Claim the same item on three consecutive packages with a different reduction reason each time.

**Expect** the third package's measurement sheet for that item to list all three claims in period
order, each against its own package label (RA-10, RA-11, RA-12), with the reasons **verbatim**.

**Then check the footer on every item of every package**: `thisBillQty + uptoPreviousQty` must equal
`uptoDateQty` **exactly** — not to within a rounding difference (FR-035). This is the one property of
the package that cannot be checked by reading a single bill.

Where a line names equipment, confirm the daily record appears beneath, and that a date with no
logbook entry reads `logbookMissing: true` rather than a run of zero (FR-034).

## Pass 6 — Debits

Record three debits under two headings. Apply two to this package.

**Expect** the register to show all three — including from a *later* package, because the running
total is the point (FR-039) — grouped under their headings, with the two applied naming this package.
The bill's mechanical-debit recovery equals the two applied.

Apply one of them to a second package. **Expect** 409 `DEBIT_ALREADY_RECOVERED`, naming the first. A
debit recovered twice is money taken twice.

## Pass 7 — The workbook

```bash
curl -s "$API/projects/bill-packages/$PKG/workbook.xlsx" -H "Authorization: Bearer $TOKEN" \
  -o /tmp/ra.xlsx && file /tmp/ra.xlsx
```

**Expect** a `.xlsx` containing: the check list, the abstract, the priced schedule, **one measurement
sheet per item** — count them against the schedule, including items with nothing this period
(FR-030) — and the debit register.

Download it twice and diff the figures. **Expect** them identical (FR-028).

Then clear a party's PAN and download again. **Expect** the workbook still produced, the cell blank,
and the missing field reported (FR-027) — a bill that cannot be produced because a PAN is unrecorded
is worse than one produced with a gap somebody fills by hand.

Finally, produce it for a package in the **other** direction. **Expect** the same layout with the two
party names and their identifiers exchanged (FR-025), from the same renderer.

## Pass 8 — Locks, permissions, tenancy

1. Lock the project, then attempt any write. **Expect 423, not 403** — the same caller may write once
   it is unlocked.
2. Call with a token lacking `PROJECT_FINANCIALS`. **Expect** 403.
3. Request another company's package by id. **Expect 404, not 403** — a 403 confirms the row exists.

---

## The test suites

```bash
npm test -- src/projects/billing                      # unit
npm run test:e2e -- test/bill-package.e2e-spec.ts     # passes 1–8
npm run test:e2e -- test/ra-bill-package-rls.e2e-spec.ts
npm run lint && npm run build
```

`test/ra-bill-package-rls.e2e-spec.ts` covers the four new tables under a `NOSUPERUSER NOBYPASSRLS`
role, asserts the probe role was **created** before anything else, and reports as **skipped — never
as passed** when it cannot be built. The development and CI role is a superuser and Postgres exempts
superusers from row-level security unconditionally, so a policy without that probe has never been in
force in any test run.

## Before committing

```bash
npx jest src/approvals/fr-022-unmigrated-modules.spec.ts   # and again after the first commit
npx jest src/projects/route-shadowing.spec.ts              # literal paths under projects/
```

The first diffs two commits, so a new directory is invisible until its first commit lands — 022
learned that the rule is "run it again straight after the first commit of any new directory", not
merely "run it before committing". The second caught `GET projects/dwr` being shadowed by
`GET projects/:id` during 022, and this controller carries the same hazard.
