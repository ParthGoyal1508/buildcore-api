import { PrismaClient } from '@prisma/client';

/**
 * Local development fixtures for the My Workspace feature (003).
 *
 * Every `/my/*` endpoint resolves the caller's `Employee` from their token and
 * accepts no employee identifier (FR-028), so an account with no Employee row gets
 * a 403 from all of them. Creating that row is HR & Payroll's job (spec 005) and
 * creating a Site is Projects' (spec 008) — neither feature exists yet, which would
 * otherwise leave My Workspace impossible to exercise by hand until they do.
 *
 * This seeds the minimum chain — Company → Shift → Site → Employee — so a developer
 * can log in and immediately enrol and punch. Find-or-create rather than
 * delete-and-recreate, so re-running the seed neither duplicates fixtures nor
 * destroys companies created through the Settings UI.
 */

/** Demo company short code; also the find key that makes this idempotent. */
const DEMO_SHORT_CODE = 'DEMO';

/**
 * Geofence centre for the demo site.
 *
 * Env-overridable because the useful test is location-dependent: to see a clean
 * in-range punch you need the site to be roughly where you actually are, and to see
 * the exception path you need it not to be. Defaults to central Mumbai, which for
 * most developers will be far away — so the out-of-geofence exception is what you
 * get out of the box, and setting these to your own coordinates is what
 * demonstrates the in-range case.
 */
const DEFAULT_LATITUDE = 19.076;
const DEFAULT_LONGITUDE = 72.8777;
/** Generous by construction-site standards, so small GPS drift doesn't flip the
 * verdict while you are testing. */
const DEFAULT_RADIUS_METERS = 500;

function numberFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export async function seedWorkspaceFixtures(
  prisma: PrismaClient,
  userId: string,
): Promise<void> {
  const company =
    (await prisma.company.findFirst({ where: { shortCode: DEMO_SHORT_CODE } })) ??
    (await prisma.company.create({
      data: {
        name: 'Demo Constructions',
        shortCode: DEMO_SHORT_CODE,
        payrollLockDay: 7,
        pfEmployerRate: 12,
        esicEmployerRate: 3.25,
        gratuityRate: 4.81,
        bonusRate: 8.33,
      },
    }));

  // The account must belong to the company its Employee record does, or the
  // caller's RLS company context won't match the rows they own.
  await prisma.user.update({
    where: { id: userId },
    data: { companyId: company.id },
  });

  const shift =
    (await prisma.shift.findFirst({
      where: { companyId: company.id, name: 'General Shift' },
    })) ??
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

  const latitude = numberFromEnv(process.env.SEED_SITE_LATITUDE, DEFAULT_LATITUDE);
  const longitude = numberFromEnv(
    process.env.SEED_SITE_LONGITUDE,
    DEFAULT_LONGITUDE,
  );
  const geofenceRadiusMeters = numberFromEnv(
    process.env.SEED_SITE_RADIUS_METERS,
    DEFAULT_RADIUS_METERS,
  );

  const existingSite = await prisma.site.findFirst({
    where: { companyId: company.id, name: 'Demo Site' },
  });
  const site = existingSite
    ? // Updated on re-seed so changing SEED_SITE_LATITUDE and re-running actually
      // moves the geofence, rather than silently keeping the first value.
      await prisma.site.update({
        where: { id: existingSite.id },
        data: { latitude, longitude, geofenceRadiusMeters },
      })
    : await prisma.site.create({
        data: {
          companyId: company.id,
          name: 'Demo Site',
          latitude,
          longitude,
          geofenceRadiusMeters,
          // Sunday.
          weeklyOffDay: 0,
          holidays: [],
        },
      });

  const existingEmployee = await prisma.employee.findFirst({
    where: { userId },
  });
  if (!existingEmployee) {
    await prisma.employee.create({
      data: {
        userId,
        companyId: company.id,
        siteId: site.id,
        shiftId: shift.id,
        employeeCode: `${DEMO_SHORT_CODE}-0001`,
      },
    });
  } else {
    await prisma.employee.update({
      where: { id: existingEmployee.id },
      data: { companyId: company.id, siteId: site.id, shiftId: shift.id },
    });
  }

  console.log(
    `My Workspace fixtures: company "${company.name}", site "${site.name}" ` +
      `at ${latitude},${longitude} (radius ${geofenceRadiusMeters}m), ` +
      `employee ${DEMO_SHORT_CODE}-0001 linked to the admin account.`,
  );
  console.log(
    '  To test an in-geofence punch, set SEED_SITE_LATITUDE / SEED_SITE_LONGITUDE ' +
      'to your own coordinates and re-run `npm run seed`.',
  );
}
