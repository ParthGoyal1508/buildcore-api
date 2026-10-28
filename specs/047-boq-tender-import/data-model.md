# Data Model: 047

## New enum `projects.BoqPricingBasis`

| Value | Meaning |
|---|---|
| `percentage` | Priced at the line rate × (1 + project quoted %). Default. |
| `item_rate` | Priced at the line rate as quoted by the bidder; the quoted % never applies. |

## `BOQTaskItem` — one new column

| Field | Type | Rule |
|---|---|---|
| `pricingBasis` | `BoqPricingBasis` NOT NULL DEFAULT `percentage` | Set from the schedule on import; from the request on manual create; changeable on edit only while no `ClientBillLine` references the line. |

Migration `20261028100000_boq_pricing_basis`: `CREATE TYPE`, `ALTER TABLE ... ADD COLUMN ... DEFAULT 'percentage'`. Existing rows take the default; no backfill.

## Derived rule

`takesQuotedPercentage(line) = !line.nonBoq && line.pricingBasis !== 'item_rate'`

## Import-time (in memory, not persisted)

- `StagedItem.pricingBasis`
- `ImportBatch`: `fileQuotedPercentage | null`, `projectQuotedPercentage` (string, at validate), `replacesExisting: number` (lines present at validate), `schedules` summary for audit.

## Deletes

- `DELETE groups/:groupId`: allowed iff the group has 0 items.
- Replace: `deleteMany BOQTaskGroup where projectId & isEstimate = variant` after verifying no item of the variant has `doneQty ≠ 0`, DWR tasks, client bill lines or award lines.
