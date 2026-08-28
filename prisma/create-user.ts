/**
 * Creates (or updates) a single account — safe to run against a real database.
 *
 * Unlike `prisma/seed.ts`, this NEVER deletes anything. seed.ts wipes every
 * user, refresh token, and audit row before inserting its demo accounts, which
 * is correct for a local reset and catastrophic against a deployed database.
 * This script is the one to use anywhere real data exists.
 *
 * Usage (from the repo root):
 *
 *   DATABASE_URL="<target database url>" \
 *   USER_EMAIL=admin@yourcompany.com \
 *   USER_USERNAME=admin \
 *   USER_PASSWORD='a-strong-password' \
 *   USER_FIRSTNAME=Site USER_LASTNAME=Admin \
 *   USER_ROLE="Super Admin" \
 *   npx ts-node prisma/create-user.ts
 *
 * USER_ROLE is optional — omit it to create an account with no role (no
 * permissions). Re-running with the same email updates that account's password
 * and name rather than creating a duplicate, so it doubles as a password reset.
 */
import { PrismaClient } from '@prisma/client';
import { hash } from 'argon2';

const prisma = new PrismaClient();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function main() {
  const email = required('USER_EMAIL').trim().toLowerCase();
  const username = required('USER_USERNAME').trim().toLowerCase();
  const rawPassword = required('USER_PASSWORD');
  const firstname = process.env.USER_FIRSTNAME || null;
  const lastname = process.env.USER_LASTNAME || null;
  const roleName = process.env.USER_ROLE || null;

  if (rawPassword.length < 8) {
    throw new Error('USER_PASSWORD must be at least 8 characters');
  }

  // Same RLS bypass seed.ts uses — this script writes as the system, not as a
  // company-scoped caller (src/common/prisma/rls-context.ts).
  await prisma.$executeRaw`SELECT set_config('app.is_super_admin', 'true', false)`;

  const password = await hash(rawPassword);

  const user = await prisma.user.upsert({
    where: { email },
    // Deliberately narrow: an existing account keeps its status, company, and
    // any roles beyond the one named below. Names are only touched when
    // actually supplied, so re-running purely to reset a password doesn't
    // blank out the account holder's name.
    update: {
      password,
      mustChangePassword: false,
      ...(firstname !== null ? { firstname } : {}),
      ...(lastname !== null ? { lastname } : {}),
    },
    create: { email, username, password, firstname, lastname },
  });

  console.log(`Account ready: ${user.email} (@${user.username})`);

  if (roleName) {
    const role = await prisma.role.findUnique({ where: { name: roleName } });
    if (!role) {
      const available = await prisma.role.findMany({ select: { name: true } });
      throw new Error(
        `Role "${roleName}" not found. Available roles: ${
          available.map((r) => r.name).join(', ') || '(none)'
        }`,
      );
    }
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: user.id, roleId: role.id } },
      update: {},
      create: { userId: user.id, roleId: role.id },
    });
    console.log(`Role assigned: ${role.name}`);
  } else {
    console.log('No USER_ROLE given — account has no permissions yet.');
  }
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
