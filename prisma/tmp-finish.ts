import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const EMAIL = 'testuser@buildcore.dev';

async function main() {
  await prisma.$executeRaw`SELECT set_config('app.is_super_admin', 'true', false)`;

  const user = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL } });
  const company = await prisma.company.findFirstOrThrow({
    where: { id: user.companyId! },
  });
  const site = await prisma.site.findFirstOrThrow({
    where: { companyId: company.id },
  });
  const shift = await prisma.shift.findFirstOrThrow({
    where: { companyId: company.id },
  });

  const existing = await prisma.employee.findFirst({ where: { userId: user.id } });
  if (existing) {
    console.log(`employee already present: ${existing.employeeCode}`);
    return;
  }

  // The sequence was behind the codes actually in use — BCD-0001 predates the
  // allocator — so advance it past the highest existing suffix before allocating.
  // Left alone it would keep handing out codes that already exist, for the app as
  // much as for this script.
  const codes = await prisma.employee.findMany({
    where: { companyId: company.id },
    select: { employeeCode: true },
  });
  const highest = codes.reduce((max, e) => {
    const n = Number(e.employeeCode.split('-').pop());
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);

  await prisma.employeeCodeSequence.update({
    where: { companyId: company.id },
    data: { lastNumber: highest },
  });
  console.log(`sequence realigned to ${highest} (highest live code)`);

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
  console.log(`employee created: ${employeeCode}`);
  console.log(`  company: ${company.name} (${company.shortCode})`);
  console.log(`  site:    ${site.name} @ ${site.latitude},${site.longitude} r=${site.geofenceRadiusMeters}m`);
  console.log(`  shift:   ${shift.name}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
