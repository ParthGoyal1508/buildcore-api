# Data Model: Access Granularity and Multi-Company

**Date**: 2026-09-29. Three new tables and one new enum, all in the `settings` schema beside `Role`
and `User` (Principle I). One existing column is retired, in a later migration than the one that
stops reading it.

## New enum

### `settings.AccessLevel`

```
read
write
```

Two values, deliberately. A third (`approve`) was considered and rejected: the system already
expresses approval as separate `Permission` values — `INVENTORY_APPROVE`, `LABOUR_APPROVE`,
`RECRUITMENT_APPROVE`, `ASSETS_APPROVE` — and a level that duplicated them would give two ways to say
one thing, with nothing stating which wins.

## New tables

### `settings.RolePermission`

Replaces `Role.permissions Permission[]`. One row per role, area and level.

| Field | Type | Notes |
|---|---|---|
| `id` | `String @id @default(cuid())` | |
| `roleId` | `String` | → `Role`, `onDelete: Cascade` |
| `permission` | `Permission` | The area. The existing 34-value enum, unchanged |
| `level` | `AccessLevel` | |
| `createdAt` | `DateTime @default(now())` | |
| `createdBy` | `String?` | |

- `@@unique([roleId, permission, level])` — a grant is present or absent, never duplicated.
- `@@index([roleId])` — the guard's read path resolves a caller's grants by role.
- No `companyId`: `Role` has none (research §7), and inventing one here would put the level table in
  disagreement with the table it belongs to.

**Why not a `level` column on a reshaped scalar list**: Postgres arrays of composite types are
awkward to query and Prisma does not model them. A row per grant is queryable by area, by level and by
role, which is what the guard, the access matrix (SC-002) and the role editor all need.

**Backfill**: every entry in every `Role.permissions` array becomes **two** rows, `read` and `write`.
That is today's behaviour stated explicitly — holding `MACHINERY` has always meant both. FR-006 is
satisfied by construction rather than by inspection, and no role becomes tighter until somebody
deliberately tightens it.

### `settings.PermissionRefusal`

FR-003 requires a refused write be recorded. Additive; no backfill.

| Field | Type | Notes |
|---|---|---|
| `id` | `String @id @default(cuid())` | |
| `companyId` | `String` | RLS tenant key |
| `userId` | `String` | Who attempted |
| `method` | `String` | HTTP verb |
| `path` | `String` | Route template, not the resolved URL — a resolved URL carries ids and turns a security log into a PII store |
| `requiredPermission` | `Permission` | The area required |
| `requiredLevel` | `AccessLevel` | The level required |
| `heldLevel` | `AccessLevel?` | The level actually held for that area. **Null means the area was not held at all** |
| `createdAt` | `DateTime @default(now())` | |

- `@@index([companyId, createdAt])`, `@@index([companyId, userId])`.
- RLS: `ENABLE` + `FORCE`, `tenant_isolation` policy with an explicit `WITH CHECK`, hand-authored.

`heldLevel` is the field that earns this table. A refusal with `heldLevel = read` against
`requiredLevel = write` is an interface that offered a control it should have hidden — FR-004's failure
mode. A refusal with `heldLevel = null` is somebody reaching for a module they hold nothing in. The
first is a bug report, the second is a security signal, and without this column they are the same row.

**Retention**: 180 days, swept by the existing cron pattern. Recorded here as a decision rather than
left open — an unbounded security log is how a small table becomes an incident.

### `settings.UserCompanySelection`

FR-011 requires the selection to survive a browser restart, so it is stored server-side (plan D5).

| Field | Type | Notes |
|---|---|---|
| `userId` | `String @id` | One row per user — the selection is singular by definition |
| `companyId` | `String` | The selected company |
| `updatedAt` | `DateTime @updatedAt` | |

- No `@@unique` beyond the primary key; `userId` being the id **is** the constraint, and it is what
  makes "two selections for one user" unrepresentable rather than merely prevented.
- RLS: `ENABLE` + `FORCE` on `companyId`.

**The selection is not authorisation.** It is validated against the user's accessible companies on
every read, not only on write (plan D5). A row here that the user may no longer access resolves to
their own company and is re-recorded; it never widens what RLS permits.

## Existing structures

### `settings.Role.permissions` — retired, in two steps

| Step | Migration | State |
|---|---|---|
| 1 | Phase 1 | `RolePermission` created and backfilled. The column still exists and is still the source of truth. Nothing reads the new table |
| 2 | Phase 2 | The guard and `authenticated-user` read `RolePermission`. The column still exists, unread |
| 3 | A later migration, after a release has proved Phase 2 | The column is dropped |

Three steps rather than one so that a rollback of Phase 2 is a code revert with no data loss. The
column is the rollback.

### `settings.Company` — one field added

| Field | Type | Notes |
|---|---|---|
| `hideCashTransactions` | `Boolean @default(false)` | FR-014. Default false: a display control that arrives switched on would hide figures nobody asked to hide |

Corrected 2026-09-30, during implementation: this document and the plan both said
`CompanySettings`. **There is no such table** — the company's tunables, including
`labourCashDenominations`, live on `settings.Company` itself. Caught by the migration
failing with `42P01` rather than by review, and the migration rolled back cleanly because
Prisma wraps each file in a transaction.

Who may change it (FR-016) is `COMPANY_SETTINGS` at `write` level, and every change is recorded
through the existing audit-log service rather than a new table — the service already carries actor and
time, which is exactly what FR-016 asks for.

### Unchanged

- `Permission` — all 34 values, no addition, rename or removal. Areas are already granular enough for
  Note 22 (research §2).
- Every `tenant_isolation` policy on every existing table. Company isolation stays where it is.
- `Company.labourCashDenominations` — configuration, not a cash transaction (research §4).

## Migration notes

Two migrations, both with data statements, both therefore carrying
`SELECT set_config('app.is_super_admin', 'true', true);` before the first of them:

1. **Phase 1**: `AccessLevel`, `RolePermission`, the backfill, `hideCashTransactions`.
2. **Phase 3**: `PermissionRefusal`, `UserCompanySelection`, with their RLS policies.

The Phase 1 backfill is a write over every role in the system. Under `buildcore_app` with neither GUC
set it would match zero rows and leave the deploy green with every role holding nothing — the exact
failure that took production down on 2026-09-16, in the exact same shape. The gate on Phase 1 is the
before/after access matrix (SC-002), not a successful deploy.
