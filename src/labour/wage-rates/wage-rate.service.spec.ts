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
