/**
 * Creates N sample employee accounts, fully wired for `/my/*`. NON-DESTRUCTIVE and
 * safe against a real database — it contains no deleteMany() of any kind, unlike
 * `prisma/seed.ts`, which wipes every account and must never run outside local dev.
 *
 * Each account gets: a password, a role carrying MY_WORKSPACE, membership of a
 * company, an Employee record on that company's site/shift, and opening leave
 * balances for the current financial year.
 *
 * Re-running is idempotent: an account that already exists keeps its employee code
 * and is only re-pointed at the company/site/shift, and its leave balances are
 * upserted rather than duplicated.
 *
 * Usage (local):
 *
 *   COMPANY_SHORT_CODE=DEMO npx ts-node prisma/create-sample-users.ts
 *
 * Usage (production — note the env is sourced, never printed):
 *
 *   sh -c 'set -a; . ./.env.production.local; set +a; \
 *     COMPANY_SHORT_CODE=BCD npx ts-node prisma/create-sample-users.ts'
 *
 * Env: COMPANY_SHORT_CODE (required — which company to attach to),
 * SAMPLE_USER_COUNT (default 3), SAMPLE_USER_PASSWORD (default "secret42"),
 * SAMPLE_USER_ROLE (default "Site User").
 */
import { PrismaClient } from '@prisma/client';
import { hash } from 'argon2';
import { financialYearOf } from '../src/hr/leave/leave-days';

const prisma = new PrismaClient();

const COUNT = Number(process.env.SAMPLE_USER_COUNT ?? 3);
const PASSWORD = process.env.SAMPLE_USER_PASSWORD ?? 'secret42';
const ROLE_NAME = process.env.SAMPLE_USER_ROLE ?? 'Site User';

/**
 * Opening balances, in days, for the current financial year.
 *
 * `lwp` is deliberately absent: leave without pay is the one type not checked
 * against a balance (FR-020), so a row for it would be inert.
 */
const LEAVE_BALANCES = [
  { leaveType: 'earned' as const, opening: 12, accrued: 3, used: 2 },
  { leaveType: 'casual' as const, opening: 6, accrued: 0, used: 1 },
  { leaveType: 'sick' as const, opening: 6, accrued: 0, used: 0 },
];

/**
 * Allocates the next employee code, realigning the sequence first if it has fallen
 * behind the codes actually in use.
 *
 * Not paranoia: production's `BCD-0001` was created outside the allocator, leaving
 * the sequence at 0 and the next allocation colliding on the (companyId,
 * employeeCode) unique constraint.
 */
async function nextEmployeeCode(
  companyId: string,
  shortCode: string,
): Promise<string> {
  const codes = await prisma.employee.findMany({
    where: { companyId },
    select: { employeeCode: true },
  });
  const highest = codes.reduce((max, e) => {
    const n = Number(e.employeeCode.split('-').pop());
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);

  const sequence = await prisma.employeeCodeSequence.findUnique({
    where: { companyId },
  });
  if (!sequence) {
    await prisma.employeeCodeSequence.create({
      data: { companyId, lastNumber: highest },
    });
  } else if (sequence.lastNumber < highest) {
    await prisma.employeeCodeSequence.update({
      where: { companyId },
      data: { lastNumber: highest },
    });
  }

  // One atomic statement, matching EmployeeCodeService: concurrent callers can
  // never observe the same number twice.
  const rows = await prisma.$queryRaw<{ lastNumber: number }[]>`
    UPDATE "settings"."EmployeeCodeSequence"
    SET "lastNumber" = "lastNumber" + 1
    WHERE "companyId" = ${companyId}
    RETURNING "lastNumber"
  `;
  return `${shortCode}-${String(rows[0].lastNumber).padStart(4, '0')}`;
}

async function main() {
  const shortCode = process.env.COMPANY_SHORT_CODE;
  if (!shortCode) {
    throw new Error('COMPANY_SHORT_CODE is required (e.g. DEMO locally, BCD in production)');
  }

  // The same RLS bypass src/common/prisma/rls-context.ts sets for system-level
  // writes, session-wide since this is one short-lived connection.
  await prisma.$executeRaw`SELECT set_config('app.is_super_admin', 'true', false)`;

  const company = await prisma.company.findFirst({ where: { shortCode } });
  if (!company) {
    throw new Error(`No company with short code "${shortCode}" in this database.`);
  }
  const site = await prisma.site.findFirst({ where: { companyId: company.id } });
  const shift = await prisma.shift.findFirst({ where: { companyId: company.id } });
  if (!site || !shift) {
    throw new Error(
      `Company ${company.name} needs both a Site and a Shift before employees can be attached.`,
    );
  }
  const role = await prisma.role.findUnique({ where: { name: ROLE_NAME } });
  if (!role) {
    throw new Error(`No "${ROLE_NAME}" role in this database.`);
  }

  const financialYear = financialYearOf(new Date());
  const password = await hash(PASSWORD);

  console.log(
    `Company ${company.name} (${company.shortCode}) | site ${site.name} | ` +
      `shift ${shift.name} | role ${ROLE_NAME} | FY ${financialYear}\n`,
  );

  for (let i = 1; i <= COUNT; i += 1) {
    const displayName = `SampleUser${i}`;
    // Lowercase: AuthService.findByIdentifier() lowercases the submitted identifier
    // before lookup, so a mixed-case username could never be logged in with.
    const username = displayName.toLowerCase();
    const email = `${username}@buildcore.dev`;

    const user = await prisma.user.upsert({
      where: { email },
      create: {
        email,
        username,
        displayName,
        firstname: 'Sample',
        lastname: `User ${i}`,
        password,
        companyId: company.id,
        status: 'active',
      },
      update: { password, companyId: company.id, status: 'active' },
    });

    const hasRole = await prisma.userRole.findFirst({
      where: { userId: user.id, roleId: role.id },
    });
    if (!hasRole) {
      await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
    }

    const existingEmployee = await prisma.employee.findFirst({
      where: { userId: user.id },
    });
    const employee = existingEmployee
      ? await prisma.employee.update({
          where: { id: existingEmployee.id },
          data: { companyId: company.id, siteId: site.id, shiftId: shift.id },
        })
      : await prisma.employee.create({
          data: {
            userId: user.id,
            companyId: company.id,
            siteId: site.id,
            shiftId: shift.id,
            employeeCode: await nextEmployeeCode(company.id, company.shortCode),
          },
        });

    for (const balance of LEAVE_BALANCES) {
      await prisma.leaveBalance.upsert({
        where: {
          employeeId_leaveType_financialYear: {
            employeeId: employee.id,
            leaveType: balance.leaveType,
            financialYear,
          },
        },
        create: { employeeId: employee.id, financialYear, ...balance },
        update: {
          opening: balance.opening,
          accrued: balance.accrued,
          used: balance.used,
        },
      });
    }

    console.log(
      `${displayName.padEnd(12)} ${email.padEnd(30)} ${employee.employeeCode}` +
        `${existingEmployee ? ' [existing]' : ' [created]'}`,
    );
  }

  console.log('\nLeave balances per account (days):');
  for (const b of LEAVE_BALANCES) {
    console.log(
      `  ${b.leaveType.padEnd(7)} opening ${b.opening}, accrued ${b.accrued}, ` +
        `used ${b.used} -> balance ${b.opening + b.accrued - b.used}`,
    );
  }
  console.log('\n--- DONE (no rows deleted) ---');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
