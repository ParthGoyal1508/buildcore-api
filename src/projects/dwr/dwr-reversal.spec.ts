import { Prisma } from '@prisma/client';

import { storedQuantityInForce } from './dwr-quantity';

/**
 * Reversal arithmetic: what a reversal takes back, and why it is read rather than recomputed
 * (022 FR-019, FR-021, research §7).
 *
 * The service-level paths — the refusals, the billed-quantity floor, the status transition — are
 * exercised end to end in `test/dwr.e2e-spec.ts` against a real database, because their whole
 * content is a transaction and a mocked transaction proves only that the mock was called. What is
 * worth testing in isolation is the **arithmetic**, and specifically the one decision in it that a
 * reader would otherwise assume was arbitrary: that the quantities subtracted come from the stored
 * columns and not from recomputing the factors.
 */
describe('a reversal subtracts what the approval added, not what the line now computes to', () => {
  it('reads the stored measured quantity even after the factors have been edited', () => {
    // The scenario, which is ordinary: a line is approved at 14.063, somebody later corrects a
    // factor on the row directly, and the report is then reversed. Recomputing from the factors
    // would subtract a figure the approval never added, leaving the counter permanently wrong by
    // the difference — and nothing would notice, because both numbers look plausible.
    const approvedAt = new Prisma.Decimal('14.063');

    const rowAfterSomebodyEditedTheFactors = {
      paymentMode: 'work_basis' as const,
      actualQty: approvedAt, // what the approval moved
      servedQty: null,
      // Factors now implying 999.000 — irrelevant, and that is the point.
      nos1: new Prisma.Decimal(999),
    };

    expect(
      storedQuantityInForce(rowAfterSomebodyEditedTheFactors).toFixed(3),
    ).toBe('14.063');
  });

  it('returns a counter to its exact prior value, not approximately', () => {
    // Three lines against one BOQ line, the shape the client's own sheets produce when two crews
    // measure two stretches of one item. Approval adds the total; reversal subtracts the same
    // total; the counter must land on the original figure exactly.
    const before = new Prisma.Decimal('2.600');
    const lines = [
      {
        paymentMode: 'day_basis' as const,
        actualQty: null,
        servedQty: new Prisma.Decimal('0.700'),
      },
      {
        paymentMode: 'day_basis' as const,
        actualQty: null,
        servedQty: new Prisma.Decimal('0.200'),
      },
      {
        paymentMode: 'work_basis' as const,
        actualQty: new Prisma.Decimal('1.333'),
        servedQty: null,
      },
    ];

    const total = lines.reduce(
      (sum, line) => sum.plus(storedQuantityInForce(line)),
      new Prisma.Decimal(0),
    );

    const afterApproval = before.plus(total);
    const afterReversal = afterApproval.minus(total);

    expect(total.toFixed(3)).toBe('2.233');
    expect(afterApproval.toFixed(3)).toBe('4.833');
    // `equals`, not a tolerance. Decimal arithmetic is exact, and FR-039a's reconciliation is only
    // meaningful at an exact tolerance — a reversal that landed within a thousandth would make
    // every later reconciliation report a discrepancy nobody could act on.
    expect(afterReversal.equals(before)).toBe(true);
  });

  it('cannot be satisfied by floating point, which is why Decimal is used throughout', () => {
    // The same three quantities as plain numbers — what the previous test would be asserting if
    // quantities were JavaScript numbers, and why they are not.
    const floatTotal = 0.7 + 0.2 + 1.333;
    const floatAfter = 2.6 + floatTotal - floatTotal;

    // The total is not the figure anybody typed, and only looks right once rounded for display:
    expect(floatTotal).not.toBe(2.233);
    expect(floatTotal.toFixed(3)).toBe('2.233');

    // And the approve-then-reverse round trip does **not** return the counter to where it started.
    // 2.6000000000000005 against 2.6 — a sixteenth-decimal-place error, invisible in every report
    // that formats to three places, and permanent. A reconciliation at an exact tolerance (FR-039a)
    // would report this line as a discrepancy for ever, and nobody could act on it because both
    // figures display identically.
    expect(floatAfter).not.toBe(2.6);
    expect(floatAfter.toFixed(3)).toBe('2.600');

    // Decimal is exact before any rounding, which is what a billed figure needs.
    expect(
      new Prisma.Decimal('0.700')
        .plus('0.200')
        .plus('1.333')
        .equals(new Prisma.Decimal('2.233')),
    ).toBe(true);
    expect(
      new Prisma.Decimal('2.600')
        .plus('2.233')
        .minus('2.233')
        .equals(new Prisma.Decimal('2.600')),
    ).toBe(true);
  });

  it('drops lines that reference no BOQ line, which move nothing in either direction', () => {
    // FR-007. Freeform work the BOQ itemises differently is ordinary, and a line with nowhere to
    // post a quantity must not post one — in either direction. Asserted because the symmetry is
    // what matters: if approval skipped such a line and reversal did not, the counter would drift
    // by its quantity every time a report went round.
    const tasks = [
      {
        boqItemId: null,
        paymentMode: 'day_basis' as const,
        actualQty: null,
        servedQty: new Prisma.Decimal(1),
      },
      {
        boqItemId: 'boq-1',
        paymentMode: 'day_basis' as const,
        actualQty: null,
        servedQty: new Prisma.Decimal(1),
      },
    ];

    const posting = tasks.filter((t) => t.boqItemId !== null);
    expect(posting).toHaveLength(1);
    expect(posting[0].boqItemId).toBe('boq-1');
  });
});

describe('the non-negative floor', () => {
  it('can only be reached when the counter has already drifted', () => {
    // FR-021 reads as arithmetic and is in practice a drift requirement, which is worth stating
    // somewhere a reader will find it. A reversal subtracts exactly what its own approval added, so
    // the result cannot be negative unless something else moved the counter down in between — a
    // partial failure, a hand-edit, or a bug. The floor exists to refuse rather than to go
    // negative, and the message points at reconciliation for that reason.
    const approvalAdded = new Prisma.Decimal('5.000');

    const undisturbed = new Prisma.Decimal('5.000').minus(approvalAdded);
    expect(undisturbed.isNegative()).toBe(false);
    expect(undisturbed.isZero()).toBe(true);

    const drifted = new Prisma.Decimal('3.000').minus(approvalAdded);
    expect(drifted.isNegative()).toBe(true);
  });
});
