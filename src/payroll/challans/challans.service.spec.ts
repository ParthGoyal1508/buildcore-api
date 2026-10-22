import { Prisma } from '@prisma/client';
import { ChallansService } from './challans.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

const D = (n: number) => new Prisma.Decimal(n);
const caller = { rls: { isSuperAdmin: true } } as never;

/** A processed PF line for one employee, filed under `branchId`. */
const line = (employeeId: string, branchId: string, basic: number) => ({
  employeeId,
  branchId,
  basic: D(basic),
  hra: D(0),
  conveyanceAllowance: D(0),
  siteAllowance: D(0),
  specialAllowance: D(0),
  otWages: D(0),
  employeePf: D(basic * 0.12),
  employerPf: D(basic * 0.0367),
  employerEps: D(basic * 0.0833),
  employerEdli: D(basic * 0.005),
  adminCharges: D(basic * 0.005),
  employeeEsic: D(0),
  employerEsic: D(0),
  professionalTax: D(0),
});

const employee = (id: string, code: string) => ({
  id,
  employeeCode: code,
  firstName: code,
  lastName: '',
  pfApplicable: true,
  esicApplicable: false,
  uan: `UAN-${code}`,
  esicNumber: null,
});

const BRANCHES: Record<string, Record<string, unknown>> = {
  'b-rj': {
    branchId: 'b-rj',
    city: 'Deoli',
    state: 'Rajasthan',
    pfEstablishmentCode: 'RJRAJ1296202',
  },
  'b-hr': {
    branchId: 'b-hr',
    city: 'Rewari',
    state: 'Haryana',
    pfEstablishmentCode: 'RJRAJ1296203',
  },
  'b-mp': {
    branchId: 'b-mp',
    city: 'Mandsaur',
    state: 'Madhya Pradesh',
    pfEstablishmentCode: null,
  },
};

function build() {
  const run = {
    status: 'processed',
    lineItems: [
      line('e-a', 'b-rj', 20000),
      line('e-c', 'b-rj', 15000),
      // B moved to Rajasthan after this month was processed; the line still says Haryana.
      line('e-b', 'b-hr', 18000),
    ],
  };
  const employees = [
    employee('e-a', 'A'),
    employee('e-b', 'B'),
    employee('e-c', 'C'),
  ];
  const tx = {
    $executeRaw: jest.fn(),
    payrollRun: { findFirst: jest.fn(async () => run) },
    employee: {
      findMany: jest.fn(async ({ where }: any) =>
        employees.filter((e) => where.id.in.includes(e.id)),
      ),
    },
  };
  const prisma = { $transaction: jest.fn(async (fn: any) => fn(tx)) };
  const companies = {
    assertActiveBranch: jest.fn(async () => undefined),
    getBranchIdentity: jest.fn(async (_c: string, id: string) => BRANCHES[id]),
  };
  return new ChallansService(prisma as never, companies as never);
}

describe('ChallansService per establishment (041)', () => {
  it('lists only the branch’s lines, under its PF establishment code', async () => {
    const view = await build().get(caller, 'te', 'pf', '2026-09', 'b-hr');
    expect(view.rows.map((r) => r.employeeCode)).toEqual(['B']);
    expect(view.branch).toEqual({
      id: 'b-hr',
      label: 'Rewari (Haryana)',
      establishmentCode: 'RJRAJ1296203',
    });
    expect(view.warnings).toEqual([]);
  });

  it('adds up, branch by branch, to the company total', async () => {
    const service = build();
    const all = await service.get(caller, 'te', 'pf', '2026-09');
    const rj = await service.get(caller, 'te', 'pf', '2026-09', 'b-rj');
    const hr = await service.get(caller, 'te', 'pf', '2026-09', 'b-hr');
    expect(rj.totals.total + hr.totals.total).toBeCloseTo(all.totals.total, 2);
    expect(all.branch).toBeNull();
  });

  it('produces a branch with no code, and says so', async () => {
    const view = await build().get(caller, 'te', 'pf', '2026-09', 'b-mp');
    expect(view.rows).toEqual([]);
    expect(view.branch?.establishmentCode).toBeNull();
    expect(view.warnings[0]).toMatch(
      /No PF establishment code is recorded for Mandsaur/,
    );
  });

  it('names the branch in the exported file', async () => {
    const { filename } = await build().export(
      caller,
      'te',
      'pf',
      '2026-09',
      'b-hr',
    );
    expect(filename).toBe('pf-challan-2026-09-rewari-haryana.xlsx');
  });
});
