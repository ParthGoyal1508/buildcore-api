import { Prisma } from '@prisma/client';

import {
  FULL_DAY,
  ZeroFactorError,
  computeMeasuredQty,
  quantityColumnsFor,
  quantityInForce,
  storedQuantityInForce,
} from './dwr-quantity';

describe('computeMeasuredQty', () => {
  it('multiplies the six factors', () => {
    // 2 × 1 × 12.5 × 3.75 × 0.15 × 1 — the worked example in quickstart.md Pass 1.
    expect(
      computeMeasuredQty({
        nos1: 2,
        nos2: 1,
        length: 12.5,
        breadth: 3.75,
        depth: 0.15,
        density: 1,
      }).toFixed(3),
    ).toBe('14.063');
  });

  it('treats an omitted factor as 1, not as 0', () => {
    // The whole reason the columns default to 1: an unused dimension must be multiplicatively
    // neutral. Were an omitted factor 0 instead, every line measuring an area rather than a volume
    // would silently come to nothing.
    expect(computeMeasuredQty({ length: 4, breadth: 5 }).toFixed(3)).toBe(
      '20.000',
    );
    expect(computeMeasuredQty({}).toFixed(3)).toBe('1.000');
  });

  it('treats null the same as omitted, because a DTO sends one or the other', () => {
    expect(
      computeMeasuredQty({ nos1: 3, nos2: null, length: undefined }).toFixed(3),
    ).toBe('3.000');
  });

  it('refuses a factor supplied as 0, naming the factor', () => {
    // Named rather than counted: the fix is that one field, and "the quantity is invalid" sends the
    // person who hit it to no particular place.
    expect(() => computeMeasuredQty({ nos1: 2, depth: 0 })).toThrow(
      ZeroFactorError,
    );

    try {
      computeMeasuredQty({ nos1: 2, depth: 0 });
      fail('expected a ZeroFactorError');
    } catch (error) {
      expect((error as ZeroFactorError).factor).toBe('depth');
      expect((error as Error).message).toContain('depth');
    }
  });

  it('refuses the first zero factor in multiplication order', () => {
    // Deterministic, so the message is reproducible rather than depending on object key order.
    try {
      computeMeasuredQty({ density: 0, nos2: 0 });
      fail('expected a ZeroFactorError');
    } catch (error) {
      expect((error as ZeroFactorError).factor).toBe('nos2');
    }
  });

  it('keeps three-place precision exactly, never through a float', () => {
    // 0.1 + 0.2 arithmetic in the third decimal place of a figure a client is invoiced from is not
    // an acceptable error, and FR-039a's exact reconciliation tolerance is only meaningful if
    // nothing upstream has already rounded.
    const q = computeMeasuredQty({ length: '0.001', nos1: '3' });
    expect(q).toBeInstanceOf(Prisma.Decimal);
    expect(q.toFixed(3)).toBe('0.003');
  });
});

describe('quantityInForce', () => {
  it('uses the factors for a work-measured line', () => {
    expect(
      quantityInForce({
        paymentMode: 'work_basis',
        length: 10,
        breadth: 2,
      }).toFixed(3),
    ).toBe('20.000');
  });

  it('uses the served day for a presence-paid line', () => {
    expect(
      quantityInForce({ paymentMode: 'day_basis', servedQty: 0.5 }).toFixed(3),
    ).toBe('0.500');
  });

  it('accepts a served quantity of zero as a quantity, not as an absence', () => {
    // FR-031. "The asset was there and performed nothing" is a fact the client's sheets record —
    // many measurement rows read "-" — and it is a different fact from nobody having recorded the
    // day at all. Zero must survive every layer rather than being treated as missing.
    const q = quantityInForce({ paymentMode: 'day_basis', servedQty: 0 });
    expect(q.isZero()).toBe(true);
    expect(q.toFixed(3)).toBe('0.000');
  });

  it('treats a served quantity of 1 as one full day and infers no other basis', () => {
    // FR-030e. Not derived from the line's unit, its rate, or the days in the month.
    expect(
      quantityInForce({ paymentMode: 'day_basis', servedQty: 1 }).equals(
        FULL_DAY,
      ),
    ).toBe(true);
  });
});

describe('a presence-paid line and the six factors', () => {
  /**
   * **The awkward test** (022 T011, FR-030d, quickstart.md Pass 4 step 4).
   *
   * This is the one assertion in the feature most likely to rot, and it is written awkwardly on
   * purpose.
   *
   * All six measurement factors default to **1**, so their product is **1** — which is exactly
   * what one day served looks like. Any implementation that reached for the factors on a presence
   * line would therefore return the right answer for every row anybody created normally, pass a
   * conventionally-written test, and turn wrong only once somebody set a factor. The defect would
   * be invisible until it reached a bill.
   *
   * So the factors are set to **7** here, where 7 is chosen for no reason other than that it is not
   * 1 and its sixth power is not 1 either. The expected answer is the served quantity, untouched.
   * If this test ever fails, something has started consulting the factors for a line that is not
   * measured by them.
   *
   * `PresenceLine` has no factor fields at all, so the extra properties are cast in deliberately —
   * the cast is what simulates the thing the types are there to prevent: a row whose columns carry
   * values the type system says cannot be there, which is exactly what a seed, a migration or a
   * hand-edit produces.
   */
  it('still yields the served quantity when all six factors are set to 7', () => {
    const contaminated = {
      paymentMode: 'day_basis' as const,
      servedQty: 0.5,
      nos1: 7,
      nos2: 7,
      length: 7,
      breadth: 7,
      depth: 7,
      density: 7,
    };

    // 7^6 = 117,649. If the factors were being read, this would be that — or 58,824.5.
    expect(quantityInForce(contaminated).toFixed(3)).toBe('0.500');
    expect(quantityColumnsFor(contaminated)).toEqual({
      actualQty: null,
      servedQty: new Prisma.Decimal(0.5),
    });
  });

  it('is unaffected even when a factor is 0, which would refuse a measured line', () => {
    // The same point from the other side: a zero factor is a refusal for a measured line and a
    // non-event for a presence line, because the factors are not part of its arithmetic at all.
    const contaminated = {
      paymentMode: 'day_basis' as const,
      servedQty: 1,
      depth: 0,
    };

    expect(() => quantityInForce(contaminated)).not.toThrow();
    expect(quantityInForce(contaminated).toFixed(3)).toBe('1.000');
  });
});

describe('quantityColumnsFor', () => {
  it('writes the measured quantity and leaves the served one null', () => {
    expect(
      quantityColumnsFor({ paymentMode: 'work_basis', length: 3, breadth: 4 }),
    ).toEqual({ actualQty: new Prisma.Decimal(12), servedQty: null });
  });

  it('writes the served quantity and leaves the measured one null', () => {
    expect(
      quantityColumnsFor({ paymentMode: 'day_basis', servedQty: '0.700' }),
    ).toEqual({ actualQty: null, servedQty: new Prisma.Decimal('0.700') });
  });

  it('never returns both or neither, which is what the CHECK constraint also refuses', () => {
    // The invariant of FR-030a, asserted here as well as in the database. Two guards rather than
    // one because this function is what every write goes through, and the constraint is what every
    // *other* path goes through.
    for (const line of [
      { paymentMode: 'work_basis' as const, length: 2 },
      { paymentMode: 'day_basis' as const, servedQty: 9 },
    ]) {
      const columns = quantityColumnsFor(line);
      const present = [columns.actualQty, columns.servedQty].filter(
        (c) => c !== null,
      );
      expect(present).toHaveLength(1);
    }
  });
});

describe('storedQuantityInForce', () => {
  it('reads the stored measured quantity rather than recomputing it', () => {
    // Reading and recomputing are different acts. A stored measured quantity is the figure an
    // approval actually moved; recomputing it from factors that may since have been edited would
    // make a reversal subtract something other than what was added.
    expect(
      storedQuantityInForce({
        paymentMode: 'work_basis',
        actualQty: new Prisma.Decimal('14.063'),
        servedQty: null,
      }).toFixed(3),
    ).toBe('14.063');
  });

  it('reads the stored served quantity for a presence line', () => {
    expect(
      storedQuantityInForce({
        paymentMode: 'day_basis',
        actualQty: null,
        servedQty: new Prisma.Decimal('0.700'),
      }).toFixed(3),
    ).toBe('0.700');
  });

  it('reads a stored zero as zero and not as missing', () => {
    expect(
      storedQuantityInForce({
        paymentMode: 'day_basis',
        actualQty: null,
        servedQty: new Prisma.Decimal(0),
      }).isZero(),
    ).toBe(true);
  });

  it('throws rather than defaulting to zero when the governing column is null', () => {
    // Unreachable while the CHECK holds, which is why it is worth asserting: if the constraint is
    // ever dropped, this is what says so. A missing quantity silently read as nothing is how a bill
    // loses a line, and that failure would present as a smaller invoice rather than as an error.
    expect(() =>
      storedQuantityInForce({
        paymentMode: 'work_basis',
        actualQty: null,
        servedQty: new Prisma.Decimal(1),
      }),
    ).toThrow(/DWRTask_quantity_matches_basis/);
  });
});
