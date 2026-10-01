import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The 019 Phase 1 migration's load-bearing properties (019 T010, T011).
 *
 * Parsed from the SQL rather than exercised against a database, following
 * `document-type-scope.spec.ts`. The three claims below are the ones whose failure is
 * silent, and each has a specific consequence worth naming:
 *
 * 1. **The `set_config` guard.** Without it the backfill's `INSERT ... SELECT` matches
 *    zero rows under `buildcore_app` and the deploy goes green with every role holding
 *    nothing — every user in the system losing every permission at once. Five migrations
 *    failed this exact way in production on 2026-09-16.
 * 2. **The doubling rule.** Each array entry must become `read` AND `write`, because
 *    holding a permission has always meant both. A backfill that inserted one level would
 *    either lock every role out of every write or grant read where none was held, and
 *    FR-006 says neither may happen.
 * 3. **No RLS, deliberately.** `settings.Role` has none — who *holds* a role is tenant
 *    data, its definition is not — so a child table cannot have a real policy. A future
 *    edit that adds one here would be writing something that looks like isolation and
 *    enforces nothing.
 */

const MIGRATION = join(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
  '20260930090000_access_level_model',
  'migration.sql',
);

const sql = () => readFileSync(MIGRATION, 'utf8');

describe('019 Phase 1 migration — the level model', () => {
  it('exists where this spec expects it', () => {
    // A guard reading a file that has moved passes vacuously on every other assertion.
    expect(sql().length).toBeGreaterThan(500);
  });

  it('sets app.is_super_admin transaction-locally before any data statement', () => {
    const source = sql();
    const guard =
      /SELECT\s+set_config\(\s*'app\.is_super_admin'\s*,\s*'true'\s*,\s*true\s*\)/;
    expect(guard.test(source)).toBe(true);

    // And *before* the INSERT, not merely somewhere in the file. A guard after the
    // statement it guards is no guard at all.
    const guardAt = source.search(guard);
    const insertAt = source.search(
      /INSERT\s+INTO\s+"settings"\."RolePermission"/,
    );
    expect(guardAt).toBeGreaterThan(-1);
    expect(insertAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(insertAt);
  });

  it('backfills both levels for every array entry, not one', () => {
    const source = sql();
    // The cross join against a two-row VALUES list is what produces read AND write.
    expect(source).toMatch(/unnest\(r\."permissions"\)/);
    expect(source).toMatch(/'read'::"settings"\."AccessLevel"/);
    expect(source).toMatch(/'write'::"settings"\."AccessLevel"/);
  });

  it('is idempotent on the grant’s uniqueness', () => {
    // ON CONFLICT DO NOTHING, so a re-run cannot fail on a partially applied migration.
    expect(sql()).toMatch(
      /ON CONFLICT \("roleId", "permission", "level"\) DO NOTHING/,
    );
  });

  it('does NOT drop Role.permissions', () => {
    // The old column is the rollback: reverting Phase 2 must be a code revert with no
    // data loss. A later migration drops it once a release has proved the new path.
    expect(sql()).not.toMatch(/DROP\s+COLUMN\s+"permissions"/i);
  });

  it('adds no row-level security, and says why in the file', () => {
    const source = sql();
    expect(source).not.toMatch(/ENABLE ROW LEVEL SECURITY/i);
    expect(source).not.toMatch(/CREATE POLICY/i);
    // The absence must be argued, not incidental — otherwise the next person adds a
    // policy that reads as isolation and enforces nothing.
    expect(source).toMatch(/Deliberately NO row-level security/);
  });

  it('cascades from Role, so deleting a role cannot orphan its grants', () => {
    expect(sql()).toMatch(
      /RolePermission_roleId_fkey[\s\S]*?ON DELETE CASCADE/,
    );
  });
});
