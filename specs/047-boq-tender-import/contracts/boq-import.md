# Contract changes: 047

Base: `projects/:id/boq` (JWT, `PROJECTS`, project lock on writes).

## POST `import/validate` and `estimate-import/validate` — response (additive)

```jsonc
{
  "batchId": "uuid" | null,          // null when blockers exist
  "confirmable": true,
  "sheetName": "BoQ1",               // first schedule (kept for compatibility)
  "groups": 12, "lines": 104,        // all schedules
  "units": [...], "totals": {...},   // all schedules combined (reconciles = every schedule reconciles)
  "quotedPercentage": "-0.191200" | null,   // the file's, from the percentage schedule(s)
  "quotedPercentageFound": true,
  "projectQuotedPercentage": "-0.040000",
  "quotedPercentageDiffers": true,   // never true for an estimate
  "isEstimate": false,
  "schedules": [{
    "sheetName": "BoQ2", "pricingBasis": "percentage",
    "groups": 10, "lines": 102,
    "quotedPercentage": "-0.191200" | null,
    "excludedTaxAmount": "0.00",
    "totals": { /* ImportTotals */ }
  }],
  "excludedRows": [{ "sheet": "BoQ1", "row": 44, "description": "Add GST @18%", "kind": "tax", "amount": "2109163.00" }],
  "blockers": [{ "code": "BOQ_IMPORT_NOT_RECONCILED", "sheet": "BoQ1", "message": "..." }],
  "replace": null | { "existingLines": 26, "existingGroups": 3, "replaceable": true },
  "errors": [{ "sheet": "BoQ1", "row": 9, "column": "Rate", "reason": "..." }],
  "warnings": [...], "alerts": {...}
}
```

New refusals (400): `BOQ_REPLACE_BLOCKED` (`blockedBy: { measured, dwr, billed, awarded, boqNumbers[] }`).
`BOQ_ALREADY_POPULATED` no longer raised at validate (replace info instead), only at confirm without the flag.

## POST `import/confirm` and `estimate-import/confirm` — body

```jsonc
{ "batchId": "uuid", "quotedPercentageSource": "file" | "project" /* optional */, "replaceExisting": true /* optional */ }
```

Refusals: `BOQ_QUOTED_PERCENTAGE_CHOICE_REQUIRED`, `BOQ_ALREADY_POPULATED` (lines exist, no flag), `BOQ_REPLACE_BLOCKED`.
Response adds `replaced: number` (lines removed) and `quotedPercentage` (what the project now holds).

## DELETE `groups/:groupId`

200 `{ id }`; 404 not on project; 409 `BOQ_GROUP_NOT_EMPTY`.

## POST `items` / PATCH `items/:itemId`

Optional `pricingBasis: 'percentage' | 'item_rate'`. PATCH refuses `BOQ_PRICING_BASIS_LOCKED` (409) on a billed line.

## Reads

- `GET /projects/:id/boq` items carry `pricingBasis`.
- Billable BOQ items carry `pricingBasis` and `takesQuotedPercentage`; `quotedTotal` applies the % to percentage lines only.
- Client bill view lines carry `pricingBasis`; `quotedRate` equals `rate` for lines that do not take the %.
- Certified-copy lines carry `takesQuotedPercentage`.
