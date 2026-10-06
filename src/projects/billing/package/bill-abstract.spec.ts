import { BillTaxBasis, Prisma } from '@prisma/client';

import {
  AbstractInput,
  RecoveryExceedsTotalError,
  billAbstract,
  displayRupees,
  isFullyRecovered,
  zeroColumn,
} from './bill-abstract';

/**
 * The abstract's arithmetic (023 US2, tasks T045 to T048).
 *
 * **T046 is the test this phase exists for**: the client's own RA-12, reproduced. Asserting that
 * "nine per cent was applied" is satisfied by nine per cent of anything — of the post-retention
 * figure, of the tax-inclusive total, of the wrong month. A real document is satisfied by nine per
 * cent of exactly one thing.
 */

const d = (value: string | number) => new Prisma.Decimal(value);

const RATES = {
  retentionFraction: d('0.050000'),
  cgstFraction: d('0.090000'),
  sgstFraction: d('0.090000'),
  igstFraction: d('0.180000'),
  tdsFraction: d('0.020000'),
};

const NOTHING_ENTERED = {
  releaseWithheld: d(0),
  recoveryDiesel: d(0),
  debitAgainstCivil: d(0),
  otherRecoveries: d(0),
  mechanicalDebit: d(0),
  mobilizationAdvance: d(0),
  performanceSecurity: d(0),
  theftWithheld: d(0),
};

const NO_ONE_TIME = {
  mobilizationAdvance: { total: null, recoveredBefore: d(0) },
  performanceSecurity: { total: null, recoveredBefore: d(0) },
};

function input(over: Partial<AbstractInput> = {}): AbstractInput {
  return {
    workDone: d('1841686'),
    entered: { ...NOTHING_ENTERED },
    rates: RATES,
    taxBasis: BillTaxBasis.intra_state,
    previous: null,
    oneTime: NO_ONE_TIME,
    ...over,
  };
}

describe('the client’s own RA-12, reproduced', () => {
  // T046. Figures transcribed from `docs/Parth Realcon Pvt Ltd. RA-12 (1).pdf`, page 2, not
  // inferred — SC-003's own stated figures do not reach its stated payable without them, and a
  // number back-solved to make a test pass tests nothing.
  //
  // This month, from the document:
  //   Work done        18,41,686     CGST 1,65,752   SGST 1,65,752   Total (A) 21,73,189
  //   Recoveries (B)            -
  //   Retention @5%        92,084     Theft withheld 9,04,300        Total (C)  9,96,384
  //   TDS @2%              36,834                                    Total (D)    36,834
  //   Payable           11,39,971
  const THIS_MONTH = input({
    entered: { ...NOTHING_ENTERED, theftWithheld: d('904300') },
    oneTime: {
      mobilizationAdvance: { total: null, recoveredBefore: d(0) },
      // Fully recovered before this bill, which is why it is blank this month and present in both
      // cumulative columns: 10,57,832 against 10,57,832.
      performanceSecurity: {
        total: d('1057832'),
        recoveredBefore: d('1057832'),
      },
    },
  });

  it('derives every rate-driven figure to the rupee the document shows', () => {
    const { thisBill } = billAbstract(THIS_MONTH);

    expect(displayRupees(thisBill.cgstAmount)).toBe('165752');
    expect(displayRupees(thisBill.sgstAmount)).toBe('165752');
    expect(displayRupees(thisBill.retentionAmount)).toBe('92084');
    expect(displayRupees(thisBill.tdsAmount)).toBe('36834');
    // The full-rate row exists and is blank, which is the document's own shape.
    expect(displayRupees(thisBill.igstAmount)).toBe('0');
  });

  it('totals each block to the document’s own figure — including block A’s rupee', () => {
    // **The assertion that settles the rounding rule.** Nine per cent of 18,41,686 is 1,65,751.74.
    // The document shows each tax cell as 1,65,752 and block A as 21,73,189 — which is
    // round(18,41,686 + 1,65,751.74 + 1,65,751.74). Summing the two *displayed* figures gives
    // 21,73,190 and disagrees with the paper the client signed.
    //
    // An implementation that re-sums displayed values passes every percentage assertion and fails
    // this one. That is the whole reason to reproduce a real document.
    const { thisBill } = billAbstract(THIS_MONTH);

    expect(displayRupees(thisBill.workTotal)).toBe('2173189');
    expect(displayRupees(thisBill.recoveriesTotal)).toBe('0');
    expect(displayRupees(thisBill.deductionsTotal)).toBe('996384');
    expect(displayRupees(thisBill.taxDeductionsTotal)).toBe('36834');
    expect(displayRupees(thisBill.payable)).toBe('1139971');
  });

  it('carries full precision underneath, which is what makes those totals possible', () => {
    const { thisBill } = billAbstract(THIS_MONTH);

    expect(thisBill.cgstAmount.toFixed(2)).toBe('165751.74');
    expect(thisBill.retentionAmount.toFixed(2)).toBe('92084.30');
    expect(thisBill.tdsAmount.toFixed(2)).toBe('36833.72');
    expect(thisBill.workTotal.toFixed(2)).toBe('2173189.48');
    expect(thisBill.payable.toFixed(2)).toBe('1139971.46');
  });

  it('shows a fully-recovered one-time deduction as blank this bill', () => {
    // FR-020a. The real performance security: 10,57,832 up to date, 10,57,832 up to previous, and
    // nothing this month. Re-recovering it would take the money twice.
    const { thisBill } = billAbstract(THIS_MONTH);

    expect(thisBill.performanceSecurity.isZero()).toBe(true);
    expect(isFullyRecovered(THIS_MONTH.oneTime.performanceSecurity)).toBe(true);
  });

  it('reaches the document’s cumulative column from the previous bill’s stored one', () => {
    // FR-014. Up to previous is read, never recomputed — so the cumulative column is the previous
    // bill's figures plus this bill's, and the document's 28,40,324 for cumulative tax is
    // round(26,74,572.57 + 1,65,751.74) = round(28,40,324.31). The displayed figures would sum to
    // 28,40,325, a rupee out, in the other direction from block A's.
    const previous = {
      ...zeroColumn(),
      workDone: d('29717473'),
      cgstAmount: d('2674572.57'),
      sgstAmount: d('2674572.57'),
      workTotal: d('35066618.14'),
      retentionAmount: d('1485873.65'),
      performanceSecurity: d('1057832'),
      theftWithheld: d('3042019'),
      deductionsTotal: d('5585724.65'),
      tdsAmount: d('594349.46'),
      taxDeductionsTotal: d('594349.46'),
      payable: d('28886544.03'),
    };

    const { uptoDate, uptoPrevious } = billAbstract(
      input({ ...THIS_MONTH, previous }),
    );

    expect(displayRupees(uptoDate.workDone)).toBe('31559159');
    expect(displayRupees(uptoDate.cgstAmount)).toBe('2840324');
    expect(displayRupees(uptoDate.retentionAmount)).toBe('1577958');
    expect(displayRupees(uptoDate.theftWithheld)).toBe('3946319');
    expect(displayRupees(uptoDate.deductionsTotal)).toBe('6582109');
    expect(displayRupees(uptoDate.payable)).toBe('30026515');
    // And the middle column is the predecessor's, untouched.
    expect(uptoPrevious.workDone.toFixed(2)).toBe('29717473.00');
  });
});

describe('the abstract’s structure', () => {
  it('reports every named recovery and deduction whether or not it carries an amount', () => {
    // FR-017. Not one `otherDeductions` bucket: a subcontractor disputing a payment asks which
    // deduction accounts for the difference, and a bucket cannot answer.
    const { thisBill } = billAbstract(input());

    for (const key of [
      'recoveryDiesel',
      'debitAgainstCivil',
      'otherRecoveries',
      'mechanicalDebit',
      'mobilizationAdvance',
      'retentionAmount',
      'performanceSecurity',
      'theftWithheld',
    ] as const) {
      expect(thisBill[key]).toBeDefined();
    }
  });

  it('balances each of the three columns independently', () => {
    // FR-021. A reader checking the middle column by hand must get the same answer as one checking
    // the right.
    const previous = {
      ...zeroColumn(),
      workDone: d('1000000'),
      cgstAmount: d('90000'),
      sgstAmount: d('90000'),
      workTotal: d('1180000'),
      retentionAmount: d('50000'),
      deductionsTotal: d('50000'),
      tdsAmount: d('20000'),
      taxDeductionsTotal: d('20000'),
      payable: d('1110000'),
    };
    const result = billAbstract(
      input({
        previous,
        entered: { ...NOTHING_ENTERED, recoveryDiesel: d('1000') },
      }),
    );

    for (const column of [result.thisBill, result.uptoDate]) {
      const expected = column.workTotal
        .minus(column.recoveriesTotal)
        .minus(column.deductionsTotal)
        .minus(column.taxDeductionsTotal);
      expect(column.payable.equals(expected)).toBe(true);
    }
  });

  it('applies either the half-rate pair or the full-rate tax — never both, never neither', () => {
    // FR-015. The two failures this prevents fail in opposite directions: both is a bill 18% too
    // high, neither is 18% too low and a liability the company carries itself.
    const intra = billAbstract(input({ taxBasis: BillTaxBasis.intra_state }));
    expect(intra.thisBill.igstAmount.isZero()).toBe(true);
    expect(intra.thisBill.cgstAmount.isZero()).toBe(false);

    const inter = billAbstract(input({ taxBasis: BillTaxBasis.inter_state }));
    expect(inter.thisBill.cgstAmount.isZero()).toBe(true);
    expect(inter.thisBill.sgstAmount.isZero()).toBe(true);
    expect(inter.thisBill.igstAmount.isZero()).toBe(false);

    // And the two come to the same money, which is the property that makes "never both, never
    // neither" worth stating: 9 + 9 is 18.
    expect(
      intra.thisBill.cgstAmount
        .plus(intra.thisBill.sgstAmount)
        .equals(inter.thisBill.igstAmount),
    ).toBe(true);
  });

  it('permits a negative payable rather than clamping it to zero', () => {
    // FR-022. A bill whose debits exceed its work is a real outcome the client's own format
    // expresses, and clamping hides money the company is owed back behind a payable of nothing.
    const { thisBill } = billAbstract(
      input({
        workDone: d('100000'),
        entered: { ...NOTHING_ENTERED, theftWithheld: d('500000') },
      }),
    );

    expect(thisBill.payable.isNegative()).toBe(true);
    // A 1,18,000 less 5,05,000 of deductions less 2,000 of tax deducted.
    expect(displayRupees(thisBill.payable)).toBe('-389000');
  });

  it('treats the first bill’s up-to-previous as zero, which is a position', () => {
    // FR-014. Zero and absent are different things on a document whose reader subtracts columns.
    const { uptoPrevious, uptoDate, thisBill } = billAbstract(
      input({ previous: null }),
    );

    expect(uptoPrevious.workDone.isZero()).toBe(true);
    expect(uptoDate.payable.equals(thisBill.payable)).toBe(true);
  });
});

describe('the release withheld amount, which the sample bill cannot test', () => {
  // FR-015a, and the reason it had to be written down: the real package withholds nothing, so no
  // test drawn from it constrains this path at all. CHK016.

  it('leaves the taxable base alone', () => {
    const without = billAbstract(input());
    const withHeld = billAbstract(
      input({ entered: { ...NOTHING_ENTERED, releaseWithheld: d('-100000') } }),
    );

    // The tax is nine per cent of the work done, before any withholding. Had the withholding
    // entered the base, this would be 9% of 17,41,686 instead.
    expect(
      withHeld.thisBill.cgstAmount.equals(without.thisBill.cgstAmount),
    ).toBe(true);
  });

  it('enters block A with the sign it was given', () => {
    // Stated rather than guessed. A withholding that reduces the block is entered negative; the
    // function does not decide which direction "withheld" points, because the client's own sheet
    // shows a dash and settles nothing.
    const reducing = billAbstract(
      input({ entered: { ...NOTHING_ENTERED, releaseWithheld: d('-100000') } }),
    );
    const plain = billAbstract(input());

    expect(
      plain.thisBill.workTotal.minus(reducing.thisBill.workTotal).toFixed(2),
    ).toBe('100000.00');
  });

  it('leaves retention and tax deducted on the work done too', () => {
    const withHeld = billAbstract(
      input({ entered: { ...NOTHING_ENTERED, releaseWithheld: d('-100000') } }),
    );

    expect(withHeld.thisBill.retentionAmount.toFixed(2)).toBe('92084.30');
    expect(withHeld.thisBill.tdsAmount.toFixed(2)).toBe('36833.72');
  });
});

describe('a one-time recovery against its recorded total', () => {
  it('refuses a recovery that would take it past the total, naming what remains', () => {
    // FR-020b. Without the total there is nothing to refuse against, which is what made FR-020
    // satisfiable by doing nothing (CHK021).
    expect(() =>
      billAbstract(
        input({
          entered: { ...NOTHING_ENTERED, mobilizationAdvance: d('300000') },
          oneTime: {
            mobilizationAdvance: {
              total: d('1000000'),
              recoveredBefore: d('800000'),
            },
            performanceSecurity: { total: null, recoveredBefore: d(0) },
          },
        }),
      ),
    ).toThrow(RecoveryExceedsTotalError);
  });

  it('allows a recovery that exactly completes it', () => {
    const { thisBill } = billAbstract(
      input({
        entered: { ...NOTHING_ENTERED, mobilizationAdvance: d('200000') },
        oneTime: {
          mobilizationAdvance: {
            total: d('1000000'),
            recoveredBefore: d('800000'),
          },
          performanceSecurity: { total: null, recoveredBefore: d(0) },
        },
      }),
    );

    expect(thisBill.mobilizationAdvance.toFixed(2)).toBe('200000.00');
  });

  it('refuses any further recovery once it is complete', () => {
    expect(() =>
      billAbstract(
        input({
          entered: { ...NOTHING_ENTERED, performanceSecurity: d('1') },
          oneTime: {
            mobilizationAdvance: { total: null, recoveredBefore: d(0) },
            performanceSecurity: {
              total: d('1057832'),
              recoveredBefore: d('1057832'),
            },
          },
        }),
      ),
    ).toThrow(RecoveryExceedsTotalError);
  });

  it('says nothing about completeness when no total is recorded', () => {
    // Null total means the contract records none, so the entered figure stands and the null is what
    // says why. This is the honest gap rather than a silent "fully recovered".
    expect(
      isFullyRecovered({ total: null, recoveredBefore: d('999999') }),
    ).toBe(false);
  });
});

describe('displayRupees', () => {
  it('rounds half away from zero, to the rupee', () => {
    expect(displayRupees(new Prisma.Decimal('165751.74'))).toBe('165752');
    expect(displayRupees(new Prisma.Decimal('92084.30'))).toBe('92084');
    expect(displayRupees(new Prisma.Decimal('0.5'))).toBe('1');
    expect(displayRupees(new Prisma.Decimal('-0.5'))).toBe('-1');
  });
});
