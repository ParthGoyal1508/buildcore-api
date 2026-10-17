/**
 * Installs every company's per-company defaults, and the e2e fixture role, idempotently.
 *
 * ## Why this exists
 *
 * `CompaniesService.create` gives a new company its masters — document types, vendor categories,
 * item categories, asset categories, asset document types, condition grades, equipment categories
 * and equipment document types — so nobody's first vendor, purchase, asset return or machine is
 * refused for want of a category. `prisma/seed.ts` writes its company rows directly and installs
 * none of them, so a database brought up by `prisma db seed` has companies with empty masters.
 * The assets and dashboard suites then fail with "Cannot read properties of undefined (reading
 * 'id')" on a condition grade that does not exist (test/README-e2e.md). The suites are right; the
 * database is not ready.
 *
 * `seed-approval-chains.ts` closes the approval-chain half of the same gap; this closes the rest.
 *
 * ## It calls the services rather than copying their lists
 *
 * Each master's `seedDefaultsForCompany` is the one `CompaniesService.create` calls, reading the
 * same `DEFAULT_*` constant — so a default added to a service reaches this script without anybody
 * remembering it exists. Every one of them inserts with `skipDuplicates` on the master's unique
 * name, which is what makes this safe to run twice or against a partly provisioned database. Nest
 * is not stood up: the methods need a transaction client and nothing from the container.
 *
 * ## The fixture role
 *
 * `QA No Modules` — a global role with no permissions — is what `test/dashboard.e2e-spec.ts` signs a
 * user in with to prove a caller who may open nothing is refused everywhere. It is a QA fixture,
 * not a product default, which is why no migration creates it; `prisma/seed-demo.ts` makes it too.
 *
 * Usage: `DATABASE_URL=… npm run seed:defaults`
 */
import { PrismaClient } from '@prisma/client';

import { withRlsContext } from '../src/common/prisma/rls-context';
import { AssetCategoriesService } from '../src/settings/asset-masters/asset-categories.service';
import { AssetDocTypesService } from '../src/settings/asset-masters/asset-doc-types.service';
import { ConditionGradesService } from '../src/settings/asset-masters/condition-grades.service';
import { ItemCategoriesService } from '../src/settings/item-masters/item-categories.service';
import { EquipmentCategoriesService } from '../src/settings/machinery-masters/equipment-categories.service';
import { EquipmentDocTypesService } from '../src/settings/machinery-masters/equipment-doc-types.service';
import { DocumentTypesService } from '../src/settings/reference-data/document-types.service';
import { VendorCategoriesService } from '../src/settings/vendor-categories/vendor-categories.service';

const FIXTURE_ROLE = 'QA No Modules';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    // The services take (prisma, auditLog); seeding uses only the transaction client it is given.
    const deps = [prisma, null] as unknown as [never, never];
    const masters: [
      string,
      { seedDefaultsForCompany(id: string, tx: never): Promise<unknown> },
    ][] = [
      ['document types', new DocumentTypesService(...deps)],
      ['vendor categories', new VendorCategoriesService(...deps)],
      ['item categories', new ItemCategoriesService(...deps)],
      ['asset categories', new AssetCategoriesService(...deps)],
      ['asset document types', new AssetDocTypesService(...deps)],
      ['condition grades', new ConditionGradesService(...deps)],
      ['equipment categories', new EquipmentCategoriesService(...deps)],
      ['equipment document types', new EquipmentDocTypesService(...deps)],
    ];

    const companies = await withRlsContext(
      prisma as never,
      { isSuperAdmin: true },
      (tx) => tx.company.findMany({ select: { id: true, name: true } }),
    );
    if (companies.length === 0) {
      console.log('No companies found. Run `prisma db seed` first.');
    }

    for (const company of companies) {
      // One transaction per company, under the same bypass context the service's own
      // creation path runs in, so the RLS policies on these tables are exercised rather
      // than depending on a superuser connection.
      await withRlsContext(
        prisma as never,
        { isSuperAdmin: true },
        async (tx) => {
          for (const [, service] of masters) {
            await service.seedDefaultsForCompany(company.id, tx as never);
          }
        },
      );
      console.log(
        `${company.name}: ${masters
          .map(([label]) => label)
          .join(', ')} — present.`,
      );
    }

    const fixture = await prisma.role.findFirst({
      where: { name: FIXTURE_ROLE, companyId: null },
      select: { id: true },
    });
    if (fixture) {
      console.log(`Role "${FIXTURE_ROLE}": already present.`);
    } else {
      await prisma.role.create({
        data: { name: FIXTURE_ROLE, permissions: [], isProtected: false },
      });
      console.log(`Role "${FIXTURE_ROLE}": created.`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
