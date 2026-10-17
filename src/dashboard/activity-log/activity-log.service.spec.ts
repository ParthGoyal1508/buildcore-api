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
    user: { findMany: jest.fn(async () => []) },
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
