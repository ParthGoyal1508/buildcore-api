import { RateSource } from '@prisma/client';

import { WageRateService } from './wage-rate.service';
import type { AuthenticatedUser } from '../../auth/authenticated-user';

describe('WageRateService.resolveRate', () => {
  const service = new WageRateService(
    null as never,
    null as never,
    null as never,
  );
  const caller = {} as AuthenticatedUser;
  const date = new Date('2026-02-15T00:00:00.000Z');

  it("returns the worker's override, ignoring the project rate", async () => {
    const tx = { wageRate: { findFirst: jest.fn() } } as never;
    const result = await service.resolveRate(caller, {
      projectId: 'p1',
      skillCategoryId: 's1',
      rateOverride: 950,
      date,
      tx,
    });
    expect(result).toEqual({ rate: 950, source: RateSource.override });
    expect(
      (tx as never as { wageRate: { findFirst: jest.Mock } }).wageRate
        .findFirst,
    ).not.toHaveBeenCalled();
  });

  it('resolves the project rate in force when there is no override', async () => {
    const tx = {
      wageRate: {
        findFirst: jest.fn().mockResolvedValue({
          dailyRate: { toNumber: () => 800 },
        }),
      },
    } as never;
    const result = await service.resolveRate(caller, {
      projectId: 'p1',
      skillCategoryId: 's1',
      rateOverride: null,
      date,
      tx,
    });
    expect(result).toEqual({ rate: 800, source: RateSource.project_rate });
  });

  it('returns null when no rate applies and there is no override', async () => {
    const tx = {
      wageRate: { findFirst: jest.fn().mockResolvedValue(null) },
    } as never;
    const result = await service.resolveRate(caller, {
      projectId: 'p1',
      skillCategoryId: 's1',
      rateOverride: null,
      date,
      tx,
    });
    expect(result).toBeNull();
  });
});

describe('WageRateService.findAll (036 follow-up)', () => {
  it('names each row’s project, so a screen need not load every project to label it', async () => {
    const row = {
      id: 'r1',
      projectId: 'p1',
      skillCategoryId: 's1',
      dailyRate: { toNumber: () => 800 },
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      effectiveTo: null,
    };
    const tx = {
      $executeRaw: jest.fn(),
      $queryRaw: jest.fn(),
      wageRate: { findMany: jest.fn().mockResolvedValue([row]) },
    };
    const prisma = {
      $transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
    };
    const projects = {
      getProjectNamesByIds: jest
        .fn()
        .mockResolvedValue(new Map([['p1', 'Dummy Highway Project']])),
    };
    const service = new WageRateService(
      prisma as never,
      null as never,
      projects as never,
    );
    const rows = await service.findAll(
      { companyId: 'c1', permissions: [] } as unknown as AuthenticatedUser,
      {},
    );
    expect(rows).toEqual([
      expect.objectContaining({
        projectId: 'p1',
        projectName: 'Dummy Highway Project',
        dailyRate: 800,
      }),
    ]);
    expect(projects.getProjectNamesByIds).toHaveBeenCalledWith(
      ['p1'],
      expect.anything(),
    );
  });
});
