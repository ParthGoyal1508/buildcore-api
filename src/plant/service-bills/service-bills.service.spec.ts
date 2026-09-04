import { computeServiceBillAmounts } from './service-bills.service';

describe('computeServiceBillAmounts (FR-021)', () => {
  it('withholds TDS on the gross and adds tax on top', () => {
    const amounts = computeServiceBillAmounts({
      grossAmount: 50000,
      taxAmount: 9000,
      tdsPercent: 2,
    });
    expect(amounts.tdsAmount).toBe(1000);
    expect(amounts.netPayable).toBe(58000);
  });

  it('does not withhold on the tax component', () => {
    // Tax collected for the state is not the vendor's income. Deducting TDS on
    // gross + tax would over-withhold, and the vendor would be short every bill.
    const withTax = computeServiceBillAmounts({
      grossAmount: 50000,
      taxAmount: 9000,
      tdsPercent: 2,
    });
    const withoutTax = computeServiceBillAmounts({
      grossAmount: 50000,
      taxAmount: 0,
      tdsPercent: 2,
    });
    expect(withTax.tdsAmount).toBe(withoutTax.tdsAmount);
  });

  it('leaves net = gross + tax at a zero TDS percent', () => {
    const amounts = computeServiceBillAmounts({
      grossAmount: 12000,
      taxAmount: 2160,
      tdsPercent: 0,
    });
    expect(amounts.tdsAmount).toBe(0);
    expect(amounts.netPayable).toBe(14160);
  });

  it('rounds to paise', () => {
    const amounts = computeServiceBillAmounts({
      grossAmount: 1000.005,
      taxAmount: 0,
      tdsPercent: 33.333,
    });
    expect(amounts.tdsAmount).toBe(Math.round(amounts.tdsAmount * 100) / 100);
    expect(amounts.netPayable).toBe(Math.round(amounts.netPayable * 100) / 100);
  });
});
