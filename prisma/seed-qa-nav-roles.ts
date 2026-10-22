/**
 * Test fixtures for feature 014 (role-based navigation), safe to re-run.
 *
 * Creates four roles whose permission sets between them exercise every branch of the
 * sidebar filter, and one account per role. Non-destructive: no deleteMany() anywhere,
 * every write is an upsert keyed on a natural unique, and it refuses to run against
 * anything but a local database.
 *
 * Usage (from the repo root):
 *
 *   npx ts-node prisma/seed-qa-nav-roles.ts
 *
 * Password for every account: secret42 (the same one prisma/seed.ts uses).
 */
import { Permission, PrismaClient } from '@prisma/client';
import { hash } from 'argon2';

import { seedWorkspaceFixtures } from './seeds/workspace.seed';

const prisma = new PrismaClient();

/**
 * Every permission a role may hold. `CROSS_COMPANY_ACCESS` is excluded because only the
 * protected Super Admin role carries it and role CRUD rejects it with a 400 — granting
 * it here would produce a role the app itself would refuse to save.
 */
const ASSIGNABLE = Object.values(Permission).filter(
  (permission) => permission !== Permission.CROSS_COMPANY_ACCESS,
);

/**
 * The four accounts, chosen so each covers a distinct branch of `visibleModules()`
 * rather than just differing from one another.
 */
const FIXTURES = [
  {
    email: 'qa-all@buildcore.dev',
    username: 'qa-all',
    firstname: 'QA',
    lastname: 'All Access',
    roleName: 'QA All Access',
    permissions: ASSIGNABLE,
    // All nine modules.
    employeeCode: 'DEMO-9001',
  },
  {
    email: 'qa-supervisor@buildcore.dev',
    username: 'qa-supervisor',
    firstname: 'QA',
    lastname: 'Supervisor',
    roleName: 'QA Supervisor',
    permissions: [Permission.ATTENDANCE, Permission.MY_WORKSPACE],
    // HR & Payroll + My Workspace only. Also the account for the direct-URL refusal
    // pass, since it lacks DASHBOARD and must be redirected off the shell root.
    employeeCode: 'DEMO-9002',
  },
  {
    email: 'qa-payroll@buildcore.dev',
    username: 'qa-payroll',
    firstname: 'QA',
    lastname: 'Payroll Only',
    roleName: 'QA Payroll Only',
    // Proves the any-of rule: HR & Payroll is governed by EMPLOYEES | ATTENDANCE |
    // PAYROLL, and holding just one of the three must be enough to show it.
    permissions: [Permission.PAYROLL],
    employeeCode: null,
  },
  {
    email: 'qa-nomodules@buildcore.dev',
    username: 'qa-nomodules',
    firstname: 'QA',
    lastname: 'No Modules',
    roleName: 'QA No Modules',
    // Deliberately not an empty role. DATA_EXPORT is one of the nine permissions that
    // govern no sidebar module, so this account tests two things at once: the empty
    // state and landingRoute() returning null, *and* that holding a real permission
    // which controls nothing in the sidebar still yields nothing in the sidebar.
    permissions: [Permission.DATA_EXPORT],
    employeeCode: null,
  },
] as const;

async function main() {
  const url = process.env.DATABASE_URL ?? '';
  if (!/@(localhost|127\.0\.0\.1|host\.docker\.internal)[:/]/.test(url)) {
    throw new Error(
      'Refusing to run: DATABASE_URL does not point at a local database. ' +
        'These are throwaway QA accounts and must never reach a real one.',
    );
  }

  // The same RLS bypass src/common/prisma/rls-context.ts sets for system-level writes.
  await prisma.$executeRaw`SELECT set_config('app.is_super_admin', 'true', false)`;

  const password = await hash('secret42');

  for (const fixture of FIXTURES) {
    const role = await prisma.role.upsert({
      where: { name: fixture.roleName },
      // Rewritten on every run so an edited fixture takes effect rather than silently
      // keeping whatever the first run created.
      update: { permissions: [...fixture.permissions] },
      create: { name: fixture.roleName, permissions: [...fixture.permissions] },
    });

    const user = await prisma.user.upsert({
      where: { email: fixture.email },
      update: { status: 'active', mustChangePassword: false },
      create: {
        email: fixture.email,
        username: fixture.username,
        firstname: fixture.firstname,
        lastname: fixture.lastname,
        password,
        status: 'active',
        mustChangePassword: false,
      },
    });

    // Only this role, so a re-run after narrowing a fixture cannot leave the account
    // holding permissions the fixture no longer grants — effective permissions are the
    // union across roles, and a stale second role would quietly widen the test.
    await prisma.userRole.deleteMany({
      where: { userId: user.id, roleId: { not: role.id } },
    });
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: user.id, roleId: role.id } },
      update: {},
      create: { userId: user.id, roleId: role.id },
    });

    if (fixture.employeeCode) {
      // Without a Company -> Shift -> Site -> Employee chain every `/my/*` endpoint
      // 403s, and the punch screen would fail for a reason unrelated to navigation.
      await seedWorkspaceFixtures(
        prisma,
        user.id,
        fixture.employeeCode,
        fixture.username,
      );
    }

    console.log(
      `${fixture.email.padEnd(30)} role=${fixture.roleName.padEnd(16)} ` +
        `permissions=${fixture.permissions.length}`,
    );
  }

  console.log('\nPassword for all four: secret42');
  console.log('No rows deleted apart from superseded role assignments.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
