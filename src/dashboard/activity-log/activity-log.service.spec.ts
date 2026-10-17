import { Permission } from '@prisma/client';

import { createPrismaMock } from '../../settings/testing/prisma-mock';
import {
  ACTIVITY_EXPORT_MAX_ROWS,
  ActivityLogService,
} from './activity-log.service';

function build() {
  const findMany = jest.fn(async () => []);
  const prisma = createPrismaMock({
    auditLogEntry: { findMany },
    user: {
      findMany: jest.fn(async () => [{ id: 'acct-1', displayName: 'Ravi' }]),
      count: jest.fn(async () => 1),
    },
  });
  return { service: new ActivityLogService(prisma as never), findMany };
}

type FindArgs = { where: Record<string, unknown>; take?: number };

describe('ActivityLogService (036 B3, B13)', () => {
  it('scopes a Super Admin who has selected a company to that company, not their home', async () => {
    const { service, findMany } = build();
    await service.feed(
      {
        id: 'u',
        companyId: 'home-A',
        selectedCompanyId: 'selected-B',
        permissions: [Permission.CROSS_COMPANY_ACCESS, Permission.DASHBOARD],
        grants: [],
      } as never,
      {},
    );
    const args = (findMany.mock.calls[0] as unknown as [FindArgs])[0];
    expect(args.where.companyId).toBe('selected-B');
  });

  it('bounds an export with no time range to 90 days and a row cap', async () => {
    const { service, findMany } = build();
    const before = Date.now();
    await service.exportRows(
      {
        id: 'u',
        companyId: 'co',
        permissions: [Permission.DASHBOARD],
        grants: [],
      } as never,
      {},
    );
    const args = (findMany.mock.calls[0] as unknown as [FindArgs])[0];
    expect(args.take).toBe(ACTIVITY_EXPORT_MAX_ROWS);
    const since = (args.where.createdAt as { gte: Date }).gte.getTime();
    const days = (before - since) / 86_400_000;
    expect(days).toBeGreaterThan(89);
    expect(days).toBeLessThan(92);
  });
});

describe('ActivityLogService filters (036 E3)', () => {
  const caller = {
    id: 'u',
    companyId: 'co',
    permissions: [Permission.DASHBOARD],
    grants: [],
  } as never;

  it('narrows to a custom business-day range, a user and a search', async () => {
    const { service, findMany } = build();
    await service.feed(caller, {
      from: '2026-10-01',
      to: '2026-10-01',
      userId: 'acct-9',
      q: 'ravi',
    });
    const args = (findMany.mock.calls[0] as unknown as [FindArgs])[0];
    expect(args.where.createdAt).toEqual({
      gte: new Date('2026-09-30T18:30:00.000Z'),
      lt: new Date('2026-10-01T18:30:00.000Z'),
    });
    expect(args.where.accountId).toBe('acct-9');
    expect(args.where.AND).toEqual([
      {
        OR: [
          { attemptedEmail: { contains: 'ravi', mode: 'insensitive' } },
          { entityId: 'ravi' },
          { accountId: { in: ['acct-1'] } },
        ],
      },
    ]);
  });

  it('refuses a From after the To', async () => {
    const { service } = build();
    await expect(
      service.feed(caller, { from: '2026-10-02', to: '2026-10-01' }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('lists the accounts the User filter offers', async () => {
    const { service } = build();
    await expect(service.actors(caller, { q: 'ra' })).resolves.toEqual({
      items: [{ id: 'acct-1', name: 'Ravi' }],
      total: 1,
    });
  });
});
