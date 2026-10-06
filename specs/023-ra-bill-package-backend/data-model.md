# Data Model: Running-Account Bill Package (023)

Phase 1 of [plan.md](./plan.md). The decisions behind each table are in
[research.md](./research.md).

**Amended 2026-10-05 after `checklists/silent-failure.md`.** Four of its findings land here: a
status for an abandoned draft (FR-002b), a proposed quantity that can be *absent* rather than zero
(FR-003a), the one-time recoveries' frozen totals (FR-020), and the account of the up-to-previous
column, which this file had derived the one way FR-013a now forbids. Each is marked below.

Four new tables; **nothing is added to or removed from the four existing ones**. Measured against
the development database on 2026-10-05: `ClientBill` 0 rows, `RABill` 0 rows, `WorkOrder` 0 rows,
`BOQTaskItem` 0 rows — nothing in the billing chain has ever held a row, so every change here is
additive with no data to reinterpret.

---

## New: `BillPackage` — `projects`

One row per bill that has been made into a package. Holds **only what the two bill tables lack**
(research §3).

| Field | Type | Notes |
|---|---|---|
| `id`, `companyId` | `String` | |
| `projectId` | `String` | Relation. The package's project. |
| `direction` | `BillDirection` | `to_client` or `to_subcontractor`. Which party sits in which position on every sheet (FR-025). |
| `clientBillId` | `String?` | Set exactly when `direction = to_client`. |
| `raBillId` | `String?` | Set exactly when `direction = to_subcontractor`. |
| `periodFrom`, `periodTo` | `DateTime @db.Date` | Both **inclusive** (FR-001). The client's cycle runs the 21st to the 20th, so a month is not derivable. |
| `sequenceNo` | `Int` | The package's running number — "RA-12". Per project, per direction. |
| **Frozen rates** (FR-023, research §4) | | |
| `retentionFraction` | `Decimal(8,6)` | From the contract, not the system. |
| `cgstFraction`, `sgstFraction`, `igstFraction` | `Decimal(8,6)` | Recorded even when the amount is zero, so the bill says what rate it was computed at. |
| `tdsFraction` | `Decimal(8,6)` | |
| `taxBasis` | `BillTaxBasis` | `intra_state` or `inter_state`, and **how it was decided** — `derived_from_gstin` or `from_project_flag` (research §5). |
| **This period's figures** | `Decimal(18,2)` each | `workDone`, `releaseWithheld`, `cgstAmount`, `sgstAmount`, `igstAmount`, and the four recoveries (`recoveryDiesel`, `debitAgainstCivil`, `otherRecoveries`, `mechanicalDebit`), the four deductions (`mobilizationAdvance`, `retentionAmount`, `performanceSecurity`, `theftWithheld`), `tdsAmount`, `payable`. Each reported in its own right (FR-017). |
| `mobilizationAdvanceTotal`, `performanceSecurityTotal` | `Decimal(18,2)?` | **Added by the checklist (FR-020).** What each one-time recovery totals, frozen at composition. Without them "fully recovered" has nothing to compare against, and FR-020 is satisfied by an implementation that does nothing: a deduction that is complete and one somebody entered as zero this month are the same row. Recovered-to-date is the `…UptoDate` cumulative already stored, so only the target was missing. Nullable because a contract may carry neither, and the source of each is recorded with it. |
| **Frozen cumulative** (FR-014a, D1) | `Decimal(18,2)` each | The same figures again as `…UptoDate`. The *up-to-previous* column is **not a column on this row**: it is **the previous bill's stored `…UptoDate`**, read across the chain (FR-014). **Corrected by the checklist (FR-013a).** This file previously derived it as this bill's up-to-date minus this bill's own amount, which is numerically equal only while the chain is unbroken — and which makes FR-035's footer identity a rearrangement of its own definition, true for any values whatever. The reason for not storing a third copy still stands; the reason it is read from the predecessor rather than subtracted from itself is that the identity must be able to fail. |
| **Frozen statutory header** (FR-026, FR-028) | `String?` each | `issuerName`, `issuerGstin`, `issuerPan`, `issuerState`, `issuerAddress`, `receiverName`, `receiverGstin`, `receiverPan`, `receiverState`, `receiverAddress`, `receiverCode`, `natureOfWork`, `location`, `externalWorkOrderNo`, `externalBillNo`. Copied from `settings.Company`, `partners.Vendor` or `projects.Client` **at issue** and never re-read — which is what makes FR-028's "produced twice is identical" true rather than hoped for. |
| `missingHeaderFields` | `String[]` | What could not be filled (FR-027). Reported, never a refusal. |
| `status` | `BillPackageStatus` | `draft` → `issued` → `certified`, and `draft` → `abandoned`. **`abandoned` added by the checklist (FR-002b, FR-044a):** a period is occupied by a bill in any status, so without a way out a mistakenly-opened draft holds its period for ever and the only remedy is deleting the row that records the period was billed. An issued bill is never deletable. |
| `issuedAt`, `issuedByUserId` | | FR-044. |
| `revisionCount`, `lastRevisedAt`, `lastRevisedByUserId`, `lastRevisionReason` | | FR-046, following `RABill.revisionCount`'s precedent. |
| `createdAt`, `updatedAt` | | |

```sql
-- Appended to the generated migration (plan.md Complexity Tracking).
-- Prisma cannot express a constraint spanning two nullable references.
ALTER TABLE "projects"."BillPackage"
  ADD CONSTRAINT "BillPackage_one_bill_matching_direction" CHECK (
    ("direction" = 'to_client'         AND "clientBillId" IS NOT NULL AND "raBillId" IS NULL)
    OR
    ("direction" = 'to_subcontractor'  AND "raBillId" IS NOT NULL AND "clientBillId" IS NULL)
  );
```

A package attached to both bills, or to neither, would produce a document whose figures belong to one
bill and whose lines belong to another. The thing the constraint protects is a money document, which
is why it is in the database rather than in a service.

**Indexes**: `@@unique([projectId, direction, sequenceNo])` so "RA-12" means one thing;
`@@unique([clientBillId])` and `@@unique([raBillId])` so a bill has at most one package;
`@@index([companyId])`; `@@index([projectId, periodFrom, periodTo])` for the overlap check (FR-002).

---

## New: `BillPackageLineClaim` — `projects`

How each line's quantity came to be chosen (research §2).

| Field | Type | Notes |
|---|---|---|
| `id`, `companyId` | `String` | |
| `packageId` | `String` | Relation, `onDelete: Cascade`. |
| `clientBillLineId` | `String?` | Exactly one of these two, matching the package's direction. |
| `raBillLineId` | `String?` | |
| `proposedQty` | `Decimal(18,3)?` | What 022's approved measurement proposed, **as at composition**. A point-in-time fact. **Nullable, by the checklist (FR-003a)**: null is *no measurement source*, which is not the same fact as zero. |
| `proposalSource` | `ClaimProposalSource` | **Added by the checklist (FR-003a).** `approved_measurement` or `no_measurement_source`. A subcontractor bill measures award lines, and `WorkOrderBOQItem.boqTaskItemId` is nullable by design — so an unmapped award line has nothing to propose from. Proposing zero would make "the measurement was read and was nothing" and "there is no measurement to read" the same number, on the direction billed every month. |
| `claimedQty` | `Decimal(18,3)` | What is being billed. |
| `varianceQty` | `Decimal(18,3)?` | `claimedQty − proposedQty`. **Stored, not derived** — the proposed figure can move afterwards, which is the case FR-014b exists for, so a recomputed variance would answer a different question than the engineer was looking at. Null exactly when `proposedQty` is null: there is no variance from a figure that was never proposed, and zero would say the claim matched a proposal it did not have. |
| `reason` | `String?` | Required when the variance is non-zero (FR-004, FR-006). |
| `overClaimed` | `Boolean @default(false)` | Set when `claimedQty > proposedQty` (FR-006, D2). A claim against `no_measurement_source` is **not** an over-claim — nothing was exceeded — and must not be counted as one, or FR-006a's count becomes a count of unmapped award lines instead. Countable per bill and per project, which is the mitigation D2 depends on (FR-006a). |

**Index**: `@@unique([packageId, clientBillLineId])`, `@@unique([packageId, raBillLineId])`,
`@@index([companyId])`, `@@index([packageId, overClaimed])` — the last one so FR-006a's count is a
query rather than a scan.

---

## New: `BillPackageDebit` — `projects`

The register (FR-036 to FR-040). A debit is recorded once against a project and recovered on **one**
bill.

| Field | Type | Notes |
|---|---|---|
| `id`, `companyId`, `projectId` | `String` | |
| `groupHeading` | `String?` | "Debit against the ATMS Equipment Missing at site" (FR-040). |
| `description` | `String` | |
| `location` | `String?` | "KM.226 LHS". |
| `nos`, `length`, `width`, `quantity` | `Decimal(18,3)?` | Present where the debit has them; the real register uses different ones per line. |
| `unit` | `String?` | |
| `rate` | `Decimal(18,2)` | |
| `amount` | `Decimal(18,2)` | |
| `amountWithTax` | `Decimal(18,2)` | Carried rather than computed: the real register shows both, and the tax on a debit is not always the bill's own rate. |
| `recoveredOnPackageId` | `String?` | Null until applied. **Unique**, so a debit cannot be recovered twice (FR-037) — enforced by the index and not only by the service, because a debit recovered twice is money taken twice. |
| `recordedByUserId`, `recordedAt` | | |

`recordedAt` carries a second weight after the checklist: **FR-039a** makes an issued bill's
register the register *as at issue*, which is `recordedAt <= BillPackage.issuedAt` and needs no new
column. Without it FR-039's running total and FR-028's frozen workbook contradict each other — a
debit recorded between two productions of one issued bill would change a signed document.
**FR-037b** confines application to a bill that has not been issued, for the same reason from the
other side.

**Index**: `@@index([companyId, projectId])`, `@@index([recoveredOnPackageId])`. The one-bill rule is
a partial unique index on `(id)` where `recoveredOnPackageId` is not null — in practice a plain
`@@unique` is wrong here (one package recovers many debits), so the rule is: a debit row's
`recoveredOnPackageId` may transition from null to a value **once**, enforced by a conditional
update whose row count the service checks, in the same shape 022 used for its status transitions.

---

## New: `BillPackageCheckListAnswer` — `projects`

Six per package (FR-041, FR-042).

| Field | Type | Notes |
|---|---|---|
| `id`, `companyId`, `packageId` | `String` | |
| `questionKey` | `String` | One of six fixed keys. The **questions themselves are a constant in code**, not rows: the client reads them by position and their wording is part of the format. |
| `answer` | `CheckListAnswer?` | `yes`, `no`, `not_required`. **Nullable** — an unanswered question is distinguishable from one answered `no` (FR-042), which a boolean could not express. |
| `answeredByUserId`, `answeredAt` | | |

**Index**: `@@unique([packageId, questionKey])`, `@@index([companyId])`.

---

## New enums — `projects`

- `BillDirection`: `to_client`, `to_subcontractor`
- `BillTaxBasis`: `intra_state`, `inter_state`
- `BillTaxBasisSource`: `derived_from_gstin`, `from_project_flag`
- `BillPackageStatus`: `draft`, `issued`, `certified`, `abandoned`
- `ClaimProposalSource`: `approved_measurement`, `no_measurement_source`
- `CheckListAnswer`: `yes`, `no`, `not_required`

---

## Unchanged, and read: the two bill tables

`ClientBill` / `ClientBillLine` measure `BOQTaskItem` at the client's rate. `RABill` / `RABillLine`
measure `WorkOrderBOQItem` at the subcontractor's awarded rate. **These are different schedules, not
one schedule with a flag** (research §1), which is why there are two of them and one package table
rather than the reverse.

`grossAmount`, `retentionAmount`, `netAmount`, `certifiedAmount` and `quotedPercentage` stay their
only home. The package adds no second copy (research §3), and nothing is dropped despite the tables
being empty — `ClientBillsService`, the certification path and the P&L's revenue contribution all
read them.

---

## Not stored, and deliberately

- **The up-to-previous column.** It is the **previous bill's** stored up-to-date figure, read across
  the chain (FR-014) — not a column here, and explicitly **not** this bill's up-to-date less its own
  amount, which FR-013a forbids. A third stored copy of a figure fixed by the other two is the
  pattern 018 research §3 and 022 research §6 both refused; reading the predecessor costs nothing and
  leaves FR-035's identity able to fail, which is the only reason to assert it.
- **The approved measurement.** Read from feature 022 per BOQ line per period at composition, and
  what `proposedQty` was taken from. 023 stores the figure it proposed, not the measurement.
- **Which daily reports a bill line consumed.** Decision D3: the provenance is the line's item plus
  its bill's period, true by construction because a period is billed once. This closes 022 FR-020a,
  and means 022's reversal guard stays a quantity floor (FR-049a).
- **The check-list questions.** A constant in code, because their wording and order are the client's
  format rather than this system's data.

---

## Row-level security

All four new tables carry their own `companyId` and a `tenant_isolation` policy keyed on it, with
`USING` **and** `WITH CHECK` stated explicitly — matching 018's tables in this schema.

**Each policy is read rather than copied**, because the neighbours disagree (research §7):
`projects."DWRTask"` has no `companyId` at all and is protected by a correlated lookup on its parent,
and both of 008's policies omit `WITH CHECK` and rely on Postgres applying `USING` to new rows. A
`companyId`-keyed policy added beside a parent-lookup one would `AND` with it and hide every row.

`test/ra-bill-package-rls.e2e-spec.ts` is a deliverable of this feature (FR-050), following
`test/dwr-rls.e2e-spec.ts`: the non-vacuity assertion **first**, a skipped probe reporting as
**skipped and never as passed**, and a cross-company read proving the rows exist to be hidden. The
development and CI role is a superuser and Postgres exempts superusers from row-level security
unconditionally, so a policy without a probe has never been in force in any test run.
