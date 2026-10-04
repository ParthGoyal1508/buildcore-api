# Contract: `/projects/bill-packages` endpoints (023)

Every endpoint requires `JwtAuthGuard` plus `@RequirePermission(Permission.PROJECT_FINANCIALS)` — a
bill is money, unlike a BOQ, which is project work and takes `PROJECTS`. Every **write** carries
`ProjectLockGuard`.

Another company's package is **404, not 403** (FR-053): a 403 confirms the row exists.

Money is `Decimal(18, 2)` and quantity `Decimal(18, 3)`; both arrive as **strings**. Dates are
`YYYY-MM-DD`.

> **Route order matters.** This controller's literal paths sit under `projects/`, where
> `ProjectsController` registers the parameterised `GET projects/:id`. Nest matches in registration
> order, so this controller is registered **first** — during 022, registering second made
> `GET projects/dwr` arrive at `ProjectsController.findOne` looking for a project with the id "dwr".
> `src/projects/route-shadowing.spec.ts` will say so if the order regresses.

---

## Composition

### `POST /projects/:projectId/bill-packages` → 201

Opens a package for a period and proposes every line from feature 022's approved measurement.

```jsonc
{
  "direction": "to_client",            // or "to_subcontractor"
  "periodFrom": "2025-12-21",
  "periodTo":   "2026-01-20",
  "workOrderId": "clx…",               // required when direction is to_subcontractor
  "externalBillNo": "0016014256/12",   // the client's own reference, recorded not generated
  "externalWorkOrderNo": "16014256"
}
```

**Response** carries the package, its sequence number, and one proposed line per schedule line — the
project's BOQ for a client bill, the work order's award lines for a subcontractor bill (research §1:
these are different schedules, which is why there are two bill tables and one package table).

Every line comes back, including lines with no measurement (FR-003). The count of lines returned
equals the count of schedule lines, and that equality is assertable — an assertion over a returned
list passes just as happily over a short one, and a bill missing an item is a smaller invoice.

**A line carries one of two proposals, and they are different facts** (FR-003a, from
`checklists/silent-failure.md`):

```jsonc
{ "proposedQty": "0.000", "proposalSource": "approved_measurement" }   // read, and it was nothing
{ "proposedQty": null,    "proposalSource": "no_measurement_source" }  // there was nothing to read
```

The second happens on a subcontractor bill whose award line maps to no BOQ line — which the
subcontract model permits, because a subcontract may itemise work differently. Measurement is
attributed to BOQ lines, so such a line has no source at all, and a proposal of zero would say "no
work was done this month" for every unmapped line of every bill.

`varianceQty` is null exactly when `proposedQty` is, and such a line is **never** `overClaimed`:
nothing was exceeded, and counting it would turn FR-006a's count into a count of unmapped lines.

| Refusal | Code | When |
|---|---|---|
| 400 | `BILL_PERIOD_INVERTED` | `periodTo` precedes `periodFrom` |
| 409 | `BILL_PERIOD_OVERLAPS` | the period overlaps one already billed **on this schedule to this counterparty** — the project for a client bill, the work order for a subcontractor bill — **naming the package** (FR-002). A day's measurement claimed on two bills is claimed twice. The check is deliberately not per project: one project is billed to its client and to several subcontractors over the same month, and a per-project rule would refuse the second of those (CHK029). A package in **any** status occupies its period, draft included (FR-002a) |
| 409 | `BILL_PACKAGE_EXISTS` | this project and period already have a package; the existing one is returned in the body rather than a second created (FR-007) |
| 400 | `BILL_NO_SCHEDULE` | the project has no BOQ lines, or the work order no award lines (FR-011) |
| 400 | `BILL_RATE_MISSING` | a required rate — retention, tax, tax deducted — is not available. **Refused rather than defaulted to zero**: a silent zero produces a bill with no retention and a payable 5 % too high, which is the error most likely to be paid before anybody notices (research §4) |
| 404 | — | the project is another company's (FR-053) |
| 423 | `PROJECT_LOCKED` | the project is locked (FR-052) — not 403; the same caller may write once it is unlocked |

### `PATCH /projects/bill-packages/:packageId/lines/:lineId` → 200

Sets one line's claimed quantity.

```jsonc
{ "claimedQty": "0.700", "reason": "30% deduction — shoulder slope, staff not available" }
```

- Accepting the proposal unchanged needs no reason, and the variance is zero (Story 1 AC2).
- **Reducing** requires a reason (FR-004).
- **Raising it above the approved measurement** is accepted, requires a reason, and sets
  `overClaimed` (FR-006, decision D2). The flag appears on that item's measurement sheet and is
  counted per bill and per project (FR-006a) — the mitigation D2 depends on, because a reason nobody
  aggregates is a reason nobody reads.

| Refusal | Code | When |
|---|---|---|
| 400 | `BILL_CLAIM_NEEDS_REASON` | the claim differs from the proposal and no reason was given |
| 409 | `BILL_PACKAGE_ISSUED` | the package has been issued; revise it instead (FR-044) |

A reason is **cleared** when a later edit returns the claim to its proposal (FR-004a). A reason left
beside a zero variance argues on the measurement sheet for a deduction the bill does not make.

### `POST /projects/bill-packages/:packageId/abandon` → 200

Releases a draft's period (FR-002b). The only way out of a mistakenly-opened draft: a package in any
status occupies its period, and without this the alternative is deleting the row that records the
period was billed — which FR-044a forbids for an issued bill and this endpoint makes unnecessary for
a draft.

| Refusal | Code | When |
|---|---|---|
| 409 | `BILL_PACKAGE_ISSUED` | only a draft can be abandoned; an issued bill is revised or certified, never removed (FR-044a) |

---

## The abstract

### `GET /projects/bill-packages/:packageId/abstract` → 200

The four blocks, three columns each (FR-013).

```jsonc
{
  "taxBasis": { "basis": "intra_state", "decidedBy": "derived_from_gstin" },
  "work": {
    "workDone":        { "uptoDate": "31559159.00", "uptoPrevious": "29717473.00", "thisMonth": "1841686.00" },
    "releaseWithheld": { "uptoDate": "0.00", "uptoPrevious": "0.00", "thisMonth": "0.00" },
    "cgst":            { "uptoDate": "2840324.00", "uptoPrevious": "2674573.00", "thisMonth": "165752.00" },
    "sgst":            { "uptoDate": "2840324.00", "uptoPrevious": "2674573.00", "thisMonth": "165752.00" },
    "igst":            { "uptoDate": "0.00", "uptoPrevious": "0.00", "thisMonth": "0.00" },
    "total":           { "uptoDate": "37239807.00", "uptoPrevious": "35066618.00", "thisMonth": "2173189.00" }
  },
  "recoveries":  { "diesel": …, "debitAgainstCivil": …, "other": …, "mechanical": …, "total": … },
  "deductions":  { "mobilizationAdvance": …, "retention": …, "performanceSecurity": …, "theftWithheld": …, "total": … },
  "taxDeducted": { "tds": …, "total": … },
  "payable":     { "uptoDate": "30026515.00", "uptoPrevious": "28886544.00", "thisMonth": "1139971.00" },
  "rates": { "retention": "0.050000", "cgst": "0.090000", "sgst": "0.090000", "igst": "0.000000", "tds": "0.020000" }
}
```

Four properties, each tested:

1. **Every recovery and deduction kind appears whether or not it carries an amount** (FR-017). A
   subcontractor disputing a payment asks *which* deduction accounts for the difference, and a single
   net figure cannot answer.
2. **Either the two half-rate taxes or the single full-rate one, never both and never neither**
   (FR-015), decided from the parties' registration numbers with the project flag as a fallback —
   and `decidedBy` says which, because a bill decided by the fallback is one somebody should look at
   (research §5).
3. **The up-to-previous column is the previous package's stored up-to-date figure** (FR-014,
   decision D1), not a recomputation. The package therefore always agrees with the signed copy the
   client holds.
4. **Each column balances independently** (FR-021): work total less recoveries, deductions and tax
   deducted. The payable may be negative (FR-022) — a bill whose debits exceed its work is a real
   outcome the client's format expresses.

**The rates are echoed back** because they are recorded on the bill rather than read from the system
(FR-023, research §4). A bill issued in March must recompute identically in September after a budget
changes a rate, which is only true if the rate travels with the bill.

---

## The sheets' data

### `GET /projects/bill-packages/:packageId/measurement/:boqItemId` → 200

One item's claim history across every package, in period order, with the daily record beneath.

```jsonc
{
  "boqNo": "30.10",
  "claims": [
    { "sequenceNo": 10, "label": "RA-10", "periodFrom": "2025-09-21", "periodTo": "2025-11-20",
      "qty": "1.200", "reason": "40 % deduction — shoulder slope, labour, staff & ROW not cleaned" },
    { "sequenceNo": 11, "label": "RA-11", … },
    { "sequenceNo": 12, "label": "RA-12", …, "overClaimed": false }
  ],
  "thisBillQty": "0.700", "uptoPreviousQty": "1.900", "uptoDateQty": "2.600",
  "dailyRecord": [
    { "date": "2025-12-21", "openingReading": "19827.000", "closingReading": "19830.000",
      "totalHours": "3.000", "remarks": "Breakdown attend CH.247+300 RHS" },
    { "date": "2025-12-22", "logbookMissing": true }
  ]
}
```

- Reasons appear **verbatim** as the engineer wrote them (FR-032). They are the argument the document
  exists to settle.
- The footer satisfies `thisBillQty + uptoPreviousQty = uptoDateQty`, **exactly** (FR-035), where
  `uptoPreviousQty` is **read from the previous package's stored up-to-date figure** (FR-013a,
  FR-014) and not derived as this package's up-to-date less its own quantity. The distinction is the
  whole value of the assertion: against a stored figure it can fail, against a derived one it is a
  rearrangement of its own definition. Where there is no previous package the figure is `"0.000"`,
  which is a position, and not `null`, which is not.
- A date with no logbook entry is `logbookMissing: true` rather than a run of zero (FR-034) — read
  through `ProjectSourcesRegistry`, never by querying the plant schema, as 022 established.

### `GET /projects/:projectId/bill-packages/:packageId/debits` → 200 · `POST /projects/:projectId/bill-package-debits` → 201 · `POST /projects/bill-package-debits/:debitId/apply` → 200

A **draft's** register shows every debit on the project from any package, including those recovered
earlier, because the running total is the point (FR-039), grouped under its heading (FR-040).

An **issued** package's register is the register **as at issue** — `recordedAt <= issuedAt` (FR-039a).
Without that, FR-039 and FR-028 contradict each other: a debit recorded between two productions of a
signed bill would change it. The running total stays live where it is useful and freezes where the
document was signed.

| Refusal | Code | When |
|---|---|---|
| 409 | `DEBIT_ALREADY_RECOVERED` | applied to a package already, **naming it** (FR-037) — a debit recovered twice is money taken twice. Holds under two simultaneous applications and not only against a second attempt (FR-037a) |
| 409 | `BILL_PACKAGE_ISSUED` | the target package has been issued (FR-037b) — applying a debit afterwards either moves a figure FR-044 froze or records a recovery the bill never made |

### `PUT /projects/bill-packages/:packageId/check-list` → 200

Six fixed questions in a fixed order with fixed wording; an answer of `yes`, `no`, `not_required`, or
**absent**, which is distinguishable from `no` (FR-041, FR-042). It never refuses an issue (FR-043) —
the check list records a fact, and the real document says only that gaps "may delay the process".

The gaps are **returned to the caller that issues the package** (FR-043a), in its response body
beside `missingHeaderFields`, not merely recorded against the row. "MUST report the gaps" with no
addressee is satisfied by storing them where nobody looks.

---

## The workbook

### `GET /projects/bill-packages/:packageId/workbook.xlsx` → 200

Five sheet kinds, one measurement sheet per item including items with nothing this period (FR-024,
FR-030). Party names and identifiers from the **frozen header** on the package, bound by direction
(FR-025, FR-026).

Every figure comes from the stored package; **nothing is recomputed at production time** (FR-028), so
the same package downloaded twice is identical. That is a property of the renderer's inputs rather
than a rule it follows: it receives a view type and holds no database client (research §6).

Sheet names follow a stated rule that **cannot lose a sheet** (FR-024a): a name is capped at 31
characters, excludes the characters a path uses, and must be unique in the workbook, so a name drawn
from a BOQ number or a description collides or truncates on a 312-item schedule. Each sheet is named
by its line's position and identifies its item **inside** the sheet. A description too long for a
single cell is reported rather than silently truncated (FR-029a), and the number of measurement
sheets equals the number of schedule lines, assertable as a count (FR-030a).

A missing party identifier is **reported, not refused** (FR-027) — the response header
`X-Bill-Package-Missing-Fields` names what was missing, and the issue response carries the same list
in its body (FR-027a), because a workbook is a file download and a list absent from the response is a
gap nobody is told about. The sheet leaves the cell blank. A bill that cannot be produced because a PAN is
unrecorded is worse than one produced with a gap somebody fills by hand. Note from the spec's
assumptions: a client record carries no `state` and no `pan` today, so those are the likeliest gaps
for a bill issued to a client.

---

## Lifecycle, and the two reports the decisions oblige

### `POST /projects/bill-packages/:packageId/issue` → 200

Freezes every figure and the statutory header (FR-044). Refuses an unpriced line carrying a non-zero
claim (FR-009). The response carries `missingHeaderFields` and the check-list gaps (FR-027a,
FR-043a) — reported, never a refusal. An issued package can never be deleted (FR-044a); a draft is
abandoned instead.

### `POST /projects/bill-packages/:packageId/revise` → 200 · `POST /projects/bill-packages/:packageId/certify` → 200

A revision is counted with a reason and what the package stated at issue stays readable (FR-045,
FR-046). A certified amount is kept **beside** the billed one and never instead of it (FR-047) — the
variance between the two is what a project manager chases, and overwriting the billed figure erases
the fact that there was a shortfall.

### `GET /projects/:projectId/bill-packages/reports/understatement` → 200

**FR-014b, and this endpoint exists because of decision D1.** Freezing the cumulative position means
a report approved after a package went out belongs to a period already billed, so its quantity falls
to the next package — or, if nobody looks, to no package at all.

```jsonc
{ "packages": [ { "sequenceNo": 11, "label": "RA-11",
                  "periodFrom": "2025-11-21", "periodTo": "2025-12-20",
                  "lines": [ { "boqNo": "30.10", "claimed": "1.000", "approvedNow": "1.300",
                               "understatedBy": "0.300" } ] } ] }
```

Each line carries the remedy, because the report alone is not one (FR-014c): 022 attributes
measurement by **work date**, so a quantity approved late whose work date sits inside an
already-billed period never appears in any later period's proposal either — it is unreachable rather
than deferred. The route back is an over-claim under FR-006 on a later package, carrying this report
as its written reason, and the response says so rather than leaving each engineer to work it out.

Choosing to freeze without this report would trade a reconciliation problem for a **silent revenue
leak**, which is worse because nothing surfaces it. FR-049b's cross-period work-date correction
shares this mechanism rather than having its own: both are "compare a billed period's claims against
that period's approved measurement as it now stands", and two implementations of one comparison
would disagree.

### `GET /projects/:projectId/bill-packages/reports/over-claims` → 200

**FR-006a, and this endpoint exists because of decision D2.** Permitting an over-claim with a reason
is only safe if the reasons can be read in aggregate.

```jsonc
{ "totalOverClaimedLines": 4,
  "byPackage": [ { "sequenceNo": 12, "label": "RA-12", "lines": 3 } ],
  "lines": [ { "boqNo": "30.50", "claimed": "40.000", "proposed": "39.935",
               "reason": "two guards' reports filed late" } ] }
```

A flag that can be found only by inspecting lines one at a time is a flag that will not be found.
