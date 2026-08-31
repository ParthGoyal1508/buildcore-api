import { PrismaClient } from '@prisma/client';
import { hash } from 'argon2';
import { seedDefaultRoles } from './seeds/settings.seed';
import { seedWorkspaceFixtures } from './seeds/workspace.seed';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding...');

  // DESTRUCTIVE — local development fixtures only. The deleteMany() calls below
  // remove every account, session and audit record in the target database. Never
  // point this at production: the default roles it seeds are applied there by
  // migration 20260830090000_seed_default_roles instead (see DEPLOYMENT.md §8a).
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'prisma/seed.ts is destructive and must never run against production — ' +
        'default roles are seeded by migration 20260830090000_seed_default_roles.',
    );
  }

  // Standalone script, outside the Nest app's DI — set the same RLS bypass
  // src/common/prisma/rls-context.ts's withRlsContext() sets for system-level
  // writes, session-wide (`is_local = false`) since this whole script is one
  // short-lived connection anyway. Harmless if the connecting role happens to be
  // a Postgres superuser (bypasses RLS regardless), required if it isn't.
  await prisma.$executeRaw`SELECT set_config('app.is_super_admin', 'true', false)`;
  // My Workspace rows hang off Employee, which hangs off the accounts wiped below,
  // so they are cleared first. Site/Shift/Company are deliberately NOT deleted:
  // seedWorkspaceFixtures() finds-or-creates them, so re-seeding neither duplicates
  // fixtures nor destroys companies created through the Settings UI.
  await prisma.punchRecord.deleteMany();
  await prisma.faceEnrolment.deleteMany();
  await prisma.reEnrolmentRequest.deleteMany();
  await prisma.leaveApplication.deleteMany();
  await prisma.leaveBalance.deleteMany();
  await prisma.employee.deleteMany();

  // FK-dependent rows first — every login/refresh creates RefreshToken and
  // AuditLogEntry rows referencing the account, which otherwise block re-seeding.
  await prisma.refreshToken.deleteMany();
  await prisma.auditLogEntry.deleteMany();
  await prisma.userRole.deleteMany();
  await prisma.user.deleteMany();

  // The nine default roles (002 FR-006). Also applied by migration
  // 20260830090000_seed_default_roles, which is what production relies on — this
  // script must never run there, since the deleteMany() calls above would wipe real
  // accounts. Kept here so a local `migrate reset` + seed still ends up complete.
  await seedDefaultRoles(prisma);

  const password = await hash('secret42');

  const admin = await prisma.user.create({
    data: {
      email: 'admin@buildcore.dev',
      username: 'admin',
      firstname: 'Super',
      lastname: 'Admin',
      password,
    },
  });

  const superAdminRole = await prisma.role.findUniqueOrThrow({
    where: { name: 'Super Admin' },
  });
  await prisma.userRole.create({
    data: { userId: admin.id, roleId: superAdminRole.id },
  });

  const user = await prisma.user.create({
    data: {
      email: 'user@buildcore.dev',
      username: 'user',
      firstname: 'Test',
      lastname: 'User',
      password,
    },
  });

  // Site User — DASHBOARD + MY_WORKSPACE + ATTENDANCE (002 FR-006). The narrowest
  // default role that can actually reach `/my/*`, which is what this account is for:
  // exercising the employee side without Super Admin's blanket permissions hiding a
  // missing authorization check.
  const siteUserRole = await prisma.role.findUniqueOrThrow({
    where: { name: 'Site User' },
  });
  await prisma.userRole.create({
    data: { userId: user.id, roleId: siteUserRole.id },
  });

  // Company → Shift → Site → Employee for both accounts, so `/my/*` is reachable
  // immediately. Without this every My Workspace endpoint returns 403, since none of
  // them accept an employee identifier (FR-028). Both land in the same demo company
  // and site, on separate employee codes.
  await seedWorkspaceFixtures(prisma, admin.id);
  await seedWorkspaceFixtures(prisma, user.id, 'DEMO-0002', 'user');

  console.log({ admin, user });
}

main()
  .catch((e) => console.error(e))
  .finally(async () => {
    await prisma.$disconnect();
  });
