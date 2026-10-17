import { ConflictException } from '@nestjs/common';
import { PayrollRunStatus, Prisma } from '@prisma/client';

import config from '../../common/configs/config';
import { createPrismaMock } from '../../settings/testing/prisma-mock';
import {
  PayrollEngineService,
  findStaleRecoveries,
  lineTotals,
} from './payroll-engine.service';

/**
 * 036 stream 1a. The payroll engine's run lifecycle against a mocked database.
 *
 * Each `describe` names the audit row it proves; the first test in each is written so it fails on
 * the code before 036 (recoveries applied at draft, every claim settled, every company's EMIs paid,
 * paid without approval, a read-then-write status move).
 */

const D = (n: number) => new Prisma.Decimal(n);
const caller = {
  userId: 'user-hr',
  companyId: 'co-1',
  ipAddress: '127.0.0.1',
  rls: { isSuperAdmin: false, companyId: 'co-1' },
  roleIds: [],
} as never;

const EMPLOYEE = {
  id: 'emp-1',
  companyId: 'co-1',
  siteId: 'site-1',
  shiftId: 'shift-1',
  employeeCode: 'E001',
  firstName: 'Dummy',
  lastName: 'Worker',
  isActive: true,
  basic: D(20000),
  hra: D(5000),
  conveyanceAllowance: D(1000),
  siteAllowance: D(1000),
  specialAllowance: D(3000),
  pfApplicable: false,
  pfUpperLimit: false,
  esicApplicable: false,
  esicUpperLimit: false,
  hoursPerDay: D(8),
};

/** A line as `createMany` wrote it, with the Decimal columns a read returns. */
function storedLine(overrides: Record<string, unknown> = {}) {
  return {
    id: 'line-1',
    payrollRunId: 'run-1',
    employeeId: 'emp-1',
    monthDays: 30,
    payableDays: D(30),
    lopDays: D(0),
    otHours: D(0),
    otWages: D(0),
    basic: D(20000),
    hra: D(5000),
    conveyanceAllowance: D(1000),
    siteAllowance: D(1000),
    specialAllowance: D(3500),
    employeePf: D(0),
    employeeEsic: D(0),
    professionalTax: D(200),
    tds: D(0),
    loanEmiDeduction: D(1000),
    fuelRecoveryDeduction: D(300),
    advanceRecovered: D(2000),
    advanceRecoveryAdvanceId: 'adv-1',
    fuelRecoveries: [{ recoveryId: 'fuel-1', amount: 300 }],
    reimbursementClaimIds: ['claim-in-run'],
    reimbursementTotal: D(500),
    netPay: D(27000),
    employerPf: D(0),
    employerEps: D(0),
    employerEdli: D(0),
    adminCharges: D(0),
    employerEsic: D(0),
    gratuity: D(0),
    bonus: D(0),
    ...overrides,
  };
}

function build(
  opts: {
    existingRun?: { id: string; status: PayrollRunStatus } | null;
    run?: Record<string, unknown>;
    lines?: Record<string, unknown>[];
    gate?: { allowed: boolean; state: string | null; levelLabel?: string };
    statusMoveCount?: number;
    draftClaimCount?: number;
    advance?: Record<string, unknown> | null;
    fuel?: Record<string, unknown> | null;
    claim?: Record<string, unknown> | null;
  } = {},
) {
  const run = {
    id: 'run-1',
    companyId: 'co-1',
    period: '2026-09',
    status: PayrollRunStatus.draft,
    isFnf: false,
    exceptions: null,
    ...opts.run,
  };
  const lines = opts.lines ?? [storedLine()];
  const created: Record<string, unknown>[] = [];

  const prisma = createPrismaMock({
    payrollRun: {
      findFirst: jest
        .fn()
        .mockImplementation(({ where, include }: never) =>
          (where as { period?: string }).period
            ? opts.existingRun ?? null
            : include
            ? { ...run, lineItems: lines }
            : run,
        ),
      findFirstOrThrow: jest
        .fn()
        .mockImplementation(() => ({ ...run, status: run.status })),
      create: jest
        .fn()
        .mockImplementation(({ data }: never) => ({
          id: 'run-1',
          ...(data as object),
        })),
      updateMany: jest.fn().mockImplementation(({ where }: never) => ({
        count: (where as { status?: string }).status
          ? (where as { status: string }).status === PayrollRunStatus.draft &&
            opts.draftClaimCount !== undefined
            ? opts.draftClaimCount
            : opts.statusMoveCount ?? 1
          : 1,
      })),
    },
    payrollLineItem: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockImplementation(({ data }: never) => {
        created.push(...(data as Record<string, unknown>[]));
        return { count: (data as unknown[]).length };
      }),
      findMany: jest.fn().mockImplementation(({ where }: never) => {
        const w = where as { loanEmiDeduction?: unknown };
        return w.loanEmiDeduction
          ? lines.filter((l) => Number(l.loanEmiDeduction) > 0)
          : lines;
      }),
    },
    employee: {
      findMany: jest.fn().mockResolvedValue([EMPLOYEE]),
    },
    loanScheduleEntry: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn(),
      count: jest.fn().mockResolvedValue(1),
    },
    loan: { update: jest.fn() },
    salarySlip: { upsert: jest.fn() },
    salaryAdvance: {
      findMany: jest.fn().mockResolvedValue(
        opts.advance === null
          ? []
          : [
              {
                id: 'adv-1',
                status: 'disbursed',
                outstandingBalance: D(5000),
                ...opts.advance,
              },
            ],
      ),
    },
    operatorFuelRecovery: {
      findMany: jest.fn().mockResolvedValue(
        opts.fuel === null
          ? []
          : [
              {
                id: 'fuel-1',
                status: 'approved',
                amount: D(1000),
                recoveredAmount: D(0),
                ...opts.fuel,
              },
            ],
      ),
    },
    reimbursementClaim: {
      findMany: jest.fn().mockResolvedValue(
        opts.claim === null
          ? []
          : [
              {
                id: 'claim-in-run',
                status: 'approved',
                paymentMode: 'payroll',
                ...opts.claim,
              },
            ],
      ),
    },
  });

  const advances = {
    recoveryDue: jest
      .fn()
      .mockResolvedValue({ amount: 2000, advanceId: 'adv-1' }),
    applyRecovery: jest.fn().mockResolvedValue(undefined),
  };
  const fuelRecovery = {
    dueForEmployees: jest
      .fn()
      .mockResolvedValue(
        new Map([['emp-1', [{ recoveryId: 'fuel-1', balance: 300 }]]]),
      ),
    recordRecovered: jest.fn().mockResolvedValue(undefined),
  };
  const reimbursements = {
    pendingPayrollReimbursements: jest
      .fn()
      .mockResolvedValue({ total: 500, claimIds: ['claim-in-run'] }),
    settlePayrollClaims: jest.fn().mockResolvedValue(undefined),
  };
  const approvals = {
    mayTakeEffect: jest.fn().mockResolvedValue({
      allowed: true,
      state: 'approved',
      levelLabel: null,
      ...opts.gate,
    }),
  };
  const auditLog = { record: jest.fn().mockResolvedValue(undefined) };

  const service = new PayrollEngineService(
    prisma as never,
    {
      getPayrollRates: jest.fn().mockResolvedValue({
        pfEmployerRate: 12,
        esicEmployerRate: 3.25,
        gratuityRate: 0,
        bonusRate: 0,
        otMultiplier: 2,
      }),
      getDeductionCeilingPercent: jest.fn().mockResolvedValue(50),
    } as never,
    {
      getMonthForEmployee: jest.fn().mockResolvedValue({
        days: Array.from({ length: 30 }, () => ({
          status: 'present',
          otHours: 0,
        })),
      }),
    } as never,
    reimbursements as never,
    {
      computeForEmployee: jest.fn().mockResolvedValue({
        tds: 0,
        slabsMissing: false,
        noPanRateApplied: true,
      }),
    } as never,
    advances as never,
    fuelRecovery as never,
    auditLog as never,
    { get: (key: string) => (config() as never)[key] } as never,
    approvals as never,
  );
  return {
    service,
    prisma,
    created,
    advances,
    fuelRecovery,
    reimbursements,
    approvals,
  };
}

describe('PayrollEngineService (036 stream 1a)', () => {
  describe('F1/F2 — generating a draft settles nothing', () => {
    it('records the recoveries on the line without touching any balance', async () => {
      const { service, advances, fuelRecovery, created } = build({
        existingRun: null,
      });
      await service.generate(caller, 'co-1', '2026-09');

      expect(advances.applyRecovery).not.toHaveBeenCalled();
      expect(fuelRecovery.recordRecovered).not.toHaveBeenCalled();
      expect(created[0]).toMatchObject({
        advanceRecovered: 2000,
        advanceRecoveryAdvanceId: 'adv-1',
        fuelRecoveryDeduction: 300,
        fuelRecoveries: [{ recoveryId: 'fuel-1', amount: 300 }],
        reimbursementClaimIds: ['claim-in-run'],
        reimbursementTotal: 500,
      });
    });

    it('leaves balances untouched however many times a draft is regenerated', async () => {
      const { service, advances, fuelRecovery } = build({
        existingRun: { id: 'run-1', status: PayrollRunStatus.draft },
      });
      await service.generate(caller, 'co-1', '2026-09');
      await service.generate(caller, 'co-1', '2026-09');
      await service.generate(caller, 'co-1', '2026-09');

      expect(advances.applyRecovery).not.toHaveBeenCalled();
      expect(fuelRecovery.recordRecovered).not.toHaveBeenCalled();
    });

    it('still reports the planned advance recoveries in the response', async () => {
      const { service } = build({ existingRun: null });
      const result = await service.generate(caller, 'co-1', '2026-09');
      expect(result.advanceRecoveries).toEqual([
        { advanceId: 'adv-1', amount: 2000 },
      ]);
    });
  });

  describe('F7 — exceptions are kept on the run', () => {
    it('writes them when the run is created', async () => {
      const { service, prisma } = build({ existingRun: null });
      await service.generate(caller, 'co-1', '2026-09');
      const data = prisma.tx.payrollRun.create.mock.calls[0][0].data;
      expect(data.exceptions).toEqual([
        {
          employeeId: 'emp-1',
          reason: 'No PAN on file — the penal no-PAN rate was applied.',
        },
      ]);
    });

    it('returns them from getRun with the employee named', async () => {
      const { service } = build({
        run: { exceptions: [{ employeeId: 'emp-1', reason: 'No PAN' }] },
      });
      const run = await service.getRun(caller, 'run-1');
      expect(run.exceptions).toEqual([
        {
          employeeId: 'emp-1',
          reason: 'No PAN',
          employeeCode: 'E001',
          name: 'Dummy Worker',
        },
      ]);
    });

    it('returns [] for a run generated before exceptions were kept', async () => {
      const { service } = build({ run: { exceptions: null } });
      expect((await service.getRun(caller, 'run-1')).exceptions).toEqual([]);
    });
  });

  describe('regeneration races', () => {
    it('refuses to rewrite a run processed while it was being regenerated', async () => {
      const { service, prisma } = build({
        existingRun: { id: 'run-1', status: PayrollRunStatus.draft },
        draftClaimCount: 0,
      });
      await expect(service.generate(caller, 'co-1', '2026-09')).rejects.toThrow(
        /processed while it was being regenerated/,
      );
      expect(prisma.tx.payrollLineItem.deleteMany).not.toHaveBeenCalled();
    });

    it('turns a concurrent generate (P2002) into a readable 409', async () => {
      const { service, prisma } = build({ existingRun: null });
      prisma.tx.payrollRun.create.mockRejectedValueOnce(
        Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
      );
      const error = await service
        .generate(caller, 'co-1', '2026-09')
        .catch((e) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect(error.message).toMatch(/being generated by someone else/);
    });
  });

  describe('F1/F2/F3 — processing applies the recoveries exactly once', () => {
    it('applies the advance and fuel recoveries the lines recorded', async () => {
      const { service, advances, fuelRecovery } = build();
      await service.setStatus(caller, 'run-1', PayrollRunStatus.processed);

      expect(advances.applyRecovery).toHaveBeenCalledTimes(1);
      expect(advances.applyRecovery).toHaveBeenCalledWith(
        expect.anything(),
        'adv-1',
        2000,
      );
      expect(fuelRecovery.recordRecovered).toHaveBeenCalledTimes(1);
      expect(fuelRecovery.recordRecovered).toHaveBeenCalledWith(
        expect.anything(),
        'fuel-1',
        300,
        'line-1',
      );
    });

    it('stamps recoveriesSettledAt in the same conditional status move', async () => {
      const { service, prisma } = build();
      await service.setStatus(caller, 'run-1', PayrollRunStatus.processed);
      const call = prisma.tx.payrollRun.updateMany.mock.calls[0][0];
      expect(call.where).toEqual({ id: 'run-1', status: 'draft' });
      expect(call.data.recoveriesSettledAt).toBeInstanceOf(Date);
    });

    it('writes the advance recovered to the payslip instead of 0 (F3)', async () => {
      const { service, prisma } = build();
      await service.setStatus(caller, 'run-1', PayrollRunStatus.processed);
      const slip = prisma.tx.salarySlip.upsert.mock.calls[0][0].create;
      expect(Number(slip.deductionAdvanceRecovery)).toBe(2000);
      expect(Number(slip.deductionFuelRecovery)).toBe(300);

      // Earnings − deductions = net, which is what was broken.
      const earnings =
        Number(slip.earningBasic) +
        Number(slip.earningHra) +
        Number(slip.earningConveyance) +
        Number(slip.earningSiteAllowance) +
        Number(slip.earningSpecialAllowance) +
        Number(slip.earningOt);
      const deductions =
        Number(slip.deductionPf) +
        Number(slip.deductionEsic) +
        Number(slip.deductionPt) +
        Number(slip.deductionTds) +
        Number(slip.deductionLoanEmi) +
        Number(slip.deductionAdvanceRecovery) +
        Number(slip.deductionFuelRecovery);
      expect(earnings - deductions).toBe(Number(slip.netPay));
    });

    it('settles nothing when a concurrent process already moved the run (F6)', async () => {
      const { service, advances, fuelRecovery, reimbursements } = build({
        statusMoveCount: 0,
      });
      await expect(
        service.setStatus(caller, 'run-1', PayrollRunStatus.processed),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(advances.applyRecovery).not.toHaveBeenCalled();
      expect(fuelRecovery.recordRecovered).not.toHaveBeenCalled();
      expect(reimbursements.settlePayrollClaims).not.toHaveBeenCalled();
    });

    it('refuses a stale draft whose advance was recovered elsewhere since', async () => {
      const { service, advances } = build({
        advance: { outstandingBalance: D(500) },
      });
      const error = await service
        .setStatus(caller, 'run-1', PayrollRunStatus.processed)
        .catch((e) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect(error.getResponse()).toMatchObject({
        code: 'PAYROLL_DRAFT_STALE',
      });
      expect(advances.applyRecovery).not.toHaveBeenCalled();
    });
  });

  describe('F4 — only the claims the run carried are settled', () => {
    it('settles exactly the claim ids on the lines', async () => {
      const { service, reimbursements, prisma } = build();
      await service.setStatus(caller, 'run-1', PayrollRunStatus.processed);
      expect(reimbursements.settlePayrollClaims).toHaveBeenCalledWith(
        expect.anything(),
        ['claim-in-run'],
        'run-1',
      );
      // And no blanket update over the employee's other approved claims.
      expect(prisma.tx.reimbursementClaim.updateMany).toBeUndefined();
    });

    it('refuses the run when a carried claim was paid directly in the meantime', async () => {
      const { service, reimbursements } = build({
        claim: { status: 'paid', paymentMode: 'direct' },
      });
      await expect(
        service.setStatus(caller, 'run-1', PayrollRunStatus.processed),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(reimbursements.settlePayrollClaims).not.toHaveBeenCalled();
    });
  });

  describe('F5 — loan EMIs settled for this run only', () => {
    it("filters by the run's company and the employees whose line took an EMI", async () => {
      const { service, prisma } = build();
      await service.setStatus(caller, 'run-1', PayrollRunStatus.processed);
      const where = prisma.tx.loanScheduleEntry.findMany.mock.calls[0][0].where;
      expect(where.month).toBe('2026-09');
      expect(where.loan).toEqual({
        status: 'active',
        companyId: 'co-1',
        employeeId: { in: ['emp-1'] },
      });
    });

    it('settles no EMI when no line deducted one', async () => {
      const { service, prisma } = build({
        lines: [storedLine({ loanEmiDeduction: D(0) })],
      });
      await service.setStatus(caller, 'run-1', PayrollRunStatus.processed);
      expect(prisma.tx.loanScheduleEntry.findMany).not.toHaveBeenCalled();
    });
  });

  describe('F6 — paid only once approved', () => {
    it('refuses processed → paid while the approval is pending', async () => {
      const { service, prisma } = build({
        run: { status: PayrollRunStatus.processed },
        gate: { allowed: false, state: 'pending', levelLabel: 'Director' },
      });
      const error = await service
        .setStatus(caller, 'run-1', PayrollRunStatus.paid)
        .catch((e) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect(error.getResponse()).toMatchObject({
        code: 'PAYROLL_RUN_NOT_APPROVED',
      });
      expect(error.message).toMatch(/awaiting Director/);
      expect(prisma.tx.payrollRun.updateMany).not.toHaveBeenCalled();
    });

    it('refuses a run never submitted for approval', async () => {
      const { service } = build({
        run: { status: PayrollRunStatus.processed },
        gate: { allowed: false, state: null },
      });
      const error = await service
        .setStatus(caller, 'run-1', PayrollRunStatus.paid)
        .catch((e) => e);
      expect(error.getResponse()).toMatchObject({
        code: 'PAYROLL_RUN_NOT_SUBMITTED',
      });
    });

    it('marks an approved run paid with a conditional update', async () => {
      const { service, prisma } = build({
        run: { status: PayrollRunStatus.processed },
      });
      await service.setStatus(caller, 'run-1', PayrollRunStatus.paid);
      expect(prisma.tx.payrollRun.updateMany.mock.calls[0][0].where).toEqual({
        id: 'run-1',
        status: 'processed',
      });
    });
  });

  describe('F8 — server totals on each line', () => {
    it('adds gross and totalDeductions that reconcile to net pay', async () => {
      const { service } = build();
      const run = await service.getRun(caller, 'run-1');
      const line = run.lineItems[0];
      expect(line.gross.toString()).toBe('30500');
      expect(line.totalDeductions.toString()).toBe('3500');
      expect(line.gross.minus(line.totalDeductions).toNumber()).toBe(
        line.netPay.toNumber(),
      );
    });

    it('lineTotals counts fuel and advance among the deductions', () => {
      const totals = lineTotals(storedLine() as never);
      expect(totals.totalDeductions.toNumber()).toBe(200 + 1000 + 300 + 2000);
    });
  });
});

describe('findStaleRecoveries (036)', () => {
  const line = (o: Record<string, unknown> = {}) =>
    ({
      employeeId: 'emp-1',
      advanceRecovered: 1000,
      advanceRecoveryAdvanceId: 'adv-1',
      fuelRecoveries: [{ recoveryId: 'fuel-1', amount: 200 }],
      reimbursementClaimIds: ['c-1'],
      ...o,
    } as never);
  const current = (o: Record<string, unknown> = {}) =>
    ({
      advances: [
        { id: 'adv-1', status: 'disbursed', outstandingBalance: 1000 },
      ],
      fuel: [
        { id: 'fuel-1', status: 'approved', amount: 500, recoveredAmount: 300 },
      ],
      claims: [{ id: 'c-1', status: 'approved', paymentMode: 'payroll' }],
      ...o,
    } as never);

  it('passes a draft that still matches', () => {
    expect(findStaleRecoveries([line()], current())).toEqual([]);
  });

  it('flags an advance closed since the draft', () => {
    const stale = findStaleRecoveries(
      [line()],
      current({
        advances: [{ id: 'adv-1', status: 'closed', outstandingBalance: 0 }],
      }),
    );
    expect(stale).toMatchObject([{ kind: 'advance', id: 'adv-1' }]);
  });

  it('flags a fuel recovery whose balance fell below the planned amount', () => {
    const stale = findStaleRecoveries(
      [line()],
      current({
        fuel: [
          {
            id: 'fuel-1',
            status: 'approved',
            amount: 500,
            recoveredAmount: 400,
          },
        ],
      }),
    );
    expect(stale).toMatchObject([{ kind: 'fuel_recovery', id: 'fuel-1' }]);
  });

  it('flags a reversed fuel recovery', () => {
    const stale = findStaleRecoveries(
      [line()],
      current({
        fuel: [
          { id: 'fuel-1', status: 'reversed', amount: 500, recoveredAmount: 0 },
        ],
      }),
    );
    expect(stale).toMatchObject([{ kind: 'fuel_recovery' }]);
  });

  it('flags a withdrawn claim', () => {
    const stale = findStaleRecoveries(
      [line()],
      current({
        claims: [{ id: 'c-1', status: 'withdrawn', paymentMode: 'payroll' }],
      }),
    );
    expect(stale).toMatchObject([{ kind: 'reimbursement', id: 'c-1' }]);
  });

  it('tolerates sub-paisa floating error', () => {
    expect(
      findStaleRecoveries([line({ advanceRecovered: 1000.001 })], current()),
    ).toEqual([]);
  });
});
