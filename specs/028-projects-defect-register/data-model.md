# Data model: Projects defect register (028)

Three new tables, four altered, one new enum value, one new code series. **Every one ships a generated migration**; the three new tables each ship an RLS probe before their phase can be committed (Principle IV).

---

## New — `inventory.VendorItemRate` (Phase D)

The rate agreed with one vendor for one item, and the period it applied to.

| Field                     | Type                          | Notes                                                                                                                                              |
| ------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                      | `String @id @default(cuid())` |                                                                                                                                                    |
| `companyId`               | `String`                      | Plain column, RLS key                                                                                                                              |
| `vendorId`                | `String`                      | **Plain id, no relation** — `partners.Vendor` is another schema, exactly as `Purchase.vendorId` already does it (Principle I)                      |
| `itemId`                  | `String`                      | **Plain id, no relation too** — `Item` lives in `settings`, and `Purchase.itemId` beside it is already a plain column for the same reason          |
| `rate`                    | `Decimal @db.Decimal(18, 2)`  | Matches `Purchase.rate` precisely; a rate that cannot be stored exactly is a rate that cannot be compared exactly                                  |
| `effectiveFrom`           | `DateTime @db.Date`           |                                                                                                                                                    |
| `effectiveTo`             | `DateTime? @db.Date`          | **Null means current** — the convention `settings.HireRate` already establishes                                                                    |
| `establishedByPurchaseId` | `String?`                     | The first purchase that set it, where it was set that way rather than by an approved change. What makes FR-016's first-purchase report answerable. |


**Indexes**: `@@unique([companyId, vendorId, itemId, effectiveFrom])`, `@@index([companyId])`, `@@index([companyId, itemId])` — the second serves FR-016's "what have other vendors agreed for this item".

**Why not a column on `Item` or `Vendor`**: research §4. The history is the point; FR-015 is unanswerable without it.

---

## New — `projects.RABillPayment` (Phase E)

Money that actually left, against a bill.

| Field              | Type                          | Notes                                                                             |
| ------------------ | ----------------------------- | --------------------------------------------------------------------------------- |
| `id`               | `String @id @default(cuid())` |                                                                                   |
| `companyId`        | `String`                      | RLS key                                                                           |
| `raBillId`         | `String`                      | Relation, `onDelete: Restrict` — a bill with payments against it is not deletable |
| `paidOn`           | `DateTime @db.Date`           |                                                                                   |
| `amount`           | `Decimal @db.Decimal(18, 2)`  |                                                                                   |
| `instrument`       | `PaymentInstrument`           | New enum: `bank_transfer`, `cheque`, `cash`, `adjustment`                         |
| `reference`        | `String?`                     | UTR, cheque number — free text because every bank spells it differently           |
| `recordedByUserId` | `String?`                     | Bare id, per the schema-level note                                                |
| `recordedAt`       | `DateTime @default(now())`    |                                                                                   |

**Indexes**: `@@index([companyId, raBillId])`.

**What is deliberately absent**: any `outstanding` or `balance` column. FR-021 says outstanding is **derived** — certified less the sum of payments. A stored balance is a second source of truth that goes wrong silently the first time a payment is corrected.

---

## New — `projects.SignedCopy` (Phase E)

The countersigned document coming back, for a bill or a debit.

| Field              | Type                          | Notes                                                                                             |
| ------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------- |
| `id`               | `String @id @default(cuid())` |                                                                                                   |
| `companyId`        | `String`                      | RLS key                                                                                           |
| `subjectType`      | `SignedCopySubject`           | New enum: `ra_bill`, `debit_note`                                                                 |
| `subjectId`        | `String`                      | Bare id — the two subjects are different tables, so no relation                                   |
| `fileRef`          | `String`                      | `StorageService`'s encrypted reference, the same pattern as `DWRAttachment` and `ProjectDocument` |
| `fileName`         | `String`                      | As uploaded, so a download arrives named rather than as a UUID                                    |
| `receivedOn`       | `DateTime @db.Date`           |                                                                                                   |
| `uploadedByUserId` | `String?`                     |                                                                                                   |
| `uploadedAt`       | `DateTime @default(now())`    |                                                                                                   |

**Indexes**: `@@index([companyId, subjectType, subjectId])`.

**Why a state and not only a file** (FR-020): the arrival of a signed copy is what makes a bill _acknowledged_. A file in a list cannot answer "which bills are unacknowledged", which is the only question anybody asks of it. The state lives on the subject (below); this table holds the evidence.

---

## Altered — `projects.RABill`

| Change                                                                      | Phase | Note                                                                                                                                                                        |
| --------------------------------------------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@@unique([projectId, billNumber])` → `@@unique([workOrderId, billNumber])` | A     | The numbers are allocated per work order; the constraint disagreed and refused the bill. The nullable half is closed by a service rule, not by the constraint — research §1 |
| `advanceRecovery`, `otherDeductions`                                        | B     | **Columns retained, input retired.** Not dropped: research §2                                                                                                               |
| `acknowledgedAt DateTime?`                                                  | E     | Null until the signed copy arrives                                                                                                                                          |
| `payments RABillPayment[]`                                                  | E     |                                                                                                                                                                             |

---

## Altered — `projects.WorkOrder`

`WorkOrderStatus` gains `pending_approval`, between `draft` and `active`.

**Migration risk, stated here because it is the one that could stop a business trading**: existing rows keep the status they have. A migration that set live `active` work orders to `pending_approval` would make every project in flight unbillable overnight. Only work orders raised after this ships start pending.

---

## Altered — `projects.BillPackageDebit`

| Change               | Phase | Note                                                                                                                |
| -------------------- | ----- | ------------------------------------------------------------------------------------------------------------------- |
| `noteNumber String?` | E     | Allocated from the new `DEBIT_NOTE` series **when the debit is raised**, never when a PDF is produced — research §6 |

Nullable because debits already recorded have none, and inventing numbers for them would print identifiers on documents nobody issued. The same decision 027 made for work-order codes.

---

## Altered — `settings.CodeSeriesType`

Gains `DEBIT_NOTE` (`{shortCode}-DN-0001`), per company like every other series.

---

## Altered — `projects.DailyWorkReport`

**No schema change.** FR-023 removes weather from _entry_; the column, its default and every recorded value stay. FR-024 needs nothing new either — `createdByUserId` and `submittedByUserId` are already populated and already returned; only the names are missing, and those are resolved at read time.

This is worth stating because "remove the weather field" reads like a migration and is not one.

---

## Row-level security

Three probes, one per new table, each proving a second company cannot read the first's rows. These are **gating tasks**, not documentation: Principle IV is non-negotiable and this feature is the first in several to add tables at all.

| Table                      | Probe                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| `inventory.VendorItemRate` | Company B cannot read company A's agreed rates, and cannot establish one against company A's item |
| `projects.RABillPayment`   | Company B cannot read or record a payment against company A's bill                                |
| `projects.SignedCopy`      | Company B cannot read company A's signed copy or its stored file reference                        |

---

## Migrations

Six touches, each generated with:

```
prisma migrate diff --from-schema-datasource --to-schema-datamodel --script
```

`npm run migrate:dev:create` is non-interactive in this environment, which is why the diff form is used. **No migration is hand-edited** (Principle VI), and the nine pre-existing index-name drifts are excluded from every generated file — a migration containing them has been mis-generated and must be regenerated rather than trimmed by hand.
