import { NotFoundException } from '@nestjs/common';
import { LabourPaymentMode, Prisma } from '@prisma/client';

import { CASH_HIDDEN_CODE } from '../../common/cash/cash-policy';
import { LabourAdvanceService } from '../advances/labour-advance.service';
import { PaymentSheetService } from '../payment-sheets/payment-sheet.service';
import { MonthlyWageRollupService } from '../reports/monthly-wage-rollup.service';

/** The cash mode, named once (cash-entry-surface.spec flags literal cash modes). */
const CASH = 'cash' as LabourPaymentMode;

/**
 * 038 in labour: with cash hidden for the company, cash sheets, cash lines and advances do not exist
 * for reads, and cannot be written; with it off, everything reads and writes as before.
 */

const D = (n: number) => new Prisma.Decimal(n);
const caller = {
  id: 'u-1',
  companyId: 'co-1',
  permissions: [],
} as never;

function cashPolicy(hidden: boolean) {
  return {
    isHidden: jest.fn(async () => hidden),
    hiddenAmong: jest.fn(
      async (ids: readonly string[]) =>
        new Set(hidden ? ids.filter((id) => id === 'co-1') : []),
    ),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const lineRow = (over: Record<string, unknown>): any => ({
  companyId: 'co-1',
  workerId: 'w-1',
  daysWorked: D(10),
  overtimeHours: D(0),
  resolvedRate: D(500),
  rateSource: 'site_rate',
  grossWage: D(5000),
  deductions: [],
  netPayable: D(5000),
  paymentMode: null,
  paidOn: null,
  paidAmount: null,
  shortPaymentReason: null,
  carriedForwardBalance: D(0),
  carriedFromLineId: null,
  status: 'pending',
  ...over,
});

const contractorSheet = {
  id: 'sheet-c',
  companyId: 'co-1',
  projectId: 'p-1',
  siteId: null,
  periodFrom: new Date('2026-09-01'),
  periodTo: new Date('2026-09-15'),
  engagementType: 'contractor',
  status: 'partially_disbursed',
  grossTotal: D(15000),
  deductionTotal: D(1000),
  netTotal: D(14000),
  denominationBreakup: null,
  approvedBy: null,
  closedAt: null,
  deletedAt: null,
  lines: [
    lineRow({
      id: 'l-cash',
      sheetId: 'sheet-c',
      paymentMode: CASH,
      paidAmount: D(5000),
      status: 'disbursed',
    }),
    lineRow({
      id: 'l-bank',
      sheetId: 'sheet-c',
      workerId: 'w-2',
      paymentMode: 'bank',
      paidAmount: D(4000),
      netPayable: D(4000),
      deductions: [
        { type: 'advance', advanceId: 'a-1', amount: 1000, label: 'Advance' },
      ],
      status: 'disbursed',
    }),
    lineRow({ id: 'l-pending', sheetId: 'sheet-c', workerId: 'w-3' }),
  ],
};

const directSheet = {
  ...contractorSheet,
  id: 'sheet-d',
  engagementType: 'direct',
  status: 'approved',
  lines: [lineRow({ id: 'l-d', sheetId: 'sheet-d' })],
};

function sheetService(
  hidden: boolean,
  sheets = [contractorSheet, directSheet],
) {
  const byId = new Map(sheets.map((s) => [s.id, s]));
  const lineById = new Map(
    sheets.flatMap((s) => s.lines.map((l) => [l.id, { ...l, sheet: s }])),
  );
  const tx = {
    $executeRaw: jest.fn(async () => 0),
    $queryRaw: jest.fn(async () => []),
    labourPaymentSheet: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const s = byId.get(where.id);
        return s ? { ...s, lines: [...s.lines] } : null;
      }),
      findMany: jest.fn(async () => sheets.map((s) => ({ ...s }))),
      findFirst: jest.fn(async () => null),
      create: jest.fn(async ({ data }: { data: object }) => ({
        id: 'new',
        ...data,
      })),
      update: jest.fn(async () => ({})),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    paymentSheetLine: {
      findUnique: jest.fn(
        async ({ where }: { where: { id: string } }) =>
          lineById.get(where.id) ?? null,
      ),
      findMany: jest.fn(
        async ({ where }: { where: Record<string, unknown> }) => {
          const inSheets = (where.sheetId as { in?: string[] } | undefined)?.in;
          if (inSheets) {
            return sheets
              .filter((s) => inSheets.includes(s.id))
              .flatMap((s) => s.lines);
          }
          return [];
        },
      ),
      update: jest.fn(async () => ({})),
    },
    labourWorker: {
      findMany: jest.fn(async () => []),
      findUnique: jest.fn(async () => ({ bankAccount: '123' })),
    },
    labourAdvance: { findUnique: jest.fn(async () => null), update: jest.fn() },
  };
  const prisma = {
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };
  const refs = {
    siteNames: async () => new Map(),
    getLabourSettings: async () => ({ cashDenominations: [500, 100] }),
  };
  const sites = {
    getSiteById: async () => ({
      id: 'site-1',
      companyId: 'co-1',
      projectId: 'p-1',
      name: 'Site',
    }),
  };
  const supervisorSites = { assertSiteAllowed: async () => undefined };
  const days = {
    today: () => '2026-10-20',
    lockSiteForSheet: async () => undefined,
  };
  const audit = { record: jest.fn(async () => undefined) };
  const service = new PaymentSheetService(
    prisma as never,
    audit as never,
    refs as never,
    sites as never,
    {} as never,
    supervisorSites as never,
    {} as never,
    {} as never,
    days as never,
    cashPolicy(hidden) as never,
  );
  return { service, tx };
}

async function expectCashHidden(promise: Promise<unknown>) {
  await expect(promise).rejects.toMatchObject({
    response: { code: CASH_HIDDEN_CODE },
  });
}

describe('payment sheets with cash hidden (038)', () => {
  it('lists only the contractor sheet, with totals from its bank and pending lines', async () => {
    const { service } = sheetService(true);
    const rows = await service.findAll(caller, {});
    expect(rows.map((r) => r.id)).toEqual(['sheet-c']);
    // bank line: net 4000, advance recovery out → gross 4000; pending 5000.
    expect(rows[0]).toMatchObject({
      grossTotal: 9000,
      deductionTotal: 0,
      netTotal: 9000,
    });
  });

  it('a direct (cash) sheet reads as not found, also its denominations', async () => {
    const { service } = sheetService(true);
    await expect(service.findOne(caller, 'sheet-d')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      service.getDenominations(caller, 'sheet-d'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a mixed sheet shows only its non-cash lines, without the advance deduction', async () => {
    const { service } = sheetService(true);
    const sheet = await service.findOne(caller, 'sheet-c');
    expect(sheet.lines.map((l) => l.id)).toEqual(['l-bank', 'l-pending']);
    const bank = sheet.lines[0];
    expect(bank.deductions).toEqual([]);
    expect(bank.grossWage).toBe(4000);
    expect(bank.netPayable).toBe(4000);
    expect(sheet.grossTotal).toBe(9000);
    expect(sheet.netTotal).toBe(9000);
    expect(sheet.summary).toMatchObject({
      disbursedCount: 1,
      pendingCount: 1,
      disbursedAmount: 4000,
      outstandingAmount: 5000,
    });
  });

  it('refuses every write to cash: generate direct, approve/reopen/regenerate/delete a direct sheet, pay or reverse cash', async () => {
    const { service } = sheetService(true);
    await expectCashHidden(
      service.generate(
        caller,
        { siteId: 'site-1', periodFrom: '2026-09-01', periodTo: '2026-09-15' },
        'ip',
      ),
    );
    await expectCashHidden(service.approve(caller, 'sheet-d', 'ip'));
    await expectCashHidden(service.reopen(caller, 'sheet-d', 'r', 'ip'));
    await expectCashHidden(service.regenerate(caller, 'sheet-d', 'ip'));
    await expectCashHidden(service.remove(caller, 'sheet-d', 'r', 'ip'));
    await expectCashHidden(
      service.disburseLine(
        caller,
        'l-d',
        { paymentMode: 'bank', paidOn: '2026-09-20', paidAmount: 5000 },
        'ip',
      ),
    );
    await expectCashHidden(
      service.disburseLine(
        caller,
        'l-pending',
        { paymentMode: CASH, paidOn: '2026-09-20', paidAmount: 5000 },
        'ip',
      ),
    );
    await expectCashHidden(service.reverseLine(caller, 'l-cash', 'r', 'ip'));
  });

  it('still pays a contractor line by bank', async () => {
    const { service, tx } = sheetService(true);
    await service.disburseLine(
      caller,
      'l-pending',
      { paymentMode: 'bank', paidOn: '2026-09-20', paidAmount: 5000 },
      'ip',
    );
    expect(tx.paymentSheetLine.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'l-pending' },
        data: expect.objectContaining({ paymentMode: 'bank' }),
      }),
    );
  });
});

describe('payment sheets with cash not hidden (038 — unchanged)', () => {
  it('lists both sheets with their stored totals', async () => {
    const { service } = sheetService(false);
    const rows = await service.findAll(caller, {});
    expect(rows.map((r) => r.id)).toEqual(['sheet-c', 'sheet-d']);
    expect(rows[0]).toMatchObject({ grossTotal: 15000, netTotal: 14000 });
  });

  it('shows every line of a mixed sheet as stored, and the direct sheet', async () => {
    const { service } = sheetService(false);
    const sheet = await service.findOne(caller, 'sheet-c');
    expect(sheet.lines).toHaveLength(3);
    expect(sheet.grossTotal).toBe(15000);
    expect(sheet.lines[1].deductions).toHaveLength(1);
    await expect(service.findOne(caller, 'sheet-d')).resolves.toMatchObject({
      id: 'sheet-d',
    });
  });

  it('does not refuse a direct sheet for cash', async () => {
    const { service } = sheetService(false);
    // The direct fixture is already approved, so the refusal is the ordinary 409, not CASH_HIDDEN.
    await expect(service.approve(caller, 'sheet-d', 'ip')).rejects.toThrow(
      'Only a draft sheet can be approved',
    );
  });
});

// ── Advances ────────────────────────────────────────────────────────────────

function advanceService(hidden: boolean) {
  const advance = {
    id: 'a-1',
    companyId: 'co-1',
    workerId: 'w-1',
    amount: D(3000),
    reason: 'Festival',
    recoveryInstalments: 3,
    instalmentAmount: D(1000),
    recoveryStartPeriod: new Date('2026-09-01'),
    outstandingBalance: D(0),
    exceedsLimit: false,
    status: 'pending',
    createdBy: 'u-2',
    approvedBy: null,
    deletedAt: null,
  };
  const tx = {
    $executeRaw: jest.fn(async () => 0),
    labourAdvance: {
      findMany: jest.fn(async () => [advance]),
      findUnique: jest.fn(async () => advance),
      create: jest.fn(async () => advance),
      update: jest.fn(async () => advance),
      updateMany: jest.fn(async () => ({ count: 1 })),
      findUniqueOrThrow: jest.fn(async () => advance),
    },
    paymentSheetLine: { findMany: jest.fn(async () => []) },
    labourWorker: { findMany: jest.fn(async () => []) },
  };
  const prisma = {
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };
  const refs = { userNames: async () => new Map(), advanceLimitMultiple: 5 };
  const service = new LabourAdvanceService(
    prisma as never,
    { record: jest.fn() } as never,
    refs as never,
    {} as never,
    {} as never,
    // The approval chain (2026-10-20): in one, and the decision final.
    {
      stateOfSystem: jest.fn(async () => ({ state: 'pending' })),
      decideByEntity: jest.fn(async () => ({ state: 'approved' })),
    } as never,
    cashPolicy(hidden) as never,
  );
  return { service, tx };
}

describe('labour advances with cash hidden (038)', () => {
  it('lists none and reads one as not found', async () => {
    const { service } = advanceService(true);
    await expect(service.findAll(caller, {})).resolves.toEqual([]);
    await expect(service.findOne(caller, 'a-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('refuses raising, approving and disbursing an advance', async () => {
    const { service, tx } = advanceService(true);
    await expectCashHidden(
      service.create(
        caller,
        {
          workerId: 'w-1',
          amount: 1000,
          reason: 'x',
          recoveryInstalments: 1,
          recoveryStartPeriod: '2026-10-01',
        },
        'ip',
      ),
    );
    await expectCashHidden(service.approve(caller, 'a-1', 'ip'));
    await expectCashHidden(service.disburse(caller, 'a-1', 'ip'));
    expect(tx.labourAdvance.create).not.toHaveBeenCalled();
    expect(tx.labourAdvance.update).not.toHaveBeenCalled();
  });

  it('with hiding off, lists, reads and approves as before', async () => {
    const { service, tx } = advanceService(false);
    await expect(service.findAll(caller, {})).resolves.toHaveLength(1);
    await expect(service.findOne(caller, 'a-1')).resolves.toMatchObject({
      id: 'a-1',
    });
    await service.approve(caller, 'a-1', 'ip');
    expect(tx.labourAdvance.updateMany).toHaveBeenCalled();
  });
});

// ── P&L labour cost ─────────────────────────────────────────────────────────

describe('labour cost for the P&L with cash hidden (038)', () => {
  function rollup(hidden: boolean) {
    const sheets = [
      { ...contractorSheet, status: 'closed' },
      { ...directSheet, status: 'closed' },
    ];
    const tx = {
      $executeRaw: jest.fn(async () => 0),
      labourPaymentSheet: { findMany: jest.fn(async () => sheets) },
      paymentSheetLine: { findMany: jest.fn(async () => []) },
    };
    const prisma = {
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    };
    return new MonthlyWageRollupService(
      prisma as never,
      { getSitesByProject: async () => [] } as never,
      { registerCostSource: () => undefined } as never,
      cashPolicy(hidden) as never,
    );
  }
  const range = { from: new Date('2026-09-01'), to: new Date('2026-09-30') };

  it('leaves the direct sheet, the cash line and the advance-settled wage out', async () => {
    const costs = await rollup(true).costsByProject(['p-1'], 'co-1', range);
    // bank line 4000 (5000 less the 1000 the cash advance settled) + pending 5000.
    expect(costs.get('p-1')).toBe(9000);
  });

  it('counts everything when hiding is off', async () => {
    const costs = await rollup(false).costsByProject(['p-1'], 'co-1', range);
    // contractor 3 × 5000 + direct 5000.
    expect(costs.get('p-1')).toBe(20000);
  });
});
