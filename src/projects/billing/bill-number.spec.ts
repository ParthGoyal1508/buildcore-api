import type { Prisma } from '@prisma/client';

import { nextRaBillNumber, packageLabel } from './bill-number';

/** Only `rABill.findMany` is reached, so only that is stood up. */
const txWith = (billNumbers: string[]) =>
  ({
    rABill: {
      findMany: jest
        .fn()
        .mockResolvedValue(billNumbers.map((billNumber) => ({ billNumber }))),
    },
  } as unknown as Prisma.TransactionClient);

describe('packageLabel', () => {
  it('pads to two digits and keeps going past ninety-nine', () => {
    expect(packageLabel(1)).toBe('RA-01');
    expect(packageLabel(12)).toBe('RA-12');
    // Not truncated: a work order with a hundred bills is unusual, not impossible, and a label
    // that wrapped to `RA-00` would collide with a number already issued.
    expect(packageLabel(100)).toBe('RA-100');
  });
});

describe('nextRaBillNumber', () => {
  it('starts at RA-01 on a work order with no bills', async () => {
    await expect(nextRaBillNumber(txWith([]), 'wo1')).resolves.toBe('RA-01');
  });

  it('continues the sequence', async () => {
    await expect(
      nextRaBillNumber(txWith(['RA-01', 'RA-02']), 'wo1'),
    ).resolves.toBe('RA-03');
  });

  /**
   * The property that matters. Counting would return `RA-03` here and re-issue a number already
   * printed on the document somebody holds; a gap in the series is the lesser harm.
   */
  it('takes the highest number, not the count, so a deleted bill never re-issues one', async () => {
    await expect(
      nextRaBillNumber(txWith(['RA-01', 'RA-04']), 'wo1'),
    ).resolves.toBe('RA-05');
  });

  /** The free text the field allowed before 027 — "123" is on real data — is not a sequence. */
  it('skips numbers it does not recognise rather than guessing at them', async () => {
    await expect(
      nextRaBillNumber(txWith(['123', 'SC/2026/07', 'RA-02']), 'wo1'),
    ).resolves.toBe('RA-03');
  });

  it('is not fooled by a number that merely contains the pattern', async () => {
    await expect(
      nextRaBillNumber(txWith(['REV-RA-09', 'RA-01x', 'RA-02']), 'wo1'),
    ).resolves.toBe('RA-03');
  });

  it('scopes the read to the one work order', async () => {
    const tx = txWith([]);
    await nextRaBillNumber(tx, 'wo-42');
    expect(tx.rABill.findMany).toHaveBeenCalledWith({
      where: { workOrderId: 'wo-42' },
      select: { billNumber: true },
    });
  });
});
