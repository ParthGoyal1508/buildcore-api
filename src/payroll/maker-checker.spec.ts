import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { createPrismaMock } from '../settings/testing/prisma-mock';
import { SalaryAdvancesService } from './advances/salary-advances.service';
import { CreateSalaryAdvanceDto } from './advances/dto/salary-advance.dto';
import { LoansService } from './loans/loans.service';
import { CreateLoanDto } from './loans/dto/create-loan.dto';

/**
 * 036 F19 (decision 4: block, no override). Maker-checker on salary advances and loans: the person
 * who recorded it cannot approve it, the employee it is for cannot approve it, and two approvals at
 * once take effect once.
 *
 * Since 2026-10-20 the decision is taken on the item's approval chain; the effect lands on the
 * chain's final approval, once, however many paths report it.
 */

/** The spine, as the services see it: in a chain, and the decision final unless told otherwise. */
const approvalsMock = (state = 'approved') => ({
  stateOfSystem: jest.fn().mockResolvedValue({ state: 'pending' }),
  submit: jest.fn().mockResolvedValue({}),
  decideByEntity: jest.fn().mockResolvedValue({ state }),
  abandon: jest.fn(),
});
const user = { id: 'u' } as never;

const callerAs = (userId: string) =>
  ({
    userId,
    companyId: 'co-1',
    ipAddress: '127.0.0.1',
    rls: { isSuperAdmin: false, companyId: 'co-1' },
    roleIds: [],
  } as never);

const D = (n: number) => new Prisma.Decimal(n);

function advancesWith(
  advance: Record<string, unknown>,
  opts: { payeeUserId?: string | null; moved?: number; state?: string } = {},
) {
  const row = {
    id: 'adv-1',
    employeeId: 'emp-1',
    amount: D(5000),
    reason: 'Dummy reason',
    recoveryMonth: '2026-10',
    outstandingBalance: D(5000),
    exceedsLimit: false,
    status: 'pending',
    disbursedOn: null,
    createdByUserId: 'user-maker',
    employee: { companyId: 'co-1' },
    ...advance,
  };
  const prisma = createPrismaMock({
    salaryAdvance: {
      findFirst: jest.fn().mockResolvedValue(row),
      findFirstOrThrow: jest
        .fn()
        .mockResolvedValue({ ...row, status: 'disbursed' }),
      updateMany: jest.fn().mockResolvedValue({ count: opts.moved ?? 1 }),
      create: jest.fn().mockImplementation(({ data }: never) => ({
        id: 'adv-new',
        disbursedOn: null,
        ...(data as object),
        amount: D(5000),
        outstandingBalance: D(5000),
      })),
    },
    employee: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'emp-1',
        companyId: 'co-1',
        firstName: 'Dummy',
        lastName: 'Test',
        isActive: true,
        userId: opts.payeeUserId ?? 'user-payee',
        basic: D(20000),
        hra: null,
        conveyanceAllowance: null,
        siteAllowance: null,
        specialAllowance: null,
      }),
    },
  });
  const approvals = approvalsMock(opts.state);
  const service = new SalaryAdvancesService(
    prisma as never,
    { record: jest.fn() } as never,
    approvals as never,
    {
      get: () => ({ salaryAdvance: { limitMultipleOfMonthlyNet: 2 } }),
    } as never,
  );
  return { service, prisma, approvals };
}

function loansWith(
  loan: Record<string, unknown>,
  opts: { payeeUserId?: string | null; moved?: number; state?: string } = {},
) {
  const row = {
    id: 'loan-1',
    companyId: 'co-1',
    employeeId: 'emp-1',
    amount: D(50000),
    emiAmount: D(5000),
    disbursementDate: new Date('2026-09-01'),
    reason: 'Dummy',
    remarks: null,
    status: 'pending',
    createdByUserId: 'user-maker',
    schedule: [],
    ...loan,
  };
  const prisma = createPrismaMock({
    loan: {
      findFirst: jest.fn().mockResolvedValue(row),
      findFirstOrThrow: jest
        .fn()
        .mockResolvedValue({ ...row, status: 'active' }),
      updateMany: jest.fn().mockResolvedValue({ count: opts.moved ?? 1 }),
    },
    employee: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ userId: opts.payeeUserId ?? 'user-payee' }),
    },
  });
  const approvals = approvalsMock(opts.state);
  const service = new LoansService(
    prisma as never,
    { record: jest.fn() } as never,
    approvals as never,
  );
  return { service, prisma, approvals };
}

describe('maker-checker (036 F19)', () => {
  describe('salary advances', () => {
    it('refuses the person who recorded the advance', async () => {
      const { service, prisma } = advancesWith({});
      const error = await service
        .approve(callerAs('user-maker'), 'adv-1', user)
        .catch((e) => e);
      expect(error).toBeInstanceOf(ForbiddenException);
      expect(error.getResponse()).toMatchObject({ code: 'SELF_APPROVAL' });
      expect(prisma.tx.salaryAdvance.updateMany).not.toHaveBeenCalled();
    });

    it('refuses the employee the advance is for', async () => {
      const { service } = advancesWith({});
      await expect(
        service.approve(callerAs('user-payee'), 'adv-1', user),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('lets a third person approve, conditionally on still pending', async () => {
      const { service, prisma } = advancesWith({});
      const view = await service.approve(
        callerAs('user-checker'),
        'adv-1',
        user,
      );
      expect(view).toBeDefined();
      const write = prisma.tx.salaryAdvance.updateMany.mock.calls[0][0];
      expect(write.where).toEqual({ id: 'adv-1', status: 'pending' });
      expect(write.data.status).toBe('disbursed');
    });

    it('disburses once when the spine reports the same approval again', async () => {
      const { service, prisma } = advancesWith({});
      await service.approve(callerAs('user-checker'), 'adv-1', user);
      prisma.tx.salaryAdvance.updateMany.mockResolvedValueOnce({ count: 0 });
      await service.onApprovalCompleted({
        entityType: 'salary_advance',
        entityId: 'adv-1',
        companyId: 'co-1',
        instanceId: 'i-1',
      });
      // The second write matched nothing: the advance had already left `pending`.
      expect(prisma.tx.salaryAdvance.updateMany).toHaveBeenCalledTimes(2);
    });

    it('leaves the advance pending while the chain moves on', async () => {
      const { service, prisma, approvals } = advancesWith(
        {},
        { state: 'pending' },
      );
      await service.approve(callerAs('user-checker'), 'adv-1', user);
      expect(approvals.decideByEntity).toHaveBeenCalled();
      expect(prisma.tx.salaryAdvance.updateMany).not.toHaveBeenCalled();
    });

    it('a rejection zeroes the balance so it is never recovered', async () => {
      const { service, prisma } = advancesWith({}, { state: 'rejected' });
      await service.reject(callerAs('user-checker'), 'adv-1', 'Not now', user);
      expect(prisma.tx.salaryAdvance.updateMany.mock.calls[0][0].data).toEqual({
        status: 'rejected',
        outstandingBalance: 0,
      });
    });

    it('records the maker on create', async () => {
      const { service, prisma } = advancesWith({ status: 'closed' });
      prisma.tx.salaryAdvance.findFirst.mockResolvedValueOnce(null);
      await service.create(callerAs('user-maker'), 'co-1', {
        employeeId: 'emp-1',
        amount: 5000,
        reason: 'Dummy',
        recoveryMonth: '2026-10',
      });
      expect(
        prisma.tx.salaryAdvance.create.mock.calls[0][0].data.createdByUserId,
      ).toBe('user-maker');
    });

    it('caps the amount', async () => {
      const dto = plainToInstance(CreateSalaryAdvanceDto, {
        employeeId: 'emp-1',
        amount: 1_000_001,
        reason: 'Dummy',
        recoveryMonth: '2026-10',
      });
      const errors = await validate(dto);
      expect(errors.map((e) => e.property)).toContain('amount');
    });
  });

  describe('loans', () => {
    it('refuses the person who recorded the loan', async () => {
      const { service, prisma } = loansWith({});
      await expect(
        service.approve(callerAs('user-maker'), 'loan-1', user),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.tx.loan.updateMany).not.toHaveBeenCalled();
    });

    it('refuses the employee the loan is for', async () => {
      const { service } = loansWith({});
      await expect(
        service.approve(callerAs('user-payee'), 'loan-1', user),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('lets a third person approve', async () => {
      const { service } = loansWith({});
      const view = await service.approve(
        callerAs('user-checker'),
        'loan-1',
        user,
      );
      expect(view.status).toBe('active');
    });

    it('submits a new loan to its chain, excluding the maker and the payee', async () => {
      const { service, prisma, approvals } = loansWith({});
      prisma.tx.loan.create = jest.fn().mockResolvedValue({
        id: 'loan-new',
        companyId: 'co-1',
        amount: D(50000),
        emiAmount: D(5000),
        disbursementDate: new Date('2026-09-01'),
        status: 'pending',
        schedule: [],
      });
      prisma.tx.employee.findFirst.mockResolvedValueOnce({
        id: 'emp-1',
        isActive: true,
        userId: 'user-payee',
        firstName: 'Dummy',
        lastName: 'Test',
      });
      await service.create(callerAs('user-maker'), 'co-1', {
        employeeId: 'emp-1',
        amount: 50000,
        emiAmount: 5000,
        disbursementDate: '2026-09-01',
        reason: 'Dummy',
      } as never);
      expect(approvals.submit).toHaveBeenCalledWith(
        expect.objectContaining({
          actionType: 'employee_loan',
          excludedUserIds: ['user-maker', 'user-payee'],
        }),
      );
    });

    it('checks only the payee on a pre-036 loan with no recorded maker', async () => {
      const { service } = loansWith({ createdByUserId: null });
      await expect(
        service.approve(callerAs('user-maker'), 'loan-1', user),
      ).resolves.toMatchObject({ status: 'active' });
    });

    it('caps the amount and the EMI', async () => {
      const dto = plainToInstance(CreateLoanDto, {
        employeeId: 'emp-1',
        amount: 10_000_001,
        emiAmount: 10_000_001,
        disbursementDate: '2026-09-01',
        reason: 'Dummy',
      });
      const errors = await validate(dto);
      expect(errors.map((e) => e.property)).toEqual(
        expect.arrayContaining(['amount', 'emiAmount']),
      );
    });
  });
});
