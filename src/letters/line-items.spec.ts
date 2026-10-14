import { expandLineItems, LineItemsError, parseLineItems } from './line-items';
import { renderTemplate } from './template-resolver';

/**
 * The item table of a commercial letter (2026-10-14). The figures are checked against the
 * client's own work order: three months at 65,000 is 1,95,000, and 9% each way on it.
 */
describe('commercial letter line items', () => {
  it('reads pipe- and tab-separated lines, skipping blank ones', () => {
    const items = parseLineItems(
      'Toilet block O&M | MON | 3 | 65,000\n\nEarthwork\tCum\t12.5\t₹ 410\n',
    );
    expect(items).toEqual([
      expect.objectContaining({ quantity: 3, rate: 65000, amount: 195000 }),
      expect.objectContaining({ unit: 'Cum', quantity: 12.5, amount: 5125 }),
    ]);
  });

  it('names the line it cannot read', () => {
    expect(() =>
      parseLineItems('Fine | Nos | 1 | 10\nBroken | Nos | x | 10'),
    ).toThrow(/line 2/);
    expect(() => parseLineItems('Only | three | parts')).toThrow(
      LineItemsError,
    );
  });

  it('splits a work order’s tax into CGST and SGST where the project charges them', () => {
    const out = expandLineItems('letter_work_order', {
      lineItems: 'Toilet block O&M | MON | 3 | 65000 | 998719',
      gstRate: '18',
      gstOnBills: 'CGST + SGST',
    });
    expect(out.lineItemsTable).toContain(
      '| 1 | Toilet block O&M | 998719 | MON | 3 |',
    );
    expect(out.lineItemsTable).toContain('CGST @ 9% |');
    expect(out.lineItemsTable).toContain('SGST @ 9% |');
    expect(out.basicAmount).toBe('Rs. 1,95,000.00');
    expect(out.totalAmount).toBe('Rs. 2,30,100.00');
    expect(out.totalAmountInWords).toMatch(
      /^Rupees Two Lakh Thirty Thousand One Hundred/,
    );
  });

  it('charges IGST on a work order for an IGST project, and plain GST elsewhere', () => {
    expect(
      expandLineItems('letter_work_order', {
        lineItems: 'A | Nos | 1 | 100',
        gstRate: '18',
        gstOnBills: 'IGST',
      }).lineItemsTable,
    ).toContain('IGST @ 18%');
    expect(
      expandLineItems('letter_purchase_order', {
        lineItems: 'A | Nos | 1 | 100',
        gstRate: '18',
      }).lineItemsTable,
    ).toContain('GST @ 18%');
  });

  it('quotes the LOI’s contract value with or without GST, as the issuer says', () => {
    const base = { lineItems: 'A | Nos | 10 | 1000', gstRate: '18' };
    expect(
      expandLineItems('letter_loi', { ...base, gstInclusion: 'exclusive' })
        .contractValue,
    ).toBe('Rs. 10,000.00');
    expect(
      expandLineItems('letter_loi', { ...base, gstInclusion: 'inclusive' })
        .contractValue,
    ).toBe('Rs. 11,800.00');
  });

  it('expands nothing for a kind without a table', () => {
    expect(expandLineItems('offer', { lineItems: 'x' })).toEqual({});
  });

  it('keeps a table value as rows, and drops a line whose optional token is blank', () => {
    const body = 'Training: {{?training}}\nSupport: {{?support}}\n{{table}}';
    expect(
      renderTemplate(body, {
        training: '',
        support: '2 days',
        table: '| a | b |\n| c | d |',
      }),
    ).toBe('Support: 2 days\n| a | b |\n| c | d |');
  });
});
