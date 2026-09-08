import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
  FunnelQueryDto,
  NewJoiningsQueryDto,
  ResignationsQueryDto,
} from './dto/recruitment-reports.dto';
import { RecruitmentReportsService } from './recruitment-reports.service';

/**
 * The period contract of the recruitment reports.
 *
 * Both period-scoped reports used to declare their query as individual
 * `@Query('from')` parameters, which the global ValidationPipe has no class to
 * validate against — so nothing was checked and an omitted date reached the service
 * as `undefined`, was sliced, and came back as a 500. These cover the two halves of
 * the fix: the DTO refusing a bad request, and the service refusing a backwards one.
 */

const CALLER = {
  id: 'user-1',
  companyId: 'co-1',
  isSuperAdmin: false,
  permissions: [],
} as never;

describe('recruitment report period DTOs', () => {
  const failedProps = async (
    cls: new () => object,
    payload: Record<string, unknown>,
  ) => (await validate(plainToInstance(cls, payload))).map((e) => e.property);

  it('refuses a new-joinings request with no period at all', async () => {
    // The exact request that used to 500.
    await expect(failedProps(NewJoiningsQueryDto, {})).resolves.toEqual(
      expect.arrayContaining(['from', 'to']),
    );
  });

  it('refuses a resignations request with no period at all', async () => {
    await expect(failedProps(ResignationsQueryDto, {})).resolves.toEqual(
      expect.arrayContaining(['from', 'to']),
    );
  });

  it('refuses a half-supplied period', async () => {
    await expect(
      failedProps(NewJoiningsQueryDto, { from: '2026-04-01' }),
    ).resolves.toEqual(['to']);
  });

  it('accepts a well-formed period', async () => {
    await expect(
      failedProps(NewJoiningsQueryDto, {
        from: '2026-04-01',
        to: '2026-09-30',
      }),
    ).resolves.toEqual([]);
  });

  it('refuses a date that is not a calendar date', async () => {
    // An instant with an offset would be truncated to its first ten characters by
    // the service, quietly moving the boundary a day for a caller behind UTC.
    await expect(
      failedProps(NewJoiningsQueryDto, {
        from: '2026-04-01T00:00:00-05:00',
        to: '2026-09-30',
      }),
    ).resolves.toEqual(['from']);
    await expect(
      failedProps(NewJoiningsQueryDto, {
        from: '01-04-2026',
        to: '2026-09-30',
      }),
    ).resolves.toEqual(['from']);
  });

  it('coerces headcount to a number and refuses a non-positive one', async () => {
    const ok = plainToInstance(ResignationsQueryDto, {
      from: '2026-04-01',
      to: '2026-09-30',
      headcount: '240',
    }) as ResignationsQueryDto;
    expect(ok.headcount).toBe(240);
    await expect(validate(ok)).resolves.toEqual([]);

    // `Number(headcount)` used to turn this into NaN and carry it into the
    // attrition division, reporting a null rate that reads as "none supplied".
    await expect(
      failedProps(ResignationsQueryDto, {
        from: '2026-04-01',
        to: '2026-09-30',
        headcount: 'lots',
      }),
    ).resolves.toEqual(['headcount']);
  });

  it('leaves the funnel period-free', async () => {
    await expect(failedProps(FunnelQueryDto, {})).resolves.toEqual([]);
  });
});

describe('RecruitmentReportsService — period guard', () => {
  const build = () => {
    const prisma = {
      $transaction: jest.fn(async (cb: (tx: unknown) => unknown) =>
        cb({
          candidate: { findMany: jest.fn().mockResolvedValue([]) },
          resignation: { findMany: jest.fn().mockResolvedValue([]) },
          $executeRaw: jest.fn().mockResolvedValue(undefined),
        }),
      ),
    } as never;
    return new RecruitmentReportsService(prisma, {} as never);
  };

  const backwards = { from: '2026-09-30', to: '2026-04-01' };

  it('refuses a backwards period on new joinings', async () => {
    await expect(build().newJoinings(CALLER, backwards)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('refuses a backwards period on resignations', async () => {
    await expect(
      build().resignations(CALLER, backwards),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts a single-day period', async () => {
    // Equal endpoints are a legitimate question — "who joined on Monday" — and the
    // guard must not read that as backwards.
    await expect(
      build().newJoinings(CALLER, { from: '2026-09-08', to: '2026-09-08' }),
    ).resolves.toEqual(expect.objectContaining({ items: [] }));
  });
});
