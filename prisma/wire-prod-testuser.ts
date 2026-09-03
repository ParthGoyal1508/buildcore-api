/**
 * One-off, NON-DESTRUCTIVE fixture wiring for a single account, safe to run
 * against a real database.
 *
 * Unlike `prisma/seed.ts` — which wipes every user, punch, enrolment and audit row
 * before inserting demo accounts, and throws if NODE_ENV is production — this
 * script contains no deleteMany() of any kind. It only finds-or-creates the
 * Company -> Shift -> Site -> Employee chain an account needs before any `/my/*`
 * endpoint will answer it, and grants a role carrying MY_WORKSPACE if it has none.
 *
 * It prints the database's existing state before changing anything, so the run
 * itself doubles as the inspection.
 *
 * Usage (from the repo root):
 *
 *   sh -c 'set -a; . ./.env.production.local; set +a; \
 *     USER_EMAIL=testuser@buildcore.dev npx ts-node prisma/wire-prod-testuser.ts'
 *
 * Optional: SEED_SITE_LATITUDE / SEED_SITE_LONGITUDE place the geofence centre if a
 * Site has to be created. Without them it defaults to central Mumbai, which will
 * put most punches out of range — recorded as a geofence exception, not a failure.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const EMAIL = (process.env.USER_EMAIL ?? 'testuser@buildcore.dev')
  .trim()
  .toLowerCase();

async function main() {
  // The same RLS bypass src/common/prisma/rls-context.ts sets for system-level
  // writes, session-wide since this is one short-lived connection. Harmless if the
  // connecting role already bypasses RLS.
  await prisma.$executeRaw`SELECT set_config('app.is_super_admin', 'true', false)`;

  // ---------------------------------------------------------------- inspection
  const user = await prisma.user.findUnique({ where: { email: EMAIL } });
  if (!user) {
    throw new Error(`No account ${EMAIL} in this database — aborting.`);
  }

  const companies = await prisma.company.findMany({
    select: { id: true, name: true, shortCode: true },
    orderBy: { createdAt: 'asc' },
  });
  const sites = await prisma.site.findMany({
    select: { id: true, name: true, companyId: true },
  });
  const shifts = await prisma.shift.findMany({
    select: { id: true, name: true, companyId: true },
  });
  const roles = await prisma.userRole.findMany({
    where: { userId: user.id },
    select: { role: { select: { name: true, permissions: true } } },
  });
  const employee = await prisma.employee.findFirst({ where: { userId: user.id } });

  console.log('--- STATE BEFORE ---');
  console.log('account:', { email: user.email, companyId: user.companyId });
  console.log('companies:', companies.map((c) => `${c.name} (${c.shortCode})`));
  console.log('sites:', sites.map((s) => s.name));
  console.log('shifts:', shifts.map((s) => s.name));
  console.log('roles:', roles.map((r) => r.role.name));
  console.log('employee:', employee ? employee.employeeCode : 'none');

  // ------------------------------------------------------------------- company
  // A real company is preferred over the local DEMO fixture, and one is invented
  // only if this database has no company at all — demo rows in a production tenant
  // list outlive their usefulness.
  const real = companies.find((c) => c.shortCode !== 'DEMO');
  const existing = real ?? companies[0];
  const company =
    existing ??
    (await prisma.company.create({
      data: {
        name: 'Demo Constructions',
        shortCode: 'DEMO',
        payrollLockDay: 7,
        pfEmployerRate: 12,
        esicEmployerRate: 3.25,
        gratuityRate: 4.81,
        bonusRate: 8.33,
      },
    }));
  console.log(
    `\nusing company: ${company.name} (${company.shortCode})` +
      `${existing ? ' [existing]' : ' [created]'}`,
  );

  // The account must belong to the company its Employee record does, or the
  // caller's RLS company context won't match the rows they own.
  await prisma.user.update({
    where: { id: user.id },
    data: { companyId: company.id },
  });

  // --------------------------------------------------------------------- shift
  const existingShift = shifts.find((s) => s.companyId === company.id);
  const shift =
    existingShift ??
    (await prisma.shift.create({
      data: {
        companyId: company.id,
        name: 'General Shift',
        // Postgres `time` values: only the time-of-day component is meaningful.
        inTime: new Date('1970-01-01T09:00:00.000Z'),
        outTime: new Date('1970-01-01T18:00:00.000Z'),
        graceMinutes: 10,
      },
    }));
  console.log(
    `using shift: ${shift.name}${existingShift ? ' [existing]' : ' [created]'}`,
  );

  // ---------------------------------------------------------------------- site
  const existingSite = sites.find((s) => s.companyId === company.id);
  const site =
    existingSite ??
    (await prisma.site.create({
      data: {
        companyId: company.id,
        name: 'Head Office',
        latitude: Number(process.env.SEED_SITE_LATITUDE ?? 19.076),
        longitude: Number(process.env.SEED_SITE_LONGITUDE ?? 72.8777),
        geofenceRadiusMeters: 500,
        // Sunday.
        weeklyOffDay: 0,
      },
    }));
  console.log(
    `using site: ${site.name}${existingSite ? ' [existing]' : ' [created]'}`,
  );

  // ---------------------------------------------------------------------- role
  // Only granted if the account cannot already reach `/my/*`, so an account that
  // already has a real role keeps it rather than collecting a second one.
  const hasWorkspace = roles.some((r) =>
    (r.role.permissions as string[]).includes('MY_WORKSPACE'),
  );
  if (hasWorkspace) {
    console.log('role: already carries MY_WORKSPACE, left alone');
  } else {
    const siteUser = await prisma.role.findUnique({ where: { name: 'Site User' } });
    if (!siteUser) {
      throw new Error('No "Site User" role in this database — aborting role grant.');
    }
    await prisma.userRole.create({
      data: { userId: user.id, roleId: siteUser.id },
    });
    console.log('granted role: Site User (DASHBOARD + MY_WORKSPACE + ATTENDANCE)');
  }

  // ------------------------------------------------------------------ employee
  if (employee) {
    await prisma.employee.update({
      where: { id: employee.id },
      data: { companyId: company.id, siteId: site.id, shiftId: shift.id },
    });
    console.log(
      `employee: reused ${employee.employeeCode}, re-pointed at this company/site/shift`,
    );
  } else {
    // The company's code series, not a hand-picked string: the same atomic
    // `UPDATE ... RETURNING` EmployeeCodeService uses, so this allocation cannot
    // collide with one the app makes concurrently.
    await prisma.employeeCodeSequence.upsert({
      where: { companyId: company.id },
      create: { companyId: company.id, lastNumber: 0 },
      update: {},
    });
    const rows = await prisma.$queryRaw<{ lastNumber: number }[]>`
      UPDATE "settings"."EmployeeCodeSequence"
      SET "lastNumber" = "lastNumber" + 1
      WHERE "companyId" = ${company.id}
      RETURNING "lastNumber"
    `;
    const employeeCode = `${company.shortCode}-${String(rows[0].lastNumber).padStart(4, '0')}`;
    await prisma.employee.create({
      data: {
        userId: user.id,
        companyId: company.id,
        siteId: site.id,
        shiftId: shift.id,
        employeeCode,
      },
    });
    console.log(`employee: created ${employeeCode}`);
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
