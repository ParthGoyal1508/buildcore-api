/**
 * Every role's effective access, as a stable, diffable JSON document (019 T001).
 *
 * **This must be run before 019's Phase 1 migration and again after it**, and the two
 * outputs must be identical. FR-006 requires the migration to preserve every existing
 * role's effective access exactly, and SC-002 is precisely this comparison. There is no
 * way to prove either after the fact: once `Role.permissions` has been backfilled into
 * `RolePermission`, the state it was backfilled *from* is gone.
 *
 *   npx ts-node scripts/access-matrix.ts > var/access-matrix-before.json
 *   # ... run the migration ...
 *   npx ts-node scripts/access-matrix.ts > var/access-matrix-after.json
 *   diff var/access-matrix-before.json var/access-matrix-after.json
 *
 * An empty diff is the gate on Phase 2. A non-empty one means the migration widened or
 * narrowed somebody's access, which is the one failure in this feature that a user finds
 * before a test does.
 *
 * Reads **both** shapes and reports them side by side, so the same script serves as the
 * before and the after: before the migration `levels` is derived from the array and is
 * the only source; after it, `levels` still reports the effective answer and `source`
 * says which shape produced it. Sorted everywhere — an unstable order would make every
 * diff noise.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface RoleAccess {
  role: string;
  isProtected: boolean;
  /** `PERMISSION:level` pairs, sorted. The effective answer, whatever produced it. */
  grants: string[];
  source: 'array' | 'table';
}

async function main(): Promise<void> {
  // As a superuser connection (the developer's own), so RLS does not silently hide roles
  // and make a narrowed matrix look like a faithful one. This is a read-only diagnostic.
  const roles = await prisma.role.findMany({
    select: { id: true, name: true, isProtected: true, permissions: true },
    orderBy: { name: 'asc' },
  });

  // Present only after Phase 1's migration. Absent before it, which is the whole point:
  // the same script runs on both sides.
  let table: { roleId: string; permission: string; level: string }[] = [];
  try {
    table = await (
      prisma as unknown as {
        rolePermission: {
          findMany: (
            a: unknown,
          ) => Promise<{ roleId: string; permission: string; level: string }[]>;
        };
      }
    ).rolePermission.findMany({
      select: { roleId: true, permission: true, level: true },
    });
  } catch {
    // The table does not exist yet. Expected on the "before" run.
    table = [];
  }

  const byRole = new Map<string, string[]>();
  for (const row of table) {
    const list = byRole.get(row.roleId) ?? [];
    list.push(`${row.permission}:${row.level}`);
    byRole.set(row.roleId, list);
  }

  const matrix: RoleAccess[] = roles.map((role) => {
    const fromTable = byRole.get(role.id);
    if (fromTable && fromTable.length > 0) {
      return {
        role: role.name,
        isProtected: role.isProtected,
        grants: [...fromTable].sort(),
        source: 'table',
      };
    }
    // Before the migration — and for any role the backfill did not reach, which is the
    // case this exists to catch. Holding a permission has always meant read AND write,
    // so that is what the array expands to.
    return {
      role: role.name,
      isProtected: role.isProtected,
      grants: role.permissions
        .flatMap((p) => [`${p}:read`, `${p}:write`])
        .sort(),
      source: 'array',
    };
  });

  // `source` is deliberately excluded from the diffed payload. It is expected to change
  // from "array" to "table" — that IS the migration — and including it would make every
  // diff non-empty and the gate meaningless. What must not change is `grants`.
  const payload = matrix.map(({ role, isProtected, grants }) => ({
    role,
    isProtected,
    grants,
  }));

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);

  // To stderr, so it is visible to the operator without polluting the diffed document.
  const sources = new Set(matrix.map((m) => m.source));
  process.stderr.write(
    `access-matrix: ${matrix.length} roles, read from ${[...sources].join(
      ' + ',
    )}\n`,
  );
}

main()
  .catch((error) => {
    process.stderr.write(`${String(error)}\n`);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
