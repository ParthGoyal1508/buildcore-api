import { BillTaxBasis, Prisma } from '@prisma/client';

/**
 * The abstract's arithmetic — four blocks, three columns (023 FR-012 to FR-023).
 *
 * Pure: no Nest, no Prisma client, no configuration lookup. **Every rate is an argument with no
 * default**, which is research §4's decision and the shape the whole feature turns on. A bill issued
 * in March must recompute to the same figures in September, after a budget has changed a tax rate
 * and a new contract has changed a retention percentage. A function that read the current rate would
 * make every historical bill re-derive to a number that does not match the paper it was signed on —
 * and it would do that silently, to every bill at once.
 *
 * ## Rounding: computed exact, rounded only to display
 *
 * **This is settled by the client's own document rather than by preference, and the proof is a
 * one-rupee discrepancy on its face.** Block A of the real RA-12 reads:
 *
 *     Work Done        18,41,686
 *     CGST              1,65,752
 *     SGST              1,65,752
 *     Total Amount (A) 21,73,189      ← not 21,73,190
 *
 * Nine per cent of 18,41,686 is 1,65,751.74. Each tax cell shows that rounded to 1,65,752, and the
 * total shows `round(18,41,686 + 1,65,751.74 + 1,65,751.74)` = `round(21,73,189.48)` = 21,73,189.
 * Summing the two *displayed* figures gives 21,73,190 and disagrees with the signed paper by a
 * rupee. The same holds in the cumulative column — 26,74,572.57 + 1,65,751.74 is 28,40,324.31, shown
 * as 28,40,324, where the displayed figures would sum to 28,40,325 — and in blocks C and D.
 *
 * So: **every figure here is a full-precision `Decimal`, and rounding happens once, at the point of
 * display, by `displayRupees`.** Nothing in this file rounds, and nothing sums a rounded value.
 *
 * I got this wrong twice before reading the document carefully. FR-012a's first version required
 * every total to be rounded from unrounded components, which would have made the priced schedule's
 * footer disagree with the column above it; its second said a total of printed lines is the sum of
 * those lines as printed, which produces 21,73,190. The document's answer is neither: full precision
 * throughout, rounded for the eye.
 *
 * ## What is an input and what is computed
 *
 * **Computed**: the three taxes, retention, tax deducted at source, each block's total, and the
 * payable. Each is one multiplication or one sum, never a re-aggregation of displayed values.
 *
 * **Entered**: the four recoveries and three of the four deductions. These are judgements somebody
 * makes about a month — a diesel recovery, a debit, an amount withheld against stolen equipment —
 * and no rate derives them.
 *
 * **Read from the previous bill**: the up-to-previous column, in full, never derived from this bill's
 * own figures (FR-013a). Up-to-date less this bill equals up-to-previous only while the chain is
 * unbroken, and defining the column that way makes FR-035's footer identity a restatement of its own
 * definition — true for any values whatever.
 */

/** A rate, as a fraction. `0.09` is nine per cent. */
export type Fraction = Prisma.Decimal;

export interface AbstractRates {
  retentionFraction: Fraction;
  cgstFraction: Fraction;
  sgstFraction: Fraction;
  igstFraction: Fraction;
  tdsFraction: Fraction;
}

/** The figures a person enters for a month. No rate derives any of these. */
export interface EnteredAmounts {
  /**
   * An amount held back from release this month, shown in block A beside the work done.
   *
   * **Added to block A as entered, and not taxed.** Two statements FR-015a requires be made
   * explicitly, because the sample package withholds nothing and so constrains neither: the taxable
   * base is the work done before any recovery, deduction or withholding (which is what reproduces
   * the real document's 1,65,751.74 exactly), and block A's total is the sum of its rows as they
   * stand — so a withholding that *reduces* the block is entered as a negative figure rather than
   * having its sign guessed here.
   */
  releaseWithheld: Prisma.Decimal;
  recoveryDiesel: Prisma.Decimal;
  debitAgainstCivil: Prisma.Decimal;
  otherRecoveries: Prisma.Decimal;
  /** The debits applied to this bill (FR-038, FR-038a). */
  mechanicalDebit: Prisma.Decimal;
  mobilizationAdvance: Prisma.Decimal;
  performanceSecurity: Prisma.Decimal;
  theftWithheld: Prisma.Decimal;
}

/**
 * A one-time recovery's position (FR-020, FR-020a, FR-020b).
 *
 * **The total is what makes "fully recovered" a fact rather than a wish.** Without it, a deduction
 * that is complete and one somebody happened to enter as zero this month are the same row, and
 * FR-020 is satisfied by an implementation that does nothing at all — which is what
 * `checklists/silent-failure.md` CHK021 found.
 */
export interface OneTimeRecovery {
  /** Null where the contract records none. Then nothing can be said about completeness. */
  total: Prisma.Decimal | null;
  /** What earlier bills have already recovered — the previous bill's cumulative figure. */
  recoveredBefore: Prisma.Decimal;
}

export interface AbstractInput {
  /** The sum of this bill's lines' own stored amounts (FR-012). */
  workDone: Prisma.Decimal;
  entered: EnteredAmounts;
  rates: AbstractRates;
  /** Which tax applies. Decided by `bill-tax.ts`, never chosen here. */
  taxBasis: BillTaxBasis;
  /**
   * The previous bill's **stored** up-to-date column, or null where this is the first bill.
   *
   * Null becomes a column of zeros — "stated as zero, which is a position, and not as absent, which
   * is not" (FR-014).
   */
  previous: AbstractColumn | null;
  oneTime: {
    mobilizationAdvance: OneTimeRecovery;
    performanceSecurity: OneTimeRecovery;
  };
}

/** One of the abstract's three money columns. Every figure full-precision. */
export interface AbstractColumn {
  workDone: Prisma.Decimal;
  releaseWithheld: Prisma.Decimal;
  cgstAmount: Prisma.Decimal;
  sgstAmount: Prisma.Decimal;
  igstAmount: Prisma.Decimal;
  /** Block A. */
  workTotal: Prisma.Decimal;

  recoveryDiesel: Prisma.Decimal;
  debitAgainstCivil: Prisma.Decimal;
  otherRecoveries: Prisma.Decimal;
  mechanicalDebit: Prisma.Decimal;
  /** Block B. */
  recoveriesTotal: Prisma.Decimal;

  mobilizationAdvance: Prisma.Decimal;
  retentionAmount: Prisma.Decimal;
  performanceSecurity: Prisma.Decimal;
  theftWithheld: Prisma.Decimal;
  /** Block C. */
  deductionsTotal: Prisma.Decimal;

  tdsAmount: Prisma.Decimal;
  /** Block D. */
  taxDeductionsTotal: Prisma.Decimal;

  /** A − B − C − D. **May be negative** (FR-022). */
  payable: Prisma.Decimal;
}

export interface BillAbstract {
  thisBill: AbstractColumn;
  uptoPrevious: AbstractColumn;
  uptoDate: AbstractColumn;
}

/** A one-time recovery that would be taken past its total (FR-020b). */
export class RecoveryExceedsTotalError extends Error {
  constructor(
    readonly recovery: 'mobilizationAdvance' | 'performanceSecurity',
    readonly total: Prisma.Decimal,
    readonly alreadyRecovered: Prisma.Decimal,
    readonly attempted: Prisma.Decimal,
  ) {
    super(
      `Recovering ${attempted.toFixed(
        2,
      )} of ${recovery} would take the amount recovered past its ` +
        `total of ${total.toFixed(2)}: ${alreadyRecovered.toFixed(
          2,
        )} has already been recovered, ` +
        `so ${total.minus(alreadyRecovered).toFixed(2)} remains.`,
    );
    // Thrown by name rather than returned as a flag, for the reason 022's `ZeroFactorError` is:
    // a caller that forgets to check a flag bills the money twice, and a caller that forgets to
    // catch gets a 500 somebody notices.
    this.name = 'RecoveryExceedsTotalError';
  }
}

const ZERO = new Prisma.Decimal(0);

const sum = (...values: Prisma.Decimal[]): Prisma.Decimal =>
  values.reduce((total, value) => total.plus(value), ZERO);

/** A column of zeros — what precedes the first bill (FR-014). */
export function zeroColumn(): AbstractColumn {
  return {
    workDone: ZERO,
    releaseWithheld: ZERO,
    cgstAmount: ZERO,
    sgstAmount: ZERO,
    igstAmount: ZERO,
    workTotal: ZERO,
    recoveryDiesel: ZERO,
    debitAgainstCivil: ZERO,
    otherRecoveries: ZERO,
    mechanicalDebit: ZERO,
    recoveriesTotal: ZERO,
    mobilizationAdvance: ZERO,
    retentionAmount: ZERO,
    performanceSecurity: ZERO,
    theftWithheld: ZERO,
    deductionsTotal: ZERO,
    tdsAmount: ZERO,
    taxDeductionsTotal: ZERO,
    payable: ZERO,
  };
}

/**
 * **The single rounding point in this feature** (FR-012a).
 *
 * To the rupee, half away from zero, and only for the eye. The client's package is written in whole
 * rupees and so are the statutory returns behind it. Nothing computed from a figure may be computed
 * from this one — see the one-rupee proof in this file's own docblock.
 */
export function displayRupees(value: Prisma.Decimal): string {
  return value.toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toFixed(0);
}

/** `true` when a one-time recovery has nothing left to take (FR-020, FR-020a). */
export function isFullyRecovered(recovery: OneTimeRecovery): boolean {
  if (recovery.total === null) return false;
  return recovery.recoveredBefore.greaterThanOrEqualTo(recovery.total);
}

/**
 * The abstract, in three columns.
 *
 * Each column balances on its own (FR-021): its payable is its own A less its own B, C and D, so a
 * reader checking the middle column by hand gets the same answer as a reader checking the right one.
 * The cumulative column is this bill added to the previous bill's stored one, never a recomputation
 * from current data (FR-014).
 */
export function billAbstract(input: AbstractInput): BillAbstract {
  const { workDone, entered, rates, taxBasis, oneTime } = input;

  // FR-015: either the two half-rate taxes or the single full-rate one. **Never both and never
  // neither** — both is a bill 18% too high, neither is 18% too low and a liability the company
  // carries itself.
  const intra = taxBasis === BillTaxBasis.intra_state;
  // FR-015a: the base is the work done, before any recovery, deduction or withholding. This is what
  // reproduces the real document's 1,65,751.74 exactly, and a base of the post-retention figure or
  // the tax-inclusive total would not.
  const cgstAmount = intra ? workDone.times(rates.cgstFraction) : ZERO;
  const sgstAmount = intra ? workDone.times(rates.sgstFraction) : ZERO;
  const igstAmount = intra ? ZERO : workDone.times(rates.igstFraction);

  // FR-018a and FR-019a: both over the work done before tax, recoveries and other deductions — not
  // over the payable that tax deducted is subtracted from. Five per cent of the right base
  // reproduces the sample's 92,084.30 and five per cent of the tax-inclusive total does not.
  const retentionAmount = workDone.times(rates.retentionFraction);
  const tdsAmount = workDone.times(rates.tdsFraction);

  const mobilizationAdvance = guardOneTime(
    'mobilizationAdvance',
    entered.mobilizationAdvance,
    oneTime.mobilizationAdvance,
  );
  const performanceSecurity = guardOneTime(
    'performanceSecurity',
    entered.performanceSecurity,
    oneTime.performanceSecurity,
  );

  const thisBill = balance({
    workDone,
    releaseWithheld: entered.releaseWithheld,
    cgstAmount,
    sgstAmount,
    igstAmount,
    recoveryDiesel: entered.recoveryDiesel,
    debitAgainstCivil: entered.debitAgainstCivil,
    otherRecoveries: entered.otherRecoveries,
    mechanicalDebit: entered.mechanicalDebit,
    mobilizationAdvance,
    retentionAmount,
    performanceSecurity,
    theftWithheld: entered.theftWithheld,
    tdsAmount,
  });

  const uptoPrevious = input.previous ?? zeroColumn();
  const uptoDate = balance({
    workDone: uptoPrevious.workDone.plus(thisBill.workDone),
    releaseWithheld: uptoPrevious.releaseWithheld.plus(
      thisBill.releaseWithheld,
    ),
    cgstAmount: uptoPrevious.cgstAmount.plus(thisBill.cgstAmount),
    sgstAmount: uptoPrevious.sgstAmount.plus(thisBill.sgstAmount),
    igstAmount: uptoPrevious.igstAmount.plus(thisBill.igstAmount),
    recoveryDiesel: uptoPrevious.recoveryDiesel.plus(thisBill.recoveryDiesel),
    debitAgainstCivil: uptoPrevious.debitAgainstCivil.plus(
      thisBill.debitAgainstCivil,
    ),
    otherRecoveries: uptoPrevious.otherRecoveries.plus(
      thisBill.otherRecoveries,
    ),
    mechanicalDebit: uptoPrevious.mechanicalDebit.plus(
      thisBill.mechanicalDebit,
    ),
    mobilizationAdvance: uptoPrevious.mobilizationAdvance.plus(
      thisBill.mobilizationAdvance,
    ),
    retentionAmount: uptoPrevious.retentionAmount.plus(
      thisBill.retentionAmount,
    ),
    performanceSecurity: uptoPrevious.performanceSecurity.plus(
      thisBill.performanceSecurity,
    ),
    theftWithheld: uptoPrevious.theftWithheld.plus(thisBill.theftWithheld),
    tdsAmount: uptoPrevious.tdsAmount.plus(thisBill.tdsAmount),
  });

  return { thisBill, uptoPrevious, uptoDate };
}

/**
 * A one-time recovery, checked against its recorded total (FR-020a, FR-020b).
 *
 * A fully-recovered deduction is **zero this bill** and keeps its cumulative figure, which is what
 * the real package's performance security does: 10,57,832 up to date, 10,57,832 up to previous,
 * blank this month. Getting it wrong re-recovers money that was already taken.
 */
function guardOneTime(
  which: 'mobilizationAdvance' | 'performanceSecurity',
  entered: Prisma.Decimal,
  position: OneTimeRecovery,
): Prisma.Decimal {
  if (position.total === null) {
    // Nothing recorded to compare against, so nothing can be asserted about completeness. The
    // entered figure stands and `BillPackage`'s null total is what says why.
    return entered;
  }
  if (isFullyRecovered(position)) {
    // Blank this bill, cumulative preserved. Not an error: it is the ordinary end state of a
    // one-time recovery, and the sample package is in it.
    if (entered.isZero()) return ZERO;
    throw new RecoveryExceedsTotalError(
      which,
      position.total,
      position.recoveredBefore,
      entered,
    );
  }
  if (position.recoveredBefore.plus(entered).greaterThan(position.total)) {
    throw new RecoveryExceedsTotalError(
      which,
      position.total,
      position.recoveredBefore,
      entered,
    );
  }
  return entered;
}

/** Totals a column's rows. The only place a block total is formed. */
function balance(
  rows: Omit<
    AbstractColumn,
    | 'workTotal'
    | 'recoveriesTotal'
    | 'deductionsTotal'
    | 'taxDeductionsTotal'
    | 'payable'
  >,
): AbstractColumn {
  const workTotal = sum(
    rows.workDone,
    rows.releaseWithheld,
    rows.cgstAmount,
    rows.sgstAmount,
    rows.igstAmount,
  );
  const recoveriesTotal = sum(
    rows.recoveryDiesel,
    rows.debitAgainstCivil,
    rows.otherRecoveries,
    rows.mechanicalDebit,
  );
  const deductionsTotal = sum(
    rows.mobilizationAdvance,
    rows.retentionAmount,
    rows.performanceSecurity,
    rows.theftWithheld,
  );
  const taxDeductionsTotal = rows.tdsAmount;

  return {
    ...rows,
    workTotal,
    recoveriesTotal,
    deductionsTotal,
    taxDeductionsTotal,
    // FR-021, and FR-022: never clamped at zero. A bill whose debits exceed its work is a real
    // outcome the client's own format expresses, and clamping would hide money the company is owed
    // back behind a payable of nothing.
    payable: workTotal
      .minus(recoveriesTotal)
      .minus(deductionsTotal)
      .minus(taxDeductionsTotal),
  };
}
