import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { callerFor, createPrismaMock } from '../testing/prisma-mock';
import { HireRatesService } from './hire-rates.service';

const caller = callerFor('co-1');
const decimal = (n: number) => new Prisma.Decimal(n);
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const rate = (
  id: string,
  ratePerUnit: number,
  effectiveFrom: string,
  effectiveTo: string | null,
) => ({
  id,
  companyId: 'co-1',
  categoryId: 'cat-1',
  ratePerUnit: decimal(ratePerUnit),
  effectiveFrom: day(effectiveFrom),
  effectiveTo: effectiveTo === null ? null : day(effectiveTo),
  createdAt: new Date(),
  category: { name: 'Excavator' },
});

/**
 * FR-014 and SC-006 are the same guarantee seen from two sides: rates form a
 * non-overlapping timeline, so a hire bill raised for last March still resolves last
 * March's rate after this year's revision lands.
 */
describe('HireRatesService.create — the non-overlap invariant (FR-014)', () => {
  const build = (existing: ReturnType<typeof rate>[]) => {
    const closed: Record<string, unknown>[] = [];
    const prisma = createPrismaMock({
      equipmentCategory: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'cat-1', companyId: 'co-1' }),
      },
      hireRate: {
        findFirst: jest.fn(async ({ where }: never) => {
          const w = where as { effectiveFrom?: { gte?: Date } };
          const from = w.effectiveFrom?.gte;
          if (!from) return null;
          return existing.find((row) => row.effectiveFrom >= from) ?? null;
        }),
        updateMany: jest.fn(async ({ data }: never) => {
          closed.push(data as Record<string, unknown>);
          return { count: 1 };
        }),
        create: jest.fn(async ({ data }: never) => ({
          ...(data as Record<string, unknown>),
          id: 'rate-new',
          createdAt: new Date(),
          category: { name: 'Excavator' },
        })),
      },
    });
    const service = new HireRatesService(
      prisma as never,
      { record: jest.fn() } as never,
    );
    return { service, closed, prisma };
  };

  it('closes the prior current rate the day before the new one starts', async () => {
    const { service, closed } = build([]);

    await service.create(
      caller,
      { categoryId: 'cat-1', ratePerUnit: 1400, effectiveFrom: '2026-04-01' },
      '10.0.0.1',
    );

    // 31 March, not 1 April. An overlap of even one day makes
    // `getEffectiveHireRate` return whichever row the planner ordered first, and a
    // bill's amount must not depend on that.
    expect(closed[0].effectiveTo).toEqual(day('2026-03-31'));
  });

  it('refuses a rate that starts on or before an existing one', async () => {
    const { service } = build([rate('rate-1', 1250, '2026-04-01', null)]);

    // Backdating into the covered timeline would make two rates apply to the same
    // day, which is precisely what the invariant forbids.
    await expect(
      service.create(
        caller,
        { categoryId: 'cat-1', ratePerUnit: 1100, effectiveFrom: '2026-02-01' },
        '10.0.0.1',
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('closes the prior rate and creates the new one in one transaction', async () => {
    const { service, prisma } = build([]);

    await service.create(
      caller,
      { categoryId: 'cat-1', ratePerUnit: 1400, effectiveFrom: '2026-04-01' },
      '10.0.0.1',
    );

    // A crash between the two would leave two overlapping "current" rates.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe('HireRatesService.getEffectiveHireRate (SC-006)', () => {
  const build = (rows: ReturnType<typeof rate>[]) => {
    const prisma = createPrismaMock({
      hireRate: {
        findFirst: jest.fn(async ({ where }: never) => {
          const w = where as {
            effectiveFrom: { lte: Date };
            OR: [{ effectiveTo: null }, { effectiveTo: { gte: Date } }];
          };
          const onDate = w.effectiveFrom.lte;
          return (
            rows
              .filter(
                (row) =>
                  row.effectiveFrom <= onDate &&
                  (row.effectiveTo === null || row.effectiveTo >= onDate),
              )
              .sort(
                (a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime(),
              )[0] ?? null
          );
        }),
      },
    });
    return new HireRatesService(
      prisma as never,
      { record: jest.fn() } as never,
    );
  };

  const timeline = [
    rate('rate-old', 1100, '2025-04-01', '2026-03-31'),
    rate('rate-new', 1400, '2026-04-01', null),
  ];

  it('resolves the rate in force on the date asked for, not the latest one', async () => {
    const service = build(timeline);

    // The whole of SC-006: a bill for August 2025 must still cost what a machine
    // cost in August 2025, however many revisions have landed since.
    await expect(
      service.getEffectiveHireRate(caller, 'cat-1', day('2025-08-15')),
    ).resolves.toBe(1100);
  });

  it('resolves the current rate for a date after the revision', async () => {
    const service = build(timeline);
    await expect(
      service.getEffectiveHireRate(caller, 'cat-1', day('2026-06-01')),
    ).resolves.toBe(1400);
  });

  it('resolves on the exact boundary day to the newer rate', async () => {
    const service = build(timeline);
    await expect(
      service.getEffectiveHireRate(caller, 'cat-1', day('2026-04-01')),
    ).resolves.toBe(1400);
  });

  it('returns null for a date before any rate existed', async () => {
    const service = build(timeline);
    // Null rather than falling back to the earliest rate: the caller turns this into
    // "supply a rate" rather than inventing a number for a period nobody priced.
    await expect(
      service.getEffectiveHireRate(caller, 'cat-1', day('2024-01-01')),
    ).resolves.toBeNull();
  });
});
