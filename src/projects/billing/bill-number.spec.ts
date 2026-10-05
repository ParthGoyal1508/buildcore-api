import type { Prisma } from '@prisma/client';

import {
  nextClientBillNumber,
  nextRaBillNumber,
  packageLabel,
} from './bill-number';

/** Only the one `findMany` each allocator reaches is stood up. */
const txWith = (billNumbers: string[]) => {
  const findMany = jest
    .fn()
    .mockResolvedValue(billNumbers.map((billNumber) => ({ billNumber })));
  return {
    rABill: { findMany },
    clientBill: { findMany },
  } as unknown as Prisma.TransactionClient;
};

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

/**
 * The client's sequence is the same rule over a different table. Its own cases rather than a shared
 * loop: the two take different arguments and read different columns, and a loop passing both
 * through one assertion would stop testing the thing that differs between them.
 */
describe('nextClientBillNumber', () => {
  it('starts at RA-01 on a project with no bills', async () => {
    await expect(nextClientBillNumber(txWith([]), 'p1')).resolves.toBe('RA-01');
  });

  it('continues the sequence and skips what it does not recognise', async () => {
    await expect(
      nextClientBillNumber(txWith(['RA-01', 'INV/2026/7', 'RA-02']), 'p1'),
    ).resolves.toBe('RA-03');
  });

  it('takes the highest, so a deleted bill never re-issues a number', async () => {
    await expect(
      nextClientBillNumber(txWith(['RA-01', 'RA-07']), 'p1'),
    ).resolves.toBe('RA-08');
  });

  it('scopes the read to the one project', async () => {
    const tx = txWith([]);
    await nextClientBillNumber(tx, 'proj-9');
    expect(tx.clientBill.findMany).toHaveBeenCalledWith({
      where: { projectId: 'proj-9' },
      select: { billNumber: true },
    });
  });
});
