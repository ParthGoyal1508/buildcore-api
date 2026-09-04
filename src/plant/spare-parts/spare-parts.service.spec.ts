import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import {
  callerFor,
  createPrismaMock,
} from '../../settings/testing/prisma-mock';
import { SparePartsService, weightedAverageRate } from './spare-parts.service';

const decimal = (n: number) => new Prisma.Decimal(n);
const caller = callerFor('co-1');

describe('weightedAverageRate (FR-017)', () => {
  it('moves the average toward the new rate, weighted by current stock', () => {
    // 10 @ 100 plus 10 @ 200 = 20 @ 150.
    expect(
      weightedAverageRate({
        existingStock: 10,
        existingRate: 100,
        receivedQuantity: 10,
        receivedRate: 200,
      }),
    ).toBe(150);
  });

  it('weights by CURRENT stock, not by everything ever received', () => {
    // Received 100 @ 10, consumed 90, then received 10 @ 20. Weighting by current
    // stock (10) gives 15. Weighting by total received (110) would give ~10.9 — the
    // rate of material that is no longer on the shelf, still dragging the average.
    expect(
      weightedAverageRate({
        existingStock: 10,
        existingRate: 10,
        receivedQuantity: 10,
        receivedRate: 20,
      }),
    ).toBe(15);
  });

  it('takes the new rate outright when stock is at zero', () => {
    // A part received and then fully consumed has nothing left to average against.
    // Dividing by the zero denominator would be NaN.
    expect(
      weightedAverageRate({
        existingStock: 0,
        existingRate: 250,
        receivedQuantity: 5,
        receivedRate: 400,
      }),
    ).toBe(400);
  });
});

/** A part row as `lockPart`'s raw query returns it. */
const partRow = (over: Record<string, unknown> = {}) => ({
  id: 'part-1',
  companyId: 'co-1',
  partNumber: 'HF-6177',
  unitOfMeasure: 'NOS',
  stockQuantity: decimal(6),
  avgRate: decimal(250),
  compatibleCategoryIds: ['cat-excavator'],
  ...over,
});

const job = (over: Record<string, unknown> = {}) => ({
  id: 'job-1',
  companyId: 'co-1',
  status: 'open',
  equipmentId: 'eq-1',
  equipment: { categoryId: 'cat-excavator', ownership: 'owned' },
  ...over,
});

const build = (options: {
  part?: Record<string, unknown>;
  job?: Record<string, unknown> | null;
}) => {
  const created: Record<string, unknown>[] = [];
  const partUpdates: Record<string, unknown>[] = [];
  const jobUpdates: Record<string, unknown>[] = [];

  const prisma = createPrismaMock({
    maintenanceJob: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          options.job === null ? null : job(options.job ?? {}),
        ),
      update: jest.fn(async ({ data }: never) => {
        jobUpdates.push(data as Record<string, unknown>);
        return {};
      }),
    },
    sparePart: {
      update: jest.fn(async ({ data }: never) => {
        partUpdates.push(data as Record<string, unknown>);
        return {};
      }),
    },
    sparePartMovement: {
      create: jest.fn(async ({ data }: never) => {
        const row = data as Record<string, unknown>;
        created.push(row);
        return {
          ...row,
          id: 'movement-1',
          createdAt: new Date(),
          reversalOfId: row.reversalOfId ?? null,
          reason: row.reason ?? null,
          vendorId: null,
          billReference: null,
          sparePart: { partNumber: 'HF-6177', name: 'Hydraulic filter' },
          reversedBy: null,
        };
      }),
    },
  });
  prisma.tx.$queryRaw = jest
    .fn()
    .mockResolvedValue([partRow(options.part ?? {})]);

  const service = new SparePartsService(
    prisma as never,
    { record: jest.fn() } as never,
    {
      parseDate: (value: string) =>
        new Date(`${value.slice(0, 10)}T00:00:00.000Z`),
      categoriesByIds: async () => new Map(),
    } as never,
    { getItemStockTotals: async () => new Map() } as never,
  );

  return { service, prisma, created, partUpdates, jobUpdates };
};

describe('SparePartsService.consume (FR-017, FR-018, FR-019, FR-020)', () => {
  it('values the consumption at the rate in force now and freezes it on the movement', async () => {
    const { service, created } = build({});

    const movement = await service.consume(
      caller,
      'job-1',
      { sparePartId: 'part-1', quantity: 2, consumedOn: '2026-09-04' },
      '10.0.0.1',
    );

    // 2 × 250. The rate is written onto the row, not left to be re-read later: a
    // receipt next week moves the average, and it must not move what this repair
    // cost (FR-017).
    expect(created[0].rate).toBe(250);
    expect(created[0].amount).toBe(500);
    expect(movement.rate).toBe(250);
  });

  it('accrues the consumption onto the job and deducts it from stock', async () => {
    const { service, partUpdates, jobUpdates } = build({});

    await service.consume(
      caller,
      'job-1',
      { sparePartId: 'part-1', quantity: 2 },
      '10.0.0.1',
    );

    expect(partUpdates[0]).toEqual({ stockQuantity: { decrement: 2 } });
    expect(jobUpdates[0]).toEqual({ partsCost: { increment: 500 } });
  });

  it('locks the part row before reading its balance', async () => {
    const { service, prisma } = build({});

    await service.consume(
      caller,
      'job-1',
      { sparePartId: 'part-1', quantity: 1 },
      '10.0.0.1',
    );

    // Two mechanics taking the last filter would otherwise both read the same
    // balance, both pass, and both commit — leaving stock negative (FR-018).
    const sql = (prisma.tx.$queryRaw as jest.Mock).mock.calls[0][0].join('');
    expect(sql).toContain('FOR UPDATE');
  });

  it('refuses a quantity above stock and reports what is available', async () => {
    const { service } = build({ part: { stockQuantity: decimal(3) } });

    const attempt = service.consume(
      caller,
      'job-1',
      { sparePartId: 'part-1', quantity: 5 },
      '10.0.0.1',
    );
    await expect(attempt).rejects.toThrow(BadRequestException);
    await expect(attempt).rejects.toMatchObject({
      response: { availableStock: 3 },
    });
  });

  it('refuses consumption against a closed job', async () => {
    const { service } = build({ job: { status: 'closed' } });

    await expect(
      service.consume(
        caller,
        'job-1',
        { sparePartId: 'part-1', quantity: 1 },
        '10.0.0.1',
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('flags an incompatible part but still records the consumption', async () => {
    const { service, created } = build({
      job: { equipment: { categoryId: 'cat-crane', ownership: 'owned' } },
    });

    const movement = await service.consume(
      caller,
      'job-1',
      { sparePartId: 'part-1', quantity: 1 },
      '10.0.0.1',
    );

    // FR-020: flagged, never blocked. The yard sometimes has to fit what it has,
    // and a system that refuses simply gets worked around.
    expect(movement.incompatiblePart).toBe(true);
    expect(created).toHaveLength(1);
  });

  it('does not flag a part that declares no compatible categories', async () => {
    const { service } = build({ part: { compatibleCategoryIds: [] } });

    const movement = await service.consume(
      caller,
      'job-1',
      { sparePartId: 'part-1', quantity: 1 },
      '10.0.0.1',
    );

    // An empty list means unrestricted — a part nobody has classified fits anything.
    expect(movement.incompatiblePart).toBe(false);
  });
});
