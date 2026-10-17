import { PaymentMode } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { CreatePaymentDto } from './payment.dto';

const errorsFor = (body: Record<string, unknown>) =>
  validateSync(
    plainToInstance(CreatePaymentDto, {
      vendorId: 'v-1',
      amount: 100,
      date: '2026-10-17',
      ...body,
    }),
  ).map((error) => error.property);

describe('CreatePaymentDto.referenceNumber (036 M10)', () => {
  it('is optional for cash', () => {
    expect(errorsFor({ paymentMode: PaymentMode.cash })).toEqual([]);
    expect(
      errorsFor({ paymentMode: PaymentMode.cash, referenceNumber: '  ' }),
    ).toEqual([]);
  });

  it('is still validated for cash when one is given', () => {
    expect(
      errorsFor({
        paymentMode: PaymentMode.cash,
        referenceNumber: 'x'.repeat(61),
      }),
    ).toEqual(['referenceNumber']);
  });

  it('is required for every other mode', () => {
    for (const mode of [
      PaymentMode.bank_transfer,
      PaymentMode.upi,
      PaymentMode.cheque,
    ]) {
      expect(errorsFor({ paymentMode: mode })).toEqual(['referenceNumber']);
      expect(errorsFor({ paymentMode: mode, referenceNumber: '' })).toEqual([
        'referenceNumber',
      ]);
    }
  });
});
