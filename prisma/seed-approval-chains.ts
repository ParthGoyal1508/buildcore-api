/**
 * Installs every company's default approval chains, idempotently.
 *
 * ## Why this exists
 *
 * Approval chains are installed by `CompaniesService.create`, which is the right place for the
 * product: a company gets its chains the moment it exists. But `prisma/seed.ts` writes its company
 * row directly, bypassing that service — so a database brought up by `prisma db seed` has companies
 * and **no chains at all**.
 *
 * That is invisible until something is submitted for approval, and then it is seven red tests with
 * a 409 that reads as a product fault. `test/ra-bills.e2e-spec.ts` failed exactly this way on a
 * freshly seeded `buildcore_scratch` on 2026-10-06, while passing against a database whose
 * companies had been created through the API. The suites were right and the database was not ready.
 *
 * ## It reuses the list rather than copying it
 *
 * `DEFAULT_COMPANY_CHAINS` is imported from `src/approvals/default-chains.ts` — the same constant
 * `ChainsService.seedDefaultsForCompany` reads. `chains.service.ts` carries a warning about this
 * written from experience: there used to be two lists, and the hand-copied one in
 * `prisma/seed-demo.ts` drifted three chains behind, "which left every demo company refusing a
 * subcontractor bill sent for certification". A second copy here would be the same bug a third time.
 *
 * Nest is not stood up for this. The service's method needs a transaction client and a container;
 * this needs a list and a `PrismaClient`, and the part worth sharing is the list.
 *
 * ## Idempotent, per chain
 *
 * Skips a chain a company already has, exactly as the service does — so it is safe to run against a
 * database that is partly provisioned, and safe to run twice.
 *
 * Usage: `DATABASE_URL=… npx ts-node prisma/seed-approval-chains.ts`
 */
import { PrismaClient } from '@prisma/client';

import { DEFAULT_COMPANY_CHAINS } from '../src/approvals/default-chains';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const companies = await prisma.company.findMany({
      select: { id: true, name: true },
    });
    if (companies.length === 0) {
      console.log('No companies found. Run `prisma db seed` first.');
      return;
    }

    let installed = 0;
    let skipped = 0;

    for (const company of companies) {
      for (const [actionType, levels] of DEFAULT_COMPANY_CHAINS) {
        const existing = await prisma.approvalChain.findFirst({
          where: { companyId: company.id, actionType },
          select: { id: true },
        });
        if (existing) {
          skipped += 1;
          continue;
        }

        await prisma.approvalChain.create({
          data: {
            companyId: company.id,
            actionType,
            isFinalAuthorityRequired: true,
            levels: {
              create: levels.map((level) => ({
                companyId: company.id,
                position: level.position,
                slotKey: level.slotKey,
                isFinalAuthority: level.isFinalAuthority ?? false,
                label: level.label ?? null,
              })),
            },
          },
        });
        installed += 1;
      }
    }

    console.log(
      `Approval chains: ${installed} installed, ${skipped} already present, ` +
        `across ${companies.length} compan${
          companies.length === 1 ? 'y' : 'ies'
        }.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main();
