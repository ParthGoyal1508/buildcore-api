import { Prisma } from '@prisma/client';

import { billNote } from './pnl-drill-down.service';
import {
  originalScope,
  positionReport,
  type PositionExportInput,
} from './position-export.service';

const dec = (value: number) => new Prisma.Decimal(value);

/**
 * Original scope and variations are separable in every report (018 FR-015a, T036).
 *
 * The client confirmed on 2026-10-03 that a variation is an ordinary BOQ line carrying a mark. That
 * answer is only worth having if every report can still pull the two apart — otherwise a flagged
 * line is a flag nobody can read, and the question a director actually asks goes unanswered: a
 * project at 110% of its contract value is doing well if the extra is approved variations and is in
 * trouble if it is not, and one revenue figure cannot say which.
 *
 * Tested against the pure functions each report composes, so none of this needs a database.
 */
describe('variations are separable from original scope', () => {
  describe('the position export', () => {
    const view = (
      over: Partial<PositionExportInput> = {},
    ): PositionExportInput => ({
      projectName: 'Ring Road',
      period: '2026-09',
      revenueMonthly: 1000,
      revenueCumulative: 5000,
      revenueFromVariationsMonthly: 250,
      revenueFromVariationsCumulative: 800,
      revenueNote: 'Billed gross.',
      categories: [],
      costMonthly: 400,
      costCumulative: 2000,
      marginCumulative: 3000,
      unavailableCategories: [],
      ...over,
    });

    const lineNamed = (
      report: { rows: Record<string, unknown>[] },
      text: string,
    ) => report.rows.find((row) => String(row.line ?? '').includes(text));

    it('breaks revenue into original scope and variations', () => {
      const report = positionReport(view(), new Date('2026-10-03T09:00:00Z'));

      expect(lineNamed(report, 'original scope')).toMatchObject({
        monthly: '750.00',
        cumulative: '4200.00',
      });
      expect(lineNamed(report, 'variations')).toMatchObject({
        monthly: '250.00',
        cumulative: '800.00',
      });
    });

    /**
     * The two parts must add back to the whole, or the document is one somebody double-counts from.
     * Asserted rather than assumed, because the two figures are produced by different code paths —
     * one a subtraction here, the other a sum over bill lines in the service.
     */
    it('leaves the two parts adding up to the revenue above them', () => {
      const report = positionReport(view(), new Date('2026-10-03T09:00:00Z'));
      const scope = Number(lineNamed(report, 'original scope')?.cumulative);
      const variations = Number(lineNamed(report, 'variations')?.cumulative);

      expect(scope + variations).toBe(5000);
    });

    /**
     * A project with no variations is the ordinary case, and the rows still appear — with zero
     * against variations and the whole against original scope. Hiding them when empty would mean a
     * reader could not tell "no variations" from "this document does not report variations".
     */
    it('reports a project with no variations as entirely original scope', () => {
      const report = positionReport(
        view({
          revenueFromVariationsMonthly: 0,
          revenueFromVariationsCumulative: 0,
        }),
        new Date('2026-10-03T09:00:00Z'),
      );

      expect(lineNamed(report, 'original scope')).toMatchObject({
        cumulative: '5000.00',
      });
      expect(lineNamed(report, 'variations')).toMatchObject({
        cumulative: '0.00',
      });
    });

    /**
     * Cash hiding nulls revenue, and the split must go with it.
     *
     * Subtracting against a hidden variation total would publish the whole of revenue as original
     * scope — a specific, plausible falsehood rather than an obviously missing cell.
     */
    it('hides the split when revenue itself is hidden', () => {
      expect(originalScope(null, 100)).toBe(null);
      expect(originalScope(5000, null)).toBe(null);

      const report = positionReport(
        view({
          revenueCumulative: null,
          revenueFromVariationsCumulative: null,
        }),
        new Date('2026-10-03T09:00:00Z'),
      );
      expect(lineNamed(report, 'original scope')?.cumulative).toBe('Hidden');
    });
  });

  describe('the revenue drill-down', () => {
    const bill = (over: Partial<Parameters<typeof billNote>[0]> = {}) => ({
      description: null,
      grossAmount: dec(1000),
      certifiedAmount: null,
      lines: [
        { amount: dec(700), boqTaskItem: { isVariation: false } },
        { amount: dec(300), boqTaskItem: { isVariation: true } },
      ],
      ...over,
    });

    it('says how much of a bill was variation work', () => {
      expect(billNote(bill())).toBe('Includes 300.00 of variation work');
    });

    /**
     * Silent on the ordinary case. A note reading "0.00 of this is variation work" against every
     * bill on every project is noise, and noise in this column teaches people to stop reading it —
     * including on the row where it mattered.
     */
    it('says nothing on a bill of entirely original scope', () => {
      expect(
        billNote(
          bill({
            lines: [{ amount: dec(1000), boqTaskItem: { isVariation: false } }],
          }),
        ),
      ).toBe(null);
    });

    /**
     * Both facts at once — rare in the wild, and exactly the case a format mistake would mangle.
     * The certification shortfall comes first: money in dispute outranks context.
     */
    it('reports a short certification and a variation share together, in that order', () => {
      expect(
        billNote(bill({ description: 'September', certifiedAmount: dec(900) })),
      ).toBe(
        'September. Certified 900.00 of 1000.00. Includes 300.00 of variation work',
      );
    });

    it('keeps a bill certified in full unannotated but still reports its variations', () => {
      expect(billNote(bill({ certifiedAmount: dec(1000) }))).toBe(
        'Includes 300.00 of variation work',
      );
    });
  });
});
