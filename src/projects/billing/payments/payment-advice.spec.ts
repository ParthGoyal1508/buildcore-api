import { PaymentAdviceRenderer } from './payment-advice.renderer';
import { Prisma } from '@prisma/client';

import {
  PaymentAdviceService,
  fill,
  PAYMENT_ADVICE_TEMPLATE,
  type PaymentAdviceView,
} from './payment-advice.service';

/** The payment advice (2026-10-13): a template filled at runtime, rendered twice from one view. */

const VIEW: PaymentAdviceView = {
  company: {
    name: 'Parth Realcon Pvt. Ltd.',
    address:
      '28-A, Gandhi Nagar, Ward No-15, Teli Mohalla, Deoli, Tonk, Rajasthan - 304804',
    logo: null,
  },
  title: 'PAYMENT ADVICE',
  details: {
    left: [
      ['Transaction Date', '18.10.2025'],
      ['Bank Reference No.', 'HDFCR52025101874160134'],
      ['Vendor Code', '1502676'],
      ['Vendor Name', 'TIRUPATI ENTERPRISES, DEOLI'],
    ],
    right: [
      ['Bank Name', 'BOB'],
      ['IFSC Code', 'BARB0DEOLIX'],
      ['Account Number', '09310400000526'],
      ['Bank Transaction Mode.', 'NEFT/RTGS/Cash'],
    ],
  },
  salutation: PAYMENT_ADVICE_TEMPLATE.salutation,
  body: fill(PAYMENT_ADVICE_TEMPLATE.body, {
    how: 'initiated a credit through NEFT/RTGS to your account',
    amount: '7,54,619.39',
    amountInWords:
      'Seven Lakh Fifty Four Thousand Six Hundred Nineteen Rupees and Thirty Nine Paise Only',
  }),
  footer: PAYMENT_ADVICE_TEMPLATE.footer,
  rows: [
    {
      particulars: '10/2026-27',
      documentDate: '18.10.2025',
      siteName: 'Delhi-Vadodara (8&9)',
      paymentAmount: '7,54,619.39',
      tdsAmount: '0.00',
    },
  ],
  totalAmount: '7,54,619.39',
  totalTds: '0.00',
  transactionDate: '2025-10-18',
  vendorName: 'TIRUPATI ENTERPRISES',
  billNumber: 'RA-03',
};

describe('the payment advice template', () => {
  it('fills every token from the payment', () => {
    expect(VIEW.body).toBe(
      'We have initiated a credit through NEFT/RTGS to your account for Rs 7,54,619.39 ' +
        '(Seven Lakh Fifty Four Thousand Six Hundred Nineteen Rupees and Thirty Nine Paise Only) ' +
        'against the below mentioned particulars.',
    );
  });

  it('leaves an unknown token visible rather than printing a blank in a money sentence', () => {
    expect(fill('Rs {{amount}} to {{nobody}}', { amount: '1' })).toBe(
      'Rs 1 to {{nobody}}',
    );
  });
});

describe('rendering the payment advice', () => {
  const renderer = new PaymentAdviceRenderer();

  it('writes a PDF', async () => {
    const bytes = await renderer.pdf(VIEW);
    expect(bytes.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('writes the same advice as a Word document', async () => {
    const bytes = await renderer.docx(VIEW);
    // A .docx is a zip.
    expect(bytes.subarray(0, 2).toString()).toBe('PK');
  });

  it('prints the name alone when the logo cannot be decoded', async () => {
    const bytes = await renderer.pdf({
      ...VIEW,
      company: { ...VIEW.company, logo: Buffer.from('not an image') },
    });
    expect(bytes.subarray(0, 4).toString()).toBe('%PDF');
  });
});

describe('what the advice reads from the payment and the vendor', () => {
  const build = (
    vendor: Record<string, string | null> | null,
    payment = {},
    hideCash = false,
  ) => {
    const tx = {
      $executeRaw: async () => 0,
      company: {
        findUnique: async () => ({ hideCashTransactions: hideCash }),
      },
      rABill: {
        findFirst: async () => ({ workOrder: { partnerId: 'v-1' } }),
      },
      rABillPayment: {
        findFirst: async () => ({
          amount: new Prisma.Decimal('754619.39'),
          tdsAmount: new Prisma.Decimal('0'),
          paidOn: new Date('2025-10-18T00:00:00.000Z'),
          reference: 'HDFCR52025101874160134',
          transactionNo: null,
          companyId: 'co-1',
          instrument: 'bank_transfer',
          mode: null,
          particulars: null,
          ...payment,
          raBill: {
            billNumber: 'RA-03',
            billingDate: new Date('2025-10-18T00:00:00.000Z'),
            status: 'approved',
            project: { name: 'Delhi-Vadodara(8&9)' },
            workOrder: { partnerId: 'v-1', code: 'WO-1' },
            package: null,
          },
        }),
      },
    };
    const prisma = {
      $transaction: async (fn: (t: unknown) => unknown) => fn(tx),
    };
    const companies = {
      getDocumentIdentity: async () => ({
        name: 'Parth Realcon Pvt. Ltd.',
        address: 'Deoli',
        gstin: null,
        pan: null,
        logo: null,
      }),
    };
    const sources = {
      vendorIdentitySource: () => ({
        getPaymentIdentity: async () =>
          vendor && {
            code: '1502676',
            name: 'TIRUPATI ENTERPRISES, DEOLI',
            bankBranch: null,
            bankAccountHolderName: null,
            ...vendor,
          },
      }),
    };
    return new PaymentAdviceService(
      prisma as never,
      companies as never,
      sources as never,
      new PaymentAdviceRenderer(),
    );
  };
  const ctx = { isSuperAdmin: false, companyId: 'co-1' };

  it('names the bank fields the vendor record lacks, before anybody pays', async () => {
    const payee = await build({
      bankName: 'BOB',
      bankAccountNumber: null,
      ifscCode: null,
    }).payeeFor(ctx, 'co-1', 'ra-1');
    expect(payee.missing).toEqual(['bankAccountNumber', 'ifscCode']);
    expect(payee.code).toBe('1502676');
  });

  it('prints the mode and the voucher number that were entered', async () => {
    const view = await build(
      {
        bankName: 'BOB',
        bankAccountNumber: '09310400000526',
        ifscCode: 'BARB0DEOLIX',
      },
      { mode: 'RTGS', particulars: '10/2026-27' },
    ).viewFor(ctx, 'co-1', 'p-1');
    expect(view.details.right[3]).toEqual(['Bank Transaction Mode.', 'RTGS']);
    expect(view.rows[0].particulars).toBe('10/2026-27');
    expect(view.body).toContain(
      'initiated a credit through RTGS to your account for Rs',
    );
    expect(view.details.right[2]).toEqual(['Account Number', '09310400000526']);
  });

  it('does not claim a bank credit for a cash payment', async () => {
    const view = await build(
      { bankName: null, bankAccountNumber: null, ifscCode: null },
      { mode: 'Cash', instrument: 'cash' },
    ).viewFor(ctx, 'co-1', 'p-1');
    expect(view.body).toMatch(/^We have made a payment to you in cash for Rs/);
  });

  it('falls back to the bill number, and to the instrument, when neither was entered', async () => {
    const view = await build({
      bankName: 'BOB',
      bankAccountNumber: '1',
      ifscCode: 'BARB0DEOLIX',
    }).viewFor(ctx, 'co-1', 'p-1');
    expect(view.rows[0].particulars).toBe('RA-03');
    expect(view.details.right[3][1]).toBe('NEFT/RTGS');
  });

  it('has no advice for a cash payment while cash is hidden (038)', async () => {
    const vendor = { bankName: null, bankAccountNumber: null, ifscCode: null };
    for (const payment of [{ instrument: 'cash' }, { mode: 'Cash' }]) {
      await expect(
        build(vendor, payment, true).viewFor(ctx, 'co-1', 'p-1'),
      ).rejects.toMatchObject({ status: 404 });
    }
    // A bank payment's advice is unaffected.
    await expect(
      build(vendor, {}, true).viewFor(ctx, 'co-1', 'p-1'),
    ).resolves.toBeDefined();
  });
});
