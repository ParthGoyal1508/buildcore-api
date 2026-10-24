import { Prisma, PrismaClient } from '@prisma/client';
import { ensureHeadOffice } from '../../src/settings/companies/company-branches';

/**
 * The company's head-office branch id, creating it from the company's own columns if the company
 * has none yet (041) — the same idempotent step the `company_branches` migration ran.
 *
 * Every seed that creates a project or employee passes this as `branchId`: both are required, and
 * a seed that creates its company after the migration ran would otherwise have no branch to name.
 */
export async function headOfficeBranchId(
  prisma: PrismaClient,
  companyId: string,
): Promise<string> {
  return prisma.$transaction(async (tx) => {
    // `CompanyBranch` is under FORCE ROW LEVEL SECURITY, which binds the table owner too.
    await tx.$executeRaw`SELECT set_config('app.is_super_admin', 'true', true)`;
    const head = await ensureHeadOffice(
      tx as Prisma.TransactionClient,
      companyId,
    );
    return head.id;
  });
}
