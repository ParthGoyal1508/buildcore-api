import * as ExcelJS from 'exceljs';

import {
  BANK_SHEET_COLUMN,
  BANK_SHEET_COLUMN_COUNT,
  BankSheetService,
  IFSC_PATTERN,
} from './bank-sheet.service';

/**
 * The bank transaction sheet against the client's own file (021 FR-008a to FR-008g, tasks T095 to
 * T103).
 *
 * **Every assertion here reads the bytes back out of the generated workbook**, and that is not
 * thoroughness for its own sake: the bug this phase exists to prevent lives in the *cell type*. A
 * test that checked the value passed in would pass while the account number was written as a number
 * and its leading zero destroyed on the way to disk.
 */

const FORMAT = {
  columns: [
    'CUSTOM_DETAILS1',
    'Value Date',
    'Message Type',
    'Debit Account No.',
    'Beneficiary Name',
    'Payment Amount',
    'Beneficiary Bank Swift Code / IFSC Code',
    'Beneficiary Account No.',
    'Transaction Type Code',
    'CUSTOM_DETAILS2',
    'CUSTOM_DETAILS3',
    'CUSTOM_DETAILS4',
    'CUSTOM_DETAILS5',
    'CUSTOM_DETAILS6',
    'Remarks',
    'Purpose Of Payment',
  ],
  messageType: 'NEFT',
  transactionTypeCode: 'NEFT',
  valueDateFormat: 'DD/MM/YYYY' as const,
};

interface EmployeeFixture {
  id: string;
  employeeCode: string;
  firstName: string;
  lastName: string;
  bankAccountNumberEncrypted: string | null;
  ifscCode: string | null;
  bankAccountHolderName: string | null;
}

function employee(over: Partial<EmployeeFixture> = {}): EmployeeFixture {
  return {
    id: 'e1',
    employeeCode: 'EMP001',
    firstName: 'Arvind',
    lastName: 'Kumar',
    bankAccountNumberEncrypted: 'enc:42855410069',
    ifscCode: 'SBIN0062263',
    // The sample's own misspelling. The beneficiary's bank holds "Arivnd"; HR holds "Arvind".
    bankAccountHolderName: 'Arivnd',
    ...over,
  };
}

function build(opts: {
  employees?: EmployeeFixture[];
  netPay?: number[];
  debitAccount?: string | null;
  /** Advances recovered from the transfer, keyed by employee (021 FR-010, FR-011). */
  recoveries?: Record<string, { salaryAdvanceId: string; amount: number }[]>;
}) {
  const employees = opts.employees ?? [employee()];
  const nets = opts.netPay ?? employees.map(() => 55000);

  const tx = {
    $executeRaw: async () => 0,
    payrollRun: {
      findFirst: async () => ({
        id: 'run-1',
        companyId: 'co-1',
        period: '2026-07',
        isFnf: false,
        generatedAt: new Date('2026-07-31T00:00:00.000Z'),
        createdAt: new Date('2026-07-31T00:00:00.000Z'),
        lineItems: employees.map((e, index) => ({
          employeeId: e.id,
          netPay: { toNumber: () => nets[index] },
        })),
      }),
    },
    company: {
      findUnique: async () => ({
        payrollDebitAccountNumber:
          opts.debitAccount === undefined
            ? '09310400000819'
            : opts.debitAccount,
      }),
    },
    employee: { findMany: async () => employees },
  };
  const prisma = {
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };
  // Decryption is not what this spec is about; the prefix makes the round trip visible.
  const pii = {
    decrypt: (value: string | null) => value?.replace(/^enc:/, '') ?? null,
  };
  const schedule = { outstandingApproval: async () => null };
  const config = { get: () => FORMAT };
  // 021 FR-010. Recovers nothing by default — these tests are about the file's shape, and a fixture
  // that quietly reduced a transfer would make every amount assertion wrong for an unrelated reason.
  const recoveries = {
    apply: async (
      _ctx: unknown,
      _run: unknown,
      lines: { employeeId: string; netPay: number }[],
    ) =>
      new Map(
        lines.map((l) => [
          l.employeeId,
          {
            employeeId: l.employeeId,
            netPay: l.netPay,
            recoveries: opts.recoveries?.[l.employeeId] ?? [],
            recoveredTotal: (opts.recoveries?.[l.employeeId] ?? []).reduce(
              (sum, r) => sum + r.amount,
              0,
            ),
            transferAmount:
              l.netPay -
              (opts.recoveries?.[l.employeeId] ?? []).reduce(
                (sum, r) => sum + r.amount,
                0,
              ),
          },
        ]),
      ),
  };

  return new BankSheetService(
    prisma as never,
    pii as never,
    schedule as never,
    recoveries as never,
    config as never,
  );
}

/** Reads the generated file back, which is the only way to see a cell's type. */
async function sheetOf(buffer: Buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as never);
  return {
    main: workbook.getWorksheet('Sheet1'),
    unpayable: workbook.getWorksheet('Not Transferable'),
  };
}

const caller = { rls: { isSuperAdmin: true } } as never;

describe('BankSheetService — the client’s bank format', () => {
  it('writes the 16 headers in the sample’s exact order', async () => {
    const { buffer } = await build({}).build(caller, 'run-1');
    const { main } = await sheetOf(buffer);

    const header = main!.getRow(1);
    // Including the seven that are always empty. A parser counting columns rejects a sheet that
    // omits a blank one, which is why the blanks are not an oversight to tidy up.
    expect(header.cellCount).toBe(BANK_SHEET_COLUMN_COUNT);
    expect(
      Array.from({ length: BANK_SHEET_COLUMN_COUNT }, (_, i) =>
        String(header.getCell(i + 1).value),
      ),
    ).toEqual(FORMAT.columns);
  });

  it('writes a header row and payment rows and nothing else', async () => {
    // T102. No totals row: a total appended to a file read row-by-row becomes a payment
    // instruction, for the sum of every other row, to whatever account happens to be on it.
    const { buffer } = await build({
      employees: [employee(), employee({ id: 'e2', employeeCode: 'EMP002' })],
    }).build(caller, 'run-1');
    const { main } = await sheetOf(buffer);

    expect(main!.rowCount).toBe(3);
    expect(String(main!.getRow(3).getCell(1).value ?? '')).not.toMatch(
      /total/i,
    );
  });

  describe('an account number’s leading zero survives (T096, T097)', () => {
    it('writes the beneficiary account as a text cell', async () => {
      const { buffer } = await build({
        employees: [
          employee({ bankAccountNumberEncrypted: 'enc:0060311000001404' }),
        ],
      }).build(caller, 'run-1');
      const { main } = await sheetOf(buffer);

      const cell = main!
        .getRow(2)
        .getCell(BANK_SHEET_COLUMN.beneficiaryAccount + 1);
      // The assertion that matters, and it is on the type rather than the value: a numeric cell
      // destroys the zero, and the first anybody knows is a failed transfer on payment day.
      expect(typeof cell.value).toBe('string');
      expect(cell.value).toBe('0060311000001404');
    });

    it('writes an account with no leading zero as text too', async () => {
      // The sample is inconsistent here — numeric except where a zero forced Excel's hand. Being
      // consistent is the fix: "text when it starts with a zero" is a rule somebody has to get
      // right every time.
      const { buffer } = await build({
        employees: [
          employee({ bankAccountNumberEncrypted: 'enc:42855410069' }),
        ],
      }).build(caller, 'run-1');
      const { main } = await sheetOf(buffer);

      const cell = main!
        .getRow(2)
        .getCell(BANK_SHEET_COLUMN.beneficiaryAccount + 1);
      expect(typeof cell.value).toBe('string');
      expect(cell.value).toBe('42855410069');
    });

    it('writes the debit account as text', async () => {
      const { buffer } = await build({}).build(caller, 'run-1');
      const { main } = await sheetOf(buffer);

      const cell = main!.getRow(2).getCell(BANK_SHEET_COLUMN.debitAccount + 1);
      expect(typeof cell.value).toBe('string');
      expect(cell.value).toBe('09310400000819');
    });
  });

  it('writes Value Date as DD/MM/YYYY text, not a date', async () => {
    // T098. A real date is re-rendered by whatever locale opens the file, and `21/08/2026` read as
    // month 21 is a rejected file — on one machine and not another, which is the worst kind.
    const { buffer } = await build({}).build(caller, 'run-1');
    const { main } = await sheetOf(buffer);

    const cell = main!.getRow(2).getCell(BANK_SHEET_COLUMN.valueDate + 1);
    expect(typeof cell.value).toBe('string');
    expect(cell.value).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    expect(cell.value instanceof Date).toBe(false);
  });

  it('puts the IFSC in the SWIFT/IFSC column', async () => {
    // T099. Every value under that header in the sample is an IFSC and none is a SWIFT code; the
    // label offers a choice the bank does not make.
    const { buffer } = await build({}).build(caller, 'run-1');
    const { main } = await sheetOf(buffer);

    expect(main!.getRow(2).getCell(BANK_SHEET_COLUMN.ifsc + 1).value).toBe(
      'SBIN0062263',
    );
  });

  it('writes the payment amount as a number', async () => {
    // The one genuinely numeric cell: an amount is arithmetic, and the bank totals the column.
    const { buffer } = await build({ netPay: [12629.5] }).build(
      caller,
      'run-1',
    );
    const { main } = await sheetOf(buffer);

    expect(
      main!.getRow(2).getCell(BANK_SHEET_COLUMN.paymentAmount + 1).value,
    ).toBe(12629.5);
  });

  describe('the beneficiary name comes from the bank, not from HR (T100, T101)', () => {
    it('uses the bank account holder name even where it disagrees with the employee', async () => {
      const { buffer } = await build({}).build(caller, 'run-1');
      const { main } = await sheetOf(buffer);

      const cell = main!
        .getRow(2)
        .getCell(BANK_SHEET_COLUMN.beneficiaryName + 1);
      expect(cell.value).toBe('Arivnd');
      // The point of the whole task: not the employee master's spelling.
      expect(cell.value).not.toBe('Arvind Kumar');
    });

    it('refuses a row with no holder name rather than substituting one', async () => {
      // A silent fallback would move the discovery to payment day. The refusal keeps it here.
      const { buffer } = await build({
        employees: [employee({ bankAccountHolderName: null })],
      }).build(caller, 'run-1');
      const { main, unpayable } = await sheetOf(buffer);

      expect(main!.rowCount).toBe(1);
      expect(unpayable!.rowCount).toBe(2);
      expect(String(unpayable!.getRow(2).getCell(4).value)).toMatch(
        /holder name/i,
      );
    });

    it('refuses a blank-but-present holder name', async () => {
      const { buffer } = await build({
        employees: [employee({ bankAccountHolderName: '   ' })],
      }).build(caller, 'run-1');
      const { main } = await sheetOf(buffer);

      expect(main!.rowCount).toBe(1);
    });
  });

  describe('refusals name the field to fix', () => {
    it.each([
      [
        'no account number',
        employee({ bankAccountNumberEncrypted: null }),
        /account number/i,
      ],
      ['no IFSC', employee({ ifscCode: null }), /IFSC/],
      ['a malformed IFSC', employee({ ifscCode: 'SBI123' }), /not a valid/i],
    ])('reports %s', async (_label, fixture, pattern) => {
      const { buffer } = await build({ employees: [fixture] }).build(
        caller,
        'run-1',
      );
      const { main, unpayable } = await sheetOf(buffer);

      // Listed, never dropped: a bank sheet whose total silently differs from the payroll total is
      // how somebody goes unpaid without anyone noticing.
      expect(main!.rowCount).toBe(1);
      expect(String(unpayable!.getRow(2).getCell(4).value)).toMatch(pattern);
    });
  });

  it('refuses the whole file when the company has no debit account', async () => {
    // Every row names the same debit account, so a sheet with that column blank is one the bank
    // cannot act on at all — a per-row skip would produce an empty file and call it success.
    await expect(
      build({ debitAccount: null }).build(caller, 'run-1'),
    ).rejects.toThrow(/debit account/i);
  });
});

describe('IFSC_PATTERN', () => {
  it('accepts every IFSC in the client’s sample', () => {
    // Read out of `docs/RING ROAD JULY SALARY.xls`. A pattern that rejected a real one would make
    // the export refuse rows the bank would have accepted.
    for (const ifsc of [
      'SBIN0062263',
      'HDFC0002533',
      'SBIN0032073',
      'SBIN0032458',
      'SBIN0007095',
      'HDFC0000104',
    ]) {
      expect(IFSC_PATTERN.test(ifsc)).toBe(true);
    }
  });

  it('rejects the shapes that fail at the bank', () => {
    expect(IFSC_PATTERN.test('SBI123')).toBe(false);
    // Fifth character must be a zero — it is the reserved position in the format.
    expect(IFSC_PATTERN.test('SBIN1062263')).toBe(false);
    expect(IFSC_PATTERN.test('SBIN006226')).toBe(false);
    expect(IFSC_PATTERN.test('sbin0062263')).toBe(false);
  });
});

/**
 * Advances recovered from the **transfer** (021 FR-010, FR-011, task T046) — `bugs.md` item 9.
 *
 * The run's own figures stay as approved; the difference is a recovery. These assertions are on the
 * generated file because that is where the distinction is visible to the person paying.
 */
describe('advance recoveries on the sheet', () => {
  it('transfers net pay less the recovery, not net pay', async () => {
    const { buffer } = await build({
      netPay: [55000],
      recoveries: { e1: [{ salaryAdvanceId: 'adv-1', amount: 5000 }] },
    }).build(caller, 'run-1');
    const { main } = await sheetOf(buffer);

    expect(
      main!.getRow(2).getCell(BANK_SHEET_COLUMN.paymentAmount + 1).value,
    ).toBe(50000);
  });

  it('names each recovery on its own line', async () => {
    // T046. One line per advance, not one per employee: two advances are two facts to account for,
    // and a summed row leaves them indistinguishable from one larger advance.
    const { buffer } = await build({
      netPay: [55000],
      recoveries: {
        e1: [
          { salaryAdvanceId: 'adv-1', amount: 5000 },
          { salaryAdvanceId: 'adv-2', amount: 2500 },
        ],
      },
    }).build(caller, 'run-1');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as never);
    const recoverySheet = workbook.getWorksheet('Advance Recoveries');

    expect(recoverySheet!.rowCount).toBe(3);
    expect(recoverySheet!.getRow(2).getCell(5).value).toBe('adv-1');
    expect(recoverySheet!.getRow(3).getCell(5).value).toBe('adv-2');
  });

  it('shows the approved net pay beside the transfer', async () => {
    // "My transfer does not match my payslip" is the question this sheet answers before it is asked.
    // Showing only the transfer would leave the difference unexplained in the file itself.
    const { buffer } = await build({
      netPay: [55000],
      recoveries: { e1: [{ salaryAdvanceId: 'adv-1', amount: 5000 }] },
    }).build(caller, 'run-1');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as never);
    const row = workbook.getWorksheet('Advance Recoveries')!.getRow(2);

    expect(row.getCell(3).value).toBe(55000);
    expect(row.getCell(4).value).toBe(5000);
    expect(row.getCell(6).value).toBe(50000);
  });

  it('leaves the bank template itself untouched by the recovery sheet', async () => {
    // The recovery report is a third worksheet because the bank's template has no column for it and
    // must not grow one. A parser reading Sheet1 by position never sees this.
    const { buffer } = await build({
      recoveries: { e1: [{ salaryAdvanceId: 'adv-1', amount: 5000 }] },
    }).build(caller, 'run-1');
    const { main } = await sheetOf(buffer);

    expect(main!.getRow(1).cellCount).toBe(BANK_SHEET_COLUMN_COUNT);
    expect(main!.rowCount).toBe(2);
  });

  it('writes no recovery lines when nothing was recovered', async () => {
    const { buffer } = await build({}).build(caller, 'run-1');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as never);

    expect(workbook.getWorksheet('Advance Recoveries')!.rowCount).toBe(1);
  });
});
