/**
 * Creates the module-specific roles (058 US5): for every module a "<Module> — View" role (read) and a
 * "<Module> — Edit" role (read and write), and for every single-ability permission (approvals, HR
 * letters, export, delete) one "<Ability>" role. Shared by every company (`companyId` null), so a
 * Super Admin can give anyone one module's access by adding a role rather than building one.
 *
 * **Idempotent and additive.** A role whose name already exists is left exactly as it is — never
 * changed, never deleted — so running this again, or after somebody has edited one of these roles
 * in Settings → Roles, changes nothing.
 *
 * Cross-company access is never given out this way: it is Super Admin, which stays one protected
 * role.
 *
 * Usage (from the repo root):
 *
 *   npm run roles:modules                         # local database
 *   npm run roles:modules -- --host <db host>     # a remote database, named on purpose
 *
 * A non-local database is refused unless its host is named with `--host`: these roles are meant for
 * dev and production too, but only when somebody decides so.
 */
import { PrismaClient } from '@prisma/client';

import { moduleRoles } from '../src/settings/roles/module-roles';

function assertTarget(): void {
  const url = process.env.DATABASE_URL ?? '';
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  })();
  const local = host === 'localhost' || host === '127.0.0.1' || host === '';
  if (local) return;
  const flag = process.argv.indexOf('--host');
  const named = flag >= 0 ? process.argv[flag + 1] : undefined;
  if (named !== host) {
    throw new Error(
      `Refusing ${host}: a non-local database must be named on purpose. ` +
        `Re-run with --host ${host} if this is the database you mean.`,
    );
  }
}

async function main() {
  assertTarget();
  const prisma = new PrismaClient();
  const created: string[] = [];
  const existing: string[] = [];
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.is_super_admin', 'true', true)`;
      for (const role of moduleRoles()) {
        const found = await tx.role.findFirst({
          where: { name: role.name, companyId: null },
          select: { id: true },
        });
        if (found) {
          existing.push(role.name);
          continue;
        }
        await tx.role.create({
          data: {
            name: role.name,
            companyId: null,
            permissions: [role.permission],
            isProtected: false,
            rolePermissions: {
              create: role.levels.map((level) => ({
                permission: role.permission,
                level,
              })),
            },
          },
        });
        created.push(role.name);
      }
    });
  } finally {
    await prisma.$disconnect();
  }
  console.log(`Created ${created.length} module role(s):`);
  for (const name of created) console.log(`  + ${name}`);
  console.log(`Already there, left unchanged: ${existing.length}.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
