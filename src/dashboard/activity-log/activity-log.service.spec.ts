import { Permission } from '@prisma/client';

import { createPrismaMock } from '../../settings/testing/prisma-mock';
import {
  ACTIVITY_EXPORT_MAX_ROWS,
  ActivityLogService,
} from './activity-log.service';

function build(hidingCompanies: string[] = []) {
  const findMany = jest.fn<Promise<{ id: string }[]>, [unknown?]>(
    async () => [],
  );
  const ids = (prefix: string) => jest.fn(async () => [{ id: `${prefix}-1` }]);
  const prisma = createPrismaMock({
    auditLogEntry: { findMany },
    user: {
      findMany: jest.fn(async () => [{ id: 'acct-1', displayName: 'Ravi' }]),
      count: jest.fn(async () => 1),
    },
    company: {
      findMany: jest.fn(async () => hidingCompanies.map((id) => ({ id }))),
    },
    payment: { findMany: ids('pay') },
    labourPaymentSheet: { findMany: ids('sheet') },
    labourAdvance: { findMany: ids('adv') },
    equipmentDisposal: { findMany: ids('disp') },
  });
  return {
    service: new ActivityLogService(prisma as never),
    findMany,
    prisma,
  };
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

  describe('cash hidden (038)', () => {
    const caller = {
      id: 'u',
      companyId: 'co',
      permissions: [Permission.DASHBOARD],
      grants: [],
    } as never;

    it('leaves the log untouched when no company in scope hides cash', async () => {
      const { service, findMany } = build();
      await service.feed(caller, {});
      expect(findMany).toHaveBeenCalledTimes(1);
      const args = (findMany.mock.calls[0] as unknown as [FindArgs])[0];
      expect(args.where.companyId).toBe('co');
      expect(args.where).not.toHaveProperty('AND.1');
    });

    it('excludes the entries about cash records, from the feed and the export', async () => {
      const { service, findMany } = build(['co']);
      findMany.mockImplementation(async (args?: unknown) => {
        const where = (args as FindArgs).where;
        // The positive lookup of cash entries is the one with an `OR` of matchers.
        return JSON.stringify(where).includes(
          '"OR":[{"entityType":"LABOUR_ADVANCE"',
        )
          ? [{ id: 'entry-cash' }]
          : [];
      });
      await service.feed(caller, {});
      const lookup = (findMany.mock.calls[0] as unknown as [FindArgs])[0];
      const text = JSON.stringify(lookup.where);
      for (const id of ['pay-1', 'sheet-1', 'adv-1', 'disp-1']) {
        expect(text).toContain(id);
      }
      expect(text).toContain('"equals":"Cash"');
      const feed = (findMany.mock.calls[1] as unknown as [FindArgs])[0];
      expect(feed.where).toEqual({
        AND: [
          expect.objectContaining({ companyId: 'co' }),
          { id: { notIn: ['entry-cash'] } },
        ],
      });

      findMany.mockClear();
      await service.exportRows(caller, {});
      const exported = (findMany.mock.calls[1] as unknown as [FindArgs])[0];
      expect(exported.where).toEqual(
        expect.objectContaining({
          AND: [expect.anything(), { id: { notIn: ['entry-cash'] } }],
        }),
      );
    });

    it('asks only about the served company for a company-scoped caller', async () => {
      const { service, prisma } = build();
      await service.feed(caller, {});
      const companyFind = (prisma.tx.company.findMany as jest.Mock).mock
        .calls[0][0];
      expect(companyFind.where).toEqual({
        hideCashTransactions: true,
        id: 'co',
      });
    });
  });
});
