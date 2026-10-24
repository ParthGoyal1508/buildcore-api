import { Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import type { Caller } from '../../hr/biometrics/face-enrolment.service';
import { PayrollRegisterService } from './payroll-register.service';

const d = (n: number) => new Prisma.Decimal(n);
const line = (employeeId: string, branchId: string | null, netPay: number) => ({
  employeeId,
  branchId,
  projectId: null,
  payableDays: d(30),
  lopDays: d(0),
  basic: d(netPay),
  hra: d(0),
  conveyanceAllowance: d(0),
  siteAllowance: d(0),
  specialAllowance: d(0),
  otWages: d(0),
  employeePf: d(0),
  employeeEsic: d(0),
  professionalTax: d(0),
  tds: d(0),
  loanEmiDeduction: d(0),
  netPay: d(netPay),
});
const employee = (id: string, branchId: string) => ({
  id,
  branchId,
  employeeCode: id.toUpperCase(),
  firstName: id,
  lastName: null,
  designationId: null,
  departmentId: null,
  siteId: 'site-1',
});

describe('PayrollRegisterService — salary register by branch (041)', () => {
  const tx = {
    $executeRaw: jest.fn(),
    payrollRun: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'run-1',
        period: '2026-09',
        status: 'processed',
        lineItems: [
          line('e1', 'haryana', 1000),
          line('e2', 'rajasthan', 2000),
          // Generated before branches were recorded: falls back to the employee's branch.
          line('e3', null, 4000),
        ],
      }),
    },
    employee: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          employee('e1', 'haryana'),
          employee('e2', 'rajasthan'),
          employee('e3', 'haryana'),
        ]),
    },
  };
  const prisma = {
    $transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
  } as unknown as PrismaService;
  const caller = { rls: { companyId: 'co-1' } } as unknown as Caller;
  const service = new PayrollRegisterService(prisma);

  it('keeps only the branch’s lines, reading an unrecorded line’s branch off the employee', async () => {
    const register = await service.salaryRegister(caller, 'run-1', {
      branchId: 'haryana',
    });
    expect(register.rows.map((r) => r.employeeCode)).toEqual(['E1', 'E3']);
    expect(register.totals.netPay).toBe(5000);
    // A branch is a subset of the run, so it is not reconciled against the run's total.
    expect(register.filtered).toBe(true);
    expect(register.reconciliation.ok).toBe(true);
  });

  it('shows the whole run without a branch', async () => {
    const register = await service.salaryRegister(caller, 'run-1');
    expect(register.rows).toHaveLength(3);
    expect(register.filtered).toBe(false);
  });
});
