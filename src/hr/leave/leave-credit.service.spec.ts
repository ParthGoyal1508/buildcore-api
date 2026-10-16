import { LeaveLedgerKind, Prisma } from '@prisma/client';

import { createPrismaMock } from '../../settings/testing/prisma-mock';
import { LeaveCreditService } from './leave-credit.service';

/** 2026-10-16: leave crediting under the default policy (EL 18 monthly, CL 8 / SL 7 yearly). */
describe('LeaveCreditService.runCredits', () => {
  const ctx = { isSuperAdmin: true };
  const d = (n: number) => new Prisma.Decimal(n);

  function build(opts: {
    joined: string;
    existing?: { leaveType: string; kind: LeaveLedgerKind; period: string }[];
    previous?: {
      leaveType: string;
      opening: number;
      accrued: number;
      used: number;
    }[];
  }) {
    const created: {
      leaveType: string;
      kind: string;
      period: string;
      days: number;
    }[] = [];
    const prisma = createPrismaMock({
      leavePolicy: { findMany: jest.fn().mockResolvedValue([]) },
      employee: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            {
              id: 'emp-1',
              dateOfJoining: new Date(`${opts.joined}T00:00:00Z`),
            },
          ]),
      },
      leaveLedgerEntry: {
        findMany: jest
          .fn()
          .mockResolvedValue(
            (opts.existing ?? []).map((e) => ({ employeeId: 'emp-1', ...e })),
          ),
        create: jest.fn(({ data }) => {
          created.push({
            leaveType: data.leaveType,
            kind: data.kind,
            period: data.period,
            days: data.days.toNumber(),
          });
          return Promise.resolve({});
        }),
      },
      leaveBalance: {
        findMany: jest.fn().mockResolvedValue(
          (opts.previous ?? []).map((b) => ({
            employeeId: 'emp-1',
            leaveType: b.leaveType,
            opening: d(b.opening),
            accrued: d(b.accrued),
            used: d(b.used),
          })),
        ),
        upsert: jest.fn().mockResolvedValue({}),
      },
    });
    const service = new LeaveCreditService(
      prisma as never,
      { record: jest.fn() } as never,
      { get: () => ({ timezone: 'Asia/Kolkata' }) } as never,
    );
    const total = (type: string) =>
      created
        .filter((c) => c.leaveType === type)
        .reduce((a, c) => a + c.days, 0);
    return { service, created, total };
  }

  it('credits a long-serving employee April to date, and the yearly grants in full', async () => {
    const { service, created, total } = build({ joined: '2020-01-01' });
    await service.runCredits(ctx, 'co-1', '2026-10-16');
    expect(
      created.filter((c) => c.kind === 'monthly_credit').map((c) => c.period),
    ).toEqual([
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09',
      '2026-10',
    ]);
    expect(total('earned')).toBeCloseTo(10.5);
    expect(total('casual')).toBe(8);
    expect(total('sick')).toBe(7);
  });

  it('prorates a mid-year joiner', async () => {
    const { service, total } = build({ joined: '2026-07-10' });
    await service.runCredits(ctx, 'co-1', '2026-10-16');
    expect(total('earned')).toBeCloseTo(6); // Jul–Oct
    expect(total('casual')).toBe(6); // 8 × 9/12
    expect(total('sick')).toBe(5.5); // 7 × 9/12 = 5.25, to the half day
  });

  it('does not credit anything twice', async () => {
    const { service, created } = build({
      joined: '2020-01-01',
      existing: [
        ...['04', '05', '06', '07', '08', '09', '10'].map((m) => ({
          leaveType: 'earned',
          kind: LeaveLedgerKind.monthly_credit,
          period: `2026-${m}`,
        })),
        {
          leaveType: 'casual',
          kind: LeaveLedgerKind.yearly_credit,
          period: '2026-27',
        },
        {
          leaveType: 'sick',
          kind: LeaveLedgerKind.yearly_credit,
          period: '2026-27',
        },
      ],
    });
    await service.runCredits(ctx, 'co-1', '2026-10-16');
    expect(created).toEqual([]);
  });

  it('carries unused earned leave forward, up to the cap, and lets casual lapse', async () => {
    const { service, created } = build({
      joined: '2020-01-01',
      previous: [
        { leaveType: 'earned', opening: 40, accrued: 18, used: 8 },
        { leaveType: 'casual', opening: 0, accrued: 8, used: 2 },
      ],
    });
    await service.runCredits(ctx, 'co-1', '2026-10-16');
    const carried = created.filter((c) => c.kind === 'carry_forward');
    expect(carried).toEqual([
      {
        leaveType: 'earned',
        kind: 'carry_forward',
        period: '2026-27',
        days: 45,
      },
    ]);
  });

  it('credits nothing to someone who has not joined yet', async () => {
    const { service, created } = build({ joined: '2026-11-01' });
    await service.runCredits(ctx, 'co-1', '2026-10-16');
    expect(created).toEqual([]);
  });
});
