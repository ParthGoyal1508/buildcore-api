import { ConflictException } from '@nestjs/common';
import {
  AssetAllocationStatus,
  AssetStatus,
  AssetTrackingMode,
  Prisma,
} from '@prisma/client';

import {
  callerFor,
  createPrismaMock,
} from '../../settings/testing/prisma-mock';
import { AllocationService } from './allocation.service';

/**
 * 036 L1: two simultaneous returns of one allocation both passed the pre-transaction status check
 * and both credited the units back. The close is now a conditional update inside the transaction.
 */
describe('AllocationService.returnAllocation — once only (036 L1)', () => {
  const allocation = {
    id: 'al-1',
    companyId: 'co-1',
    assetId: 'as-1',
    siteId: 'site-1',
    quantity: new Prisma.Decimal(5),
    status: AssetAllocationStatus.open,
    deletedAt: null,
    remarks: null,
    allocatedFrom: new Date('2026-09-01T00:00:00.000Z'),
    asset: {
      trackingMode: AssetTrackingMode.bulk,
      status: AssetStatus.allocated,
      assetCode: 'A-1',
    },
  };

  const build = (closedCount: number) => {
    const prisma = createPrismaMock({
      assetAllocation: {
        findUnique: jest.fn().mockResolvedValue(allocation),
        updateMany: jest.fn().mockResolvedValue({ count: closedCount }),
        findUniqueOrThrow: jest.fn().mockResolvedValue(allocation),
      },
      asset: { update: jest.fn() },
    });
    const stock = { applyDelta: jest.fn() };
    const service = new AllocationService(
      { register: jest.fn() } as never,
      prisma as never,
      {
        requireGrade: jest.fn().mockResolvedValue({
          name: 'Good',
          isDamaged: false,
          isScrap: false,
        }),
        parseDate: (value: string) => new Date(`${value}T00:00:00.000Z`),
      } as never,
      stock as never,
      { record: jest.fn() } as never,
    );
    return { service, prisma, stock };
  };

  const dto = { conditionOnReturnId: 'g-1', actualReturnDate: '2026-10-01' };

  it('closes only an allocation that is still open, inside the transaction', async () => {
    const { service, prisma } = build(1);
    await service
      .returnAllocation(callerFor('co-1'), 'al-1', dto as never, 'ip')
      .catch(() => undefined); // the row decoration after the write is not under test
    expect(prisma.tx.assetAllocation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'al-1',
          status: AssetAllocationStatus.open,
          deletedAt: null,
        },
      }),
    );
  });

  it('refuses the losing return and credits no stock', async () => {
    const { service, stock } = build(0);
    await expect(
      service.returnAllocation(callerFor('co-1'), 'al-1', dto as never, 'ip'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(stock.applyDelta).not.toHaveBeenCalled();
  });
});
