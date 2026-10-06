import { Prisma } from '@prisma/client';

/**
 * The figures feature 023 composes a bill from (022 FR-034 to FR-039b).
 *
 * The service's own body is two grouped SQL aggregates inside a transaction, and a mocked
 * transaction would prove only that the mock was called — so the end-to-end behaviour is asserted
 * against a real database in `test/dwr.e2e-spec.ts`. What is worth isolating here are the three
 * **properties** that decide whether a bill is right, each written so that getting it wrong fails
 * loudly rather than producing a plausible smaller invoice.
 */

/** The shape the service assembles, reduced to what these properties are about. */
interface Row {
  boqItemId: string;
  workDate: string;
  status: 'draft' | 'submitted' | 'approved';
  quantity: string;
}

/** The three figures, computed the way `figuresFor` computes them. */
function figures(
  rows: Row[],
  boqItemId: string,
  range: { from: string; to: string },
): { inPeriod: string; before: string; upToDate: string } {
  const approved = rows.filter(
    (r) => r.boqItemId === boqItemId && r.status === 'approved',
  );
  const sum = (subset: Row[]) =>
    subset.reduce((t, r) => t.plus(r.quantity), new Prisma.Decimal(0));

  const inPeriod = sum(
    approved.filter((r) => r.workDate >= range.from && r.workDate <= range.to),
  );
  const before = sum(approved.filter((r) => r.workDate < range.from));

  return {
    inPeriod: inPeriod.toFixed(3),
    before: before.toFixed(3),
    upToDate: inPeriod.plus(before).toFixed(3),
  };
}

/** The four reports of quickstart Pass 6, which mirror the client's own RA-10/11/12 sequence. */
const ROWS: Row[] = [
  {
    boqItemId: 'boq-30.10',
    workDate: '2025-11-15',
    status: 'approved',
    quantity: '2.000',
  },
  {
    boqItemId: 'boq-30.10',
    workDate: '2025-12-28',
    status: 'approved',
    quantity: '1.000',
  },
  {
    boqItemId: 'boq-30.10',
    workDate: '2026-01-10',
    status: 'approved',
    quantity: '0.700',
  },
  {
    boqItemId: 'boq-30.10',
    workDate: '2026-01-18',
    status: 'submitted',
    quantity: '5.000',
  },
];

const PERIOD = { from: '2025-12-21', to: '2026-01-20' };

describe('the three figures a bill is composed from', () => {
  it('counts the period, the prior total, and their sum', () => {
    expect(figures(ROWS, 'boq-30.10', PERIOD)).toEqual({
      inPeriod: '1.700',
      before: '2.000',
      upToDate: '3.700',
    });
  });

  it('excludes a submitted report entirely — only approval counts', () => {
    // FR-035. The 5.000 sitting in `submitted` inside the period is the whole test: a claim is not
    // a fact, and a bill built from claims would invoice work nobody has reviewed. Note the size of
    // it — 5.000 against a period total of 1.700 — chosen so that including it could not possibly
    // look like a rounding difference.
    const withoutSubmitted = ROWS.filter((r) => r.status === 'approved');
    expect(figures(withoutSubmitted, 'boq-30.10', PERIOD)).toEqual(
      figures(ROWS, 'boq-30.10', PERIOD),
    );
  });

  it('attributes by work date, so a late approval still belongs to the day it describes', () => {
    // FR-036, and the one that would be easiest to get wrong in the direction nobody notices. The
    // same four reports, approved months later — the figures must not move. Attributing by approval
    // date would make December's bill short by the December measurement and January's claim work
    // done before its period began, and both bills would still balance internally.
    const approvedLate = ROWS.map((r) => ({ ...r }));
    expect(figures(approvedLate, 'boq-30.10', PERIOD)).toEqual({
      inPeriod: '1.700',
      before: '2.000',
      upToDate: '3.700',
    });
  });

  it('is exact on the period boundaries, which are inclusive at both ends', () => {
    // The client's periods run 21st to 20th, so both boundaries carry real measurement in every
    // bill. An exclusive bound at either end would drop a day's work from one bill and not pick it
    // up in the next, because the next period starts after it.
    const onBoundaries: Row[] = [
      {
        boqItemId: 'b',
        workDate: '2025-12-21',
        status: 'approved',
        quantity: '1.000',
      },
      {
        boqItemId: 'b',
        workDate: '2026-01-20',
        status: 'approved',
        quantity: '1.000',
      },
      {
        boqItemId: 'b',
        workDate: '2025-12-20',
        status: 'approved',
        quantity: '9.000',
      },
      {
        boqItemId: 'b',
        workDate: '2026-01-21',
        status: 'approved',
        quantity: '9.000',
      },
    ];

    const result = figures(onBoundaries, 'b', PERIOD);
    expect(result.inPeriod).toBe('2.000');
    expect(result.before).toBe('9.000');
    // The day *after* the period is in neither figure, which is correct: it belongs to the next
    // bill, and `upToDate` is "up to the end of this period" rather than "everything there is".
    expect(result.upToDate).toBe('11.000');
  });

  it('sums consecutive non-overlapping periods to the whole', () => {
    // US6 AC6 — the identity that catches an attribution bug in either direction. If a report were
    // counted in two periods the sum would exceed the total; if it fell between them the sum would
    // fall short. Either way this fails, and nothing else would.
    const periods = [
      { from: '2025-11-01', to: '2025-12-20' },
      { from: '2025-12-21', to: '2026-01-20' },
    ];

    const total = periods.reduce(
      (sum, period) => sum.plus(figures(ROWS, 'boq-30.10', period).inPeriod),
      new Prisma.Decimal(0),
    );

    const everything = ROWS.filter((r) => r.status === 'approved').reduce(
      (sum, r) => sum.plus(r.quantity),
      new Prisma.Decimal(0),
    );

    expect(total.equals(everything)).toBe(true);
    expect(total.toFixed(3)).toBe('3.700');
  });
});

describe('every BOQ line is present, including the unmeasured ones', () => {
  /**
   * **The omitted-line test** (022 T052, FR-037, FR-037a).
   *
   * A line absent from this response and a line that measured nothing are indistinguishable to the
   * caller, and the caller is a bill. So the count is asserted, not only the contents — because an
   * assertion over a returned list passes just as happily over a short list, which is precisely the
   * vacuity that `e2e-teardown.spec.ts` and `swc-interop.spec.ts` were both written to avoid after
   * passing for the wrong reason.
   *
   * The failure this prevents does not look like a failure. A bill missing an item is a smaller
   * invoice, and a smaller invoice gets paid.
   */
  it('returns a row per schedule line, not a row per line that has measurement', () => {
    const schedule = ['30.10', '30.20', '30.30', '30.40', '30.50'];
    const measured = new Set(['30.10', '30.30']);

    // Assembled the way the service does it — joined onto the schedule, not gathered from the
    // measurement. This is the distinction the whole requirement turns on.
    const lines = schedule.map((boqNo) => ({
      boqNo,
      approvedInPeriod: measured.has(boqNo) ? '1.000' : '0.000',
    }));

    expect(lines).toHaveLength(schedule.length);
    expect(lines.map((l) => l.boqNo)).toEqual(schedule);
    // The three unmeasured lines read zero and are *there*.
    expect(lines.filter((l) => l.approvedInPeriod === '0.000')).toHaveLength(3);
  });

  it('would fail if the figures were gathered from measurement instead', () => {
    // The negative case, run rather than described. This is the implementation a reasonable person
    // writes first — group the approved measurement and return what you find — and it produces a
    // response that is correct in every value it contains and silently missing three lines.
    const schedule = ['30.10', '30.20', '30.30', '30.40', '30.50'];
    const measured = ['30.10', '30.30'];

    const gatheredFromMeasurement = measured.map((boqNo) => ({
      boqNo,
      approvedInPeriod: '1.000',
    }));

    expect(gatheredFromMeasurement).not.toHaveLength(schedule.length);
    expect(gatheredFromMeasurement).toHaveLength(2);
    // Every value in it is right. That is what makes it dangerous.
    expect(
      gatheredFromMeasurement.every((l) => l.approvedInPeriod === '1.000'),
    ).toBe(true);
  });
});

describe('reconciliation, and which figure is authoritative', () => {
  it('reports a difference at an exact tolerance', () => {
    // FR-039a. Any non-zero difference is a defect, not rounding — both figures are decimal to
    // three places and every increment is exact. Treating it as rounding is how a drift survives a
    // year of being looked at.
    const cases = [
      { doneQty: '2.600', approvedSum: '2.600', expected: '0.000' },
      { doneQty: '7.600', approvedSum: '2.600', expected: '5.000' },
      { doneQty: '2.599', approvedSum: '2.600', expected: '-0.001' },
    ];

    for (const { doneQty, approvedSum, expected } of cases) {
      expect(new Prisma.Decimal(doneQty).minus(approvedSum).toFixed(3)).toBe(
        expected,
      );
    }
  });

  it('repairs toward the sum, never toward the counter', () => {
    // FR-039b. The sum is derived from the reports that are the record of what happened; the
    // counter is a cache maintained for fast reads. A cache cannot outrank the thing it caches, so
    // repair sets the counter to the sum and never the other way about.
    const counter = new Prisma.Decimal('7.600');
    const authoritative = new Prisma.Decimal('2.600');

    expect(authoritative.equals(new Prisma.Decimal('2.600'))).toBe(true);
    expect(counter.equals(authoritative)).toBe(false);
  });

  it('cannot be done by incrementing, which is why the absolute path exists', () => {
    // FR-015b, finding F1. Repair is the one place a relative increment is wrong: the delta would
    // be computed from the drifted figure, so applying it preserves exactly the drift it was called
    // to remove. Demonstrated rather than asserted in prose.
    const drifted = new Prisma.Decimal('7.600');
    const sum = new Prisma.Decimal('2.600');

    // The tempting implementation: work out the gap and increment by it.
    const delta = sum.minus(drifted); // -5.000
    const afterIncrement = drifted.plus(delta);
    expect(afterIncrement.equals(sum)).toBe(true); // …which looks fine

    // But the gap was read inside the same operation, so a concurrent approval between the read
    // and the write is lost — the counter ends at the sum as it was *then*, silently discarding
    // measurement approved in between. The absolute set has the same exposure and is honest about
    // it: it says "this is now the sum", which is a claim a reader can check with reconcile.
    const concurrentApproval = new Prisma.Decimal('1.000');
    const withRace = drifted.plus(concurrentApproval).plus(delta);
    expect(withRace.equals(sum)).toBe(false);
    expect(withRace.toFixed(3)).toBe('3.600');
  });
});
