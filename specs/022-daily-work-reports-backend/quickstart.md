# Quickstart: Daily Work Reports (022)

How to prove this feature works, end to end, against a running database. Endpoint shapes are in
[contracts/dwr-api.md](./contracts/dwr-api.md); the columns are in
[data-model.md](./data-model.md). Nothing here duplicates them.

## Prerequisites

```bash
npm install
npm run migrate:dev          # includes 022's migration once Phase A lands
npm run seed                 # roles carry Permission.DWR already — 008 seeded it in August
npm run start:dev
```

Log in as the seeded administrator to get a token. A project with at least one BOQ group and a few
priced lines is needed; the BOQ import built on 2026-10-03 is the quickest way to get one, or create
a group and two lines by hand.

Two baselines worth recording before you start, because three of the passes below are about them:

```bash
# A BOQ line's executed quantity. Today, for every line in the system, this is 0.
curl -s "$API/projects/$PROJECT/boq/tree" -H "Authorization: Bearer $TOKEN" \
  | python3 -c "import json,sys; [print(i['boqNo'], i['doneQty']) for g in json.load(sys.stdin)['groups'] for i in g['items']][:5]"
```

```bash
# Nothing has ever been written to either table. Confirmed on 2026-10-04: both zero.
npx prisma db execute --stdin <<'SQL'
SELECT (SELECT count(*) FROM projects."DailyWorkReport") dwrs,
       (SELECT count(*) FROM projects."DWRTask") tasks;
SQL
```

---

## Pass 1 — A measured day, and the quantity the server computes

Create a report with one `work_basis` line, `nos1=2`, `length=12.5`, `breadth=3.75`, `depth=0.15`,
the rest left out — **and a `quantity` of 999 supplied deliberately**.

**Expect**: 201. Status `draft`. A `dprNumber` built from the project's code. The line's
`quantityInForce` is `14.063` (2 × 1 × 12.5 × 3.75 × 0.15 × 1, rounded to three places) and **not**
999 — the supplied figure is ignored (FR-003, US1 AC4). The unsupplied factors behaved as 1, not as
0 (FR-004).

Then send the same line with `depth: 0`.

**Expect**: 400 `DWR_FACTOR_ZERO`, naming `depth`. A product of zero is a data-entry error, not a
day on which nothing happened.

## Pass 2 — Submission moves nothing; approval moves it once

**This is the 008 US5 acceptance test that has never been runnable.**

1. Submit the report from Pass 1. **Expect** 200, status `submitted`, and the BOQ line's `doneQty`
   **unchanged** — re-read the tree and compare against your baseline (FR-011).
2. Approve it **as the user who submitted it**. **Expect** 403 `DWR_APPROVER_IS_AUTHOR` (FR-012a).
3. Approve it as a second user holding `Permission.DWR`. **Expect** 200, status `approved`,
   `approvedByUserId` and `approvedAt` set, and the BOQ line's `doneQty` now `14.063` greater.
4. Approve it again. **Expect** 409 `DWR_ALREADY_APPROVED`, and `doneQty` **still** `14.063`
   greater — not twice (FR-014). Approving twice must not bill twice.

## Pass 3 — Reversal returns the counter to exactly where it was

1. Note the BOQ line's `doneQty`.
2. Reverse the approved report with no reason. **Expect** 400 `DWR_REVERSAL_NEEDS_REASON`.
3. Reverse it with a reason. **Expect** 200, status back to `draft`, `reversedAt`,
   `reversedByUserId`, `reversalReason` set and `reversalCount` at 1 — and the BOQ line's `doneQty`
   back to **exactly** your Pass 1 baseline, not approximately (FR-019).
4. Confirm `approvedAt` and `approvedByUserId` are **still set**. The approval happened; a reversal
   reason referring to an approval nobody can see is not a record (research §7).
5. Try to edit an approved report (approve again first). **Expect** 409
   `DWR_APPROVED_NOT_EDITABLE`, and the message should name the reversal path rather than just
   refusing (FR-018).

## Pass 4 — A presence-paid day, and the number that would be right by coincidence

**The pass that matters most, because what it checks is the thing most likely to rot.**

1. Create a `day_basis` line with `servedQty: 0.5` and no remark. **Expect** 400
   `DWR_SHORT_DAY_NEEDS_REMARK` (FR-030c) — the shortfall is the fact a client's deduction is later
   argued from.
2. Add a remark. **Expect** 201, `quantityInForce` `0.500`.
3. Now send a `day_basis` line that **also carries factors** — `nos1: 7, length: 7`. **Expect** 400
   `DWR_FACTORS_ON_PRESENCE_LINE` (FR-030b). The factors are not merely ignored; the shape does not
   accept them.
4. Finally, set those factors directly in the database on an existing presence line and re-read it:

   ```bash
   npx prisma db execute --stdin <<'SQL'
   UPDATE projects."DWRTask" SET "nos1" = 7, "length" = 7
   WHERE "paymentMode" = 'day_basis';
   SQL
   ```

   **Expect** `quantityInForce` still `0.500`. If it changes, something has started reading the
   factors for a presence line — and because all six default to 1, their product is 1, which looks
   exactly like one day served. A figure that is right by coincidence passes every test written the
   obvious way, which is why this one is written the awkward way.

## Pass 5 — The logbook evidence, and its absence

1. Create a `day_basis` line naming an `equipmentId` that has a `plant.LogbookEntry` for the work
   date. **Expect** the detail response to carry `logbook` with the opening and closing readings and
   the remark — the daily register printed beneath the client's measurement sheets.
2. Use a work date the equipment has **no** entry for. **Expect** `logbook: null` and
   `logbookMissing: true` (FR-033) — reported as an absence, never as a run of zero kilometres.
3. Confirm no reading was copied: `projects."DWRTask"` has no odometer column, and should not
   acquire one. The equipment's logbook is the single system of record (research §5).

## Pass 6 — The figures feature 023 will bill from

Seed four reports against one BOQ line:

| Work date | Quantity | Status |
|---|---|---|
| 2025-11-15 | 2.000 | approved |
| 2025-12-28 | 1.000 | approved |
| 2026-01-10 | 0.700 | approved |
| 2026-01-18 | 5.000 | **submitted** |

Request the period figures for `from=2025-12-21&to=2026-01-20`.

**Expect**:

- `approvedInPeriod` = `1.700` — the December and January approvals, by **work date**. If the
  January report was approved in February it still belongs to January (FR-036).
- `approvedBefore` = `2.000` — the November one only.
- `approvedUpToDate` = `3.700`.
- The submitted report contributes to **none** of the three (FR-035). Only approval counts.
- **Every BOQ line in the project appears**, including lines nobody has measured, carrying zeros
  (FR-037). Count them against the BOQ tree: the two counts must match. A line missing here is a
  line a bill would silently drop.
- `to` before `from` → 400 `DWR_RANGE_INVERTED` (FR-038).

Then request two consecutive non-overlapping ranges covering everything and add their
`approvedInPeriod` figures.

**Expect** the sum to equal the line's own `doneQty` exactly (US6 AC6). The two are the same fact
counted two ways.

## Pass 7 — Reconciliation, which exists because `doneQty` can drift

```bash
curl -s "$API/projects/$PROJECT/dwr/reconciliation" -H "Authorization: Bearer $TOKEN"
```

**Expect** `discrepancies: 0` and every line's `difference` at `0.000`.

Now break it on purpose:

```bash
npx prisma db execute --stdin <<'SQL'
UPDATE projects."BOQTaskItem" SET "doneQty" = "doneQty" + 5 WHERE "boqNo" = '30.10';
SQL
```

**Expect** `discrepancies: 1`, that line named, and `difference: "5.000"` (FR-039), at an exact
tolerance — not approximately zero elsewhere (FR-039a).

Now repair it the way FR-039c requires, rather than by hand:

```bash
curl -s -X POST "$API/projects/$PROJECT/dwr/reconciliation/repair" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"boqItemIds":["<the line>"],"reason":"induced during verification"}'
```

**Expect** 200, the counter back at the authoritative sum, and an audit entry carrying the
**previous** value. Then call it again on the same line: **expect** 409
`DWR_NOTHING_TO_REPAIR` — refused rather than silently succeeding, so a caller learns the drift
they were chasing is already gone.

Finally, send it with no reason: **expect** 400 `DWR_REPAIR_NEEDS_REASON`.

Two things this pass is really checking. The sum is authoritative and the counter is a cache of it
(FR-039b) — so repair moves the counter, never the sum. And **nothing repaired itself**: the drift
sat there until somebody asked, because the discrepancy is the only symptom of whatever moved the
counter without a report, and a silent self-heal would destroy that evidence every time it ran
(decision D3).

A denormalised total with no way to check it is a total whose drift is found at a month-end.

## Pass 8 — Locks, permissions and tenancy

1. Lock the project (`PATCH /projects/:id` with `isLocked: true`), then attempt any write.
   **Expect** 423, **not** 403 — the same caller may write once it is unlocked (FR-008).
2. Call any endpoint with a token lacking `Permission.DWR`. **Expect** 403 (FR-028).
3. Request a report belonging to another company by its id. **Expect** **404**, not 403 (FR-029) —
   a 403 confirms the row exists.

---

## The test suites

```bash
npm test -- src/projects/dwr                 # Phase B/D/E unit tests
npm run test:e2e -- test/dwr.e2e-spec.ts     # Passes 1–8 as assertions
npm run test:e2e -- test/dwr-rls.e2e-spec.ts # FR-040
npm run lint && npm run build                # both MUST pass before merge
```

**`test/dwr-rls.e2e-spec.ts` deserves its own note.** Both tables have carried `tenant_isolation`
since 008's migration in August, and **neither policy has ever been in force in a test run** — the
development and CI database role is a superuser, and Postgres exempts superusers from row-level
security unconditionally. The suite creates a `NOSUPERUSER NOBYPASSRLS` probe role and, critically,
**asserts that it was created** before asserting anything else. Without that non-vacuity check the
whole suite passes against a superuser connection and proves nothing — which is exactly how a
`42501` reached production on 2026-10-04.

Expect it to print a loud warning and skip rather than pass if the current role cannot
`CREATE ROLE`. A skipped test must report as skipped and never as passed.

## Before committing

```bash
npx jest src/approvals/fr-022-unmigrated-modules.spec.ts
```

It diffs two commits, so files added by this feature are invisible to it until the commit lands and
it then fires one commit late. Run it before each phase's commit rather than after.
