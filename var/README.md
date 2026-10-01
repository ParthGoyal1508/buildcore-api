# `var/` — access-matrix evidence

`access-matrix-before.json` and `access-matrix-after.json` are the FR-006 / SC-002 evidence
for 019's Phase 1 migration, captured on the **development** database on 2026-09-30. The
diff between them is empty, which is what gated Phase 2.

**They are environment-specific, and that matters operationally.** Each database has its
own roles, so this pair proves nothing about any other one. Before
`20260930090000_access_level_model` is deployed anywhere else — production included — the
same capture must be taken **there, first**:

```bash
npx ts-node scripts/access-matrix.ts > var/access-matrix-before.json   # BEFORE the deploy
npx prisma migrate deploy
npx ts-node scripts/access-matrix.ts > var/access-matrix-after.json
diff var/access-matrix-before.json var/access-matrix-after.json        # must be empty
```

There is no way to run the "before" capture after the fact: once `Role.permissions` has
been backfilled into `RolePermission`, the state it was backfilled from is gone. A
production deploy that skips this step is a deploy with no way to prove nobody's access
changed — and the failure it would be hiding is every role holding nothing, which is what
five migrations did in production on 2026-09-16 for exactly this reason.
