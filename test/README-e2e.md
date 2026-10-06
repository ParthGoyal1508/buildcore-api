# Running the end-to-end suites

## The database

**e2e runs against `buildcore_scratch`, never `buildcore`.** The suites create and delete their own
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
```

**The third step is not optional.** Approval chains are installed by `CompaniesService.create`, and
`prisma/seed.ts` writes its company row directly — so a database brought up by `db seed` alone has
companies and no chains. Nothing says so until something is submitted for approval, and then it is
seven red tests in `ra-bills.e2e-spec.ts` with a 409 that reads as a product fault. It is not; the
database was not ready. `npm run seed:chains` is idempotent and safe to re-run.

## Checking you are where you think you are

```sh
DATABASE_URL="$SCRATCH" npx prisma db execute --stdin <<< "SELECT current_database();"
```

Worth doing once per session. The failure mode above was silent in both directions: the tests passed,
and they passed against the wrong database.
