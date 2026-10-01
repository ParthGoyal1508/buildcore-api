import { BadRequestException } from '@nestjs/common';
import { FuelAttribution, FuelExceptionStatus } from '@prisma/client';

import {
  callerFor,
  createPrismaMock,
} from '../../settings/testing/prisma-mock';
import { FuelExceptionsService } from './fuel-exceptions.service';

/**
 * Reviewing a fuel variance (020 FR-002, FR-004, FR-008, FR-009, FR-017).
 *
 * The properties worth pinning are the four refusals — each one is a figure somebody would
 * otherwise owe without anybody having decided they owe it — and the guarantee that reviewing
 * never touches the reading the review rests on.
 */
describe('FuelExceptionsService', () => {
  const caller = callerFor('co-1');

  const build = (
    opts: {
      ownership?: 'owned' | 'hired';
      operatorIds?: (string | null)[];
      status?: FuelExceptionStatus;
    } = {},
  ) => {
    const {
      ownership = 'hired',
      operatorIds = ['emp-1'],
      status = FuelExceptionStatus.open,
    } = opts;

    const updates: Record<string, unknown>[] = [];
    const prisma = createPrismaMock({
      fuelVarianceException: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'exc-1',
          companyId: 'co-1',
          status,
          fuelEntry: {
            equipmentId: 'eq-1',
            date: new Date('2026-09-20'),
            equipment: { ownership },
          },
        }),
        update: jest.fn().mockImplementation(({ data }: never) => {
          const row = { id: 'exc-1', companyId: 'co-1', ...(data as object) };
          updates.push(row);
          return row;
        }),
      },
      logbookEntry: {
        findMany: jest
          .fn()
          .mockResolvedValue(operatorIds.map((operatorId) => ({ operatorId }))),
      },
      // FR-017's guard: if any path in this service wrote a reading, these would be called.
      fuelEntry: {
        update: jest.fn(),
        updateMany: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      },
    });

    const auditLog = { record: jest.fn().mockResolvedValue(undefined) };
    const refs = { categoriesByIds: jest.fn().mockResolvedValue(new Map()) };

    return {
      service: new FuelExceptionsService(
        prisma as never,
        auditLog as never,
        refs as never,
      ),
      prisma,
      updates,
    };
  };

  const review = (service: FuelExceptionsService, dto: object) =>
    service.review(caller, 'exc-1', dto as never, '127.0.0.1');

  describe('confirming names who bears it (FR-002)', () => {
    it('refuses a confirmation with no attribution', async () => {
      const { service } = build();
      // No default anywhere in this feature: a default attribution would decide, quietly and at
      // scale, who pays for fuel nobody can account for.
      await expect(
        review(service, { status: FuelExceptionStatus.confirmed }),
      ).rejects.toThrow(BadRequestException);
    });

    it('refuses a dismissal with no reason (FR-008)', async () => {
      const { service } = build();
      await expect(
        review(service, { status: FuelExceptionStatus.dismissed }),
      ).rejects.toThrow(BadRequestException);
    });

    it('refuses a dismissal whose reason is only whitespace', async () => {
      // A mandatory field satisfied by a space is not a reason.
      const { service } = build();
      await expect(
        review(service, {
          status: FuelExceptionStatus.dismissed,
          reason: '   ',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('a hire deduction needs a hirer (FR-004)', () => {
    it('refuses attributing an owned machine to the hirer', async () => {
      const { service } = build({ ownership: 'owned' });
      await expect(
        review(service, {
          status: FuelExceptionStatus.confirmed,
          attribution: FuelAttribution.hirer,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('allows it on a hired machine', async () => {
      const { service, updates } = build({ ownership: 'hired' });
      await review(service, {
        status: FuelExceptionStatus.confirmed,
        attribution: FuelAttribution.hirer,
      });
      expect(updates[0].attribution).toBe(FuelAttribution.hirer);
    });
  });

  describe('attributing to an operator (FR-009)', () => {
    it('refuses when several operators ran the machine and none is named', async () => {
      // Inferring here is how the wrong person's wages get docked.
      const { service } = build({ operatorIds: ['emp-1', 'emp-2'] });
      await expect(
        review(service, {
          status: FuelExceptionStatus.confirmed,
          attribution: FuelAttribution.operator,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('refuses when no operator is recorded at all and none is named', async () => {
      const { service } = build({ operatorIds: [] });
      await expect(
        review(service, {
          status: FuelExceptionStatus.confirmed,
          attribution: FuelAttribution.operator,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('adopts the single operator when there is nothing to choose between', async () => {
      // Forcing a reviewer to retype the only possible answer teaches them to click past the
      // question, which is worse than answering it for them when there is one answer.
      const { service, updates } = build({ operatorIds: ['emp-7'] });
      await review(service, {
        status: FuelExceptionStatus.confirmed,
        attribution: FuelAttribution.operator,
      });
      expect(updates[0].operatorEmployeeId).toBe('emp-7');
    });

    it('takes the named operator over the logbook even when one could be inferred', async () => {
      const { service, updates } = build({ operatorIds: ['emp-1'] });
      await review(service, {
        status: FuelExceptionStatus.confirmed,
        attribution: FuelAttribution.operator,
        operatorEmployeeId: 'emp-9',
      });
      expect(updates[0].operatorEmployeeId).toBe('emp-9');
    });
  });

  describe('detection is untouched (FR-017)', () => {
    it('writes no fuel reading on any reviewing path', async () => {
      const paths = [
        { status: FuelExceptionStatus.dismissed, reason: 'Meter was misread' },
        {
          status: FuelExceptionStatus.confirmed,
          attribution: FuelAttribution.hirer,
        },
        {
          status: FuelExceptionStatus.confirmed,
          attribution: FuelAttribution.neither,
        },
      ];

      for (const dto of paths) {
        const { service, prisma } = build();
        await review(service, dto);

        // `varianceAlert` and `variancePercent` are the evidence a review rests on. A service
        // that could rewrite them could make its own justification disappear.
        expect(prisma.tx.fuelEntry.update).not.toHaveBeenCalled();
        expect(prisma.tx.fuelEntry.updateMany).not.toHaveBeenCalled();
      }
    });
  });

  it('refuses to review an exception somebody has already reviewed', async () => {
    const { service } = build({ status: FuelExceptionStatus.confirmed });
    await expect(
      review(service, {
        status: FuelExceptionStatus.dismissed,
        reason: 'Changed my mind about this one',
      }),
    ).rejects.toThrow(BadRequestException);
  });
});
