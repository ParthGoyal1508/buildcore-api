import { Prisma } from '@prisma/client';

import { LetterRecordSources } from '../../letters/letter-record-sources';
import {
  EmployeeLetterSource,
  joinAddress,
  pronounsOf,
  salutationOf,
} from './employee-letter-source';

/**
 * The `employee` record letters pre-fill from (2026-10-13).
 *
 * The keys are the contract with the letter templates: a template's field reads
 * `revision.ctc`, and a record that names it `revisedCtc` pre-fills a blank that nobody
 * notices until a letter goes out without a salary. So the assertions name exact keys.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
const D = (n: number) => new Prisma.Decimal(n);

const EMPLOYEE = {
  id: 'e-1',
  companyId: 'co-1',
  siteId: 'site-a',
  employeeCode: 'PRPL-0007',
  firstName: 'Mohit',
  lastName: 'Chaudhary',
  title: null,
  fatherName: 'Rajesh Chaudhary',
  gender: 'male',
  designationId: 'des-1',
  departmentId: 'dep-1',
  dateOfJoining: new Date('2025-04-01'),
  reportingToEmployeeId: 'e-boss',
  employmentType: 'full_time',
  mobile: '9876543210',
  email: 'mohit@example.com',
  permanentAddress: '12 Civil Lines',
  permanentCity: 'Meerut',
  permanentState: 'Uttar Pradesh',
  permanentPinCode: '250001',
  presentAddress: null,
  presentCity: null,
  presentState: null,
  presentPinCode: null,
  basic: D(20000),
  hra: D(8000),
  conveyanceAllowance: D(1600),
  siteAllowance: D(2400),
  specialAllowance: D(0),
  pfApplicable: false,
  pfUpperLimit: false,
  esicApplicable: false,
  esicUpperLimit: false,
  hoursPerDay: null,
  uan: '100200300400',
  bankAccountNumberEncrypted: 'cipher',
};

function harness(
  over: {
    revision?: any;
    assignments?: any[];
    exit?: any;
    fnfThrows?: boolean;
  } = {},
) {
  const tx: any = {
    employee: {
      findFirst: jest.fn(async (args: any) =>
        args.where.id === 'e-1'
          ? EMPLOYEE
          : args.where.id === 'e-boss'
          ? {
              id: 'e-boss',
              employeeCode: 'PRPL-0001',
              firstName: 'Sunil',
              lastName: 'Agarwal',
              mobile: '9000000001',
            }
          : null,
      ),
    },
    salaryRevision: { findFirst: jest.fn(async () => over.revision ?? null) },
    employeeLocationAssignment: {
      findMany: jest.fn(async () => over.assignments ?? []),
    },
    exitRecord: { findFirst: jest.fn(async () => over.exit ?? null) },
    $executeRaw: jest.fn(),
  };
  const prisma: any = {
    $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
  };
  const referenceData: any = {
    findAll: jest.fn(async (resource: string) =>
      resource === 'designation'
        ? [{ id: 'des-1', name: 'Project Manager' }]
        : [{ id: 'dep-1', name: 'Projects' }],
    ),
  };
  const companies: any = {
    getPayrollRates: jest.fn(async () => ({
      pfEmployerRate: 12,
      esicEmployerRate: 3.25,
      gratuityRate: 4.81,
      bonusRate: 8.33,
      otMultiplier: 2,
    })),
  };
  const SITES: Record<string, any> = {
    'site-a': { id: 'site-a', name: 'Medshi Yard', projectId: 'p-a' },
    'site-b': { id: 'site-b', name: 'Washim Camp', projectId: 'p-b' },
  };
  const sites: any = {
    getSiteById: jest.fn(async (_ctx: unknown, id: string) => SITES[id]),
  };
  const PROJECTS: Record<string, string> = {
    'p-a': 'Medshi–Washim Road',
    'p-b': 'Washim Bypass',
  };
  const projects: any = {
    getProjectIdentityById: jest.fn(async (id: string) => ({
      id,
      code: id,
      name: PROJECTS[id],
    })),
  };
  const pii: any = { decrypt: jest.fn(() => '001122334455') };
  const fnf: any = {
    compute: jest.fn(async () => {
      if (over.fnfThrows) throw new Error('clearance open');
      return {
        employeeId: 'e-1',
        lastWorkingDay: '2026-09-15',
        period: '2026-09',
        pendingSalary: 16000,
        leaveEncashment: {
          balanceDays: 5,
          dailyRate: 1066.67,
          amount: 5333.35,
        },
        loanRecovery: 2000,
        advanceRecovery: 500,
        statutoryDeductions: 200,
        netPayable: 18633.35,
        warnings: [],
      };
    }),
  };
  const config: any = {
    get: () => ({
      standardHoursPerDay: 8,
      statutory: {
        pf: {
          employeeRatePercent: 12,
          wageCeiling: 15000,
          epsRatePercent: 8.33,
          edliRatePercent: 0.5,
          adminChargesPercent: 0.5,
        },
        esic: { employeeRatePercent: 0.75, wageCeiling: 21000 },
        professionalTaxSlabs: [{ upToMonthlyGross: null, monthlyAmount: 200 }],
      },
    }),
  };
  const registry = new LetterRecordSources();
  const source = new EmployeeLetterSource(
    prisma,
    registry,
    referenceData,
    companies,
    sites,
    projects,
    pii,
    fnf,
    config,
  );
  return { source, registry, fnf, pii };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const caller = {
  id: 'u-1',
  companyId: 'co-1',
  permissions: [],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

describe('EmployeeLetterSource', () => {
  it('registers itself as the employee record on init', async () => {
    const { source, registry } = harness();
    source.onModuleInit();
    const record = await registry.resolve(caller, 'employee', 'e-1');
    expect(record?.fullName).toBe('Mohit Chaudhary');
  });

  it('answers null for an employee the caller cannot see', async () => {
    const { source } = harness();
    await expect(source.record(caller, 'e-nobody')).resolves.toBeNull();
  });

  it('states who the employee is, in the contract’s keys', async () => {
    const { source } = harness();
    const r = (await source.record(caller, 'e-1'))!;

    expect(r).toEqual(
      expect.objectContaining({
        fullName: 'Mohit Chaudhary',
        salutation: 'Mr.',
        fatherName: 'Rajesh Chaudhary',
        employeeCode: 'PRPL-0007',
        email: 'mohit@example.com',
        phone: '9876543210',
        address: '12 Civil Lines, Meerut, Uttar Pradesh - 250001',
        designation: 'Project Manager',
        department: 'Projects',
        siteName: 'Medshi Yard',
        projectName: 'Medshi–Washim Road',
        placeOfPosting: 'Medshi–Washim Road',
        reportingManager: 'Sunil Agarwal',
        reportingManagerMobile: '9000000001',
        pronounSubject: 'he',
        pronounObject: 'him',
        pronounPossessive: 'his',
      }),
    );
    expect(r.dateOfJoining).toEqual(new Date('2025-04-01'));
  });

  it('states the pay monthly and annually, with CTC in words', async () => {
    const { source } = harness();
    const r = (await source.record(caller, 'e-1'))!;

    // No PF or ESI applies to this employee, so CTC is the gross.
    expect(String(r.gross)).toBe('32000');
    expect(String(r.grossAnnual)).toBe('384000');
    expect(String(r.conveyance)).toBe('1600');
    expect(String(r.pfEmployer)).toBe('0');
    expect(String(r.ctc)).toBe('32000');
    expect(r.ctcInWords).toBe('Rupees Thirty Two Thousand Only');
    expect(r.ctcAnnualLakh).toBe('3.84 Lakh');
  });

  it('leaves out revision, transfer, exit and F&F when there are none', async () => {
    const { source, fnf } = harness();
    const r = (await source.record(caller, 'e-1'))!;
    expect(r.revision).toBeUndefined();
    expect(r.transfer).toBeUndefined();
    expect(r.exit).toBeUndefined();
    expect(r.fnf).toBeUndefined();
    expect(fnf.compute).not.toHaveBeenCalled();
  });

  it('reads the latest salary revision', async () => {
    const { source } = harness({
      revision: {
        effectiveFrom: new Date('2026-10-01'),
        basic: D(25000),
        hra: D(10000),
        conveyance: D(1600),
        siteAllowance: D(2400),
        specialAllowance: D(1000),
        previousBasic: D(20000),
        previousHra: D(8000),
        previousConveyance: D(1600),
        previousSiteAllowance: D(2400),
        previousSpecialAllowance: null,
      },
    });
    const r = (await source.record(caller, 'e-1'))! as any; // eslint-disable-line @typescript-eslint/no-explicit-any

    expect(r.revision.effectiveFrom).toEqual(new Date('2026-10-01'));
    expect(String(r.revision.ctc)).toBe('40000');
    expect(r.revision.ctcInWords).toBe('Rupees Forty Thousand Only');
    expect(String(r.revision.previousCtc)).toBe('32000');
  });

  it('names a transfer’s destination and where they came from', async () => {
    const { source } = harness({
      assignments: [
        {
          siteId: 'site-b',
          isMobile: false,
          effectiveFrom: new Date('2026-10-05'),
        },
        {
          siteId: 'site-a',
          isMobile: false,
          effectiveFrom: new Date('2026-01-01'),
        },
      ],
    });
    const r = (await source.record(caller, 'e-1'))! as any; // eslint-disable-line @typescript-eslint/no-explicit-any

    expect(r.transfer).toEqual({
      toSite: 'Washim Camp',
      toProject: 'Washim Bypass',
      effectiveFrom: new Date('2026-10-05'),
      fromProject: 'Medshi–Washim Road',
    });
  });

  it('maps the exit and the F&F computation, keeping only the last four bank digits', async () => {
    const { source } = harness({
      exit: { lastWorkingDay: new Date('2026-09-15'), reason: 'resignation' },
    });
    const r = (await source.record(caller, 'e-1'))! as any; // eslint-disable-line @typescript-eslint/no-explicit-any

    expect(r.exit).toEqual({
      lastWorkingDay: new Date('2026-09-15'),
      reason: 'Resignation',
    });
    expect(r.fnf.salaryDays).toBe(15);
    expect(String(r.fnf.totalPayable)).toBe('21333.35');
    expect(String(r.fnf.totalDeductions)).toBe('2700');
    expect(String(r.fnf.net)).toBe('18633.35');
    expect(r.fnf.netInWords).toBe(
      'Rupees Eighteen Thousand Six Hundred Thirty Three and Thirty Five Paise Only',
    );
    expect(r.fnf.payrollPeriod).toBe('September 2026');
    expect(r.fnf.bankLast4).toBe('4455');
    expect(r.fnf.uan).toBe('100200300400');
    expect(r.fnf.employmentType).toBe('Full time');
    // What the computation does not produce is absent, not zero.
    expect(r.fnf).not.toHaveProperty('gratuity');
    expect(JSON.stringify(r)).not.toContain('001122334455');
  });

  it('still pre-fills the rest when the F&F computation refuses', async () => {
    const { source } = harness({
      exit: { lastWorkingDay: new Date('2026-09-15'), reason: 'termination' },
      fnfThrows: true,
    });
    const r = (await source.record(caller, 'e-1'))!;
    expect(r.exit).toEqual(expect.objectContaining({ reason: 'Termination' }));
    expect(r.fnf).toBeUndefined();
    expect(r.fullName).toBe('Mohit Chaudhary');
  });
});

describe('employee letter helpers', () => {
  it('salutation: title wins, else gender, else nothing', () => {
    expect(salutationOf('Dr', 'male')).toBe('Dr.');
    expect(salutationOf(null, 'female')).toBe('Ms.');
    expect(salutationOf(null, null)).toBe('');
  });

  it('pronouns default to they/them/their', () => {
    expect(pronounsOf(null)).toEqual({
      pronounSubject: 'they',
      pronounObject: 'them',
      pronounPossessive: 'their',
    });
  });

  it('address skips the parts that are missing', () => {
    expect(joinAddress('Line 1', null, 'UP', null)).toBe('Line 1, UP');
    expect(joinAddress(null, null, null, '250001')).toBe('250001');
  });
});
