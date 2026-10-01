# Quickstart: Access Granularity and Multi-Company

**Date**: 2026-09-29. Runnable validation for each phase. Every pass below is a thing that can be
observed failing before the phase and passing after; a pass nobody can see fail is not a pass.

## Prerequisites

```bash
npm install
npx prisma generate
npm run start:dev
```

A local database with at least two companies and one user holding `CROSS_COMPANY_ACCESS`. The seed
provides the Super Admin; the second company and the cross-company user are created through
`/settings/companies` and `/settings/users-admin`.

## Pass 0 — capture the access matrix, before anything changes

**This is the gate on Phase 1 and it must be run before the migration, not after.** FR-006 and SC-002
are unprovable without it.

```bash
npx ts-node scripts/access-matrix.ts > var/access-matrix-before.json
```

Every role × every one of the 34 `Permission` values, with what that role may do today. Commit the
file. After Phase 1's migration:

```bash
npx ts-node scripts/access-matrix.ts > var/access-matrix-after.json
diff var/access-matrix-before.json var/access-matrix-after.json
```

**Expected: no difference.** A difference is the migration having widened or narrowed somebody's
access, which is FR-006 failing, and it is the one failure in this feature that a user finds before a
test does.

## Pass 1 — the level model is inert

After Phase 1:

```sql
SELECT r.name, rp.permission, rp.level
  FROM settings."RolePermission" rp
  JOIN settings."Role" r ON r.id = rp."roleId"
 ORDER BY r.name, rp.permission, rp.level;
```

Expected: two rows — `read` and `write` — for every entry that was in every role's `permissions`
array. And:

```sql
SELECT count(*) FROM settings."RolePermission";
-- must equal 2 × (total entries across every Role.permissions array)
```

The old column is still present and still the source of truth. Nothing reads the new table yet, which
is why Pass 0's diff is empty.

## Pass 2 — a read-only role cannot write

After Phase 2. Define a role holding `MACHINERY` at `read` only, assign it to a test user, sign in:

```bash
# Reading is allowed
curl -sS -H "Authorization: Bearer $TOKEN" localhost:3000/plant/machinery | head -c 200

# Writing is refused, and says why
curl -sS -o- -w '\n%{http_code}\n' -X POST localhost:3000/plant/machinery \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"code":"TEST-1","name":"Test"}'
```

Expected: `200` for the GET; `403` for the POST with `code: "PERMISSION_LEVEL_INSUFFICIENT"`,
`required.level: "write"` and `held.level: "read"`.

Then confirm the refusal was recorded (FR-003):

```sql
SELECT method, path, "requiredPermission", "requiredLevel", "heldLevel"
  FROM settings."PermissionRefusal" ORDER BY "createdAt" DESC LIMIT 1;
```

Expected: `POST`, the route template, `MACHINERY`, `write`, `read`. `heldLevel` being `read` rather
than null is the whole point of the column — it says the interface offered a control it should have
hidden.

## Pass 3 — the client's Note 22 role, end to end

This is SC-001, and it is the pass that proves the feature. Define a role holding `LOGBOOK` and `FUEL`
at both levels, and `MACHINERY` at neither:

```bash
curl -sS -X POST localhost:3000/plant/logbook -H "Authorization: Bearer $OP_TOKEN" \
  -H 'Content-Type: application/json' -d '{"...":"a reading"}'            # 201

curl -sS -o /dev/null -w '%{http_code}\n' localhost:3000/plant/machinery \
  -H "Authorization: Bearer $OP_TOKEN"                                     # 403 PERMISSION_AREA_DENIED
```

Note that the first three clauses of the client's example pass **before** this feature as well as
after — that is research §2, and it is worth observing directly rather than taking on trust. What only
passes after is the fourth: give the same role `MACHINERY` at `read` and confirm the register is
visible while every write to it is refused.

## Pass 4 — an undeclared endpoint fails closed

After Phase 3. Add a throwaway controller with a route and no `@RequirePermissions`, no
`@SelfService()` and no `@Public()`:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' localhost:3000/scratch/thing -H "Authorization: Bearer $TOKEN"
```

Expected: `403`. Before Phase 3 this returns `200` for any authenticated caller, which is the hole
FR-005 describes. Delete the throwaway controller afterwards.

Then confirm the `/my/*` surfaces still work, because they are the reason the hole existed:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' localhost:3000/my/leave -H "Authorization: Bearer $TOKEN"
```

Expected: `200`. If this is a `403`, `@SelfService()` is missing from a controller that needs it, and
22 routes of self-service have just been taken away from every employee.

## Pass 5 — company selection survives a restart

After Phase 4, as the cross-company user:

```bash
curl -sS -X PUT localhost:3000/my/company-selection -H "Authorization: Bearer $XC_TOKEN" \
  -H 'Content-Type: application/json' -d '{"companyId":"'"$COMPANY_B"'"}'

# Any list now returns company B's records only
curl -sS -H "Authorization: Bearer $XC_TOKEN" localhost:3000/projects | head -c 200
```

Restart the server, sign in again, and confirm `GET /auth/me` still reports company B as `selected`.
That is FR-011 — and restarting the *server* rather than the browser is the stronger test, since it
proves the selection is stored rather than held in memory.

Then the revocation case (plan D5):

```sql
-- remove the user's cross-company access, leaving company B selected
```

Expected on the next request: the selection resolves to the user's own company, the stored row is
re-recorded, and **no** company B record is returned. A cross-tenant read here is the failure this
pass exists to catch.

## Pass 6 — cash hiding

After Phase 5:

```bash
curl -sS -X PATCH localhost:3000/settings/company-settings/cash-visibility \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"hideCashTransactions":true}'
```

Then read a cash payment and a labour payment sheet. Expected: `amount: null` with
`amountHidden: true` — **not** `amount: 0`. Sum a column in an export and confirm the total is not
silently short by the value of every cash payment.

Confirm FR-017 by reading the row directly:

```sql
SELECT amount FROM <payments table> WHERE "paymentMode" = 'cash' LIMIT 1;
```

Expected: the real amount, unchanged. Hiding is display; the data is untouched.

And the staleness guard from plan D6:

```bash
npm test -- cash-surfaces
```

Expected: passes now, and fails if a new `cash`-valued payment mode is added to the schema without
being named in the surface list. That failing test is the only thing standing between "hidden" meaning
what it says and a figure appearing on a screen somebody was told would not show one.

## Pass 7 — the permission decision is not slow

NFR-002, 50ms at p95. Phase 1 captures the current module-level check as a baseline; there is no
existing measurement, so the target is meaningless without one.

```bash
npx autocannon -c 50 -d 20 -H "Authorization: Bearer $TOKEN" localhost:3000/plant/machinery
```

Compare p95 against the Phase 1 baseline. The guard now resolves grants per request; if that is a
database round trip per request it will show here, and the answer is to resolve grants once at token
issue rather than per request — decided in Phase 2 if the measurement demands it, not assumed in
advance.

## Verification before any phase is called done

```bash
npx tsc --noEmit
npx eslint <touched files only>
npm test
npm run test:e2e
```

`npm run lint` is `eslint --fix` across the repository and will reformat files this feature never
touched; run eslint scoped to the files changed.
