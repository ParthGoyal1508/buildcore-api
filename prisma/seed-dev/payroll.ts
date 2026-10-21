/**
 * Payroll completion module: income-tax slabs, staff loans and salary advances, and the months of
 * payroll history a company running BuildCore since the start of the financial year would have.
 *
 * **Every figure is the application's own.** The runs are not hand-rolled rows: this module boots
 * the API's Nest container (`NestFactory.createApplicationContext(AppModule)`) against the same
 * DATABASE_URL and drives the real services in the order the office would have — generate the run
 * on the 1st, process it, take it through its approval chain, produce the bank sheet, mark it paid,
 * upload the bank's returned sheet. Loans and advances go through `LoansService` and
 * `SalaryAdvancesService` with a maker and a different checker, so the payroll engine deducts
 * them, settles them and closes them itself. Each step's timestamps are then moved back to the day
 * it would have happened, so the history reads as months of use rather than one afternoon.
 *
 * What it needs from earlier modules: PAN and bank particulars on the employees (the `hr` module).
 * Without a PAN every employee would be taxed at the penal no-PAN rate and every bank sheet would
 * be empty, so the history is skipped (slabs are still written) when no employee has either.
 *
 * Staff attendance before the base seed's last month is backfilled from the start of the financial
 * year — the engine computes payable days from punches, and a run over a month with no punches is
 * a month of loss of pay for everyone.
 */
import type { INestApplicationContext } from '@nestjs/common';
import {
  ApprovalDecisionAction,
  PayrollRunStatus,
  Prisma,
  PunchType,
  TaxRegime,
} from '@prisma/client';

import type { ApprovalService } from '../../src/approvals/approvals.service';
import type { AuthenticatedUser } from '../../src/auth/authenticated-user';
import type { Caller } from '../../src/hr/biometrics/face-enrolment.service';
import type { PiiCipherService } from '../../src/hr/employees/pii-cipher.service';
import type { SalaryAdvancesService } from '../../src/payroll/advances/salary-advances.service';
import type { PayrollEngineService } from '../../src/payroll/engine/payroll-engine.service';
import type { LoansService } from '../../src/payroll/loans/loans.service';
import type { BankSheetService } from '../../src/payroll/runs/bank-sheet.service';
import type { PayrollScheduleService } from '../../src/payroll/runs/payroll-schedule.service';
import type { TransactionSheetService } from '../../src/payroll/runs/transaction-sheet.service';
import {
  financialYearOf as taxYearOf,
  validateSlabs,
  type TaxSlabBand,
} from '../../src/payroll/tds/tds-computation';
import { at, d, type CompanyContext, type ModuleResult } from './support';

// ─── Tax slabs ────────────────────────────────────────────────────────────────

/** Section 115BAC as amended by the Finance Act 2025 — unchanged for FY 2026-27. */
const NEW_REGIME: TaxSlabBand[] = [
  { lowerBound: 0, upperBound: 400_000, ratePercent: 0 },
  { lowerBound: 400_000, upperBound: 800_000, ratePercent: 5 },
  { lowerBound: 800_000, upperBound: 1_200_000, ratePercent: 10 },
  { lowerBound: 1_200_000, upperBound: 1_600_000, ratePercent: 15 },
  { lowerBound: 1_600_000, upperBound: 2_000_000, ratePercent: 20 },
  { lowerBound: 2_000_000, upperBound: 2_400_000, ratePercent: 25 },
  { lowerBound: 2_400_000, upperBound: null, ratePercent: 30 },
];

/** The old regime, individuals below 60. */
const OLD_REGIME: TaxSlabBand[] = [
  { lowerBound: 0, upperBound: 250_000, ratePercent: 0 },
  { lowerBound: 250_000, upperBound: 500_000, ratePercent: 5 },
  { lowerBound: 500_000, upperBound: 1_000_000, ratePercent: 20 },
  { lowerBound: 1_000_000, upperBound: null, ratePercent: 30 },
];

async function seedTaxSlabs(ctx: CompanyContext): Promise<number> {
  const fyStart = fyStartYear(ctx.today);
  let created = 0;
  // The year just closed too: Form 16 and the quarterly return for it read the same table.
  for (const startYear of [fyStart - 1, fyStart]) {
    const financialYear = taxYearOf(startYear, 4);
    for (const [regime, bands] of [
      [TaxRegime.new, NEW_REGIME],
      [TaxRegime.old, OLD_REGIME],
    ] as const) {
      const problem = validateSlabs(bands);
      if (problem) throw new Error(`Tax slabs invalid: ${problem}`);
      const existing = await ctx.prisma.taxSlab.count({
        where: { companyId: ctx.company.id, financialYear, regime },
      });
      if (existing > 0) continue;
      const res = await ctx.prisma.taxSlab.createMany({
        data: bands.map((b) => ({
          companyId: ctx.company.id,
          financialYear,
          regime,
          lowerBound: b.lowerBound,
          upperBound: b.upperBound,
          ratePercent: b.ratePercent,
        })),
        skipDuplicates: true,
      });
      created += res.count;
    }
  }
  return created;
}

// ─── Dates ────────────────────────────────────────────────────────────────────

const fyStartYear = (day: Date) =>
  day.getUTCMonth() >= 3 ? day.getUTCFullYear() : day.getUTCFullYear() - 1;

const periodKey = (y: number, m: number) =>
  `${y}-${String(m).padStart(2, '0')}`;

const addDays = (day: Date, n: number) => {
  const t = new Date(day);
  t.setUTCDate(t.getUTCDate() + n);
  return t;
};

/** The day itself, or the Monday after it when it falls on a Sunday. */
const workday = (day: Date) => (day.getUTCDay() === 0 ? addDays(day, 1) : day);

const isoDay = (day: Date) => day.toISOString().slice(0, 10);

// ─── Staff attendance backfill ────────────────────────────────────────────────

/**
 * Punches from the start of the financial year up to the day before the earliest punch already
 * recorded for the company, so earlier months are not read as absence. Sundays (the site's weekly
 * off) and company holidays are left unpunched, as is the odd day off.
 */
async function backfillAttendance(ctx: CompanyContext): Promise<number> {
  const { prisma, company } = ctx;
  const employees = await prisma.employee.findMany({
    where: { companyId: company.id, isActive: true },
    orderBy: { employeeCode: 'asc' },
  });
  if (employees.length === 0) return 0;

  const earliest = await prisma.punchRecord.findFirst({
    where: { employeeId: { in: employees.map((e) => e.id) } },
    orderBy: { punchDate: 'asc' },
    select: { punchDate: true },
  });
  const from = d(`${fyStartYear(ctx.today)}-04-01`);
  const until = earliest
    ? addDays(earliest.punchDate, -1)
    : addDays(ctx.today, -1);
  if (until < from) return 0;

  const [sites, shifts, holidays] = await Promise.all([
    prisma.site.findMany({
      where: { id: { in: [...new Set(employees.map((e) => e.siteId))] } },
      select: { id: true, weeklyOffDay: true, latitude: true, longitude: true },
    }),
    prisma.shift.findMany({ where: { companyId: company.id } }),
    prisma.holiday.findMany({
      where: { companyId: company.id, date: { gte: from, lte: until } },
      select: { date: true },
    }),
  ]);
  const siteOf = new Map(sites.map((s) => [s.id, s]));
  const shiftOf = new Map(shifts.map((s) => [s.id, s]));
  const holidaySet = new Set(holidays.map((h) => isoDay(h.date)));
  // IST minutes since midnight of a `@db.Time` stored in UTC.
  const istMinutes = (t: Date) =>
    (t.getUTCHours() * 60 + t.getUTCMinutes() + 330) % 1440;

  const rows: Prisma.PunchRecordCreateManyInput[] = [];
  for (const e of employees) {
    const site = siteOf.get(e.siteId);
    const shift = shiftOf.get(e.shiftId);
    const start = shift ? istMinutes(shift.inTime) : 9 * 60;
    const end = shift ? istMinutes(shift.outTime) : 18 * 60;
    const isSiteShift = start < 9 * 60;
    for (let day = from; day <= until; day = addDays(day, 1)) {
      if (e.dateOfJoining && day < e.dateOfJoining) continue;
      if (day.getUTCDay() === (site?.weeklyOffDay ?? 0)) continue;
      if (holidaySet.has(isoDay(day))) continue;
      if (ctx.rng.rand() < 0.025) continue; // a day off without leave: loss of pay
      const inMin = start - 12 + ctx.rng.int(0, 27);
      let outMin = end - 5 + ctx.rng.int(0, 40);
      // Site staff stay back when a pour or a lay runs late.
      if (isSiteShift && ctx.rng.rand() < 0.1) outMin += ctx.rng.int(60, 120);
      const day10 = isoDay(day);
      for (const [type, minute] of [
        [PunchType.in, inMin],
        [PunchType.out, outMin],
      ] as const) {
        const capturedAt = at(day, Math.floor(minute / 60), minute % 60);
        rows.push({
          employeeId: e.id,
          type,
          capturedAt,
          receivedAt: capturedAt,
          createdAt: capturedAt,
          punchDate: day,
          latitude: site?.latitude ?? null,
          longitude: site?.longitude ?? null,
          geofenceResult: 'in_range',
          faceMatchResult: 'matched',
          photoRef: `punches/${e.id}/${day10}-${type}.jpg`,
        });
      }
    }
  }
  for (let i = 0; i < rows.length; i += 1000) {
    await prisma.punchRecord.createMany({ data: rows.slice(i, i + 1000) });
  }
  return rows.length;
}

// ─── The office, as callers ───────────────────────────────────────────────────

interface Actor {
  userId: string;
  roleIds: string[];
}

const OFFICE_IP = '10.20.1.15';

function callerOf(actor: Actor, companyId: string): Caller {
  return {
    userId: actor.userId,
    companyId,
    ipAddress: OFFICE_IP,
    rls: { isSuperAdmin: false, companyId },
    roleIds: actor.roleIds,
  };
}

/** The `AuthenticatedUser` the approval spine reads: id, roles and the company acted in. */
function approverOf(actor: Actor, companyId: string): AuthenticatedUser {
  return {
    id: actor.userId,
    companyId,
    permissions: [],
    roleIds: actor.roleIds,
    roleNames: [],
    grants: [],
  } as unknown as AuthenticatedUser;
}

/** Users of this company holding the role mapped to an approval slot, by username. */
async function slotHolders(
  ctx: CompanyContext,
  slotKey: string,
): Promise<Actor[]> {
  const mapping = await ctx.prisma.roleSlotMapping.findUnique({
    where: { companyId_slotKey: { companyId: ctx.company.id, slotKey } },
  });
  if (!mapping) return [];
  const users = await ctx.prisma.user.findMany({
    where: {
      companyId: ctx.company.id,
      userRoles: { some: { roleId: mapping.roleId } },
    },
    orderBy: { username: 'asc' },
    select: { id: true, userRoles: { select: { roleId: true } } },
  });
  return users.map((u) => ({
    userId: u.id,
    roleIds: u.userRoles.map((r) => r.roleId),
  }));
}

// ─── Loans and advances ───────────────────────────────────────────────────────

interface LoanPlan {
  code: string;
  amount: number;
  emi: number;
  reason: string;
  created: string;
  disbursed: string;
}

interface AdvancePlan {
  code: string;
  amount: number;
  reason: string;
  created: string;
  recoveryMonth: string;
  approved: boolean;
}

/** By company short code; employees are named by their code's sequence number. */
const LOANS: Record<string, LoanPlan[]> = {
  PRPL: [
    {
      code: '0011',
      amount: 25_000,
      emi: 5_000,
      reason: "Mother's cataract surgery at Tonk district hospital",
      created: '2026-03-10',
      disbursed: '2026-03-12',
    },
    {
      code: '0003',
      amount: 120_000,
      emi: 10_000,
      reason: 'Two-wheeler for site travel between Deva Khera and Dhor camps',
      created: '2026-05-06',
      disbursed: '2026-05-08',
    },
  ],
  TE: [
    {
      code: '0008',
      amount: 60_000,
      emi: 7_500,
      reason: 'House roof repair after pre-monsoon storm damage',
      created: '2026-04-13',
      disbursed: '2026-04-15',
    },
    {
      code: '0009',
      amount: 40_000,
      emi: 4_000,
      reason: "Daughter's B.Sc. admission fees, Gurugram",
      created: '2026-07-17',
      disbursed: '2026-07-20',
    },
  ],
};

const ADVANCES: Record<string, AdvancePlan[]> = {
  PRPL: [
    {
      code: '0009',
      amount: 15_000,
      reason: "Younger sister's wedding expenses",
      created: '2026-06-10',
      recoveryMonth: '2026-06',
      approved: true,
    },
    {
      code: '0012',
      amount: 10_000,
      reason: "Father's hospital bills, Jaipur",
      created: '2026-08-03',
      recoveryMonth: '2026-08',
      approved: true,
    },
    {
      code: '0008',
      amount: 20_000,
      reason: "Children's half-yearly school fees",
      created: '2026-10-06',
      recoveryMonth: '2026-10',
      approved: true,
    },
  ],
  TE: [
    {
      code: '0007',
      amount: 12_000,
      reason: 'Festival advance — Raksha Bandhan travel home',
      created: '2026-07-14',
      recoveryMonth: '2026-07',
      approved: true,
    },
    {
      code: '0010',
      amount: 8_000,
      reason: "Medical emergency — wife's admission at Sitapur",
      created: '2026-09-02',
      recoveryMonth: '2026-09',
      approved: true,
    },
    {
      code: '0011',
      amount: 10_000,
      reason: 'Diwali advance',
      created: '2026-10-16',
      recoveryMonth: '2026-11',
      approved: false,
    },
  ],
};

// ─── The module ───────────────────────────────────────────────────────────────

interface Services {
  engine: PayrollEngineService;
  schedule: PayrollScheduleService;
  approvals: ApprovalService;
  bankSheet: BankSheetService;
  transactionSheet: TransactionSheetService;
  loans: LoansService;
  advances: SalaryAdvancesService;
  pii: PiiCipherService;
}

interface TimedStep {
  when: Date;
  label: string;
  run: () => Promise<void>;
}

export async function seedPayroll(ctx: CompanyContext): Promise<ModuleResult> {
  const result: ModuleResult = {};
  const slabs = await seedTaxSlabs(ctx);
  if (slabs) result['tax slabs'] = slabs;

  const { prisma, company } = ctx;
  // History already written? The history always starts with April, so a finalised April run is
  // the marker. (Not "any finalised run": somebody processing September by hand on the develop
  // database must not stop April–August from being filled in; that month itself is left alone.)
  const finalised = await prisma.payrollRun.count({
    where: {
      companyId: company.id,
      period: `${ctx.fy.slice(0, 4)}-04`,
      isFnf: false,
      status: { in: [PayrollRunStatus.processed, PayrollRunStatus.paid] },
    },
  });
  if (finalised > 0) return result;

  const [withPan, withBank] = await Promise.all([
    prisma.employee.count({
      where: {
        companyId: company.id,
        isActive: true,
        panEncrypted: { not: null },
      },
    }),
    prisma.employee.count({
      where: {
        companyId: company.id,
        isActive: true,
        bankAccountNumberEncrypted: { not: null },
      },
    }),
  ]);
  if (withPan === 0 || withBank === 0) {
    console.warn(
      `  ${company.shortCode}: no employee has a PAN or bank account on file (run the hr ` +
        `module first) — payroll history skipped.`,
    );
    return result;
  }

  const [firsts, hrs, finals] = await Promise.all([
    slotHolders(ctx, 'first_approver'),
    slotHolders(ctx, 'hr'),
    slotHolders(ctx, 'final'),
  ]);
  if (!firsts.length || !hrs.length || !finals.length) {
    console.warn(
      `  ${company.shortCode}: the payroll approval slots are not all mapped to a user — ` +
        `payroll history skipped.`,
    );
    return result;
  }
  // The HR executive who runs payroll, and a different Head Office approver where there is one.
  const maker = hrs[0];
  const hrApprover = hrs[1] ?? hrs[0];
  const firstApprover = firsts[0];
  const director = finals[0];

  // The company's salary account, if nobody has entered it: every bank sheet row names it.
  const co = await prisma.company.findUnique({
    where: { id: company.id },
    select: { payrollDebitAccountNumber: true },
  });
  if (!co?.payrollDebitAccountNumber?.trim()) {
    await prisma.company.update({
      where: { id: company.id },
      data: {
        payrollDebitAccountNumber:
          company.shortCode === 'TE' ? '50200041876321' : '39280200000817',
      },
    });
    result['payroll debit account'] = 1;
  }

  result['attendance punches'] = await backfillAttendance(ctx);

  // Boot the API's own container: every figure below is computed by the services the API runs.
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../../src/app.module');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const services = await resolveServices(app);
    const counts = await buildHistory(ctx, services, {
      maker,
      hrApprover,
      firstApprover,
      director,
    });
    Object.assign(result, counts);
  } finally {
    await app.close();
  }
  return result;
}

async function resolveServices(
  app: INestApplicationContext,
): Promise<Services> {
  const [
    { PayrollEngineService },
    { PayrollScheduleService },
    { ApprovalService },
    { BankSheetService },
    { TransactionSheetService },
    { LoansService },
    { SalaryAdvancesService },
    { PiiCipherService },
  ] = await Promise.all([
    import('../../src/payroll/engine/payroll-engine.service'),
    import('../../src/payroll/runs/payroll-schedule.service'),
    import('../../src/approvals/approvals.service'),
    import('../../src/payroll/runs/bank-sheet.service'),
    import('../../src/payroll/runs/transaction-sheet.service'),
    import('../../src/payroll/loans/loans.service'),
    import('../../src/payroll/advances/salary-advances.service'),
    import('../../src/hr/employees/pii-cipher.service'),
  ]);
  return {
    engine: app.get(PayrollEngineService),
    schedule: app.get(PayrollScheduleService),
    approvals: app.get(ApprovalService),
    bankSheet: app.get(BankSheetService),
    transactionSheet: app.get(TransactionSheetService),
    loans: app.get(LoansService),
    advances: app.get(SalaryAdvancesService),
    pii: app.get(PiiCipherService),
  };
}

async function buildHistory(
  ctx: CompanyContext,
  s: Services,
  people: {
    maker: Actor;
    hrApprover: Actor;
    firstApprover: Actor;
    director: Actor;
  },
): Promise<ModuleResult> {
  const { prisma, company } = ctx;
  const companyId = company.id;
  const makerCaller = callerOf(people.maker, companyId);
  const directorCaller = callerOf(people.director, companyId);
  const steps: TimedStep[] = [];
  const counts: ModuleResult = {};
  const bump = (k: string, n = 1) => (counts[k] = (counts[k] ?? 0) + n);

  /** Moves the audit entries a step just wrote back to when the step happened. */
  const stampAudit = async (since: Date, when: Date, ids: string[]) => {
    await prisma.auditLogEntry.updateMany({
      where: { createdAt: { gte: since }, entityId: { in: ids } },
      data: { createdAt: when },
    });
  };
  const sinceNow = () => new Date(Date.now() - 5_000);

  const employees = await prisma.employee.findMany({
    where: { companyId },
    select: { id: true, employeeCode: true },
  });
  const byCode = new Map(employees.map((e) => [e.employeeCode, e.id]));
  const employeeFor = (seq: string) =>
    byCode.get(`${company.shortCode}-${seq}`);

  // ── Loans: recorded by HR, approved by the director ──
  for (const plan of LOANS[company.shortCode] ?? []) {
    const employeeId = employeeFor(plan.code);
    if (!employeeId) continue;
    const createdAt = at(d(plan.created), 11, 20);
    const approvedAt = at(workday(addDays(d(plan.created), 1)), 16, 5);
    steps.push({
      when: createdAt,
      label: `loan ${plan.code}`,
      run: async () => {
        const since = sinceNow();
        const loan = await s.loans.create(makerCaller, companyId, {
          employeeId,
          amount: plan.amount,
          emiAmount: plan.emi,
          disbursementDate: plan.disbursed,
          reason: plan.reason,
        });
        await prisma.loan.update({
          where: { id: loan.id },
          data: { createdAt, updatedAt: createdAt },
        });
        await stampAudit(since, createdAt, [loan.id]);
        const since2 = sinceNow();
        await s.loans.approve(directorCaller, loan.id);
        await prisma.loan.update({
          where: { id: loan.id },
          data: { updatedAt: approvedAt },
        });
        await stampAudit(since2, approvedAt, [loan.id]);
        bump('loans');
        bump('loan instalments', loan.instalments);
      },
    });
  }

  // ── Salary advances: recorded by HR, approved (and paid out) by the director ──
  for (const plan of ADVANCES[company.shortCode] ?? []) {
    const employeeId = employeeFor(plan.code);
    if (!employeeId) continue;
    const createdAt = at(d(plan.created), 10, 40);
    const approvedAt = at(d(plan.created), 15, 30);
    steps.push({
      when: createdAt,
      label: `advance ${plan.code}`,
      run: async () => {
        const since = sinceNow();
        const advance = await s.advances.create(makerCaller, companyId, {
          employeeId,
          amount: plan.amount,
          reason: plan.reason,
          recoveryMonth: plan.recoveryMonth,
        });
        await prisma.salaryAdvance.update({
          where: { id: advance.id },
          data: { createdAt, updatedAt: createdAt },
        });
        await stampAudit(since, createdAt, [advance.id]);
        if (plan.approved) {
          const since2 = sinceNow();
          await s.advances.approve(directorCaller, advance.id);
          await prisma.salaryAdvance.update({
            where: { id: advance.id },
            data: { updatedAt: approvedAt, disbursedOn: d(plan.created) },
          });
          await stampAudit(since2, approvedAt, [advance.id]);
        }
        bump('salary advances');
      },
    });
  }

  // ── Payroll runs, April to last month ──
  const fyStart = fyStartYear(ctx.today);
  const thisMonth = periodKey(
    ctx.today.getUTCFullYear(),
    ctx.today.getUTCMonth() + 1,
  );
  const periods: { period: string; firstOfNext: Date }[] = [];
  for (let i = 0; i < 12; i++) {
    const m = ((3 + i) % 12) + 1;
    const y = m >= 4 ? fyStart : fyStart + 1;
    const period = periodKey(y, m);
    if (period >= thisMonth) break;
    periods.push({
      period,
      firstOfNext: d(
        `${m === 12 ? y + 1 : y}-${String((m % 12) + 1).padStart(2, '0')}-01`,
      ),
    });
  }

  const runIds = new Map<string, string>();
  const bankFiles = new Map<string, Buffer>();

  for (const [index, { period, firstOfNext }] of periods.entries()) {
    const latest = index === periods.length - 1;
    const existing = await prisma.payrollRun.findFirst({
      where: { companyId, period, isFnf: false },
    });
    if (existing) {
      // A run somebody already started for this month (a draft) stays theirs: it is regenerated
      // once the history before it exists, so its TDS sees the slabs and the year to date.
      if (existing.status === PayrollRunStatus.draft) {
        steps.push({
          when: new Date(8.64e15),
          label: `regenerate ${period}`,
          run: async () => {
            const generator = existing.generatedByUserId
              ? await prisma.user.findUnique({
                  where: { id: existing.generatedByUserId },
                  select: { id: true, userRoles: { select: { roleId: true } } },
                })
              : null;
            const actor = generator
              ? {
                  userId: generator.id,
                  roleIds: generator.userRoles.map((r) => r.roleId),
                }
              : people.maker;
            await s.engine.generate(
              callerOf(actor, companyId),
              companyId,
              period,
            );
            bump('draft runs regenerated');
          },
        });
      }
      continue;
    }

    // The office's calendar for the month's payroll, each step on a working day after the last.
    const times: Date[] = [];
    let day = workday(firstOfNext);
    // 039: HR reviews the draft and sends it to the Director, who approves it before it is
    // processed — the order the product now enforces.
    const plan: [number, number, number][] = [
      [0, 11, 0], // generate
      [0, 17, 30], // HR sends it to the Director
      [1, 12, 15], // director approves
      [0, 15, 0], // process
      [1, 11, 0], // bank sheet
      [0, 16, 30], // marked paid
      [2, 12, 0], // bank's returned sheet reconciled
    ];
    for (const [gap, h, m] of plan) {
      day = workday(addDays(day, gap));
      times.push(at(day, h, m));
    }
    const [tGen, tSend, tApprove, tProc, tBank, tPaid, tRecon] = times;

    steps.push({
      when: tGen,
      label: `generate ${period}`,
      run: async () => {
        const since = sinceNow();
        const generated = await s.engine.generate(
          makerCaller,
          companyId,
          period,
        );
        runIds.set(period, generated.runId);
        await prisma.payrollRun.update({
          where: { id: generated.runId },
          data: { createdAt: tGen, generatedAt: tGen, updatedAt: tGen },
        });
        await prisma.payrollLineItem.updateMany({
          where: { payrollRunId: generated.runId },
          data: { createdAt: tGen, updatedAt: tGen },
        });
        await stampAudit(since, tGen, [generated.runId]);
        bump('payroll runs');
        bump('payroll lines', generated.lineCount);
      },
    });

    steps.push({
      when: tSend,
      label: `send ${period} to the director`,
      run: async () => {
        const runId = runIds.get(period);
        const since = sinceNow();
        const instance = await s.schedule.sendToDirector(
          companyId,
          runId,
          approverOf(people.maker, companyId),
        );
        await prisma.approvalInstance.update({
          where: { id: instance.instanceId },
          data: { createdAt: tSend, updatedAt: tSend },
        });
        await stampAudit(since, tSend, [runId, instance.instanceId]);
      },
    });

    // The latest month waits on the director; every earlier one was approved, processed and paid.
    if (latest) continue;

    steps.push({
      when: tApprove,
      label: `approve ${period} (director)`,
      run: async () => {
        const runId = runIds.get(period);
        const instance = await prisma.approvalInstance.findFirst({
          where: { companyId, entityId: runId },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        });
        const since = sinceNow();
        await s.approvals.decide(
          { instanceId: instance.id, action: ApprovalDecisionAction.approve },
          approverOf(people.director, companyId),
          OFFICE_IP,
        );
        await prisma.approvalDecision.updateMany({
          where: {
            approvalInstanceId: instance.id,
            actorUserId: people.director.userId,
          },
          data: { decidedAt: tApprove },
        });
        await prisma.approvalInstance.update({
          where: { id: instance.id },
          data: { updatedAt: tApprove },
        });
        await stampAudit(since, tApprove, [instance.id]);
        bump('approval decisions');
      },
    });

    steps.push({
      when: tProc,
      label: `process ${period}`,
      run: async () => {
        const runId = runIds.get(period);
        const since = sinceNow();
        await s.engine.setStatus(
          makerCaller,
          runId,
          PayrollRunStatus.processed,
        );
        await prisma.payrollRun.update({
          where: { id: runId },
          data: {
            processedAt: tProc,
            recoveriesSettledAt: tProc,
            updatedAt: tProc,
          },
        });
        const lines = await prisma.payrollLineItem.findMany({
          where: { payrollRunId: runId },
          select: { employeeId: true, advanceRecoveryAdvanceId: true },
        });
        const slips = await prisma.salarySlip.updateMany({
          where: { period, employeeId: { in: lines.map((l) => l.employeeId) } },
          data: { createdAt: tProc, updatedAt: tProc },
        });
        bump('salary slips', slips.count);
        const advanceIds = lines
          .map((l) => l.advanceRecoveryAdvanceId)
          .filter((id): id is string => !!id);
        if (advanceIds.length) {
          await prisma.salaryAdvance.updateMany({
            where: { id: { in: advanceIds } },
            data: { updatedAt: tProc },
          });
        }
        await prisma.loan.updateMany({
          where: {
            companyId,
            schedule: { some: { paidInPayrollRunId: runId } },
          },
          data: { updatedAt: tProc },
        });
        await stampAudit(since, tProc, [runId]);
      },
    });

    steps.push({
      when: tBank,
      label: `bank sheet ${period}`,
      run: async () => {
        const runId = runIds.get(period);
        const since = sinceNow();
        // The sheet's Value Date is the day it was produced; produce it as of that day.
        const sheet = s.bankSheet as unknown as {
          valueDateFor: (when: Date) => string;
        };
        const valueDateFor = sheet.valueDateFor;
        sheet.valueDateFor = (when: Date) =>
          valueDateFor.call(s.bankSheet, tBank ?? when);
        try {
          const { buffer } = await s.bankSheet.build(makerCaller, runId, {
            companyNamedFile: true,
          });
          bankFiles.set(period, buffer);
        } finally {
          sheet.valueDateFor = valueDateFor;
        }
        await prisma.bankSheetExport.updateMany({
          where: { payrollRunId: runId, createdAt: { gte: since } },
          data: { createdAt: tBank },
        });
        const recoveries = await prisma.bankSheetRecovery.findMany({
          where: { payrollRunId: runId },
          select: { salaryAdvanceId: true },
        });
        await prisma.bankSheetRecovery.updateMany({
          where: { payrollRunId: runId },
          data: { createdAt: tBank, updatedAt: tBank },
        });
        if (recoveries.length) {
          await prisma.salaryAdvance.updateMany({
            where: { id: { in: recoveries.map((r) => r.salaryAdvanceId) } },
            data: { updatedAt: tBank },
          });
        }
        bump('bank sheets');
        bump('bank sheet recoveries', recoveries.length);
      },
    });

    steps.push({
      when: tPaid,
      label: `paid ${period}`,
      run: async () => {
        const runId = runIds.get(period);
        const since = sinceNow();
        await s.engine.setStatus(makerCaller, runId, PayrollRunStatus.paid);
        await prisma.payrollRun.update({
          where: { id: runId },
          data: { paidAt: tPaid, updatedAt: tPaid },
        });
        await stampAudit(since, tPaid, [runId]);
      },
    });

    steps.push({
      when: tRecon,
      label: `reconcile ${period}`,
      run: async () => {
        const runId = runIds.get(period);
        const file = bankFiles.get(period);
        if (!file) return;
        // The bank returns the sheet it executed, in the layout it was sent.
        const lines = await s.transactionSheet.parse(file);
        await s.transactionSheet.reconcile(
          { isSuperAdmin: false, companyId },
          runId,
          lines,
          (value) => s.pii.decrypt(value),
        );
        const written = await prisma.bankTransactionLine.updateMany({
          where: { payrollRunId: runId },
          data: { createdAt: tRecon, updatedAt: tRecon },
        });
        bump('bank transaction lines', written.count);
      },
    });
  }

  steps.sort((a, b) => a.when.getTime() - b.when.getTime());
  for (const step of steps) {
    try {
      await step.run();
    } catch (error) {
      throw new Error(
        `payroll: ${company.shortCode} ${step.label} failed — ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return counts;
}
