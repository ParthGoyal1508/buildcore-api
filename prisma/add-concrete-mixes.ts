/**
 * Adds the client's two concrete mixes as composite items, with the MT raw materials they are made
 * of, to every company (039, 2026-10-21). For a database the dev seed never touches — production.
 *
 * Items only: no stock, purchases or issues. Material arrives through the app's own purchases.
 * Matched by name, so a second run adds nothing; an existing item of the same name in another unit
 * stops the run for that company rather than mixing units into a recipe.
 *
 *   DATABASE_URL=… npx ts-node prisma/add-concrete-mixes.ts            # dry run: says what it would add
 *   DATABASE_URL=… npx ts-node prisma/add-concrete-mixes.ts --apply    # writes
 */
import { ItemUnit, Prisma, PrismaClient } from '@prisma/client';

const APPLY = process.argv.includes('--apply');
const prisma = new PrismaClient();

const ITEMS = [
  {
    code: 'CEM-BULK',
    name: 'Cement (Bulk)',
    category: 'Cement & Binders',
    hsn: '2523',
  },
  {
    code: 'CEM-FLYASH',
    name: 'Fly Ash',
    category: 'Cement & Binders',
    hsn: '2621',
  },
  {
    code: 'AGG-CDUST',
    name: 'Crusher Dust',
    category: 'Aggregates',
    hsn: '2517',
  },
  {
    code: 'AGG-20MM-MT',
    name: 'Aggregate 20 mm',
    category: 'Aggregates',
    hsn: '2517',
  },
  {
    code: 'AGG-10MM-MT',
    name: 'Aggregate 10 mm',
    category: 'Aggregates',
    hsn: '2517',
  },
  { code: 'AGG-MSAND-MT', name: 'M Sand', category: 'Aggregates', hsn: '2517' },
] as const;

/** Per 1 Cum, in MT — the client's sheets. */
const MIXES: { name: string; parts: [string, number][] }[] = [
  {
    name: 'DLC Concrete for plant foundation',
    parts: [
      ['Cement (Bulk)', 0.08],
      ['Crusher Dust', 0.827],
      ['Aggregate 20 mm', 0.75],
      ['Aggregate 10 mm', 0.525],
      ['Fly Ash', 0.1],
    ],
  },
  {
    name: 'M20 Concrete for plant foundation',
    parts: [
      ['Cement (Bulk)', 0.18],
      ['M Sand', 0.827],
      ['Aggregate 20 mm', 0.75],
      ['Aggregate 10 mm', 0.525],
      ['Fly Ash', 0.08],
    ],
  },
];

async function forCompany(company: { id: string; name: string }) {
  await prisma.$transaction(async (tx) => {
    // Production connects as a role that RLS applies to; a cross-company script says so.
    await tx.$executeRaw`SELECT set_config('app.is_super_admin', 'true', true)`;

    const itemIds = new Map<string, string>();
    for (const spec of ITEMS) {
      const existing = await tx.item.findFirst({
        where: {
          companyId: company.id,
          OR: [{ name: spec.name }, { code: spec.code }],
        },
      });
      if (existing) {
        if (existing.unit !== ItemUnit.MT || existing.name !== spec.name) {
          throw new Error(
            `${company.name}: "${existing.name}" (${existing.code}, ${existing.unit}) is in the way of ` +
              `${spec.name} (${spec.code}, MT) — rename one, then run again.`,
          );
        }
        itemIds.set(spec.name, existing.id);
        console.log(`  item    ${spec.name} — already there`);
        continue;
      }
      const category = await tx.itemCategory.findFirst({
        where: { companyId: company.id, name: spec.category },
      });
      if (!category)
        throw new Error(`${company.name}: no "${spec.category}" category`);
      console.log(
        `  item    ${spec.name} (${spec.code}, MT) — ${
          APPLY ? 'added' : 'would add'
        }`,
      );
      if (APPLY) {
        const row = await tx.item.create({
          data: {
            companyId: company.id,
            code: spec.code,
            name: spec.name,
            categoryId: category.id,
            unit: ItemUnit.MT,
            hsnCode: spec.hsn,
          },
        });
        itemIds.set(spec.name, row.id);
      }
    }

    for (const mix of MIXES) {
      const existing = await tx.compositeItem.findFirst({
        where: { companyId: company.id, name: mix.name },
      });
      if (existing) {
        console.log(`  mix     ${mix.name} — already there`);
        continue;
      }
      console.log(
        `  mix     ${mix.name}, per 1 CUM — ${APPLY ? 'added' : 'would add'}`,
      );
      if (APPLY) {
        await tx.compositeItem.create({
          data: {
            companyId: company.id,
            name: mix.name,
            unit: ItemUnit.CUM,
            components: {
              create: mix.parts.map(([item, qty], position) => ({
                companyId: company.id,
                itemId: itemIds.get(item)!,
                qtyPerUnit: new Prisma.Decimal(qty),
                position,
              })),
            },
          },
        });
      }
    }
  });
}

async function main() {
  await prisma.$executeRaw`SELECT set_config('app.is_super_admin', 'true', false)`;
  const companies = await prisma.company.findMany({
    select: { id: true, name: true },
  });
  console.log(
    APPLY ? 'Applying.' : 'Dry run — nothing is written. Add --apply to write.',
  );
  for (const company of companies) {
    console.log(`\n${company.name}`);
    await forCompany(company);
  }
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
