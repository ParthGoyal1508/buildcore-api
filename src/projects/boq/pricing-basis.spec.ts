import { BoqPricingBasis } from '@prisma/client';

import { quotedPercentageFor, takesQuotedPercentage } from './pricing-basis';

describe('takesQuotedPercentage', () => {
  it('applies to a percentage line, and to a line with no basis (the pre-047 default)', () => {
    expect(
      takesQuotedPercentage({ pricingBasis: BoqPricingBasis.percentage }),
    ).toBe(true);
    expect(takesQuotedPercentage({})).toBe(true);
  });

  it('never applies to an item-rate line', () => {
    expect(
      takesQuotedPercentage({ pricingBasis: BoqPricingBasis.item_rate }),
    ).toBe(false);
    expect(
      quotedPercentageFor({ pricingBasis: BoqPricingBasis.item_rate }, -0.1912),
    ).toBe(0);
  });

  it('never applies to a non-BOQ item, whatever its basis', () => {
    expect(
      takesQuotedPercentage({
        nonBoq: true,
        pricingBasis: BoqPricingBasis.percentage,
      }),
    ).toBe(false);
    expect(quotedPercentageFor({ nonBoq: false }, 0.0567)).toBe(0.0567);
  });
});
