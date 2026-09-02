import { PrismaClient } from '@prisma/client';
import { DEFAULT_VENDOR_CATEGORIES } from '../../src/settings/vendor-categories/vendor-categories.service';

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

/**
 * The claim categories US8's form offers, with deliberately varied receipt rules so
 * all three cases are reachable by hand: a threshold, `0` (receipt always
 * required), and `null` (never required).
 *
 * Feature 005 owns creating these for real; seeding them here is what makes the
 * employee-side claim form exercisable before that exists.
 */
const REIMBURSEMENT_CATEGORIES = [
  { code: 'TRAVEL', name: 'Travel', receiptRequiredAbove: 1000 },
  { code: 'FUEL', name: 'Fuel', receiptRequiredAbove: 500 },
  { code: 'FOOD', name: 'Food', receiptRequiredAbove: 500 },
  { code: 'MEDICAL', name: 'Medical', receiptRequiredAbove: 0 },
  { code: 'OTHER', name: 'Other', receiptRequiredAbove: null },
];

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
  // Every account seeded here needs its own code: Employee is unique on
  // (companyId, employeeCode), so a second account reusing DEMO-0001 would collide
  // rather than get its own employee record.
  employeeCode = `${DEMO_SHORT_CODE}-0001`,
  accountLabel = 'admin',
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
        },
      });

  // Upserted rather than created: re-seeding must not duplicate a company's
  // categories, and an admin who edited one through Settings keeps their change to
  // the name while the code stays the stable key.
  for (const category of REIMBURSEMENT_CATEGORIES) {
    await prisma.reimbursementCategory.upsert({
      where: {
        companyId_code: { companyId: company.id, code: category.code },
      },
      create: { companyId: company.id, ...category },
      update: {},
    });
  }

  // The six vendor categories a company starts with (007 US1). Seeded here for the
  // demo company because CompaniesService.create() — which does this for real
  // companies — is not on the path a local seed takes.
  await prisma.vendorCategory.createMany({
    data: DEFAULT_VENDOR_CATEGORIES.map((category) => ({
      companyId: company.id,
      name: category.name,
      description: category.description,
      isDefault: true,
    })),
    skipDuplicates: true,
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
        employeeCode,
      },
    });
  } else {
    await prisma.employee.update({
      where: { id: existingEmployee.id },
      data: { companyId: company.id, siteId: site.id, shiftId: shift.id, employeeCode },
    });
  }

  console.log(
    `My Workspace fixtures: company "${company.name}", site "${site.name}" ` +
      `at ${latitude},${longitude} (radius ${geofenceRadiusMeters}m), ` +
      `employee ${employeeCode} linked to the ${accountLabel} account.`,
  );
  console.log(
    '  To test an in-geofence punch, set SEED_SITE_LATITUDE / SEED_SITE_LONGITUDE ' +
      'to your own coordinates and re-run `npm run seed`.',
  );
}
