import { validateSync } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import * as fs from 'fs';
import * as path from 'path';

import { periodRange } from '../../projects/pnl/project-pnl.service';
import { MonthlyWageRollupDto } from './dto/monthly-wage-rollup.dto';
import {
  MonthlyWageRollupService,
  monthBounds,
  sumDeductions,
} from './monthly-wage-rollup.service';

/**
 * The monthly labour wage roll-up (018 FR-010a, FR-010b — `bugs.md` item 14, tasks T056 to T067).
 *
 * The assertion that earns the phase is the straddling sheet: it is split on **days worked inside
 * the month**, and the test below checks that the answer differs from the calendar-day pro-rate it
 * would be so easy to write instead. A rule that is merely plausible passes every other test here.
 */

const dec = (value: number) => ({ toNumber: () => value });
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

interface SheetFixture {
  id: string;
  projectId?: string;
  periodFrom: string;
  periodTo: string;
  engagementType?: 'direct' | 'contractor';
  status?: string;
  grossTotal: number;
  deductionTotal: number;
  netTotal: number;
  lines: {
    workerId: string;
    daysWorked: number;
    overtimeHours?: number;
    resolvedRate: number;
    rateSource?: string;
    grossWage: number;
    deductions?: { type: string; amount: number; label: string }[];
    netPayable: number;
  }[];
}

interface MusterFixture {
  workerId: string;
  date: string;
  attendanceType?: 'full_day' | 'half_day' | 'absent';
}

function build(opts: {
  sheets: SheetFixture[];
  muster?: MusterFixture[];
  sites?: string[];
  workers?: { id: string; labourCode: string; fullName: string }[];
}) {
  const musterCalls: unknown[] = [];
  const sheetCalls: unknown[] = [];

  const tx = {
    $executeRaw: async () => 0,
    labourPaymentSheet: {
      findMany: async (args: unknown) => {
        sheetCalls.push(args);
        return opts.sheets.map((sheet) => ({
          id: sheet.id,
          projectId: sheet.projectId ?? 'p-1',
          periodFrom: day(sheet.periodFrom),
          periodTo: day(sheet.periodTo),
          engagementType: sheet.engagementType ?? 'direct',
          status: sheet.status ?? 'approved',
          grossTotal: dec(sheet.grossTotal),
          deductionTotal: dec(sheet.deductionTotal),
          netTotal: dec(sheet.netTotal),
          lines: sheet.lines.map((line) => ({
            workerId: line.workerId,
            daysWorked: dec(line.daysWorked),
            overtimeHours: dec(line.overtimeHours ?? 0),
            resolvedRate: dec(line.resolvedRate),
            rateSource: line.rateSource ?? 'project_rate',
            grossWage: dec(line.grossWage),
            deductions: line.deductions ?? [],
            netPayable: dec(line.netPayable),
          })),
        }));
      },
    },
    musterLine: {
      findMany: async (args: {
        where: { muster: { date: { gte: Date; lte: Date } } };
      }) => {
        musterCalls.push(args);
        const { gte, lte } = args.where.muster.date;
        return (opts.muster ?? [])
          .filter((row) => day(row.date) >= gte && day(row.date) <= lte)
          .map((row) => ({
            workerId: row.workerId,
            attendanceType: row.attendanceType ?? 'full_day',
            muster: { date: day(row.date) },
          }));
      },
    },
    labourWorker: {
      findMany: async () =>
        opts.workers ?? [
          { id: 'w-1', labourCode: 'LAB-0001', fullName: 'Asha Devi' },
          { id: 'w-2', labourCode: 'LAB-0002', fullName: 'Bhola Ram' },
        ],
    },
  };

  const prisma = {
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };

  const projects = {
    getSitesByProject: async () => opts.sites ?? ['site-1'],
    getProjectIdentityById: async () => ({
      id: 'p-1',
      code: 'PRJ-001',
      name: 'Ring Road',
    }),
  };

  const registered: unknown[] = [];
  const registry = {
    registerCostSource: (source: unknown) => registered.push(source),
  };

  return {
    service: new MonthlyWageRollupService(
      prisma as never,
      projects as never,
      registry as never,
    ),
    musterCalls,
    sheetCalls,
    registered,
  };
}

const caller = {
  id: 'u-1',
  companyId: 'co-1',
  permissions: [],
} as never;

const rollup = (
  service: MonthlyWageRollupService,
  year: number,
  month: number,
) => service.rollupFor(caller, { projectId: 'p-1', year, month });

/** A fortnight from 25 August to 7 September — the commonest case under any fortnightly cycle. */
const straddlingFixture = {
  sheets: [
    {
      id: 'sheet-straddle',
      periodFrom: '2026-08-25',
      periodTo: '2026-09-07',
      grossTotal: 6400,
      deductionTotal: 800,
      netTotal: 5600,
      lines: [
        // Four days, every one of them in August.
        {
          workerId: 'w-1',
          daysWorked: 4,
          resolvedRate: 600,
          grossWage: 2400,
          netPayable: 2400,
        },
        // Eight days: two in August, six in September.
        {
          workerId: 'w-2',
          daysWorked: 8,
          resolvedRate: 500,
          grossWage: 4000,
          deductions: [{ type: 'advance', amount: 800, label: 'Advance' }],
          netPayable: 3200,
        },
      ],
    },
  ] satisfies SheetFixture[],
  muster: [
    { workerId: 'w-1', date: '2026-08-25' },
    { workerId: 'w-1', date: '2026-08-26' },
    { workerId: 'w-1', date: '2026-08-27' },
    { workerId: 'w-1', date: '2026-08-28' },
    { workerId: 'w-2', date: '2026-08-25' },
    { workerId: 'w-2', date: '2026-08-26' },
    { workerId: 'w-2', date: '2026-09-01' },
    { workerId: 'w-2', date: '2026-09-02' },
    { workerId: 'w-2', date: '2026-09-03' },
    { workerId: 'w-2', date: '2026-09-04' },
    { workerId: 'w-2', date: '2026-09-07' },
    { workerId: 'w-2', date: '2026-09-05' },
  ] satisfies MusterFixture[],
};

describe('a sheet wholly inside the month contributes its full figures (T062)', () => {
  const wholly = {
    sheets: [
      {
        id: 'sheet-sep',
        periodFrom: '2026-09-01',
        periodTo: '2026-09-15',
        grossTotal: 9000,
        deductionTotal: 1000,
        netTotal: 8000,
        lines: [
          {
            workerId: 'w-1',
            daysWorked: 10,
            resolvedRate: 600,
            grossWage: 6000,
            deductions: [{ type: 'fine', amount: 1000, label: 'Fine' }],
            netPayable: 5000,
          },
          {
            workerId: 'w-2',
            daysWorked: 6,
            resolvedRate: 500,
            grossWage: 3000,
            netPayable: 3000,
          },
        ],
      },
    ] satisfies SheetFixture[],
  };

  it('takes the sheet whole, and says it apportioned nothing', async () => {
    const { service } = build(wholly);

    const view = await rollup(service, 2026, 9);

    expect(view.grossTotal).toBe(9000);
    expect(view.deductionTotal).toBe(1000);
    expect(view.netTotal).toBe(8000);
    expect(view.sheets[0].apportioned).toBe(false);
    expect(view.sheets[0].apportionment).toBeNull();
    expect(view.sheets[0].inMonth).toEqual(view.sheets[0].recorded);
  });

  it('never opens the muster, because there is nothing to apportion', async () => {
    const { service, musterCalls } = build(wholly);

    await rollup(service, 2026, 9);

    expect(musterCalls).toHaveLength(0);
  });

  it('itemises every worker with the figures the sheet recorded (T059)', async () => {
    const { service } = build(wholly);

    const view = await rollup(service, 2026, 9);

    expect(view.workers).toEqual([
      expect.objectContaining({
        workerId: 'w-1',
        fullName: 'Asha Devi',
        labourCode: 'LAB-0001',
        daysWorked: 10,
        resolvedRate: 600,
        rateSource: 'project_rate',
        grossWage: 6000,
        deductions: 1000,
        netPayable: 5000,
        apportioned: false,
        sheetIds: ['sheet-sep'],
      }),
      expect.objectContaining({ workerId: 'w-2', grossWage: 3000 }),
    ]);
  });
});

describe('a straddling sheet is split on days worked, and says how (T063)', () => {
  it('gives August only the days worked in August', async () => {
    const { service } = build(straddlingFixture);

    const august = await rollup(service, 2026, 8);

    // w-1 worked all four of their days in August: the whole 2400.
    // w-2 worked two of their eight days in August: a quarter of 4000.
    expect(august.grossTotal).toBe(3400);
    expect(august.workers).toEqual([
      expect.objectContaining({
        workerId: 'w-1',
        daysWorked: 4,
        grossWage: 2400,
      }),
      expect.objectContaining({
        workerId: 'w-2',
        daysWorked: 2,
        grossWage: 1000,
      }),
    ]);
  });

  it('gives September the rest, and drops a worker who worked none of it', async () => {
    const { service } = build(straddlingFixture);

    const september = await rollup(service, 2026, 9);

    expect(september.grossTotal).toBe(3000);
    // w-1 is absent rather than present with a zero: a zero row in a wage register reads as
    // "worked and earned nothing", which is a different and alarming claim.
    expect(september.workers.map((row) => row.workerId)).toEqual(['w-2']);
    expect(september.workers[0].daysWorked).toBe(6);
  });

  it('is not the calendar-day pro-rate, which is the whole point of plan D12', async () => {
    const { service } = build(straddlingFixture);

    const august = await rollup(service, 2026, 8);

    // The period is 14 days, 7 of them in August. Pro-rating by elapsed days would hand August
    // half of 6400. The muster says 3400, and the muster is what was actually worked.
    expect(august.grossTotal).not.toBe(3200);
    expect(august.grossTotal).toBe(3400);
  });

  it('states the apportionment on the sheet row (T060, FR-010a)', async () => {
    const { service } = build(straddlingFixture);

    const august = await rollup(service, 2026, 8);
    const row = august.sheets[0];

    expect(row.apportioned).toBe(true);
    expect(row.apportionment).toEqual({
      basis: 'muster-days',
      daysInMonth: 6,
      daysInPeriod: 12,
      placedByPeriodEnd: 0,
      note: expect.stringContaining('crosses the month boundary'),
    });
    expect(row.apportionment?.note).toContain('2026-08-25 to 2026-09-07');
    // The sheet's own totals are reported untouched beside what the month took (FR-010b).
    expect(row.recorded.grossTotal).toBe(6400);
    expect(row.inMonth.grossTotal).toBe(3400);
  });

  it('apportions deductions and net with the wage, not separately', async () => {
    const { service } = build(straddlingFixture);

    const [august, september] = [
      await rollup(service, 2026, 8),
      await rollup(service, 2026, 9),
    ];

    expect(august.deductionTotal).toBe(200);
    expect(august.netTotal).toBe(3200);
    expect(september.deductionTotal).toBe(600);
    expect(september.netTotal).toBe(2400);
  });
});

describe('the apportioned figures reconcile to the rupee (T064, SC-007)', () => {
  it('splits the sheet without losing or duplicating a paisa', async () => {
    const { service } = build(straddlingFixture);

    const august = await rollup(service, 2026, 8);
    const september = await rollup(service, 2026, 9);

    const recorded = august.sheets[0].recorded;
    expect(august.grossTotal + september.grossTotal).toBe(recorded.grossTotal);
    expect(august.deductionTotal + september.deductionTotal).toBe(
      recorded.deductionTotal,
    );
    expect(august.netTotal + september.netTotal).toBe(recorded.netTotal);
  });

  it('makes the month total the sum of its own worker rows', async () => {
    const { service } = build(straddlingFixture);

    const august = await rollup(service, 2026, 8);
    const sumOfWorkers = august.workers.reduce(
      (total, row) => total + row.grossWage,
      0,
    );

    expect(sumOfWorkers).toBe(august.grossTotal);
    expect(sumOfWorkers).toBe(
      august.byEngagement.find((row) => row.engagementType === 'direct')
        ?.grossTotal,
    );
  });

  it('frames the month exactly as the P&L frames it', () => {
    // SC-008 says the roll-up and the P&L must agree *exactly*, and two different ideas of where
    // a month starts is the way that silently stops being true.
    for (const [year, month] of [
      [2026, 1],
      [2026, 2],
      [2024, 2],
      [2026, 9],
      [2026, 12],
    ] as const) {
      const mine = monthBounds(year, month);
      const theirs = periodRange(`${year}-${String(month).padStart(2, '0')}`);
      expect(mine.monthStart.toISOString()).toBe(
        theirs.monthStart.toISOString(),
      );
      expect(mine.monthEnd.toISOString()).toBe(theirs.monthEnd.toISOString());
    }
  });
});

describe('a contractor month states its engagement and itemises nobody (T065)', () => {
  const contractorOnly = {
    sheets: [
      {
        id: 'sheet-contractor',
        periodFrom: '2026-09-01',
        periodTo: '2026-09-30',
        engagementType: 'contractor' as const,
        grossTotal: 120000,
        deductionTotal: 0,
        netTotal: 120000,
        lines: [
          {
            workerId: 'w-1',
            daysWorked: 26,
            resolvedRate: 600,
            grossWage: 60000,
            netPayable: 60000,
          },
          {
            workerId: 'w-2',
            daysWorked: 26,
            resolvedRate: 600,
            grossWage: 60000,
            netPayable: 60000,
          },
        ],
      },
    ] satisfies SheetFixture[],
  };

  it('returns the sheet total with no per-worker disbursement list', async () => {
    const { service } = build(contractorOnly);

    const view = await rollup(service, 2026, 9);

    expect(view.grossTotal).toBe(120000);
    expect(view.workers).toEqual([]);
    expect(view.byEngagement).toEqual([
      {
        engagementType: 'contractor',
        grossTotal: 120000,
        deductionTotal: 0,
        netTotal: 120000,
        sheetCount: 1,
        workerCount: 0,
      },
    ]);
  });

  it('says why the list is empty, so the screen is not read as broken', async () => {
    const { service } = build(contractorOnly);

    const view = await rollup(service, 2026, 9);

    expect(view.workersNote).toContain('directly engaged labour only');
    expect(view.workersNote).toContain('basis of payment');
  });

  it('keeps contractor money in the total while itemising only direct labour', async () => {
    const { service } = build({
      sheets: [
        ...contractorOnly.sheets,
        {
          id: 'sheet-direct',
          periodFrom: '2026-09-01',
          periodTo: '2026-09-30',
          grossTotal: 9000,
          deductionTotal: 0,
          netTotal: 9000,
          lines: [
            {
              workerId: 'w-1',
              daysWorked: 15,
              resolvedRate: 600,
              grossWage: 9000,
              netPayable: 9000,
            },
          ],
        },
      ],
    });

    const view = await rollup(service, 2026, 9);

    expect(view.grossTotal).toBe(129000);
    expect(view.workers).toHaveLength(1);
    expect(
      view.byEngagement.find((row) => row.engagementType === 'direct')
        ?.grossTotal,
    ).toBe(9000);
  });
});

describe('nothing is stored, so a correction lands on the next read (T066, FR-010b)', () => {
  it('reports the corrected figure without any invalidation step', async () => {
    const before = build({
      sheets: [
        {
          id: 'sheet-sep',
          periodFrom: '2026-09-01',
          periodTo: '2026-09-15',
          grossTotal: 6000,
          deductionTotal: 0,
          netTotal: 6000,
          lines: [
            {
              workerId: 'w-1',
              daysWorked: 10,
              resolvedRate: 600,
              grossWage: 6000,
              netPayable: 6000,
            },
          ],
        },
      ],
    });
    expect((await rollup(before.service, 2026, 9)).grossTotal).toBe(6000);

    // The sheet is reopened, a day is corrected, and it is re-approved.
    const after = build({
      sheets: [
        {
          id: 'sheet-sep',
          periodFrom: '2026-09-01',
          periodTo: '2026-09-15',
          grossTotal: 5400,
          deductionTotal: 0,
          netTotal: 5400,
          lines: [
            {
              workerId: 'w-1',
              daysWorked: 9,
              resolvedRate: 600,
              grossWage: 5400,
              netPayable: 5400,
            },
          ],
        },
      ],
    });

    expect((await rollup(after.service, 2026, 9)).grossTotal).toBe(5400);
  });

  it('writes nothing — the test double offers no write to call', async () => {
    // `build()` gives the service `findMany` and nothing else. A `create`, `update` or `upsert`
    // anywhere in the roll-up would throw here rather than quietly introduce a second place a
    // wage is recorded (plan D13).
    const { service } = build(straddlingFixture);

    await expect(rollup(service, 2026, 8)).resolves.toBeDefined();
  });
});

describe('a draft sheet is excluded and counted (FR-013)', () => {
  it('leaves a proposal out of the month and says one was left out', async () => {
    const { service } = build({
      sheets: [
        {
          id: 'sheet-approved',
          periodFrom: '2026-09-01',
          periodTo: '2026-09-15',
          grossTotal: 6000,
          deductionTotal: 0,
          netTotal: 6000,
          lines: [
            {
              workerId: 'w-1',
              daysWorked: 10,
              resolvedRate: 600,
              grossWage: 6000,
              netPayable: 6000,
            },
          ],
        },
        {
          id: 'sheet-draft',
          periodFrom: '2026-09-16',
          periodTo: '2026-09-30',
          status: 'draft',
          grossTotal: 7000,
          deductionTotal: 0,
          netTotal: 7000,
          lines: [
            {
              workerId: 'w-2',
              daysWorked: 12,
              resolvedRate: 583.33,
              grossWage: 7000,
              netPayable: 7000,
            },
          ],
        },
      ],
    });

    const view = await rollup(service, 2026, 9);

    expect(view.grossTotal).toBe(6000);
    expect(view.draftSheetCount).toBe(1);
    expect(view.sheets.map((row) => row.sheetId)).toEqual(['sheet-approved']);
  });
});

describe('a line the muster cannot place is placed whole, and counted', () => {
  const noMuster = {
    sheets: [
      {
        id: 'sheet-straddle',
        periodFrom: '2026-08-25',
        periodTo: '2026-09-07',
        grossTotal: 2400,
        deductionTotal: 0,
        netTotal: 2400,
        lines: [
          {
            workerId: 'w-1',
            daysWorked: 4,
            resolvedRate: 600,
            grossWage: 2400,
            netPayable: 2400,
          },
        ],
      },
    ] satisfies SheetFixture[],
    muster: [] as MusterFixture[],
  };

  it('puts it in the month the period ends in, never in both and never in neither', async () => {
    const august = await rollup(build(noMuster).service, 2026, 8);
    const september = await rollup(build(noMuster).service, 2026, 9);

    expect(august.grossTotal).toBe(0);
    expect(september.grossTotal).toBe(2400);
    expect(august.grossTotal + september.grossTotal).toBe(2400);
  });

  it('says so on the response rather than presenting an invented split', async () => {
    const september = await rollup(build(noMuster).service, 2026, 9);

    expect(september.sheets[0].apportionment).toEqual(
      expect.objectContaining({
        basis: 'sheet-period-end',
        placedByPeriodEnd: 1,
      }),
    );
    expect(september.sheets[0].apportionment?.note).toContain(
      'no approved muster day',
    );
  });
});

describe('the query is bounded before it reaches the service (T056)', () => {
  const check = (query: Record<string, unknown>) =>
    validateSync(plainToInstance(MonthlyWageRollupDto, query)).flatMap(
      (error) => Object.keys(error.constraints ?? {}),
    );

  it('accepts a real month', () => {
    expect(check({ projectId: 'p-1', year: '2026', month: '9' })).toEqual([]);
  });

  it('refuses a month outside 1-12 rather than returning an empty month', () => {
    expect(check({ projectId: 'p-1', year: '2026', month: '13' })).toContain(
      'max',
    );
    expect(check({ projectId: 'p-1', year: '2026', month: '0' })).toContain(
      'min',
    );
  });

  it('refuses an implausible year', () => {
    expect(check({ projectId: 'p-1', year: '20266', month: '9' })).toContain(
      'max',
    );
  });

  it('refuses a missing project', () => {
    expect(check({ year: '2026', month: '9' }).length).toBeGreaterThan(0);
  });
});

describe('the roll-up added no table (T067, plan D13)', () => {
  const serviceSource = fs.readFileSync(
    path.join(__dirname, 'monthly-wage-rollup.service.ts'),
    'utf8',
  );

  it('calls no Prisma write', () => {
    // A stored roll-up would be a second figure for the same wage, and the two would disagree the
    // first time a sheet was reopened. This is the guard on that, not a comment hoping for it.
    for (const write of [
      '.create(',
      '.createMany(',
      '.update(',
      '.updateMany(',
      '.upsert(',
      '.delete(',
      '.deleteMany(',
    ]) {
      expect(serviceSource).not.toContain(write);
    }
  });

  it('is backed by no migration of its own', () => {
    const migrations = fs.readdirSync(
      path.join(__dirname, '..', '..', '..', 'prisma', 'migrations'),
    );
    expect(
      migrations.filter((name) => /rollup|roll_up|wage_roll/i.test(name)),
    ).toEqual([]);
  });
});

describe('deductions are read from the sheet, not inferred', () => {
  it('sums the stored entries', () => {
    expect(
      sumDeductions([
        { type: 'advance', amount: 500, label: 'Advance' },
        { type: 'fine', amount: 120.5, label: 'Fine' },
      ]),
    ).toBe(620.5);
  });

  it('treats an absent or malformed list as nothing deducted', () => {
    expect(sumDeductions(null)).toBe(0);
    expect(sumDeductions({})).toBe(0);
    expect(sumDeductions([{ label: 'no amount' }])).toBe(0);
  });
});

describe('labour registers the P&L’s labour cost, and it reconciles (T026, T032, FR-013)', () => {
  it('announces itself as the labour cost source on init', () => {
    const { service, registered } = build({ sheets: [] });

    service.onModuleInit();

    expect(registered).toEqual([service]);
    expect(service.category).toBe('labour');
  });

  it('returns the same figure the roll-up shows, to the paisa', async () => {
    // This is FR-013: the P&L's monthly labour cost must reconcile to the approved payment sheets.
    // It reconciles **by construction** — both paths share `lineShare()` — and this is the test
    // that keeps it that way, because two implementations of an apportionment rule is two answers
    // and the second one written is always the one nobody checks.
    const { monthStart, monthEnd } = monthBounds(2026, 8);

    const view = await rollup(build(straddlingFixture).service, 2026, 8);
    const costs = await build(straddlingFixture).service.costsByProject(
      ['p-1'],
      'co-1',
      { from: monthStart, to: monthEnd },
    );

    expect(costs.get('p-1')).toBe(view.grossTotal);
    expect(costs.get('p-1')).toBe(3400);
  });

  it('reports gross, not net — a deduction is money recovered, not money unspent', async () => {
    const { monthStart, monthEnd } = monthBounds(2026, 9);
    const fixture = {
      sheets: [
        {
          id: 'sheet-sep',
          periodFrom: '2026-09-01',
          periodTo: '2026-09-15',
          grossTotal: 6000,
          deductionTotal: 1000,
          netTotal: 5000,
          lines: [
            {
              workerId: 'w-1',
              daysWorked: 10,
              resolvedRate: 600,
              grossWage: 6000,
              deductions: [{ type: 'advance', amount: 1000, label: 'Advance' }],
              netPayable: 5000,
            },
          ],
        },
      ] satisfies SheetFixture[],
    };

    const costs = await build(fixture).service.costsByProject(['p-1'], 'co-1', {
      from: monthStart,
      to: monthEnd,
    });

    expect(costs.get('p-1')).toBe(6000);
  });

  it('asks for every named project in one query, not one each', async () => {
    const { monthStart, monthEnd } = monthBounds(2026, 9);
    const { service, sheetCalls } = build({
      sheets: [
        {
          id: 'sheet-a',
          projectId: 'p-1',
          periodFrom: '2026-09-01',
          periodTo: '2026-09-30',
          grossTotal: 6000,
          deductionTotal: 0,
          netTotal: 6000,
          lines: [
            {
              workerId: 'w-1',
              daysWorked: 10,
              resolvedRate: 600,
              grossWage: 6000,
              netPayable: 6000,
            },
          ],
        },
        {
          id: 'sheet-b',
          projectId: 'p-2',
          periodFrom: '2026-09-01',
          periodTo: '2026-09-30',
          grossTotal: 3000,
          deductionTotal: 0,
          netTotal: 3000,
          lines: [
            {
              workerId: 'w-2',
              daysWorked: 5,
              resolvedRate: 600,
              grossWage: 3000,
              netPayable: 3000,
            },
          ],
        },
      ],
    });

    const costs = await service.costsByProject(['p-1', 'p-2', 'p-3'], 'co-1', {
      from: monthStart,
      to: monthEnd,
    });

    expect(sheetCalls).toHaveLength(1);
    expect(costs.get('p-1')).toBe(6000);
    expect(costs.get('p-2')).toBe(3000);
    // Asked, and there is none — which is a different fact from a category nobody could ask about,
    // and the P&L distinguishes them.
    expect(costs.get('p-3')).toBe(0);
  });

  it('returns nothing at all when the query fails, so no project is reported as zero', async () => {
    const service = new MonthlyWageRollupService(
      {
        $transaction: async () => {
          throw new Error('labour is down');
        },
      } as never,
      {} as never,
      { registerCostSource: () => undefined } as never,
    );

    const costs = await service.costsByProject(['p-1'], 'co-1', {
      from: new Date('2026-09-01T00:00:00.000Z'),
      to: new Date('2026-09-30T23:59:59.999Z'),
    });

    // Empty, not `{p-1: 0}`. A zero here is indistinguishable from a month with no labour, and a
    // project whose wages are invisible looks like a project running under budget.
    expect(costs.size).toBe(0);
  });
});
