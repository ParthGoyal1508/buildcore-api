import { EngagementType } from '@prisma/client';

import {
  lineContractorId,
  paidAmountProblem,
  periodEndProblem,
  planAdvanceDeductions,
  recoveryFor,
  reservedByAdvance,
  restoreFor,
} from './payment-sheet.rules';

describe('payment sheet rules (036)', () => {
  const advance = {
    id: 'adv1',
    instalmentAmount: 1000,
    outstandingBalance: 1000,
  };

  describe('advance reservations (O1)', () => {
    it('deducts an instalment once, even across two sheets generated before either is paid', () => {
      // Sheet 1 (1–7 Sep) deducts the whole single instalment.
      const first = planAdvanceDeductions([advance], new Map(), 5000);
      expect(first.deductionAmount).toBe(1000);

      // Sheet 2 (8–14 Sep) sees sheet 1's line still pending: nothing is left to deduct.
      const reserved = reservedByAdvance([{ deductions: first.deductions }]);
      expect(reserved.get('adv1')).toBe(1000);
      const second = planAdvanceDeductions([advance], reserved, 5000);
      expect(second.deductions).toEqual([]);
      expect(second.deductionAmount).toBe(0);
    });

    it('deducts only what other sheets leave of the balance', () => {
      const adv = { id: 'a', instalmentAmount: 600, outstandingBalance: 1000 };
      const reserved = new Map([['a', 600]]);
      expect(planAdvanceDeductions([adv], reserved, 5000).deductions).toEqual([
        {
          type: 'advance',
          advanceId: 'a',
          amount: 400,
          label: 'Advance recovery',
        },
      ]);
    });

    it('never takes more than the gross, oldest advance first', () => {
      const res = planAdvanceDeductions(
        [
          { id: 'old', instalmentAmount: 500, outstandingBalance: 500 },
          { id: 'new', instalmentAmount: 500, outstandingBalance: 500 },
        ],
        new Map(),
        700,
      );
      expect(res.deductions.map((d) => [d.advanceId, d.amount])).toEqual([
        ['old', 500],
        ['new', 200],
      ]);
      expect(res.deductionAmount).toBe(700);
    });

    it('ignores fines and junk when summing reservations', () => {
      const reserved = reservedByAdvance([
        { deductions: [{ type: 'fine', amount: 50, label: 'Fine' }] },
        { deductions: null },
        {
          deductions: [
            { type: 'advance', advanceId: 'x', amount: 100.1, label: '' },
            { type: 'advance', advanceId: 'x', amount: 0.2, label: '' },
          ],
        },
      ]);
      expect([...reserved.entries()]).toEqual([['x', 100.3]]);
    });
  });

  describe('recovery and reversal (O1)', () => {
    it('recovers no more than the balance, and a reversal gives back only that', () => {
      const recovered = recoveryFor(400, 1000);
      expect(recovered).toBe(400);
      expect(
        restoreFor({ type: 'advance', amount: 1000, label: '', recovered }),
      ).toBe(400);
    });

    it('falls back to the deduction for lines disbursed before 036', () => {
      expect(restoreFor({ type: 'advance', amount: 250, label: '' })).toBe(250);
    });
  });

  describe('paid amount (O4)', () => {
    it('refuses more than the net payable', () => {
      expect(paidAmountProblem(1000.01, 1000)).toMatch(/more than the net/);
      expect(paidAmountProblem(-1, 1000)).toMatch(/negative/);
    });
    it('accepts the net or less', () => {
      expect(paidAmountProblem(1000, 1000)).toBeNull();
      expect(paidAmountProblem(0, 1000)).toBeNull();
    });
  });

  describe('period end (O3)', () => {
    it('refuses a sheet ending today or later', () => {
      expect(periodEndProblem('2026-10-17', '2026-10-17')).toMatch(
        /before 2026-10-17/,
      );
      expect(periodEndProblem('2026-10-20', '2026-10-17')).not.toBeNull();
    });
    it('accepts a sheet ending yesterday', () => {
      expect(periodEndProblem('2026-10-16', '2026-10-17')).toBeNull();
    });
  });
});

describe('lineContractorId (052)', () => {
  const contractorSheet = { engagementType: EngagementType.contractor };
  const directSheet = { engagementType: EngagementType.direct };

  it("keeps the contractor the line was priced under, whatever the worker's now", () => {
    expect(
      lineContractorId(
        contractorSheet,
        { contractorId: 'v1' },
        { contractorId: 'v2' },
      ),
    ).toBe('v1');
  });

  it("falls back to the worker's contractor on a line priced before 052", () => {
    expect(
      lineContractorId(
        contractorSheet,
        { contractorId: null },
        { contractorId: 'v2' },
      ),
    ).toBe('v2');
  });

  it('has none on a direct sheet', () => {
    expect(
      lineContractorId(
        directSheet,
        { contractorId: null },
        { contractorId: 'v2' },
      ),
    ).toBeNull();
  });
});
