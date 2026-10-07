# Contract: feature 028 routes and payload changes

Every endpoint keeps the guard its siblings carry. A row belonging to another company is **404, not
403** throughout — a 403 confirms the row exists, which is itself a leak across a tenant boundary.

Decimals cross the wire as **strings**, as everywhere else in this API.

---

## Changed — composing a bill package

`POST /projects/bill-packages` — unchanged shape, two new refusals.

| Refusal | Code                      | When                                                                                                                                                                                                          |
| ------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 409     | `BILL_NUMBER_TAKEN`       | The allocated number already exists on that work order (FR-003). **Replaces raw Prisma text**: this path had no `P2002` handler, so `[P2002]: Invalid 'prisma.rABill.create()' invocation` reached the screen |
| 409     | `WORK_ORDER_NOT_APPROVED` | The award has not been approved (FR-009). Names the work order                                                                                                                                                |

`POST /projects/ra-bills` gains one refusal:

| 400 | `RA_BILL_NEEDS_WORK_ORDER` | A subcontractor bill must belong to a work order. The uniqueness of its number is scoped to one, and Postgres cannot enforce that for a null — research §1 |

---

## Changed — recording a deduction

`PATCH /projects/ra-bills/:id` no longer accepts `advanceRecovery` or `otherDeductions`. Under
`forbidNonWhitelisted` these become a **400, not a silent strip** — which is the intent: a caller
sending them is recording a figure into a column no document reads.

`PUT /projects/bill-packages/:packageId/adjustments` is unchanged and becomes the only route.

---

## New — approving an award

```
POST   /projects/work-orders/:id/submit      → 200   draft → pending_approval
POST   /projects/work-orders/:id/approve     → 200   pending_approval → active
POST   /projects/work-orders/:id/return      → 200   pending_approval → draft
```

| 409 | `WRONG_STATUS` | Names the status it is in |
| 403 | `APPROVER_IS_AUTHOR` | Where the chain forbids it, as RA bills already do |

---

## New — the agreed rate

```
GET  /inventory/vendor-rates?itemId=&vendorId=   → 200
GET  /inventory/vendor-rates/first-purchases?from=&to=   → 200   FR-016's report
POST /inventory/vendor-rates/:id/change-request  → 201   raises the approval
```

`GET /inventory/vendor-rates?itemId=` with **no** `vendorId` answers FR-016's other half: what this
item is agreed at with every other vendor, shown beside a first entry.

`POST /inventory/purchases` and `PATCH /inventory/purchases/:id` gain:

| 409 | `PURCHASE_RATE_FIXED` | A rate was sent that differs from the agreed one. Names the agreed rate and the date it took effect. **Enforced here and not only in the form** — research §5 |
| 400 | `PURCHASE_EVIDENCE_MISSING` | Approval attempted without the bill and the photograph (FR-017). At approval, never at creation |

The purchase response gains `agreedRate: string | null` and `rateIsFixed: boolean`, so a form can
render the field read-only from the server's answer rather than deciding for itself.

---

## New — the debit note

```
GET /projects/debits/:id/note.pdf    → 200 application/pdf
```

The debit response gains `noteNumber: string | null`. Null on debits recorded before this shipped —
rendered as an absence, never as an empty string.

---

## New — signed copies and payments

```
POST /projects/ra-bills/:id/signed-copy        → 201   multipart
GET  /projects/signed-copies/:id               → 200   named download
POST /projects/debits/:id/signed-copy          → 201
POST /projects/ra-bills/:id/payments           → 201
GET  /projects/ra-bills/:id/payments           → 200
GET  /projects/subcontractors/:partnerId/outstanding → 200
```

The bill response gains `acknowledgedAt`, `paidAmount` and `outstandingAmount`.

**`outstandingAmount` is computed on read and stored nowhere** (FR-021). A stored balance is a second
source of truth that goes wrong silently the first time a payment is corrected.

---

## New — the daily report as a workbook

```
GET /projects/dwr/:dwrId/report.xlsx   → 200 application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
```

Named from the project code and the work date, so a file arrives identifiable rather than as a UUID.

---

## Changed — recording a day

`POST /projects/:projectId/dwr` and `PATCH /projects/dwr/:dwrId` **no longer accept `weather`**.
Under `forbidNonWhitelisted` a caller sending it receives a 400.

The column, its default and every recorded value remain (FR-023). Removing the input is the request;
discarding what was recorded is not.

The list and detail responses gain `recordedByName` and `submittedByName`, resolved from identifiers
the responses already carry. **Both**, because on a report returned for correction they are different
people, and that is the whole point of reporting them.

---

## Unchanged, and deliberately

- The refusal after a company switch stays **404**. The server is right; only the screen is not
  (FR-028). No contract change belongs to that requirement.
- `bill-abstract.ts` and the rendered PDF already read all ten adjustment columns correctly. No
  renderer contract changes in this feature.
