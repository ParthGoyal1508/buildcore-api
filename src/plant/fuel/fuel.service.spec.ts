import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { createPrismaMock } from '../../settings/testing/prisma-mock';
import { CreateFuelEntryDto } from './dto/fuel.dto';
import { computeFuelVariance, FuelService } from './fuel.service';

/**
 * FR-004's whole point is that the threshold is a *category setting*, not the `> 15`
 * literal the original spec carried. The tests below are written against a
 * deliberately non-15 threshold for that reason: a hardcoded comparison would still
 * pass a suite that only ever used 15.
 */
describe('computeFuelVariance (FR-004)', () => {
  it('flags consumption above the category threshold', () => {
    // 12 litres over 4 hours = 3/hr against a 2/hr benchmark: 50% over.
    const result = computeFuelVariance({
      fuelConsumed: 12,
      totalHours: 4,
      benchmark: 2,
      thresholdPercent: 25,
    });
    expect(result.variancePercent).toBe(50);
    expect(result.varianceAlert).toBe(true);
  });

  it('does not flag consumption exactly at the threshold', () => {
    // 2.5/hr against 2/hr is 25% over, and the rule is "exceeds", not "reaches".
    const result = computeFuelVariance({
      fuelConsumed: 10,
      totalHours: 4,
      benchmark: 2,
      thresholdPercent: 25,
    });
    expect(result.variancePercent).toBe(25);
    expect(result.varianceAlert).toBe(false);
  });

  it('reads the threshold from the category rather than assuming 15', () => {
    const params = {
      fuelConsumed: 9,
      totalHours: 4,
      benchmark: 2,
      thresholdPercent: 15,
    };
    // 2.25/hr is 12.5% over: under 15, so no alert.
    expect(computeFuelVariance(params).varianceAlert).toBe(false);
    // The same day on a tighter category is an alert. If the threshold were
    // hardcoded these two would agree, which is the bug this test exists to catch.
    expect(
      computeFuelVariance({ ...params, thresholdPercent: 10 }).varianceAlert,
    ).toBe(true);
  });

  it('records a negative variance without alerting — under-consumption is good news', () => {
    const result = computeFuelVariance({
      fuelConsumed: 6,
      totalHours: 4,
      benchmark: 2,
      thresholdPercent: 15,
    });
    expect(result.variancePercent).toBe(-25);
    expect(result.varianceAlert).toBe(false);
  });

  it('computes nothing for a zero-hours day rather than dividing by zero', () => {
    // An idle machine has no consumption *rate*. Treating this as infinite variance
    // would flag every day a machine stood still.
    expect(
      computeFuelVariance({
        fuelConsumed: 5,
        totalHours: 0,
        benchmark: 2,
        thresholdPercent: 15,
      }),
    ).toEqual({ variancePercent: null, varianceAlert: false });
  });

  it('computes nothing when the category has no benchmark', () => {
    // An unset benchmark is not zero. Comparing against zero would make every entry
    // infinitely over, which is exactly why the column is nullable.
    expect(
      computeFuelVariance({
        fuelConsumed: 12,
        totalHours: 4,
        benchmark: null,
        thresholdPercent: 15,
      }),
    ).toEqual({ variancePercent: null, varianceAlert: false });
  });

  it('computes nothing when there is no logbook entry to measure against', () => {
    expect(
      computeFuelVariance({
        fuelConsumed: null,
        totalHours: null,
        benchmark: 2,
        thresholdPercent: 15,
      }),
    ).toEqual({ variancePercent: null, varianceAlert: false });
  });
});

describe('FuelService.create — what may be booked (036 K1, K10)', () => {
  const caller = { id: 'u-1', companyId: 'co-1', permissions: [] } as never;
  const build = () => {
    const prisma = createPrismaMock({
      equipment: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'eq-1',
          companyId: 'co-1',
          categoryId: 'cat-1',
          status: 'active',
          deployedSiteId: null,
        }),
      },
      equipmentCategory: { findUnique: jest.fn().mockResolvedValue(null) },
      logbookEntry: { findUnique: jest.fn().mockResolvedValue(null) },
      fuelEntry: { create: jest.fn() },
    });
    const refs = {
      parseDate: (value: string) =>
        new Date(`${value.slice(0, 10)}T00:00:00.000Z`),
      requireVendorName: jest.fn(),
      requireSiteName: jest.fn(),
    };
    const service = new FuelService(
      prisma as never,
      { record: jest.fn() } as never,
      refs as never,
      { emit: jest.fn() } as never,
    );
    return { service, prisma, refs };
  };
  const dto = {
    equipmentId: 'eq-1',
    date: '2026-10-01',
    quantity: 50,
    rate: 90,
  };

  it('refuses a future date', async () => {
    const { service, prisma } = build();
    await expect(
      service.create(caller, { ...dto, date: '2099-01-01' }, 'ip'),
    ).rejects.toThrow(/future/);
    expect(prisma.tx.fuelEntry.create).not.toHaveBeenCalled();
  });

  it("checks a named site against the machine's company", async () => {
    const { service, prisma, refs } = build();
    refs.requireSiteName.mockRejectedValue(
      new Error('Site s-9 does not exist in this company'),
    );
    await expect(
      service.create(caller, { ...dto, siteId: 's-9' }, 'ip'),
    ).rejects.toThrow(/does not exist in this company/);
    expect(refs.requireSiteName).toHaveBeenCalledWith(caller, 's-9', 'co-1');
    expect(prisma.tx.fuelEntry.create).not.toHaveBeenCalled();
  });

  it('refuses zero litres at the DTO', () => {
    const errors = validateSync(
      plainToInstance(CreateFuelEntryDto, { ...dto, quantity: 0 }),
    );
    expect(errors.map((error) => error.property)).toEqual(['quantity']);
  });
});
