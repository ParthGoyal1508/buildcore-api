import { PrismaClient } from '@prisma/client';
import { hash } from 'argon2';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding...');

  // Standalone script, outside the Nest app's DI — set the same RLS bypass
  // src/common/prisma/rls-context.ts's withRlsContext() sets for system-level
  // writes, session-wide (`is_local = false`) since this whole script is one
  // short-lived connection anyway. Harmless if the connecting role happens to be
  // a Postgres superuser (bypasses RLS regardless), required if it isn't.
  await prisma.$executeRaw`SELECT set_config('app.is_super_admin', 'true', false)`;
  // FK-dependent rows first — every login/refresh creates RefreshToken and
  // AuditLogEntry rows referencing the account, which otherwise block re-seeding.
  await prisma.refreshToken.deleteMany();
  await prisma.auditLogEntry.deleteMany();
  await prisma.userRole.deleteMany();
  await prisma.user.deleteMany();

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

  console.log({ admin, user });
}

main()
  .catch((e) => console.error(e))
  .finally(async () => {
    await prisma.$disconnect();
  });
