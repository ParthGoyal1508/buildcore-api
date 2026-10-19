import { roundMoney } from './wage-calc.util';

/**
 * The money rules of a labour payment sheet that need no database (036), kept pure so each can be
 * tested on its own: what an advance may still deduct, what a disbursement actually recovers, and
 * what may be paid against a line.
 */

export interface DeductionEntry {
  type: 'advance' | 'fine';
  advanceId?: string;
  amount: number;
  label: string;
  /**
   * 036 O1: what disbursing the line actually took off the advance, written at disbursement. A
   * reversal gives back exactly this, never more. Absent on lines disbursed before 036, where the
   * reversal falls back to `amount` as it always did.
   */
  recovered?: number;
}

export interface AdvanceForDeduction {
  id: string;
  instalmentAmount: number;
  outstandingBalance: number;
}

/** The deduction entries on a line's `deductions` json, tolerating anything that is not a list. */
export function deductionEntries(json: unknown): DeductionEntry[] {
  return Array.isArray(json) ? (json as DeductionEntry[]) : [];
}

/**
 * How much of each advance other sheets have already earmarked: the advance deductions on lines not
 * yet disbursed. An advance's balance only falls when a line is disbursed, so without this two sheets
 * generated before either is paid would both deduct the same instalment (036 O1).
 */
export function reservedByAdvance(
  lines: { deductions: unknown }[],
): Map<string, number> {
  const reserved = new Map<string, number>();
  for (const line of lines) {
    for (const d of deductionEntries(line.deductions)) {
      if (d.type !== 'advance' || !d.advanceId) continue;
      reserved.set(
        d.advanceId,
        roundMoney((reserved.get(d.advanceId) ?? 0) + d.amount),
      );
    }
  }
  return reserved;
}

/**
 * The advance deductions for one line: oldest advance first, each at most one instalment, at most
 * what is left once other sheets' reservations are taken out, and never more than the gross, so the
 * net cannot go negative (FR-024).
 */
export function planAdvanceDeductions(
  advances: AdvanceForDeduction[],
  reserved: Map<string, number>,
  grossWage: number,
): { deductions: DeductionEntry[]; deductionAmount: number } {
  const deductions: DeductionEntry[] = [];
  let remainingGross = grossWage;
  let deductionAmount = 0;
  for (const advance of advances) {
    if (remainingGross <= 0) break;
    const available = roundMoney(
      advance.outstandingBalance - (reserved.get(advance.id) ?? 0),
    );
    const amount = roundMoney(
      Math.min(advance.instalmentAmount, available, remainingGross),
    );
    if (amount <= 0) continue;
    deductions.push({
      type: 'advance',
      advanceId: advance.id,
      amount,
      label: 'Advance recovery',
    });
    deductionAmount += amount;
    remainingGross -= amount;
  }
  return { deductions, deductionAmount: roundMoney(deductionAmount) };
}

/** What a disbursement takes off an advance: the deduction, but never below a zero balance. */
export function recoveryFor(outstanding: number, deduction: number): number {
  return roundMoney(Math.max(0, Math.min(deduction, outstanding)));
}

/** What a reversal gives back to an advance: what was recovered, or the deduction before 036. */
export function restoreFor(entry: DeductionEntry): number {
  return roundMoney(entry.recovered ?? entry.amount);
}

/**
 * Why a paid amount cannot be accepted against a line, or null. Paying more than the net has no
 * home in the books — there is no negative carry-forward — so it is refused outright (036 O4).
 */
export function paidAmountProblem(
  paidAmount: number,
  netPayable: number,
): string | null {
  if (!Number.isFinite(paidAmount) || paidAmount < 0) {
    return 'The paid amount cannot be negative.';
  }
  if (roundMoney(paidAmount) > roundMoney(netPayable)) {
    return `The paid amount cannot be more than the net payable of ${roundMoney(
      netPayable,
    ).toFixed(2)}.`;
  }
  return null;
}

/**
 * Why a sheet cannot end on `periodTo`, or null. A day is paid once its attendance is final, and
 * today's is not: a punch out this evening would land on no sheet, and the next sheet would be
 * refused as overlapping (036 O3). Both dates are `YYYY-MM-DD` in the company's zone.
 */
export function periodEndProblem(
  periodTo: string,
  today: string,
): string | null {
  if (periodTo >= today) {
    return `A payment sheet can only cover days that have ended. Choose a last day before ${today}.`;
  }
  return null;
}
