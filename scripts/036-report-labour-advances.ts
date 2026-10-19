/**
 * 036 O1 data-repair report — READ ONLY. Changes nothing.
 *
 * Before 036 an advance's balance fell only when a line was disbursed, but a sheet read the balance
 * when it was generated, so two sheets generated before either was paid both deducted the same
 * instalment; and a reversal gave back the whole deduction even where disbursing had recovered less.
 * This lists what that may have left behind, for a person to decide on (decision 10: report only):
 *
 *   1. Advances deducted on more than one live sheet, marking those whose deductions add up to more
 *      than the advance itself — the double deductions. Several sheets alone is normal for an advance
 *      recovered over several instalments.
 *   2. Disbursed or closed advances whose outstanding balance disagrees with the amount less what
 *      disbursed lines recovered.
 *
 * Usage: `DATABASE_URL=… npx ts-node scripts/036-report-labour-advances.ts [--json]`
 *
 * The transaction is opened READ ONLY, so Postgres itself refuses any write. Row-level security is
 * lifted for the read (`app.is_super_admin`), the same way the seed scripts read every company.
 */
import { PrismaClient } from '@prisma/client';

interface Deduction {
  type?: string;
  advanceId?: string;
  amount?: number;
  recovered?: number;
}

const round = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

async function main() {
  const asJson = process.argv.includes('--json');
  const prisma = new PrismaClient();
  try {
    const { advances, lines } = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      await tx.$executeRawUnsafe(
        "SELECT set_config('app.is_super_admin', 'true', true)",
      );
      return {
        advances: await tx.labourAdvance.findMany({
          where: { deletedAt: null },
          select: {
            id: true,
            companyId: true,
            workerId: true,
            amount: true,
            outstandingBalance: true,
            status: true,
          },
        }),
        lines: await tx.paymentSheetLine.findMany({
          where: { sheet: { deletedAt: null } },
          select: {
            id: true,
            sheetId: true,
            status: true,
            deductions: true,
            sheet: { select: { periodFrom: true, periodTo: true } },
          },
        }),
      };
    });

    type Use = {
      sheetId: string;
      lineId: string;
      period: string;
      amount: number;
      recovered: number | null;
      lineStatus: string;
    };
    const usesByAdvance = new Map<string, Use[]>();
    for (const line of lines) {
      const entries = Array.isArray(line.deductions)
        ? (line.deductions as Deduction[])
        : [];
      for (const d of entries) {
        if (d.type !== 'advance' || !d.advanceId) continue;
        const list = usesByAdvance.get(d.advanceId) ?? [];
        list.push({
          sheetId: line.sheetId,
          lineId: line.id,
          period: `${line.sheet.periodFrom
            .toISOString()
            .slice(0, 10)}..${line.sheet.periodTo.toISOString().slice(0, 10)}`,
          amount: Number(d.amount ?? 0),
          recovered: d.recovered === undefined ? null : Number(d.recovered),
          lineStatus: line.status,
        });
        usesByAdvance.set(d.advanceId, list);
      }
    }

    const multiSheet = [];
    const mismatched = [];
    for (const a of advances) {
      const uses = usesByAdvance.get(a.id) ?? [];
      const amount = a.amount.toNumber();
      const sheets = new Set(uses.map((u) => u.sheetId));
      const deductedTotal = round(uses.reduce((s, u) => s + u.amount, 0));
      if (sheets.size > 1) {
        multiSheet.push({
          advanceId: a.id,
          companyId: a.companyId,
          workerId: a.workerId,
          amount,
          sheets: sheets.size,
          deductedTotal,
          overDeducted: deductedTotal > amount,
          overBy: round(Math.max(0, deductedTotal - amount)),
          uses,
        });
      }

      if (a.status !== 'disbursed' && a.status !== 'closed') continue;
      // What disbursement took: the recorded `recovered` since 036, the deduction before it, and
      // never past a zero balance — the same arithmetic `applyRecovery` does, in line order.
      const disbursed = uses.filter((u) => u.lineStatus === 'disbursed');
      let balance = amount;
      for (const u of disbursed) {
        const took = u.recovered ?? Math.min(u.amount, balance);
        balance = round(Math.max(0, balance - took));
      }
      const recorded = a.outstandingBalance.toNumber();
      if (Math.abs(recorded - balance) > 0.005) {
        mismatched.push({
          advanceId: a.id,
          companyId: a.companyId,
          workerId: a.workerId,
          amount,
          status: a.status,
          recordedOutstanding: recorded,
          expectedOutstanding: balance,
          difference: round(recorded - balance),
          disbursedRecoveries: disbursed.length,
        });
      }
    }

    const report = {
      generatedAt: new Date().toISOString(),
      advancesChecked: advances.length,
      liveSheetLinesChecked: lines.length,
      deductedOnMoreThanOneSheet: multiSheet.length,
      overDeducted: multiSheet.filter((m) => m.overDeducted).length,
      balanceMismatches: mismatched.length,
      multiSheet,
      mismatched,
    };

    if (asJson) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }
    console.log('036 labour advances report (read only)');
    console.log(`  advances checked:              ${report.advancesChecked}`);
    console.log(
      `  live sheet lines checked:      ${report.liveSheetLinesChecked}`,
    );
    console.log(
      `  deducted on more than 1 sheet: ${report.deductedOnMoreThanOneSheet}`,
    );
    console.log(`    of which over-deducted:      ${report.overDeducted}`);
    console.log(`  balance mismatches:            ${report.balanceMismatches}`);
    for (const m of multiSheet) {
      console.log(
        `  [multi] ${m.advanceId} worker ${m.workerId}: amount ${m.amount}, ${
          m.sheets
        } sheets, deducted ${m.deductedTotal}${
          m.overDeducted ? `  OVER BY ${m.overBy}` : ''
        }`,
      );
    }
    for (const m of mismatched) {
      console.log(
        `  [balance] ${m.advanceId} worker ${m.workerId}: recorded ${m.recordedOutstanding}, expected ${m.expectedOutstanding} (diff ${m.difference})`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
