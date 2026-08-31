import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  await prisma.$executeRaw`SELECT set_config('app.is_super_admin', 'true', false)`;

  const companies = await prisma.company.findMany({
    select: { id: true, name: true, shortCode: true },
  });
  for (const c of companies) {
    const employees = await prisma.employee.findMany({
      where: { companyId: c.id },
      select: { employeeCode: true, userId: true },
      orderBy: { employeeCode: 'asc' },
    });
    const seq = await prisma.employeeCodeSequence.findUnique({
      where: { companyId: c.id },
    });
    console.log(`company ${c.name} (${c.shortCode})`);
    console.log('  employees:', employees.map((e) => e.employeeCode));
    console.log('  sequence lastNumber:', seq ? seq.lastNumber : 'NO ROW');
  }

  const user = await prisma.user.findUnique({
    where: { email: 'testuser@buildcore.dev' },
    select: { id: true, companyId: true },
  });
  console.log('\ntestuser:', user);
  const roles = await prisma.userRole.findMany({
    where: { userId: user!.id },
    select: { role: { select: { name: true } } },
  });
  console.log('testuser roles:', roles.map((r) => r.role.name));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
