/**
 * Seeds a company's reimbursement categories. NON-DESTRUCTIVE and safe against a
 * real database — it upserts on the (companyId, code) key and never deletes, so an
 * admin's later edit to a name survives a re-run.
 *
 * Feature 005 owns creating these for real. Until it exists there is no UI or
 * endpoint that can, and without at least one category the employee-side claim form
 * has an empty picker and nothing can be filed (US8 AC1) — so a deployment needs
 * this run once per company.
 *
 * Usage (local):
 *
 *   COMPANY_SHORT_CODE=DEMO npx ts-node prisma/seed-reimbursement-categories.ts
 *
 * Usage (production — the env is sourced, never printed):
 *
 *   sh -c 'set -a; . ./.env.production.local; set +a; \
 *     COMPANY_SHORT_CODE=BCD npx ts-node prisma/seed-reimbursement-categories.ts'
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Receipt rules vary on purpose so all three cases are reachable: a threshold,
 * `0` (a receipt is always required), and `null` (never required).
 */
const CATEGORIES = [
  { code: 'TRAVEL', name: 'Travel', receiptRequiredAbove: 1000 },
  { code: 'FUEL', name: 'Fuel', receiptRequiredAbove: 500 },
  { code: 'FOOD', name: 'Food', receiptRequiredAbove: 500 },
  { code: 'MEDICAL', name: 'Medical', receiptRequiredAbove: 0 },
  { code: 'OTHER', name: 'Other', receiptRequiredAbove: null },
];

async function main() {
  const shortCode = process.env.COMPANY_SHORT_CODE;
  if (!shortCode) {
    throw new Error('COMPANY_SHORT_CODE is required (e.g. DEMO locally, BCD in production)');
  }

  await prisma.$executeRaw`SELECT set_config('app.is_super_admin', 'true', false)`;

  const company = await prisma.company.findFirst({ where: { shortCode } });
  if (!company) {
    throw new Error(`No company with short code "${shortCode}" in this database.`);
  }

  for (const category of CATEGORIES) {
    await prisma.reimbursementCategory.upsert({
      where: { companyId_code: { companyId: company.id, code: category.code } },
      create: { companyId: company.id, ...category },
      update: {},
    });
  }

  const all = await prisma.reimbursementCategory.findMany({
    where: { companyId: company.id },
    orderBy: { name: 'asc' },
  });
  console.log(`${company.name} (${company.shortCode}) categories:`);
  for (const c of all) {
    console.log(
      `  ${c.name.padEnd(10)} receipt required above: ` +
        `${c.receiptRequiredAbove === null ? 'never' : c.receiptRequiredAbove}` +
        `${c.isActive ? '' : '  [inactive]'}`,
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
