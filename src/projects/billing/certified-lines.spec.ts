import { BoqPricingBasis } from '@prisma/client';

import { certifiedAmountOf } from './certified-lines';

describe('certifiedAmountOf and the pricing basis (047)', () => {
  const lines = [
    { id: 'pct', quantity: 100, rate: 229.5 },
    {
      id: 'ir',
      quantity: 10,
      rate: 1490,
      pricingBasis: BoqPricingBasis.item_rate,
    },
    { id: 'nb', quantity: 2, rate: 500, nonBoq: true },
  ];

  it('certifies an item-rate line and a non-BOQ item at their own rate', () => {
    // 100 × 229.5 × 0.8088 + 10 × 1490 + 2 × 500
    expect(certifiedAmountOf(lines, [], -0.1912)).toBe(34461.96);
  });

  it('prices certified quantities on the same basis', () => {
    expect(
      certifiedAmountOf(lines, [{ lineId: 'ir', certifiedQty: 5 }], -0.1912),
    ).toBe(27011.96);
  });
});
