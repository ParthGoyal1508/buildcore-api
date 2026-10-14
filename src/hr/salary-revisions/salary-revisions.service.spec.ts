import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import {
  SALARY_REVISION_BEFORE_LATEST,
  SALARY_REVISION_FUTURE_DATE,
  SALARY_REVISION_NO_CHANGE,
  SalaryRevisionsService,
} from './salary-revisions.service';

/**
 * Salary revisions: the history behind the increment letter.
 *
 * What matters here is that the revision and the employee's pay heads move together — payroll reads
 * the employee's columns, never this table — and the three refusals that keep the history honest:
 * no future date (it would be paid early), no date before the latest revision, no empty revision.
 */

const CALLER = {
  userId: 'user-1',
  companyId: 'co-1',
  ipAddress: '10.0.0.1',
  rls: { companyId: 'co-1', isSuperAdmin: false },
  roleIds: [],
} as never;

const D = (n: number) => new Prisma.Decimal(n);

const EMPLOYEE = {
  companyId: 'co-1',
  basic: D(20000),
  hra: D(8000),
  conveyanceAllowance: D(1600),
  siteAllowance: null,
  specialAllowance: D(400),
};

function build(
  options: {
    employee?: unknown;
    latest?: { effectiveFrom: Date } | null;
    rows?: unknown[];
  } = {},
) {
  const employee = {
    findFirst: jest
      .fn()
      .mockResolvedValue(
        options.employee === undefined ? EMPLOYEE : options.employee,
      ),
    update: jest.fn(),
  };
  const salaryRevision = {
    findFirst: jest.fn().mockResolvedValue(options.latest ?? null),
    findMany: jest.fn().mockResolvedValue(options.rows ?? []),
    create: jest.fn(async ({ data }) => ({
      id: 'rev-1',
      createdAt: new Date(),
      ...data,
    })),
  };
  const prisma = {
    $transaction: jest.fn(async (cb: (tx: unknown) => unknown) =>
      cb({ employee, salaryRevision, $executeRaw: jest.fn() }),
    ),
  };
  const auditLog = { record: jest.fn() };
  const config = {
    get: jest.fn().mockReturnValue({ timezone: 'Asia/Kolkata' }),
  };
  const service = new SalaryRevisionsService(
    prisma as never,
    auditLog as never,
    config as never,
  );
  return { service, employee, salaryRevision, auditLog };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(BadRequestException);
  return ((error as BadRequestException).getResponse() as { code: string })
    .code;
}

describe('SalaryRevisionsService', () => {
  beforeAll(() => {
    jest.useFakeTimers({ now: new Date('2026-10-13T06:00:00Z') });
  });
  afterAll(() => jest.useRealTimers());

  describe('create', () => {
    it('snapshots the current heads, stores the new ones, and applies them to the employee', async () => {
      const { service, employee, salaryRevision, auditLog } = build();

      const result = await service.create(CALLER, 'emp-1', {
        effectiveFrom: '2026-10-01',
        basic: 22000,
        siteAllowance: 1000,
        remarks: 'Annual increment',
      });

      const data = salaryRevision.create.mock.calls[0][0].data;
      expect(data.previousBasic).toEqual(D(20000));
      expect(data.previousSiteAllowance).toBeNull();
      expect(data.basic).toEqual(D(22000));
      // Omitted heads keep their current value.
      expect(data.hra).toEqual(D(8000));
      expect(data.conveyance).toEqual(D(1600));
      expect(data.siteAllowance).toEqual(D(1000));
      expect(data.companyId).toBe('co-1');
      expect(data.createdByUserId).toBe('user-1');

      expect(employee.update).toHaveBeenCalledWith({
        where: { id: 'emp-1' },
        data: {
          basic: D(22000),
          hra: D(8000),
          conveyanceAllowance: D(1600),
          siteAllowance: D(1000),
          specialAllowance: D(400),
        },
      });

      expect(result.previousGross).toBe(30000);
      expect(result.gross).toBe(33000);

      expect(auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: 'EMPLOYEE',
          action: 'UPDATE',
          entityId: 'emp-1',
          companyId: 'co-1',
          changes: {
            fields: ['basic', 'siteAllowance'],
            salaryRevisionId: 'rev-1',
            effectiveFrom: '2026-10-01',
          },
        }),
      );
    });

    it('accepts today in the business timezone, not in UTC', async () => {
      // 2026-10-13T20:00Z is already the 14th in IST.
      jest.setSystemTime(new Date('2026-10-13T20:00:00Z'));
      const { service } = build();
      await expect(
        service.create(CALLER, 'emp-1', {
          effectiveFrom: '2026-10-14',
          basic: 25000,
        }),
      ).resolves.toBeDefined();
      jest.setSystemTime(new Date('2026-10-13T06:00:00Z'));
    });

    it('refuses a future effective date, and writes nothing', async () => {
      const { service, salaryRevision, employee } = build();
      expect(
        await codeOf(
          service.create(CALLER, 'emp-1', {
            effectiveFrom: '2026-10-14',
            basic: 25000,
          }),
        ),
      ).toBe(SALARY_REVISION_FUTURE_DATE);
      expect(salaryRevision.create).not.toHaveBeenCalled();
      expect(employee.update).not.toHaveBeenCalled();
    });

    it('refuses a date earlier than the latest revision', async () => {
      const { service, salaryRevision } = build({
        latest: { effectiveFrom: new Date('2026-09-01') },
      });
      expect(
        await codeOf(
          service.create(CALLER, 'emp-1', {
            effectiveFrom: '2026-08-31',
            basic: 25000,
          }),
        ),
      ).toBe(SALARY_REVISION_BEFORE_LATEST);
      expect(salaryRevision.create).not.toHaveBeenCalled();
    });

    it('allows a second revision on the same date as the latest', async () => {
      const { service } = build({
        latest: { effectiveFrom: new Date('2026-09-01') },
      });
      await expect(
        service.create(CALLER, 'emp-1', {
          effectiveFrom: '2026-09-01',
          basic: 25000,
        }),
      ).resolves.toBeDefined();
    });

    it('refuses a revision that changes nothing, treating an empty head as zero', async () => {
      const { service, salaryRevision } = build();
      expect(
        await codeOf(
          service.create(CALLER, 'emp-1', {
            effectiveFrom: '2026-10-01',
            basic: 20000,
            siteAllowance: 0,
          }),
        ),
      ).toBe(SALARY_REVISION_NO_CHANGE);
      expect(salaryRevision.create).not.toHaveBeenCalled();
    });

    it('404s for an employee outside the caller’s reach', async () => {
      const { service } = build({ employee: null });
      await expect(
        service.create(CALLER, 'emp-x', {
          effectiveFrom: '2026-10-01',
          basic: 1,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('listFor / latestFor', () => {
    const ROW = {
      id: 'rev-1',
      companyId: 'co-1',
      employeeId: 'emp-1',
      effectiveFrom: new Date('2026-10-01'),
      previousBasic: D(20000),
      previousHra: D(8000),
      previousConveyance: null,
      previousSiteAllowance: null,
      previousSpecialAllowance: null,
      basic: D(22000),
      hra: D(8800),
      conveyance: null,
      siteAllowance: null,
      specialAllowance: null,
      remarks: null,
      createdByUserId: 'user-1',
      createdAt: new Date(),
    };

    it('lists newest first with the monthly gross on either side', async () => {
      const { service, salaryRevision } = build({ rows: [ROW] });
      const [view] = await service.listFor(CALLER_RLS, 'emp-1');
      expect(salaryRevision.findMany).toHaveBeenCalledWith({
        where: { employeeId: 'emp-1' },
        orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
      });
      expect(view.previousGross).toBe(28000);
      expect(view.gross).toBe(30800);
    });

    it('scopes the latest revision to the company asked about', async () => {
      const { service, salaryRevision } = build({ latest: ROW as never });
      const latest = await service.latestFor(CALLER_RLS, 'co-1', 'emp-1');
      expect(salaryRevision.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { companyId: 'co-1', employeeId: 'emp-1' },
        }),
      );
      expect(latest?.gross).toBe(30800);
    });

    it('returns null when the pay has never been revised', async () => {
      const { service } = build();
      expect(await service.latestFor(CALLER_RLS, 'co-1', 'emp-1')).toBeNull();
    });
  });
});

const CALLER_RLS = { companyId: 'co-1', isSuperAdmin: false };
