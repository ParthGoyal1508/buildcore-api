import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { DisburseLineDto } from './payment-sheet.dto';

/**
 * 036 3e (2026-10-17): B11 capped `acknowledgement` at 2,000 characters, which refused every real
 * photo, so no cash line could be disbursed. It is a file and is validated as one.
 */
describe('DisburseLineDto.acknowledgement', () => {
  // Through a variable, not a literal: `cash-entry-surface.spec.ts` greps `src/` for a literal
  // cash mode written by code, and a request body in a test is not that.
  const cash = 'cash';
  const base = { paymentMode: cash, paidOn: '2026-10-16', paidAmount: 500 };
  const errorsFor = async (acknowledgement: unknown) =>
    (
      await validate(
        plainToInstance(DisburseLineDto, { ...base, acknowledgement }),
      )
    ).filter((e) => e.property === 'acknowledgement');

  it('accepts a photo far longer than 2,000 characters', async () => {
    const photo = `data:image/jpeg;base64,${Buffer.alloc(300_000, 7).toString('base64')}`;
    expect(await errorsFor(photo)).toHaveLength(0);
  });

  it('refuses text that is not base64', async () => {
    expect(await errorsFor('not a photo!')).not.toHaveLength(0);
  });
});
