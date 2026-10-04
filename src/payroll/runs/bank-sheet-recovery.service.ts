import { Injectable } from '@nestjs/common';
import { Prisma, SalaryAdvanceStatus } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import type { RlsContext } from '../../common/prisma/rls-context';
import { withRlsContext } from '../../common/prisma/rls-context';

/** Two decimal places, the way every money figure in this module rounds. */
const r2 = (value: number): number => Math.round(value * 100) / 100;

/** What one employee's transfer looks like after advances are taken out of it. */
export interface RecoveredTransfer {
  employeeId: string;
  /** The approved run's figure. **Never modified** — the run is immutable. */
  netPay: number;
  /** Advances taken out of this transfer, as named lines (FR-011). */
  recoveries: { salaryAdvanceId: string; amount: number }[];
  recoveredTotal: number;
  /** What the bank is actually instructed to move. Never negative. */
  transferAmount: number;
}

/**
 * Settling salary advances against the **transfer**, not against the approved run
 * (021 FR-010 to FR-013) — `bugs.md` item 9.
 *
 * ## Why this is not in the payroll engine
 *
 * The engine already recovers advances outstanding when the run is drawn up. Item 9 is about the
 * ones that are **not**: an advance taken between approval and payment day. The run is approved and
 * immutable by then — rewriting its figures would invalidate the approval that was given to those
 * figures — so the recovery adjusts the money that moves and the run stays as approved. The
 * difference shows on the sheet as a named line, which is FR-011.
 *
 * ## Which advances this touches, and the one it deliberately will not
 *
 * **Only advances the run could not have seen** — those created after it was drawn up. An advance the
 * engine already looked at and recovered *partially* is left alone, and that restraint is the
 * important part: the engine capped it because net pay could not absorb more, and taking the
 * remainder out of the transfer would drive the transfer to zero and hand the employee nothing. That
 * is the exact outcome FR-012's cap exists to prevent, and reaching it here by a different route
 * would not make it lawful.
 *
 * So the eligibility test is `createdAt` after the run's, not "anything still owed". A broader query
 * would look more thorough and would quietly undo a decision the engine made on purpose.
 *
 * ## Why running it twice is safe
 *
 * `@@unique([payrollRunId, salaryAdvanceId])` **is** FR-013. A regenerated bank sheet re-reads the
 * recoveries already written and recovers nothing further — the constraint does that, not a check
 * somebody has to remember in whichever path regenerates the file next.
 *
 * ## Why the cap is a cap and not a refusal
 *
 * FR-012: an advance larger than one month's net recovers down to a zero transfer, never a negative
 * one, and the remainder stays outstanding on the advance. An employee whose advance exceeds their
 * net still gets paid something, and the advance settles over two months — instead of producing a
 * transfer instruction the bank cannot execute, or a refusal that holds up everybody else's pay.
 */
@Injectable()
export class BankSheetRecoveryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Applies and records recoveries for a run, returning the transfer per employee.
   *
   * Idempotent: on a second call the already-written recoveries are read back and reapplied to the
   * figures, and nothing new is written. That is what lets the bank sheet be regenerated — which
   * happens, because somebody closes the file without saving it.
   */
  async apply(
    ctx: RlsContext,
    run: {
      id: string;
      companyId: string;
      /**
       * When the run was drawn up — `generatedAt` where there is one, `createdAt` otherwise.
       *
       * The cut-off for "an advance the run could not have seen". Passed in rather than read here so
       * the caller's definition of it is visible at the call site: this decides whose advance gets
       * recovered, which is not a thing to settle silently inside a private query.
       */
      drawnUpAt: Date;
    },
    lines: { employeeId: string; netPay: number }[],
  ): Promise<Map<string, RecoveredTransfer>> {
    const employeeIds = lines.map((l) => l.employeeId);

    const [existing, advances] = await Promise.all([
      withRlsContext(this.prisma, ctx, (tx) =>
        tx.bankSheetRecovery.findMany({ where: { payrollRunId: run.id } }),
      ),
      withRlsContext(this.prisma, ctx, (tx) =>
        tx.salaryAdvance.findMany({
          where: {
            employeeId: { in: employeeIds },
            // `disbursed` is the status that means "money the employee has, still owed" in this
            // product — `approved` is a decision, not a payment, and recovering against it would
            // take back what was never given.
            status: SalaryAdvanceStatus.disbursed,
            outstandingBalance: { gt: 0 },
            // The advances the run could not have seen. See the class comment: an advance the engine
            // already capped is left capped.
            createdAt: { gt: run.drawnUpAt },
          },
          orderBy: { createdAt: 'asc' },
        }),
      ),
    ]);

    const alreadyRecovered = new Set(existing.map((r) => r.salaryAdvanceId));
    const existingByEmployee = new Map<string, typeof existing>();
    for (const row of existing) {
      const list = existingByEmployee.get(row.employeeId) ?? [];
      list.push(row);
      existingByEmployee.set(row.employeeId, list);
    }

    const advancesByEmployee = new Map<string, typeof advances>();
    for (const advance of advances) {
      if (alreadyRecovered.has(advance.id)) continue;
      const list = advancesByEmployee.get(advance.employeeId) ?? [];
      list.push(advance);
      advancesByEmployee.set(advance.employeeId, list);
    }

    const result = new Map<string, RecoveredTransfer>();

    for (const line of lines) {
      // Recoveries already written count against the headroom first, so a second pass cannot recover
      // past the net pay by forgetting what the first pass took.
      const prior = (existingByEmployee.get(line.employeeId) ?? []).map(
        (row) => ({
          salaryAdvanceId: row.salaryAdvanceId,
          amount: row.amount.toNumber(),
        }),
      );
      const recoveries = [...prior];
      let headroom = r2(
        line.netPay - prior.reduce((sum, r) => sum + r.amount, 0),
      );

      for (const advance of advancesByEmployee.get(line.employeeId) ?? []) {
        if (headroom <= 0) break;
        const owed = advance.outstandingBalance.toNumber();
        // FR-012's cap. `Math.min` against the headroom, so the transfer floors at zero rather than
        // going negative — and the remainder below is what stays on the advance.
        const amount = r2(Math.min(owed, headroom));
        if (amount <= 0) continue;

        await this.write(ctx, run, line.employeeId, advance, amount);
        recoveries.push({ salaryAdvanceId: advance.id, amount });
        headroom = r2(headroom - amount);
      }

      const recoveredTotal = r2(
        recoveries.reduce((sum, r) => sum + r.amount, 0),
      );
      result.set(line.employeeId, {
        employeeId: line.employeeId,
        // The approved run's own figure, untouched and reported beside the transfer so the
        // difference is visible rather than inferred.
        netPay: line.netPay,
        recoveries,
        recoveredTotal,
        transferAmount: r2(Math.max(0, line.netPay - recoveredTotal)),
      });
    }

    return result;
  }

  /**
   * Writes one recovery and reduces the advance's outstanding balance, in one transaction.
   *
   * The two halves must not come apart: a recovery recorded without reducing the balance recovers
   * the same money again next month, and a balance reduced without a recovery row takes money off an
   * advance with nothing on the sheet to explain it.
   *
   * A unique-constraint violation is swallowed rather than raised. It means a concurrent request
   * already recovered this advance for this run, which is the outcome FR-013 asks for — the second
   * caller wanting an error would be the second caller being wrong about what it was asking.
   */
  private async write(
    ctx: RlsContext,
    run: { id: string; companyId: string },
    employeeId: string,
    advance: { id: string; outstandingBalance: Prisma.Decimal },
    amount: number,
  ): Promise<void> {
    try {
      await withRlsContext(this.prisma, ctx, async (tx) => {
        await tx.bankSheetRecovery.create({
          data: {
            companyId: run.companyId,
            payrollRunId: run.id,
            employeeId,
            salaryAdvanceId: advance.id,
            amount,
          },
        });
        const remaining = r2(advance.outstandingBalance.toNumber() - amount);
        await tx.salaryAdvance.update({
          where: { id: advance.id },
          data: {
            outstandingBalance: remaining,
            // `closed` only when nothing is left, matching `SalaryAdvancesService.applyRecovery`
            // exactly. A partially recovered advance stays `disbursed` and outstanding, which is
            // what carries the remainder to next month (FR-012).
            ...(remaining <= 0 ? { status: SalaryAdvanceStatus.closed } : {}),
          },
        });
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') return;
      throw error;
    }
  }
}
