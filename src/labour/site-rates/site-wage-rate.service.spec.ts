import { LabourGender, RateSource } from '@prisma/client';

import type { AuthenticatedUser } from '../../auth/authenticated-user';
import { WageRateService } from '../wage-rates/wage-rate.service';
import { SiteWageRateService } from './site-wage-rate.service';

describe('SiteWageRateService.resolveDayRate (031)', () => {
  const caller = {} as AuthenticatedUser;
  const date = new Date('2026-10-15T00:00:00.000Z');
  const base = {
    rateOverride: null,
    gender: LabourGender.female,
    siteId: 'site1',
    projectId: 'p1',
    skillCategoryIdOnDay: 'skill1',
    date,
  };

  const build = (siteRate: number | null, projectRate: number | null) => {
    const tx = {
      siteWageRate: {
        findFirst: jest
          .fn()
          .mockResolvedValue(
            siteRate === null
              ? null
              : { dailyRate: { toNumber: () => siteRate } },
          ),
      },
      wageRate: {
        findFirst: jest
          .fn()
          .mockResolvedValue(
            projectRate === null
              ? null
              : { dailyRate: { toNumber: () => projectRate } },
          ),
      },
    };
    const service = new SiteWageRateService(
      null as never,
      null as never,
      null as never,
      new WageRateService(null as never, null as never, null as never),
    );
    return { service, tx };
  };

  it("takes the worker's override over every rate table", async () => {
    const { service, tx } = build(500, 800);
    const result = await service.resolveDayRate(caller, tx as never, {
      ...base,
      rateOverride: 950,
    });
    expect(result).toEqual({ rate: 950, source: RateSource.override });
    expect(tx.siteWageRate.findFirst).not.toHaveBeenCalled();
  });

  it("prices at the site's rate for the worker's gender on that date", async () => {
    const { service, tx } = build(500, 800);
    const result = await service.resolveDayRate(caller, tx as never, base);
    expect(result).toEqual({ rate: 500, source: RateSource.site_rate });
    expect(tx.siteWageRate.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          siteId: 'site1',
          gender: LabourGender.female,
          effectiveFrom: { lte: date },
        }),
      }),
    );
    expect(tx.wageRate.findFirst).not.toHaveBeenCalled();
  });

  it('falls back to the pre-031 project × skill rate for days before any site rate', async () => {
    const { service, tx } = build(null, 800);
    const result = await service.resolveDayRate(caller, tx as never, base);
    expect(result).toEqual({ rate: 800, source: RateSource.project_rate });
  });

  it('skips the site rate for a worker with no gender recorded', async () => {
    const { service, tx } = build(500, 800);
    const result = await service.resolveDayRate(caller, tx as never, {
      ...base,
      gender: null,
    });
    expect(result).toEqual({ rate: 800, source: RateSource.project_rate });
    expect(tx.siteWageRate.findFirst).not.toHaveBeenCalled();
  });

  it('returns null when nothing applies', async () => {
    const { service, tx } = build(null, null);
    expect(
      await service.resolveDayRate(caller, tx as never, {
        ...base,
        skillCategoryIdOnDay: null,
      }),
    ).toBeNull();
  });
});
