import { EngagementType, LabourPaymentMode, Prisma } from '@prisma/client';

import { roundMoney } from '../payment-sheets/wage-calc.util';

/**
 * How labour applies 038 ("hiding cash means cash does not exist") to what it shows.
 *
 * Cash in labour (spec D3):
 * - a **direct-engagement sheet** — paid in cash against a note-count breakup — is cash as a whole;
 * - a **line disbursed in cash** (`paymentMode = cash`) on any other sheet;
 * - a **labour advance**, always paid in cash at site;
 * - and what derives from those: a carry-forward line paying a cash line's shortfall, and an advance
 *   recovery deduction on a line (it is the cash advance being settled out of the wage).
 *
 * Everything here is a read-time view: stored rows are never changed, so turning hiding off restores
 * every figure exactly.
 *
 * **Advance recovery on a visible (bank) line.** The deduction names a hidden advance, so it is
 * dropped. The money the worker actually received by bank — `netPayable`, `paidAmount` — is a bank
 * fact and is kept as stored. The part of the wage that the cash advance settled in advance is
 * itself cash wages, so it leaves the line's gross too: shown gross = net + the deductions still
 * shown (fines). That keeps gross − deductions = net on every line and every total, never shows a
 * bank line as short-paid, and makes the P&L leave the cash-settled part out like any other cash.
 */

export function isCashSheet(sheet: {
  engagementType: EngagementType;
}): boolean {
  return sheet.engagementType === EngagementType.direct;
}

export function isCashLine(line: {
  paymentMode: LabourPaymentMode | null;
}): boolean {
  return line.paymentMode === LabourPaymentMode.cash;
}

interface DeductionLike {
  type?: unknown;
  amount?: unknown;
}

function entriesOf(value: unknown): DeductionLike[] {
  return Array.isArray(value)
    ? (value.filter((e) => e && typeof e === 'object') as DeductionLike[])
    : [];
}

function sumOf(entries: DeductionLike[]): number {
  return roundMoney(
    entries.reduce((s, e) => {
      const n = Number(e.amount);
      return Number.isFinite(n) ? s + n : s;
    }, 0),
  );
}

/** The line minimal shape every view below needs. */
export interface LineFigures {
  id: string;
  paymentMode: LabourPaymentMode | null;
  carriedFromLineId: string | null;
  grossWage: Prisma.Decimal;
  deductions: Prisma.JsonValue;
  netPayable: Prisma.Decimal;
}

/**
 * A line's figures with any advance recovery taken out (see the file note). Returns the stored
 * figures untouched when the line recovered no advance.
 */
export function withoutAdvanceRecovery<T extends LineFigures>(line: T): T {
  const all = entriesOf(line.deductions);
  const kept = all.filter((e) => e.type !== 'advance');
  if (kept.length === all.length) return line;
  const net = line.netPayable.toNumber();
  return {
    ...line,
    deductions: kept as unknown as Prisma.JsonValue,
    grossWage: new Prisma.Decimal(roundMoney(net + sumOf(kept))),
  };
}

/** Whether one line of a visible sheet is cash, or derives from cash. */
export function isHiddenLine(
  line: Pick<LineFigures, 'paymentMode' | 'carriedFromLineId'>,
  cashSourceIds: ReadonlySet<string>,
): boolean {
  if (isCashLine(line)) return true;
  return !!line.carriedFromLineId && cashSourceIds.has(line.carriedFromLineId);
}

/**
 * A non-cash sheet as it reads with cash hidden: only its non-cash lines, advance recovery taken out
 * of them, and its totals recomputed from what is left. `changed` is false when nothing on the sheet
 * was cash, and then the stored totals are returned as they are (no rounding drift).
 */
export function visibleSheetLines<L extends LineFigures>(
  sheet: {
    grossTotal: Prisma.Decimal;
    deductionTotal: Prisma.Decimal;
    netTotal: Prisma.Decimal;
  },
  lines: L[],
  cashSourceIds: ReadonlySet<string>,
): {
  lines: L[];
  grossTotal: number;
  deductionTotal: number;
  netTotal: number;
  changed: boolean;
} {
  const out: L[] = [];
  let changed = false;
  for (const line of lines) {
    if (isHiddenLine(line, cashSourceIds)) {
      changed = true;
      continue;
    }
    const shown = withoutAdvanceRecovery(line);
    if (shown !== line) changed = true;
    out.push(shown);
  }
  if (!changed) {
    return {
      lines: out,
      grossTotal: sheet.grossTotal.toNumber(),
      deductionTotal: sheet.deductionTotal.toNumber(),
      netTotal: sheet.netTotal.toNumber(),
      changed,
    };
  }
  return {
    lines: out,
    grossTotal: roundMoney(out.reduce((s, l) => s + l.grossWage.toNumber(), 0)),
    deductionTotal: roundMoney(
      out.reduce((s, l) => s + sumOf(entriesOf(l.deductions)), 0),
    ),
    netTotal: roundMoney(out.reduce((s, l) => s + l.netPayable.toNumber(), 0)),
    changed,
  };
}

/**
 * Of the lines given, the earlier lines their carry-forward lines pay that are cash — disbursed in
 * cash, or on a direct (cash) sheet. A carry-forward line paying one of those is the remainder of a
 * cash payment, and hides with it.
 */
export async function cashCarrySources(
  tx: Prisma.TransactionClient,
  lines: { carriedFromLineId: string | null }[],
): Promise<Set<string>> {
  const ids = [
    ...new Set(
      lines.map((l) => l.carriedFromLineId).filter((id): id is string => !!id),
    ),
  ];
  if (ids.length === 0) return new Set();
  const sources = await tx.paymentSheetLine.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      paymentMode: true,
      sheet: { select: { engagementType: true } },
    },
  });
  return new Set(
    sources
      .filter((s) => isCashLine(s) || isCashSheet(s.sheet))
      .map((s) => s.id),
  );
}
