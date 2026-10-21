import { Permission } from '@prisma/client';

import { createPrismaMock } from '../settings/testing/prisma-mock';
import { ApprovalHistoryService } from './approval-history.service';
import { chainWhereForModule, moduleOf } from './approval-modules';
import { SLOT_FINAL, SLOT_FIRST_APPROVER, SLOT_HR } from './approval-slots';

const COMPANY = 'company-1';

const caller = (id: string, permissions: Permission[] = []) =>
  ({
    id,
    companyId: COMPANY,
    permissions,
    roleNames: [],
    roleIds: [],
  } as never);

const level = (position: number, slotKey: string, chainId = 'chain-ra') => ({
  id: `${chainId}-l${position}`,
  chainId,
  companyId: COMPANY,
  position,
  slotKey,
  isFinalAuthority: slotKey === SLOT_FINAL,
  label: null,
  createdAt: new Date(),
  updatedAt: new Date(),
});

const decision = (
  position: number,
  actorUserId: string,
  action: 'approve' | 'reject' | 'return',
  round = 1,
  reason: string | null = null,
) => ({
  id: `d-${round}-${position}`,
  approvalInstanceId: 'inst',
  companyId: COMPANY,
  round,
  position,
  actorUserId,
  action,
  reason,
  decidedAt: new Date(`2026-10-0${position + round}T10:00:00Z`),
});

const instance = (overrides: Record<string, unknown> = {}) => ({
  id: 'inst-1',
  companyId: COMPANY,
  chainId: 'chain-ra',
  entityType: 'bill_package',
  entityId: 'bp-1',
  subject: 'RA bill RA-03',
  href: '/dashboard/projects/portfolio/p1/bill-packages/bp-1',
  viewPermission: Permission.PROJECT_FINANCIALS,
  currentPosition: 1,
  state: 'pending',
  originatorUserId: 'raiser',
  round: 1,
  returnCount: 0,
  delegatedToUserId: null,
  delegationReason: null,
  createdAt: new Date('2026-10-01T09:00:00Z'),
  updatedAt: new Date('2026-10-02T09:00:00Z'),
  chain: {
    id: 'chain-ra',
    companyId: COMPANY,
    actionType: 'ra_bill',
    isFinalAuthorityRequired: false,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    levels: [
      level(3, SLOT_FINAL),
      level(1, SLOT_FIRST_APPROVER),
      level(2, SLOT_HR),
    ],
  },
  decisions: [] as ReturnType<typeof decision>[],
  ...overrides,
});

function harness(rows = [instance()]) {
  const prisma = createPrismaMock({
    approvalInstance: {
      findMany: jest.fn(async () => rows),
      groupBy: jest.fn(async () => [
        { chainId: 'chain-ra', _count: { _all: 7 } },
        { chainId: 'chain-dwr', _count: { _all: 2 } },
        { chainId: 'chain-mystery', _count: { _all: 1 } },
      ]),
    },
    approvalChain: {
      findMany: jest.fn(async () => [
        { id: 'chain-ra', actionType: 'ra_bill' },
        { id: 'chain-dwr', actionType: 'dwr' },
        { id: 'chain-mystery', actionType: 'something_new' },
      ]),
    },
    user: {
      findMany: jest.fn(async () => [
        { id: 'raiser', displayName: 'Ravi Raiser' },
        { id: 'site-1', displayName: 'Sita Site' },
        { id: 'hr-1', displayName: 'Hari HR' },
      ]),
    },
  });
  const service = new ApprovalHistoryService(prisma as never);
  return { prisma, service, tx: prisma.tx };
}

describe('approval modules', () => {
  it('classifies action types, letters by prefix, and the unknown as Other', () => {
    expect(moduleOf('ra_bill').key).toBe('billing');
    expect(moduleOf('client_bill').key).toBe('billing');
    expect(moduleOf('letter_work_order').key).toBe('letters');
    // A letter kind an administrator adds tomorrow is still a letter.
    expect(moduleOf('letter_offer_v2').key).toBe('letters');
    expect(moduleOf('payroll_run').key).toBe('payroll');
    expect(moduleOf('dwr').key).toBe('dwr');
    expect(moduleOf('material_indent').key).toBe('inventory');
    // Never dropped: an unclassified type is listed, under Other.
    expect(moduleOf('something_new')).toEqual({ key: 'other', label: 'Other' });
  });

  it('filters Other as the negation of every module, so filter and grouping agree', () => {
    const where = chainWhereForModule('other') as { NOT: { OR: unknown[] } };
    expect(where.NOT.OR).toEqual(
      expect.arrayContaining([
        { actionType: { startsWith: 'letter_' } },
        { actionType: { in: expect.arrayContaining(['ra_bill']) } },
        { actionType: { in: ['dwr'] } },
      ]),
    );
  });

  it('matches nothing for an unknown key rather than everything', () => {
    expect(chainWhereForModule('nope')).toEqual({ id: { in: [] } });
  });
});

describe('ApprovalHistoryService.historyFor', () => {
  it('lists what the caller may read: their permissions, or having taken part', async () => {
    const { service, tx } = harness();
    await service.historyFor(caller('me', [Permission.PAYROLL]), {
      status: 'decided',
    });
    const { where } = tx.approvalInstance.findMany.mock.calls[0][0];
    expect(where.companyId).toBe(COMPANY);
    expect(where.state).toEqual({ in: ['approved', 'rejected'] });
    // Exactly `mayViewHistory`, as a where: no wider, or the listing leaks the
    // rejection reasons the per-item check withholds.
    expect(where.OR).toEqual([
      { viewPermission: { in: [Permission.PAYROLL] } },
      { originatorUserId: 'me' },
      { delegatedToUserId: 'me' },
      { decisions: { some: { actorUserId: 'me' } } },
    ]);
  });

  it('scope=mine keeps only what the caller took part in', async () => {
    const { service, tx } = harness();
    await service.historyFor(caller('me', [Permission.PAYROLL]), {
      scope: 'mine',
      status: 'all',
    });
    const { where } = tx.approvalInstance.findMany.mock.calls[0][0];
    expect(where.state).toBeUndefined();
    expect(where.OR).not.toContainEqual({
      viewPermission: { in: [Permission.PAYROLL] },
    });
    expect(where.OR).toHaveLength(3);
  });

  it('open means pending or returned; withdrawn means abandoned', async () => {
    const { service, tx } = harness();
    await service.historyFor(caller('me'), { status: 'open' });
    await service.historyFor(caller('me'), { status: 'withdrawn' });
    expect(tx.approvalInstance.findMany.mock.calls[0][0].where.state).toEqual({
      in: ['pending', 'returned'],
    });
    expect(tx.approvalInstance.findMany.mock.calls[1][0].where.state).toEqual({
      in: ['abandoned'],
    });
  });

  it('applies the module filter to the page but not to the module counts', async () => {
    const { service, tx } = harness();
    const page = await service.historyFor(caller('me'), { module: 'billing' });
    expect(tx.approvalInstance.findMany.mock.calls[0][0].where.chain).toEqual(
      chainWhereForModule('billing'),
    );
    expect(tx.approvalInstance.groupBy.mock.calls[0][0].where.chain).toBe(
      undefined,
    );
    // Total is the filtered module's count; the chips still offer every module.
    expect(page.total).toBe(7);
    expect(page.modules).toEqual([
      { key: 'billing', label: 'Bills & work orders', count: 7 },
      { key: 'dwr', label: 'Daily work reports', count: 2 },
      { key: 'other', label: 'Other', count: 1 },
    ]);
  });

  it('pages by offset, newest change first', async () => {
    const { service, tx } = harness();
    await service.historyFor(caller('me'), { page: 3, pageSize: 10 });
    const args = tx.approvalInstance.findMany.mock.calls[0][0];
    expect(args.skip).toBe(20);
    expect(args.take).toBe(10);
    expect(args.orderBy).toEqual([{ updatedAt: 'desc' }, { id: 'desc' }]);
  });

  it('renders the whole chain: who decided each level, the current one, and what is still to come', async () => {
    const { service } = harness([
      instance({
        currentPosition: 2,
        decisions: [decision(1, 'site-1', 'approve', 1, 'Measured on site')],
      }),
    ]);
    const { items } = await service.historyFor(caller('me'), {
      status: 'open',
    });
    const [row] = items;
    expect(row.module).toBe('billing');
    expect(row.requestedByName).toBe('Ravi Raiser');
    expect(row.awaitingLabel).toBe('HR');
    expect(row.closedAt).toBeNull();
    expect(row.steps.map((s) => [s.position, s.label, s.status])).toEqual([
      [1, 'First approver', 'approved'],
      [2, 'HR', 'current'],
      [3, 'Director', 'upcoming'],
    ]);
    expect(row.steps[0]).toMatchObject({
      actorName: 'Sita Site',
      reason: 'Measured on site',
    });
    expect(row.viewerTookPart).toBe(false);
  });

  it('marks levels after a rejection as never reached, not as waiting', async () => {
    const { service } = harness([
      instance({
        state: 'rejected',
        decisions: [decision(1, 'site-1', 'reject', 1, 'Wrong quantities')],
      }),
    ]);
    const [row] = (await service.historyFor(caller('site-1'))).items;
    expect(row.steps.map((s) => s.status)).toEqual([
      'rejected',
      'not_reached',
      'not_reached',
    ]);
    expect(row.awaitingLabel).toBeNull();
    expect(row.closedAt).toEqual(new Date('2026-10-02T09:00:00Z'));
    expect(row.viewerTookPart).toBe(true);
  });

  it('keeps earlier rounds apart from the current chain', async () => {
    const { service } = harness([
      instance({
        round: 2,
        returnCount: 1,
        decisions: [
          decision(1, 'site-1', 'approve', 1),
          decision(2, 'hr-1', 'return', 1, 'Attach the measurement sheet'),
          decision(1, 'site-1', 'approve', 2),
        ],
        currentPosition: 2,
      }),
    ]);
    const [row] = (await service.historyFor(caller('me'))).items;
    expect(row.steps.map((s) => s.status)).toEqual([
      'approved',
      'current',
      'upcoming',
    ]);
    expect(row.earlierDecisions.map((d) => [d.round, d.action])).toEqual([
      [1, 'approve'],
      [1, 'return'],
    ]);
    expect(row.earlierDecisions[1].reason).toBe('Attach the measurement sheet');
  });

  it('reads a fixed number of times whatever the page holds — never per row', async () => {
    const rows = Array.from({ length: 15 }, (_, i) =>
      instance({
        id: `inst-${i}`,
        decisions: [decision(1, i % 2 ? 'site-1' : 'hr-1', 'approve')],
      }),
    );
    const { service, tx } = harness(rows);
    const page = await service.historyFor(caller('me'));
    expect(page.items).toHaveLength(15);
    expect(tx.approvalInstance.findMany).toHaveBeenCalledTimes(1);
    expect(tx.approvalInstance.groupBy).toHaveBeenCalledTimes(1);
    expect(tx.approvalChain.findMany).toHaveBeenCalledTimes(1);
    expect(tx.user.findMany).toHaveBeenCalledTimes(1);
  });

  it('returns an empty page for a caller with no company', async () => {
    const { service, tx } = harness();
    const page = await service.historyFor({
      id: 'x',
      companyId: null,
      permissions: [],
      roleIds: [],
    } as never);
    expect(page.items).toEqual([]);
    expect(tx.approvalInstance.findMany).not.toHaveBeenCalled();
  });
});

// 036 D1/D2: date range, search, requester and the CSV export.
describe('ApprovalHistoryService filters (036 D1)', () => {
  it('adds nothing when no filter is given — the listing is as before', async () => {
    const { service, tx } = harness();
    await service.historyFor(caller('me', [Permission.PAYROLL]), {});
    const { where } = tx.approvalInstance.findMany.mock.calls[0][0];
    expect(where.AND).toBeUndefined();
  });

  it('turns from/to into business-day instants on the latest action', async () => {
    const { service, tx } = harness();
    await service.historyFor(caller('me', [Permission.PAYROLL]), {
      from: '2026-10-01',
      to: '2026-10-31',
    });
    const { where } = tx.approvalInstance.findMany.mock.calls[0][0];
    // Asia/Kolkata: the 1st starts at 18:30 UTC the day before; the 31st ends at 18:30 UTC on it.
    expect(where.AND).toContainEqual({
      updatedAt: {
        gte: new Date('2026-09-30T18:30:00.000Z'),
        lt: new Date('2026-10-31T18:30:00.000Z'),
      },
    });
    // The visibility rule is untouched.
    expect(where.OR).toHaveLength(4);
  });

  it('refuses a From after the To', async () => {
    const { service } = harness();
    await expect(
      service.historyFor(caller('me'), {
        from: '2026-10-05',
        to: '2026-10-01',
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('searches the subject and the people who raised or decided', async () => {
    const { service, tx } = harness();
    await service.historyFor(caller('me'), {
      q: 'ravi',
      requestedBy: 'raiser',
    });
    const { where } = tx.approvalInstance.findMany.mock.calls[0][0];
    expect(where.AND).toContainEqual({ originatorUserId: 'raiser' });
    expect(where.AND).toContainEqual({
      OR: [
        { subject: { contains: 'ravi', mode: 'insensitive' } },
        { originatorUserId: { in: ['raiser', 'site-1', 'hr-1'] } },
        {
          decisions: {
            some: { actorUserId: { in: ['raiser', 'site-1', 'hr-1'] } },
          },
        },
      ],
    });
  });

  it('exposes the latest action as lastActionAt', async () => {
    const { service } = harness();
    const page = await service.historyFor(caller('me', [Permission.PAYROLL]));
    expect(page.items[0].lastActionAt).toEqual(
      new Date('2026-10-02T09:00:00Z'),
    );
  });

  it('exports one CSV row per item under the same filters', async () => {
    const { service, tx } = harness();
    const rows = await service.exportRows(caller('me', [Permission.PAYROLL]), {
      status: 'all',
    });
    expect(rows[0][0]).toBe('Subject');
    expect(rows[1]).toEqual(
      expect.arrayContaining(['RA bill RA-03', 'pending', 'Ravi Raiser']),
    );
    expect(tx.approvalInstance.findMany.mock.calls[0][0].take).toBe(5_000);
  });
});
