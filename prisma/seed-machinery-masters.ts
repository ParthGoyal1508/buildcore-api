/**
 * Seeds the ten default equipment categories and the equipment document types for companies that
 * already exist — safe to run against a real database, and additive only.
 *
 * ## Why existing companies need this
 *
 * `CompaniesService.create` seeded six masters and skipped the two machinery ones until
 * 2026-10-04 (006 T058). Both `seedDefaultsForCompany` methods existed, were correct, and were
 * called by nothing outside `prisma/seed-demo.ts` — so every company created through the
 * application had no equipment categories and no equipment document types. Measured on that date:
 * **zero rows for both live companies.**
 *
 * The cost was a refusal: a machine cannot be registered without a category, so the first person
 * to try was stopped until they created one by hand.
 *
 * **Not a benchmark problem, though an earlier draft of this comment said it was.**
 * `DEFAULT_EQUIPMENT_CATEGORIES` carries a name and a meter type and nothing else, so every
 * category this seeds has a **null** fuel benchmark — exactly like one created by hand. Item 13's
 * variance alert still needs somebody to set a benchmark per category either way. Corrected after
 * checking the constant rather than before writing about it.
 *
 * Creation is fixed. This is for the companies created before it was.
 *
 * ## Why it is safe
 *
 * `createMany` with `skipDuplicates`, which is what the service itself uses — a company that has a
 * category of the same name keeps its own, including any benchmark somebody set by hand. Nothing
 * is updated and nothing is deleted. Reports before it writes, and writes only under `APPLY=1`.
 *
 * Usage (from the repo root):
 *
 *   npx ts-node prisma/seed-machinery-masters.ts            # report only
 *   APPLY=1 npx ts-node prisma/seed-machinery-masters.ts    # seed the missing rows
 */
import 'dotenv/config';

import { MeterType, PrismaClient } from '@prisma/client';

import {
  DEFAULT_EQUIPMENT_CATEGORIES,
  DEFAULT_EQUIPMENT_DOC_TYPES,
} from '../src/plant/constants/plant.constants';

const prisma = new PrismaClient();
const APPLY = process.env.APPLY === '1';

async function main(): Promise<void> {
  const companies = await prisma.company.findMany({
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });

  let written = 0;

  for (const company of companies) {
    const [categories, docTypes] = await Promise.all([
      prisma.equipmentCategory.count({ where: { companyId: company.id } }),
      prisma.equipmentDocType.count({ where: { companyId: company.id } }),
    ]);

    console.log(
      `\n${company.name}\n  categories ${categories}, document types ${docTypes}`,
    );

    const needsCategories = DEFAULT_EQUIPMENT_CATEGORIES.length - categories;
    const needsDocTypes = DEFAULT_EQUIPMENT_DOC_TYPES.length - docTypes;
    if (needsCategories <= 0 && needsDocTypes <= 0) {
      console.log('  nothing missing');
      continue;
    }

    if (!APPLY) {
      console.log(
        `  would seed up to ${Math.max(
          needsCategories,
          0,
        )} category(ies) and ` +
          `${Math.max(needsDocTypes, 0)} document type(s)`,
      );
      written += 1;
      continue;
    }

    // `skipDuplicates`, exactly as the services do: a category a company already has keeps its own
    // row, and any fuel benchmark somebody set on it by hand is untouched.
    const cats = await prisma.equipmentCategory.createMany({
      data: DEFAULT_EQUIPMENT_CATEGORIES.map((category) => ({
        companyId: company.id,
        name: category.name,
        meterType: category.meterType as MeterType,
      })),
      skipDuplicates: true,
    });
    const types = await prisma.equipmentDocType.createMany({
      data: DEFAULT_EQUIPMENT_DOC_TYPES.map((type) => ({
        companyId: company.id,
        name: type.name,
        alertDays: type.alertDays,
      })),
      skipDuplicates: true,
    });
    console.log(
      `  seeded ${cats.count} category(ies) and ${types.count} document type(s)`,
    );
    written += cats.count + types.count;
  }

  console.log(
    `\n${APPLY ? 'Wrote' : 'Would write to'} ${written} ${
      APPLY ? 'row(s)' : 'company(ies)'
    }.`,
  );
  if (!APPLY && written > 0) {
    console.log('Nothing was written. Re-run with APPLY=1 to apply.');
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
