import { EngagementType, Prisma } from '@prisma/client';

import { createPrismaMock } from '../settings/testing/prisma-mock';
import { LabourService } from './labour.service';

/**
 * `LabourService.wagesOwed` (054): the dashboard's Labour card — pending lines of approved
 * sheets plus short-payments no approved sheet has carried, with cash out while it is hidden.
 */
describe('LabourService.wagesOwed', () => {
  const D = (v: number) => new Prisma.Decimal(v);
  const contractor = { engagementType: EngagementType.contractor };
  const direct = { engagementType: EngagementType.direct };

  function build(hidden: boolean) {
    const findMany = jest
      .fn()
      // Pending lines of approved sheets.
      .mockResolvedValueOnce([
        {
          netPayable: D(1000),
          paymentMode: 'bank',
          carriedFromLineId: null,
          sheet: contractor,
        },
        {
          netPayable: D(300),
          paymentMode: 'cash',
          carriedFromLineId: null,
          sheet: contractor,
        },
        {
          netPayable: D(500),
          paymentMode: null,
          carriedFromLineId: null,
          sheet: direct,
        },
        {
          netPayable: D(80),
          paymentMode: 'bank',
          carriedFromLineId: 'cash-src',
          sheet: contractor,
        },
      ])
      // Short-paid disbursed lines.
      .mockResolvedValueOnce([
        {
          id: 'short-1',
          carriedForwardBalance: D(40),
          paymentMode: 'bank',
          sheet: contractor,
        },
        {
          id: 'short-2',
          carriedForwardBalance: D(25),
          paymentMode: 'bank',
          sheet: contractor,
        },
        {
          id: 'short-3',
          carriedForwardBalance: D(15),
          paymentMode: 'cash',
          sheet: contractor,
        },
      ])
      // short-2 is already carried onto an approved sheet.
      .mockResolvedValueOnce([{ carriedFromLineId: 'short-2' }])
      // cashCarrySources: the source of the carried line was paid in cash.
      .mockResolvedValueOnce([
        { id: 'cash-src', paymentMode: 'cash', sheet: contractor },
      ]);
    const prisma = createPrismaMock({
      paymentSheetLine: { findMany },
      company: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ hideCashTransactions: hidden }),
      },
    });
    return new LabourService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
    );
  }

  it('adds pending lines and uncarried short-payments', async () => {
    await expect(build(false).wagesOwed('company-1')).resolves.toBe(
      1000 + 300 + 500 + 80 + 40 + 15,
    );
  });

  it('leaves out direct sheets, cash lines, cash carry-forwards and cash remainders while cash is hidden', async () => {
    await expect(build(true).wagesOwed('company-1')).resolves.toBe(1000 + 40);
  });
});
