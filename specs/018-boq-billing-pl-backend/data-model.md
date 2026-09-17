# Data Model: BOQ, Billing and Project P&L (018, backend)

**Date**: 2026-09-16 · Decisions: [research.md](./research.md)

Every table below lives in `projects` and gets hand-authored RLS in its own migration — the shape
017 used, `ENABLE` + `FORCE` + a `tenant_isolation` policy. **RLS is never modelled in
`schema.prisma`.**

---

## Changed: `BOQTaskItem` — `projects`

The change §1 found to be load-bearing: the BOQ has no rate, so FR-002 has nothing to price from.

| Field | Change | Notes |
|---|---|---|
| `rate` | **new**, `Decimal @default(0) @db.Decimal(18, 2)` | Default 0 because the table is populated and a required column cannot be added to one. Zero is also the honest start: it prices a line at nothing, which is visibly wrong on a bill and therefore gets fixed. |
| `isVariation` | **new**, `Boolean @default(false)` | FR-015a. A variation is a BOQ line, marked as one (Clarifications). |
| `variationRef` | **new**, `String?` | The client's variation order reference, when there is one. |

---

## New: `ClientBill` — `projects`

A claim made to the client, priced from the BOQ. **Not `Revenue`**, which stays as it is and keeps
meaning money received — see research §2.

| Field | Type | Notes |
|---|---|---|
| `id` | `String @id @default(cuid())` | |
| `companyId` | `String` | RLS-protected |
| `projectId` | `String` | FK, cascade |
| `billNumber` | `String` | |
| `periodFrom`, `periodTo` | `DateTime @db.Date` | The period measured, not the date raised |
| `billedAmount` | `Decimal @db.Decimal(18, 2)` | Sum of its lines, written in the same transaction |
| `certifiedAmount` | `Decimal? @db.Decimal(18, 2)` | **Nullable = not yet certified** (FR-005) |
| `certifiedAt` | `DateTime?` | |
| `status` | `ClientBillStatus @default(draft)` | `draft`, `submitted`, `certified`, `cancelled` |
| `deviationReason` | `String?` | FR-004: required before submit when any line exceeds scope |

**Indexes**: `@@unique([projectId, billNumber])`, `@@index([companyId])`,
`@@index([companyId, projectId, periodTo])`.

---

## New: `ClientBillLine` — `projects`

| Field | Type | Notes |
|---|---|---|
| `boqTaskItemId` | `String` | FK, `onDelete: Restrict` — a BOQ line billed against cannot vanish |
| `quantity` | `Decimal @db.Decimal(18, 3)` | Executed this period |
| `rate` | `Decimal @db.Decimal(18, 2)` | **Frozen at raise** (FR-002). Not read through the FK. |
| `amount` | `Decimal @db.Decimal(18, 2)` | `quantity × rate`, stored so the bill totals to what was printed |
| `exceedsScope` | `Boolean @default(false)` | Computed at composition, stored so the flag survives a later BOQ revision |

> **The frozen rate is the whole of FR-002 scenario 4.** Reading the rate through the relation would
> re-price every historical bill the moment somebody revised the BOQ — the company would be unable to
> say what it had actually claimed, which is the one thing a bill exists to record.

---

## New: `RABillLine` — `projects`

Attaches to the **existing** `RABill`, which keeps its id, its status and the 016 approval built on
it (research §2).

| Field | Type | Notes |
|---|---|---|
| `raBillId` | `String` | FK, cascade |
| `boqTaskItemId` | `String` | FK, `onDelete: Restrict` |
| `quantity`, `rate`, `amount` | as above | The awarded rate, frozen the same way and for the same reason |

---

## Changed: `RABill` — `projects`

| Field | Change | Notes |
|---|---|---|
| `amount` | **kept** | Derived from lines for new bills; existing rows keep what they were entered with. Dropping it would erase them. |
| `retentionAmount` | **new**, `Decimal @default(0) @db.Decimal(18, 2)` | FR-008, FR-016a |
| `deductionAmount` | **new**, `Decimal @default(0) @db.Decimal(18, 2)` | |
| `advanceRecovered` | **new**, `Decimal @default(0) @db.Decimal(18, 2)` | |
| `netPayable` | **new**, `Decimal @default(0) @db.Decimal(18, 2)` | Gross, deductions and net shown separately (FR-008) |

---

## Changed: `WorkOrder` — `projects`

| Field | Change | Notes |
|---|---|---|
| `retentionPercent` | **new**, `Decimal @default(0) @db.Decimal(5, 2)` | Per the Clarifications: a percentage per bill, set on the order |

## New: `WorkOrderBOQItem` — `projects`

What scope a subcontractor was actually awarded, at what rate. FR-006 and FR-007 need it: "remaining
awarded quantity" has no meaning without an award.

| Field | Type | Notes |
|---|---|---|
| `workOrderId`, `boqTaskItemId` | `String` | |
| `awardedQty` | `Decimal @db.Decimal(18, 3)` | |
| `rate` | `Decimal @db.Decimal(18, 2)` | **The subcontractor's rate, not the client's.** The spec's edge case says so plainly: the awarded BOQ differs from the client BOQ for the same work. |

**Index**: `@@unique([workOrderId, boqTaskItemId])`.

---

## New: `RetentionRelease` — `projects`

Release is an explicit recorded act, never a date the system acts on (Clarifications).

| Field | Type | Notes |
|---|---|---|
| `workOrderId` | `String` | |
| `amount` | `Decimal @db.Decimal(18, 2)` | |
| `releasedAt`, `releasedByUserId` | | Who let the money go, and when |
| `remark` | `String?` | Against which certificate or milestone |

---

## Not stored, and deliberately

- **Cumulative billed quantity per BOQ line** — aggregated from `ClientBillLine` (research §3). A
  second running total beside `doneQty` is a reconciliation bug waiting for a month-end.
- **Monthly project cost by category** — assembled from the source modules through the registry at
  read time (research §4). A stored monthly total is wrong for every month whose source records were
  corrected after the fact, which is normal for payment sheets.

## Row-level security

Every new table: `ClientBill`, `ClientBillLine`, `RABillLine`, `WorkOrderBOQItem`,
`RetentionRelease`.

```sql
ALTER TABLE "projects"."<Table>" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "projects"."<Table>" FORCE  ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "projects"."<Table>"
  USING ("companyId" = current_setting('app.current_company_id', true)
         OR current_setting('app.is_super_admin', true) = 'true');
```

`FORCE` matters: without it the table owner bypasses its own policy, and the application connects as
the owner. The RLS e2e must use a `NOSUPERUSER NOBYPASSRLS` probe and must check for vacuousness by
disabling a policy and confirming rows **do** appear — 017's `test/documents-rls.e2e-spec.ts` is the
template, and the reason it exists is that every pre-016 RLS test in this repository passed while
proving nothing.
