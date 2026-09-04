import { computeHireBillAmounts } from './hire-bills.service';

/** SC-003: `netPayable` equals `grossAmount − tdsAmount` in every case. */
describe('computeHireBillAmounts (FR-005, SC-003)', () => {
  it('computes gross, TDS and net from hours, rate and the vendor TDS rate', () => {
    const amounts = computeHireBillAmounts({
      billedHours: 160,
      rate: 1250,
      tdsRate: 2,
    });
    expect(amounts.grossAmount).toBe(200000);
    expect(amounts.tdsAmount).toBe(4000);
    expect(amounts.netPayable).toBe(196000);
  });

  it('leaves net equal to gross when the vendor has no TDS rate on file', () => {
    // Null is "no deduction declared", not "zero percent by policy" — but the
    // arithmetic result is the same, and it must not become NaN.
    const amounts = computeHireBillAmounts({
      billedHours: 100,
      rate: 900,
      tdsRate: null,
    });
    expect(amounts.tdsAmount).toBe(0);
    expect(amounts.netPayable).toBe(amounts.grossAmount);
  });

  it('keeps net = gross − tds exactly, with a rate that does not divide evenly', () => {
    const amounts = computeHireBillAmounts({
      billedHours: 37.5,
      rate: 1333.33,
      tdsRate: 1.5,
    });
    // The invariant, not the literal: this is the property SC-003 states, and it is
    // what a paisa-level rounding slip would break.
    expect(amounts.netPayable).toBe(
      Math.round((amounts.grossAmount - amounts.tdsAmount) * 100) / 100,
    );
  });

  it('rounds to paise rather than carrying float noise into the ledger', () => {
    const amounts = computeHireBillAmounts({
      billedHours: 3,
      rate: 0.1,
      tdsRate: null,
    });
    // 3 × 0.1 is 0.30000000000000004 in binary floating point. Stored unrounded it
    // would make a bill a fraction of a paisa out from its own components.
    expect(amounts.grossAmount).toBe(0.3);
  });

  it('deducts nothing at a zero TDS rate', () => {
    const amounts = computeHireBillAmounts({
      billedHours: 10,
      rate: 100,
      tdsRate: 0,
    });
    expect(amounts.tdsAmount).toBe(0);
    expect(amounts.netPayable).toBe(1000);
  });
});
