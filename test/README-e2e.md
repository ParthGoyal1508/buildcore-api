# Running the end-to-end suites

## The database

**e2e runs against `buildcore_scratch`, never `buildcore`.** This is now enforced: `test/refuse-shared-database.ts` runs before any suite and refuses to start when `DATABASE_URL` is unset, is an unexpanded template, or names `buildcore`. The suites create and delete their own
fixtures, and a teardown that reaches too far takes real data with it — one has, which is why
`de10b79 fix(test): stop three e2e teardowns deleting the whole company's data` exists.

### The URL is not what it looks like

`.env` holds a **template**:

```
DATABASE_URL=postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${DB_HOST}:${DB_PORT}/${POSTGRES_DB}?schema=${DB_SCHEMA}
POSTGRES_DB=buildcore
```

The placeholders are expanded at runtime, so **a `sed` over `DATABASE_URL` does nothing** — there is
no database name in that string to replace. On 2026-10-06 a whole session's e2e runs went to
`buildcore` because of exactly that: the substitution matched nothing, the unexpanded template was
exported, and dotenv then resolved it to the real database. No data was lost, and nothing about the
command said anything was wrong.

Build the URL from the parts instead:

```sh
export SCRATCH="postgresql://$POSTGRES_USER:$POSTGRES_PASSWORD@$DB_HOST:$DB_PORT/buildcore_scratch?schema=public&sslmode=prefer"
DATABASE_URL="$SCRATCH" npx jest --config ./test/jest-e2e.json
```

A resolved URL passed this way wins: `dotenv` does not overwrite a variable already in the
environment, and there is nothing left in it to expand.

## Provisioning it

```sh
DATABASE_URL="$SCRATCH" npx prisma migrate deploy
DATABASE_URL="$SCRATCH" npx prisma db seed
DATABASE_URL="$SCRATCH" npm run seed:chains
DATABASE_URL="$SCRATCH" npm run seed:defaults
```

**The third and fourth steps are not optional.** Approval chains are installed by `CompaniesService.create`, and
`prisma/seed.ts` writes its company row directly — so a database brought up by `db seed` alone has
companies and no chains. Nothing says so until something is submitted for approval, and then it is
seven red tests in `ra-bills.e2e-spec.ts` with a 409 that reads as a product fault. It is not; the
database was not ready. `npm run seed:chains` is idempotent and safe to re-run.

`npm run seed:defaults` (`prisma/seed-company-defaults.ts`, 036 follow-up) does the same for the rest
of what `CompaniesService.create` installs: document types, vendor categories, item categories,
asset categories, asset document types, condition grades, equipment categories and equipment
document types, for every company — and the approval chains **with their slot mappings** (`final` to
Super Admin, the rest to their default roles), which `seed:chains` leaves unmapped and without which
`dwr.e2e-spec.ts` refuses to run. It calls each master's own `seedDefaultsForCompany` — the method
company creation calls — so it cannot drift from the product's list; each inserts with
`skipDuplicates`, and an existing chain or slot mapping is left alone, so it too is idempotent. It also creates the global `QA No Modules` role (no
permissions) that `dashboard.e2e-spec.ts` signs in with; that is a QA fixture, which is why no
migration makes it.

## Checking you are where you think you are

```sh
DATABASE_URL="$SCRATCH" npx prisma db execute --stdin <<< "SELECT current_database();"
```

Worth doing once per session. The failure mode above was silent in both directions: the tests passed,
and they passed against the wrong database.

## Known pre-existing failures on a freshly provisioned scratch

Three suites fail on `buildcore_scratch` for the **same reason the approval chains did**, and none
of them is a product fault. Measured 2026-10-07, after feature 028.

| Suite                      | What it reports                                                                        | Why                                                                            |
| -------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `assets.e2e-spec.ts`       | `Cannot read properties of undefined (reading 'id')` on `GET /assets/condition-grades` | `settings.ConditionGrade` has **0 rows** on scratch and 12 on the dev database |
| `dashboard.e2e-spec.ts`    | the same family                                                                        | reads the asset masters above                                                  |
| `my-workspace.e2e-spec.ts` | `expected 400, got 423 "Locked"` on an offline punch                                   | a payroll/attendance lock in the scratch data, not a code path                 |

Same cause, one level up: these suites expect company state a _created_ company would have and a
_seeded_ one does not. `CompaniesService.create` installs **seven** sets of per-company defaults — vendor categories, item
categories, asset categories, asset document types, condition grades, equipment categories and
equipment document types — plus the approval chains. `prisma/seed.ts` writes its company row
directly and so installs none of them. `npm run seed:chains` closes one of the eight; the other
seven are still open, and that is what these failures are.

**They are not 028's.** `git diff --name-only cb311f9~1 HEAD -- src` touches nothing under
`src/assets`, `src/labour`, `src/plant`, `src/partners` or `src/attendance`, and
`src/approvals/fr-022-unmigrated-modules.spec.ts` asserts exactly that and passes.

**Fixed by `npm run seed:defaults`** (036 follow-up, 2026-10-18), described under "Provisioning it"
above. Run it once after `db seed` and these no longer fail for want of masters.

## Two more that accumulate, rather than appear on a fresh database

Measured 2026-10-12, after running the full suite several times in one session:

| Suite                 | What it reports                                                        | Why                                                                                                                        |
| --------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `projects.e2e-spec.ts` | `allocates a project code from the company series when none is supplied` | `settings.CodeSequence` advances every run and is never reset, so the expected next code drifts away from the asserted one |
| `dwr.e2e-spec.ts`      | `queues it, and a decision there moves the executed quantity`            | approval-chain/queue state left behind by earlier suites in the same session                                               |

**Neither is a product fault, and neither is caused by the change in front of you** — the
check that settles it is to stash the working tree and run the two suites again:

```sh
git stash push -u -- src test
DATABASE_URL="$SCRATCH" npx jest --config ./test/jest-e2e.json projects.e2e-spec dwr.e2e-spec
git stash pop
```

Both still fail. That is thirty seconds and it is the difference between "my change broke
two suites" and "this database has been run against all afternoon" — which look identical
in the output and lead to completely different afternoons.

They are a counter and a queue, not missing defaults, so the `seed:defaults` script above
would not fix them. Reprovisioning scratch would.
