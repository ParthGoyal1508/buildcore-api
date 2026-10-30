# Quickstart: validating 047

## Prerequisites

```sh
createdb -h localhost -T buildcore_scratch buildcore_047     # once
export DATABASE_URL="postgresql://parthgoyal@localhost:5432/buildcore_047?schema=public"
npx prisma migrate deploy
```

Never point these at `.env`'s shared database or production.

## Unit

```sh
npx jest src/projects/boq src/projects/billing
```

Expect `boq-tender-fixtures.spec.ts` to report, per fixture in `test/fixtures/tenders/`:

| File | Schedules | Expected |
|---|---|---|
| NEWAI_SHAHID_SMARAK.xls | BoQ1 item_rate, BoQ2 percentage | BoQ1 ₹4,88,000; BoQ2 ₹97,52,823 at −19.12%, quoted ₹78,88,083.24 |
| CYBER_THANA_859032.xls | BoQ1 item_rate, BoQ2 percentage | BoQ1 ₹2,59,000; BoQ2 at +5.67%, quoted ₹3,05,49,670.30 |
| MAHILA_THANA_749857.xls | BoQ1 percentage, BoQ2 item_rate | BoQ1 at −4.67%; BoQ2 ₹7,90,000 |
| STMC_KOTA_DARAH_832999.xls | BoQ1 percentage | no GST/Total line; GST ₹21,09,163 excluded; reconciles at −4.82% |
| PHC_GHAR_567935.xls | BoQ1 percentage | single schedule, unprefixed numbers, −12.65% |

## e2e

```sh
DATABASE_URL="$DATABASE_URL" npx jest --config ./test/jest-e2e.json boq-tender-import client-bills boq-planning
```

Walk: validate NEWAI → confirm with `quotedPercentageSource: 'file'` → GET billable BOQ shows
quoted total ≈ 4,88,000 + 78,88,083 → compose a bill with one line of each basis → item-rate line
amount = qty × rate. Re-validate another file → `replace.replaceable: true` → confirm with
`replaceExisting: true` → old lines gone. Bill a line → re-validate → `BOQ_REPLACE_BLOCKED`.

## Web

`npm run dev` in buildcore-web against the local API; Projects → a project → BOQ → Import: upload
the NEWAI fixture, see two schedule cards, the quoted-% choice, then the tree shows "Item rate" chips.

## Results (2026-10-28)

- API unit: 285 suites, 3,210 tests pass (`npx jest`). Lint on changed files: 0 errors. `npm run build`: 0 issues.
- e2e `boq-tender-import`: 7/7 pass against `buildcore_047`.
- Related e2e suites (`client-bills`, `bill-package`, `billing-rls`, `project-pnl`, `dwr`, `dwr-rls`,
  `ra-bills`, `ra-bill-package-rls`, `projects`): 148 failed / 81 passed **on a clean develop tree**
  and 148 / 88 with this change (the +7 are the new suite). The failures are the suites' own
  fixtures creating projects without `branchId` (required since 041) — not caused by 047. Every
  suite also prints an event-emitter "MaxListeners" warning that Jest reports as "failed to run";
  it appears on develop too.
- All 24 client tenders validate as confirmable; a ₹1,000 change to a stated total blocks.
- Web: typecheck and lint clean; shared bill-totals vectors 15/15 (web and API) + 2 web-only.
