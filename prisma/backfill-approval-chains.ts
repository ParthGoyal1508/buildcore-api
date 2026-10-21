/**
 * Puts every pending leave application, reimbursement claim, loan, salary advance and labour
 * advance with no approval chain into one (2026-10-20).
 *
 * Those five moved onto the approval spine on that date. Items raised before then have no chain,
 * so they would not reach the Approvals queue — each module puts such an item into its chain when
 * it is first decided from the module's screen, but until then nobody would be asked. Run once per
 * database after migration `20261020120000_hr_money_approval_chains`; safe to run again, as an item
 * already in a chain is skipped.
 *
 *   npm run backfill:approvals
 */
import 'dotenv/config';

import { NestFactory } from '@nestjs/core';

import { AppModule } from '../src/app.module';
import { LeaveService } from '../src/hr/leave/leave.service';
import { LabourAdvanceService } from '../src/labour/advances/labour-advance.service';
import { SalaryAdvancesService } from '../src/payroll/advances/salary-advances.service';
import { LoansService } from '../src/payroll/loans/loans.service';
import { ReimbursementsAdminService } from '../src/payroll/reimbursements-admin/reimbursements-admin.service';

export async function backfillApprovalChains(
  app: Awaited<ReturnType<typeof NestFactory.createApplicationContext>>,
): Promise<Record<string, number>> {
  return {
    'leave applications': await app.get(LeaveService).backfillApprovals(),
    'reimbursement claims': await app
      .get(ReimbursementsAdminService)
      .backfillApprovals(),
    loans: await app.get(LoansService).backfillApprovals(),
    'salary advances': await app.get(SalaryAdvancesService).backfillApprovals(),
    'labour advances': await app.get(LabourAdvanceService).backfillApprovals(),
  };
}

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const counts = await backfillApprovalChains(app);
    for (const [kind, n] of Object.entries(counts)) {
      console.log(`  ${kind}: ${n} put into their approval chain`);
    }
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
