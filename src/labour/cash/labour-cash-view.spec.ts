import { EngagementType, LabourPaymentMode, Prisma } from '@prisma/client';

import {
  cashCarrySources,
  isCashSheet,
  isHiddenLine,
  visibleSheetLines,
  withoutAdvanceRecovery,
} from './labour-cash-view';

/** The cash mode, named once (cash-entry-surface.spec flags literal cash modes). */
const CASH = 'cash' as LabourPaymentMode;

const D = (n: number) => new Prisma.Decimal(n);

const line = (over: Record<string, unknown> = {}) => ({
  id: 'l-1',
  paymentMode: null as LabourPaymentMode | null,
  carriedFromLineId: null as string | null,
  grossWage: D(5000),
  deductions: [] as Prisma.JsonValue,
  netPayable: D(5000),
  ...over,
});

describe('labour cash view (038)', () => {
  it('a direct sheet is cash, a contractor sheet is not', () => {
    expect(isCashSheet({ engagementType: EngagementType.direct })).toBe(true);
    expect(isCashSheet({ engagementType: EngagementType.contractor })).toBe(
      false,
    );
  });

  it('hides a cash line and a carry-forward of a cash line, keeps bank and pending lines', () => {
    const sources = new Set(['cash-src']);
    expect(isHiddenLine(line({ paymentMode: CASH }), sources)).toBe(true);
    expect(isHiddenLine(line({ carriedFromLineId: 'cash-src' }), sources)).toBe(
      true,
    );
    expect(isHiddenLine(line({ carriedFromLineId: 'bank-src' }), sources)).toBe(
      false,
    );
    expect(isHiddenLine(line({ paymentMode: 'bank' }), sources)).toBe(false);
    expect(isHiddenLine(line(), sources)).toBe(false);
  });

  it('takes advance recovery out of a line, keeping net, so gross − deductions = net', () => {
    const shown = withoutAdvanceRecovery(
      line({
        grossWage: D(6000),
        netPayable: D(4800),
        deductions: [
          { type: 'advance', advanceId: 'a-1', amount: 1000, label: 'Advance' },
          { type: 'fine', amount: 200, label: 'Fine' },
        ],
      }),
    );
    expect(shown.netPayable.toNumber()).toBe(4800);
    expect(shown.grossWage.toNumber()).toBe(5000);
    expect(shown.deductions).toEqual([
      { type: 'fine', amount: 200, label: 'Fine' },
    ]);
  });

  it('leaves a line with no advance recovery exactly as stored', () => {
    const l = line({ deductions: [{ type: 'fine', amount: 50, label: 'F' }] });
    expect(withoutAdvanceRecovery(l)).toBe(l);
  });

  it('recomputes a mixed sheet from its visible lines', () => {
    const view = visibleSheetLines(
      { grossTotal: D(15000), deductionTotal: D(1000), netTotal: D(14000) },
      [
        line({ id: 'cash', paymentMode: CASH, grossWage: D(5000) }),
        line({
          id: 'bank',
          paymentMode: 'bank',
          grossWage: D(5000),
          netPayable: D(4000),
          deductions: [{ type: 'advance', amount: 1000, label: 'A' }],
        }),
        line({ id: 'pending' }),
      ],
      new Set(),
    );
    expect(view.changed).toBe(true);
    expect(view.lines.map((l) => l.id)).toEqual(['bank', 'pending']);
    expect(view.grossTotal).toBe(9000);
    expect(view.deductionTotal).toBe(0);
    expect(view.netTotal).toBe(9000);
  });

  it('keeps the stored totals when nothing on the sheet is cash', () => {
    const view = visibleSheetLines(
      { grossTotal: D(10000.01), deductionTotal: D(0), netTotal: D(10000.01) },
      [line(), line({ id: 'l-2', paymentMode: 'bank' })],
      new Set(),
    );
    expect(view.changed).toBe(false);
    expect(view.grossTotal).toBe(10000.01);
    expect(view.lines).toHaveLength(2);
  });

  it('finds carry-forward sources that were cash, or on a direct sheet', async () => {
    const tx = {
      paymentSheetLine: {
        findMany: jest.fn(async () => [
          {
            id: 's1',
            paymentMode: CASH,
            sheet: { engagementType: 'contractor' },
          },
          { id: 's2', paymentMode: null, sheet: { engagementType: 'direct' } },
          {
            id: 's3',
            paymentMode: 'bank',
            sheet: { engagementType: 'contractor' },
          },
        ]),
      },
    };
    const found = await cashCarrySources(tx as never, [
      { carriedFromLineId: 's1' },
      { carriedFromLineId: 's2' },
      { carriedFromLineId: 's3' },
      { carriedFromLineId: null },
    ]);
    expect([...found].sort()).toEqual(['s1', 's2']);
  });

  it('asks nothing when no line carries anything forward', async () => {
    const tx = { paymentSheetLine: { findMany: jest.fn() } };
    expect((await cashCarrySources(tx as never, [line()])).size).toBe(0);
    expect(tx.paymentSheetLine.findMany).not.toHaveBeenCalled();
  });
});
