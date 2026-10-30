# Research: 047 Tender BOQ Import

## R1 — Where the quoted percentage is applied today

- **Decision**: one predicate `takesQuotedPercentage({ nonBoq, pricingBasis })` in `src/projects/boq/pricing-basis.ts`, used at every site below; the web mirrors it in one helper.
- **Sites found** (`grep -rn quotedPercentage src`, `grep -rn "nonBoq ? 0"`):
  - `billing/client-bills.service.ts` — `compose` (lineTotals per line), `billableBoq` (quotedTotal), `view` (quotedRate).
  - `billing/package/bill-package.service.ts` — compose (`nonBoq ? 0 : q`), claim edit rewriting a client bill line, certification by line, `certifiedCopyLines`.
  - `billing/certified-lines.ts` — `certifiedAmountOf`.
  - `pnl/project-pnl.service.ts` reads stored bill amounts only (no recomputation) — no change.
  - Web: `bill-sheet.tsx`/`bill-line-row.tsx` (earned rate), `award-editor.tsx` (earned rate), `boq-tree.tsx` (quoted value), `bill-lifecycle.tsx` (certified-copy pricing).
- **Rationale**: the non-BOQ rule already proved the shape — "a line that does not take the premium" — so basis extends that rule rather than inventing a second.
- **Alternatives**: freezing the basis onto `ClientBillLine` — rejected; amounts are already frozen, and locking the basis once billed (spec) gives the same guarantee without a second column.

## R2 — Schedule detection across sheets

- **Decision**: `identifySchedules(sheets)` returns one `IdentifiedSchedule` per sheet with a header row (first header per sheet), plus `basis` read from rows above the header (`/item\s*rate/i` → item_rate, `/percentage/i` → percentage, else percentage). `identifySchedule` kept as `identifySchedules(...)[0] ?? null` for existing callers.
- **Measured** on the fixture set: every BoQ sheet has the label in row 1 and the type cell in row 2 col B; `Macros` has no header and is skipped naturally.

## R3 — Tax and total rows

- **Decision**: `summaryRowKind(description)` → `'tax' | 'total' | null`. Checked before the heading/line split so a summary row is neither. Tax rows contribute their amount (amount column, else qty×rate÷100 for `%`, else qty×rate) to an `excludedTax` figure added to the derived total for reconciliation only.
- **Measured**: STMC KOTA — lines 1,17,17,572.73 + GST 21,09,163 = stated 1,38,26,735.73; quoted at −4.82% = 1,31,60,287.07 ✓.

## R4 — Blocking reconciliation

- **Decision**: validate builds a report for every schedule; any non-reconciling schedule (or conflicting percentages) adds a `blocker`, and **no batch is created** (`batchId: null`, `confirmable: false`).
- **Alternative**: store a blocked batch and refuse at confirm — rejected; it consumes the 5-batch quota for something that can never be confirmed.

## R5 — Quoted percentage choice

- **Decision**: batch records `fileQuotedPercentage` and `projectQuotedPercentage` (read at validate); confirm re-reads the project's figure inside the transaction and, if it differs from the file's, requires `quotedPercentageSource`. `project` writes nothing; `file` writes the file's figure.

## R6 — Replace

- **Decision**: validate counts the variant's lines; when > 0 it computes blockers with one `findMany` over the variant's items selecting `doneQty` and `_count { dwrTasks, clientBillLines, awardLines }`. Blocked → `BOQ_REPLACE_BLOCKED` (400) with counts and up to 20 line numbers. Confirm with `replaceExisting: true` repeats the check in the transaction, then `deleteMany` groups of that variant (items cascade). Without the flag → `BOQ_ALREADY_POPULATED` (message now says "send replaceExisting").
- **Note**: `BOQTaskGroup` holding an estimate vs tender is decided by `isEstimate` on the group; non-BOQ groups are tender groups and are replaced with them if untouched.

## R7 — Multi-schedule numbering

- **Decision**: prefix `"<sheet>/"` on item `boqNo` and on group names `"<sheet> (<Basis>) › <name>"` only when more than one schedule has lines. Group `boqNo` runs 1..n across schedules. `compareBoqNo` (numeric collation) orders `BoQ1/…` before `BoQ2/…`.

## R8 — Fixtures

- **Decision**: copy NEWAI, Cyber Thana, Mahila Thana, STMC Kota Darah, PHC Ghar and PHC Kaleda into `test/fixtures/tenders/` (git-ignored, local only) and assert line counts, totals and quoted % in `boq-tender-fixtures.spec.ts`.
