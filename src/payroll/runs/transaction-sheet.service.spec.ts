import * as ExcelJS from 'exceljs';

import { TransactionSheetService } from './transaction-sheet.service';

/**
 * Reconciling the bank's returned sheet (021 FR-008 to FR-011, tasks T058 and T059) — the second
 * half of `bugs.md` item 8.
 *
 * **The property these protect is that the upload survives a bad row.** A parser that refuses on the
 * first unrecognised row reports nothing at all, which is the opposite of useful when a bank has
 * changed a column and somebody needs to know which rows still line up.
 */

const FORMAT = {
  columns: new Array(16).fill('').map((_, i) => `col${i}`),
  messageType: 'NEFT',
  transactionTypeCode: 'NEFT',
  valueDateFormat: 'DD/MM/YYYY' as const,
};

/** Builds a workbook in the bank's column positions. */
async function workbookOf(rows: (string | number | null)[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Sheet1');
  sheet.addRow(FORMAT.columns);
  for (const row of rows) {
    const padded = new Array(16).fill('');
    row.forEach((value, index) => {
      padded[index] = value ?? '';
    });
    sheet.addRow(padded);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/**
 * One bank row in the template's positions: 1 value date, 2 message type, 3 debit account,
 * 4 beneficiary name, 5 amount, 6 IFSC, 7 beneficiary account, 8 transaction type.
 */
function bankRow(opts: {
  name?: string;
  amount?: number | string | null;
  account?: string | null;
  ifsc?: string;
}): (string | number | null)[] {
  const row: (string | number | null)[] = new Array(16).fill('');
  row[1] = '21/08/2026';
  row[2] = 'NEFT';
  row[3] = '09310400000819';
  row[4] = opts.name ?? 'Arivnd';
  row[5] = opts.amount === undefined ? 55000 : opts.amount;
  row[6] = opts.ifsc ?? 'SBIN0062263';
  row[7] = opts.account === undefined ? '42855410069' : opts.account;
  row[8] = 'NEFT';
  return row;
}

function build(opts: {
  employees?: {
    id: string;
    employeeCode: string;
    account: string | null;
  }[];
  netPay?: Record<string, number>;
}) {
  const employees = opts.employees ?? [
    { id: 'e1', employeeCode: 'EMP001', account: '42855410069' },
  ];
  const stored: Record<string, unknown>[] = [];
  let deleted = 0;

  const tx = {
    $executeRaw: async () => 0,
    payrollRun: {
      findFirst: async () => ({
        id: 'run-1',
        companyId: 'co-1',
        period: '2026-07',
        lineItems: employees.map((e) => ({
          id: `li-${e.id}`,
          employeeId: e.id,
          netPay: { toNumber: () => opts.netPay?.[e.id] ?? 55000 },
        })),
      }),
    },
    employee: {
      findMany: async () =>
        employees.map((e) => ({
          id: e.id,
          employeeCode: e.employeeCode,
          bankAccountNumberEncrypted: e.account ? `enc:${e.account}` : null,
        })),
    },
    bankTransactionLine: {
      deleteMany: async () => {
        deleted += 1;
        return { count: 0 };
      },
      createMany: async (args: { data: Record<string, unknown>[] }) => {
        stored.push(...args.data);
        return { count: args.data.length };
      },
    },
  };
  const prisma = {
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };
  const config = { get: () => FORMAT };

  return {
    service: new TransactionSheetService(prisma as never, config as never),
    stored,
    deletedCount: () => deleted,
  };
}

const ctx = { isSuperAdmin: true } as never;
const decrypt = (value: string | null) => value?.replace(/^enc:/, '') ?? null;

describe('TransactionSheetService', () => {
  it('matches a line to the employee whose account it names', async () => {
    const { service } = build({});
    const lines = await service.parse(await workbookOf([bankRow({})]));
    const report = await service.reconcile(ctx, 'run-1', lines, decrypt);

    expect(report.matched).toBe(1);
    expect(report.unmatched).toBe(0);
    expect(report.lines[0].matchedEmployeeCode).toBe('EMP001');
  });

  it('matches on the account number, not the beneficiary name', async () => {
    // The name is whatever the beneficiary's own bank holds — misspelled against every HR record in
    // the client's sample — which makes it the field in the file least able to identify anybody.
    const { service } = build({});
    const lines = await service.parse(
      await workbookOf([bankRow({ name: 'Completely Different Person' })]),
    );
    const report = await service.reconcile(ctx, 'run-1', lines, decrypt);

    expect(report.matched).toBe(1);
  });

  it('matches across a leading zero one file kept and the other dropped', async () => {
    // Exactly the inconsistency in the client's own sample. Treating these as different accounts
    // would report every such employee as both unmatched and missing.
    const { service } = build({
      employees: [
        { id: 'e1', employeeCode: 'EMP001', account: '60311000001404' },
      ],
    });
    const lines = await service.parse(
      await workbookOf([bankRow({ account: '0060311000001404' })]),
    );
    const report = await service.reconcile(ctx, 'run-1', lines, decrypt);

    expect(report.matched).toBe(1);
  });

  describe('a bad row is reported, not fatal (T058, T059)', () => {
    it('uploads three good rows and one unreadable one', async () => {
      const { service } = build({
        employees: [
          { id: 'e1', employeeCode: 'EMP001', account: '42855410069' },
          { id: 'e2', employeeCode: 'EMP002', account: '50100750108291' },
          { id: 'e3', employeeCode: 'EMP003', account: '51113750446' },
        ],
      });
      const lines = await service.parse(
        await workbookOf([
          bankRow({ account: '42855410069' }),
          bankRow({ account: '50100750108291' }),
          bankRow({ account: '51113750446' }),
          // No account and no readable amount: present, and unreadable.
          bankRow({ account: null, amount: 'not a number' }),
        ]),
      );
      const report = await service.reconcile(ctx, 'run-1', lines, decrypt);

      expect(report.matched).toBe(3);
      expect(report.unmatched).toBe(1);
      expect(report.lines[3].unmatchedReason).toMatch(/could not be read/i);
    });

    it('says which field was missing', async () => {
      const { service } = build({});
      const lines = await service.parse(
        await workbookOf([bankRow({ account: null })]),
      );
      const report = await service.reconcile(ctx, 'run-1', lines, decrypt);

      expect(report.lines[0].unmatchedReason).toMatch(/beneficiary account/i);
    });

    it('produces unmatched lines rather than an exception when the columns moved', async () => {
      // T059. A bank that reordered its template is a reportable outcome, not a fatal one: the
      // person who has to fix it needs to see which rows still line up.
      const { service } = build({});
      const shifted = new Array(16).fill('');
      shifted[0] = '21/08/2026';
      shifted[6] = 55000;
      const lines = await service.parse(await workbookOf([shifted]));
      const report = await service.reconcile(ctx, 'run-1', lines, decrypt);

      expect(report.unmatched).toBe(1);
      expect(report.lines[0].unmatchedReason).toBeTruthy();
    });

    it('refuses only a file that is not a workbook', async () => {
      // The one fatal case, because the remedy is a different file rather than a report.
      const { service } = build({});
      await expect(
        service.parse(Buffer.from('this is not a spreadsheet')),
      ).rejects.toThrow(/could not be opened/i);
    });

    it('ignores trailing blank rows', async () => {
      // Excel files are full of them. Reporting each as a problem would bury the real ones.
      const { service } = build({});
      const lines = await service.parse(
        await workbookOf([bankRow({}), new Array(16).fill('')]),
      );

      expect(lines).toHaveLength(1);
    });
  });

  describe('differences and gaps are reported separately', () => {
    it('reports the difference between the sheet and the run line by line', async () => {
      // Reported, not judged: a transfer short by a recovery is correct, and this service does not
      // know which differences are expected.
      const { service } = build({ netPay: { e1: 50000 } });
      const lines = await service.parse(
        await workbookOf([bankRow({ amount: 55000 })]),
      );
      const report = await service.reconcile(ctx, 'run-1', lines, decrypt);

      expect(report.lines[0]).toMatchObject({
        sheetAmount: 55000,
        runAmount: 50000,
        difference: 5000,
      });
    });

    it('lists an employee with no line in the sheet as missing, not unmatched', async () => {
      // Money that did not move, which is a different problem from money that moved to somebody the
      // run does not know about — and a different person chases each.
      const { service } = build({
        employees: [
          { id: 'e1', employeeCode: 'EMP001', account: '42855410069' },
          { id: 'e2', employeeCode: 'EMP002', account: '50100750108291' },
        ],
      });
      const lines = await service.parse(await workbookOf([bankRow({})]));
      const report = await service.reconcile(ctx, 'run-1', lines, decrypt);

      expect(report.unmatched).toBe(0);
      expect(report.missingFromSheet).toEqual([
        { employeeId: 'e2', employeeCode: 'EMP002', runAmount: 55000 },
      ]);
    });

    it('reports a line for an account no employee has as unmatched', async () => {
      const { service } = build({});
      const lines = await service.parse(
        await workbookOf([bankRow({ account: '99999999999' })]),
      );
      const report = await service.reconcile(ctx, 'run-1', lines, decrypt);

      expect(report.unmatched).toBe(1);
      expect(report.lines[0].unmatchedReason).toMatch(/no employee/i);
    });
  });

  describe('storage', () => {
    it('stores every line, matched or not (T055)', async () => {
      const { service, stored } = build({});
      const lines = await service.parse(
        await workbookOf([bankRow({}), bankRow({ account: '99999999999' })]),
      );
      await service.reconcile(ctx, 'run-1', lines, decrypt);

      expect(stored).toHaveLength(2);
      expect(stored[1].unmatchedReason).toBeTruthy();
    });

    it('stores the account exactly as the file gave it', async () => {
      // Normalisation is for matching only. Storing the normalised form would lose the leading zero
      // that is part of the account number at the bank.
      const { service, stored } = build({
        employees: [
          { id: 'e1', employeeCode: 'EMP001', account: '60311000001404' },
        ],
      });
      const lines = await service.parse(
        await workbookOf([bankRow({ account: '0060311000001404' })]),
      );
      await service.reconcile(ctx, 'run-1', lines, decrypt);

      expect(stored[0].beneficiaryAccount).toBe('0060311000001404');
    });

    it('replaces the run’s previous upload rather than appending', async () => {
      // A second upload is a correction of the first. Two sets of lines for one run would make
      // "unmatched" a number nobody could interpret.
      const { service, deletedCount } = build({});
      const lines = await service.parse(await workbookOf([bankRow({})]));
      await service.reconcile(ctx, 'run-1', lines, decrypt);

      expect(deletedCount()).toBe(1);
    });

    it('points the match at the payroll line item, not the employee', async () => {
      // A line item is the thing a transfer corresponds to; an employee could appear in two runs.
      const { service, stored } = build({});
      const lines = await service.parse(await workbookOf([bankRow({})]));
      await service.reconcile(ctx, 'run-1', lines, decrypt);

      expect(stored[0].matchedPayrollLineItemId).toBe('li-e1');
    });
  });
});
