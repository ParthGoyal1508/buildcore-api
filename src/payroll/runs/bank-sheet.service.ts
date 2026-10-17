import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'nestjs-prisma';
import * as ExcelJS from 'exceljs';

import type { BankSheetConfig } from '../../common/configs/config.interface';
import { PayrollRunStatus } from '@prisma/client';
import { withRlsContext } from '../../common/prisma/rls-context';
import type { Caller } from '../../hr/biometrics/face-enrolment.service';
import { PiiCipherService } from '../../hr/employees/pii-cipher.service';
import { BankSheetRecoveryService } from './bank-sheet-recovery.service';
import { PayrollScheduleService } from './payroll-schedule.service';

/**
 * Which column holds what, by **index into the configured header list**.
 *
 * Positions, not names: the bank reads the file by position and the headers are there for a human.
 * Naming them here and ordering them in configuration would be two places to keep one layout
 * correct — see `bankSheet` in `config.ts` for the headers themselves.
 */
export const BANK_SHEET_COLUMN = {
  customDetails1: 0,
  valueDate: 1,
  messageType: 2,
  debitAccount: 3,
  beneficiaryName: 4,
  paymentAmount: 5,
  /**
   * Labelled "Beneficiary Bank Swift Code / IFSC Code" and holding the **IFSC** (FR-008d).
   *
   * Every value under that header in `docs/RING ROAD JULY SALARY.xls` is an IFSC and none is a
   * SWIFT code. The label offers a choice the bank does not actually make.
   */
  ifsc: 6,
  beneficiaryAccount: 7,
  transactionTypeCode: 8,
} as const;

/** Total columns the sheet must carry, blanks included (FR-008a). */
export const BANK_SHEET_COLUMN_COUNT = 16;

/**
 * The IFSC shape: four letters, a zero, then six alphanumerics (FR-008d).
 *
 * Validated **before** export rather than after the bank rejects the file. A malformed IFSC is a
 * payment that fails on payment day, which is the one day nobody has time to fix it.
 */
export const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;

/** A debit account typed for one sheet: digits only, as banks issue them (2026-10-17). */
export const DEBIT_ACCOUNT_PATTERN = /^\d{6,20}$/;

export interface BankSheetOptions {
  /** Overrides the company's payroll debit account for this sheet. */
  debitAccount?: string;
  /** Employees to leave off — paid another way this month. */
  excludeEmployeeIds?: string[];
  /** `Salary_Bank_Sheet_<Company>_<Month>_<Year>.xlsx` rather than the run's own name. */
  companyNamedFile?: boolean;
}

export interface BankSheetLeftOff {
  employeeId: string;
  employeeCode: string;
  name: string;
  netPay: number;
  kind: 'bank_details' | 'excluded' | 'nothing_to_pay';
  reason: string;
}

export interface BankSheetPreview {
  runId: string;
  period: string;
  companyName: string;
  debitAccount: string;
  defaultDebitAccount: string | null;
  employeeCount: number;
  transferTotal: number;
  payrollNetTotal: number;
  recoveredTotal: number;
  leftOffTotal: number;
  reconciles: boolean;
  leftOff: BankSheetLeftOff[];
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** `Salary_Bank_Sheet_<Company>_<Month>_<Year>.xlsx`, the company name made filename-safe. */
export function salaryBankSheetFilename(
  company: string,
  period: string,
): string {
  const [year, month] = period.split('-').map(Number);
  const safe =
    company
      .trim()
      .replace(/[^A-Za-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'Company';
  return `Salary_Bank_Sheet_${safe}_${
    MONTH_NAMES[month - 1] ?? month
  }_${year}.xlsx`;
}

/**
 * The bank transfer sheet for a payroll run (005 FR-017, 021 FR-008a to FR-008g).
 *
 * **The format is the client's bank's, not ours.** Until 2026-10-02 this emitted a seven-column
 * layout of our own invention with a bold TOTAL row — reasonable while the question was open, and
 * wrong in three ways the sample file settled:
 *
 *   * **16 columns in a fixed order, seven of them always empty.** A parser counting columns
 *     rejects a sheet that omits a blank one, so the blanks are emitted.
 *   * **No totals row.** The sample has none, and a total appended to a file read row-by-row
 *     becomes a payment instruction — for the sum of every other row, to whatever account happens
 *     to be on it.
 *   * **Every account number as text.** The sample is inconsistent here: numeric except where a
 *     leading zero forced Excel's hand (`0060311000001404`, `05152122005693`). A numeric cell
 *     destroys the zero, and the first anybody knows is a failed transfer.
 *
 * Deliberately renders the *unmasked* account number: this file is handed to a bank to move money,
 * and a masked account number would make it useless. That makes the export a PII disclosure, so it
 * is gated on the `PAYROLL` permission like the rest of the run surface, and the decryption happens
 * here rather than in a general read path that anything could call.
 */
@Injectable()
export class BankSheetService {
  private readonly format: BankSheetConfig;

  constructor(
    private readonly prisma: PrismaService,
    private readonly pii: PiiCipherService,
    private readonly schedule: PayrollScheduleService,
    /**
     * 021 FR-010 to FR-013. Advances taken *after* the run was drawn up come out of the transfer,
     * not out of the approved run — see the service's own comment.
     */
    private readonly recoveries: BankSheetRecoveryService,
    configService: ConfigService,
  ) {
    this.format = configService.get<BankSheetConfig>(
      'bankSheet',
    ) as BankSheetConfig;
  }

  /**
   * The regular (non-F&F) payroll run for a company and month, finalised — the run the salary
   * bank sheet is generated from (2026-10-17). A run still in draft is not payroll anybody has
   * agreed, so it is refused by name rather than treated as missing.
   */
  async findRegularRun(
    caller: Caller,
    companyId: string,
    period: string,
  ): Promise<{ id: string; status: PayrollRunStatus }> {
    const run = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.payrollRun.findFirst({
        where: { companyId, period, isFnf: false },
        select: { id: true, status: true },
      }),
    );
    if (!run) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'PAYROLL_RUN_NOT_FOUND',
        message: `No payroll has been run for ${period} for this company.`,
      });
    }
    if (run.status === PayrollRunStatus.draft) {
      throw new ConflictException({
        statusCode: 409,
        code: 'PAYROLL_RUN_NOT_FINALISED',
        message: `The payroll for ${period} is still a draft. Process it before generating the bank sheet.`,
      });
    }
    return run;
  }

  /**
   * What the sheet would contain, without producing it or recovering anything (2026-10-17): the
   * count and total the bank will be asked to pay, everyone left off and why, and whether it all adds
   * back up to the payroll's net pay.
   */
  async preview(
    caller: Caller,
    runId: string,
    options: BankSheetOptions = {},
  ): Promise<BankSheetPreview> {
    const computed = await this.compute(caller, runId, options, false);
    return {
      runId,
      period: computed.run.period,
      companyName: computed.companyName,
      debitAccount: computed.debitAccount,
      defaultDebitAccount: computed.defaultDebitAccount,
      employeeCount: computed.rows.length,
      transferTotal: computed.transferTotal,
      payrollNetTotal: computed.payrollNetTotal,
      recoveredTotal: computed.recoveredTotal,
      leftOffTotal: computed.leftOffTotal,
      reconciles: computed.reconciles,
      leftOff: computed.leftOff,
    };
  }

  async build(
    caller: Caller,
    runId: string,
    options: BankSheetOptions = {},
  ): Promise<{ buffer: Buffer; filename: string }> {
    const computed = await this.compute(caller, runId, options, true);
    const { run, rows, debitAccount } = computed;
    const valueDate = this.valueDateFor(new Date());

    const workbook = new ExcelJS.Workbook();
    workbook.created = new Date();
    const sheet = workbook.addWorksheet('Sheet1');

    // `columns` with widths and no `key`: rows are written as positional arrays, because the
    // contract is the order. A keyed row would let a reordered config silently move a value into
    // the wrong column while every key still looked right.
    sheet.columns = this.format.columns.map((header) => ({
      header,
      width: Math.max(14, header.length + 2),
    }));
    if (sheet.columns.length !== BANK_SHEET_COLUMN_COUNT) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'BANK_SHEET_FORMAT_INVALID',
        message:
          `The configured bank sheet format has ${sheet.columns.length} columns; the bank's ` +
          `template has ${BANK_SHEET_COLUMN_COUNT}. A parser counting columns rejects the file.`,
      });
    }

    // Employees who cannot be paid by transfer are listed on a second sheet rather than dropped,
    // because a bank sheet whose total silently differs from the payroll total is how someone goes
    // unpaid without anyone noticing. The *first* sheet stays exactly the bank's template — a
    // second worksheet is ignored by a parser reading Sheet1 by position.
    const unpayable = workbook.addWorksheet('Not Transferable');
    unpayable.columns = [
      { header: 'Employee Code', key: 'code', width: 16 },
      { header: 'Employee Name', key: 'name', width: 28 },
      { header: 'Net Pay', key: 'net', width: 14 },
      { header: 'Reason', key: 'reason', width: 52 },
    ];
    unpayable.getRow(1).font = { bold: true };
    for (const left of computed.leftOff) {
      unpayable.addRow({
        code: left.employeeCode,
        name: left.name,
        net: left.netPay,
        reason: left.reason,
      });
    }

    /**
     * FR-011. Each recovery as a **named line**, never a netted figure.
     *
     * A third worksheet, because the bank's template has no column for it and must not grow one.
     * Without this sheet the only record of why a transfer is short of the payslip is a row in a
     * table nobody looking at the file can see — and "my transfer does not match my payslip" is the
     * question this is here to answer before it is asked.
     */
    const recoverySheet = workbook.addWorksheet('Advance Recoveries');
    recoverySheet.columns = [
      { header: 'Employee Code', key: 'code', width: 16 },
      { header: 'Employee Name', key: 'name', width: 28 },
      { header: 'Net Pay (as approved)', key: 'net', width: 20 },
      { header: 'Advance Recovered', key: 'recovered', width: 18 },
      { header: 'Advance Reference', key: 'advance', width: 28 },
      { header: 'Amount Transferred', key: 'transfer', width: 20 },
    ];
    recoverySheet.getRow(1).font = { bold: true };

    for (const r of rows) {
      const row: (string | number)[] = new Array(BANK_SHEET_COLUMN_COUNT).fill(
        '',
      );
      row[BANK_SHEET_COLUMN.valueDate] = valueDate;
      row[BANK_SHEET_COLUMN.messageType] = this.format.messageType;
      // A string, always. The sample's single debit account is `09310400000819`, and a numeric cell
      // loses that leading zero before anybody looks at the file.
      row[BANK_SHEET_COLUMN.debitAccount] = debitAccount;
      // FR-008e. The **bank's** name for the account holder, never the employee master's — see
      // `refusalFor`, which refuses rather than falling back.
      row[BANK_SHEET_COLUMN.beneficiaryName] = r.holderName;
      // The one genuinely numeric cell. An amount is arithmetic and the bank totals the column.
      row[BANK_SHEET_COLUMN.paymentAmount] = r.transfer.transferAmount;
      row[BANK_SHEET_COLUMN.ifsc] = r.ifsc;
      row[BANK_SHEET_COLUMN.beneficiaryAccount] = r.account;
      row[BANK_SHEET_COLUMN.transactionTypeCode] =
        this.format.transactionTypeCode;
      sheet.addRow(row);

      // One line per advance, not one per employee: an employee with two advances recovered has two
      // facts to account for, and a single summed row leaves them indistinguishable from one larger
      // advance.
      for (const recovery of r.transfer.recoveries) {
        recoverySheet.addRow({
          code: r.employeeCode,
          name: r.name,
          net: r.transfer.netPay,
          recovered: recovery.amount,
          advance: recovery.salaryAdvanceId,
          transfer: r.transfer.transferAmount,
        });
      }
    }

    // Header row and payment rows only (FR-008g). **No totals row** — see the class comment.
    // `numFmt '@'` on the two account columns so a reader opening the file does not re-parse a
    // numeric-looking string back into a number. The cell *values* are already strings, which is
    // what actually preserves the digits; this stops Excel undoing it on the way in.
    sheet.getColumn(BANK_SHEET_COLUMN.debitAccount + 1).numFmt = '@';
    sheet.getColumn(BANK_SHEET_COLUMN.beneficiaryAccount + 1).numFmt = '@';
    sheet.getColumn(BANK_SHEET_COLUMN.valueDate + 1).numFmt = '@';
    sheet.getColumn(BANK_SHEET_COLUMN.paymentAmount + 1).numFmt = '#,##0.00';
    unpayable.getColumn('net').numFmt = '#,##0.00';
    for (const key of ['net', 'recovered', 'transfer']) {
      recoverySheet.getColumn(key).numFmt = '#,##0.00';
    }

    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    return {
      buffer,
      filename: options.companyNamedFile
        ? salaryBankSheetFilename(computed.companyName, run.period)
        : `bank-transfer-${run.period}${run.isFnf ? '-fnf' : ''}.xlsx`,
    };
  }

  /**
   * Everything the sheet and its preview share: the approval gate, the debit account, each
   * employee's transfer after advance recoveries, and who is left off and why.
   *
   * `write` is true only for the download — recovering an advance is money moving, and a preview
   * that recorded recoveries would take them again from nobody's file.
   */
  private async compute(
    caller: Caller,
    runId: string,
    options: BankSheetOptions,
    write: boolean,
  ) {
    const run = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.payrollRun.findFirst({
        where: { id: runId },
        include: { lineItems: true },
      }),
    );
    if (!run) throw new NotFoundException('Payroll run not found');

    // 016 FR-015: a run may not produce a bank transfer sheet until its approval chain
    // is complete. This is the point where the chain stops being paperwork and starts
    // being control — everything before it is a record of opinions; this is the file
    // that moves money.
    //
    // The refusal names the outstanding level, because "not approved" leaves whoever is
    // waiting to guess whose desk it is on.
    const outstanding = await this.schedule.outstandingApproval(
      run.companyId,
      run.id,
    );
    if (outstanding && !outstanding.submitted) {
      // 2026-10-17: a run processed by hand before processing submitted it. Said plainly, with the
      // run named, so the screen can offer to submit it rather than leave everyone waiting on an
      // approval nobody was ever asked for.
      throw new ConflictException({
        statusCode: 409,
        message:
          'This payroll run has not been submitted for approval yet. Submit it, and the bank ' +
          'sheet can be produced once every level has approved.',
        code: 'PAYROLL_RUN_NOT_SUBMITTED',
        runId: run.id,
      });
    }
    if (outstanding) {
      throw new ConflictException({
        statusCode: 409,
        message:
          outstanding.state === 'pending'
            ? `This payroll run is awaiting ${
                outstanding.levelLabel ?? 'approval'
              }. A bank transfer sheet cannot be produced until every level has approved.`
            : `This payroll run was ${outstanding.state} and cannot produce a bank ` +
              `transfer sheet.`,
        code: 'PAYROLL_RUN_NOT_APPROVED',
      });
    }

    const [company, employees] = await Promise.all([
      withRlsContext(this.prisma, { isSuperAdmin: true }, (tx) =>
        tx.company.findUnique({
          where: { id: run.companyId },
          select: { name: true, payrollDebitAccountNumber: true },
        }),
      ),
      withRlsContext(this.prisma, caller.rls, (tx) =>
        tx.employee.findMany({
          where: { id: { in: run.lineItems.map((l) => l.employeeId) } },
        }),
      ),
    ]);

    const defaultDebitAccount =
      company?.payrollDebitAccountNumber?.trim() || null;
    // 2026-10-17: the account the money leaves from may be chosen for this sheet; the company's
    // payroll account is the default.
    const debitAccount = options.debitAccount?.trim() || defaultDebitAccount;
    if (!debitAccount) {
      // Refused for the whole file, not skipped per row: every row names the same debit account,
      // and a sheet with that column blank is a sheet the bank cannot act on at all.
      throw new BadRequestException({
        statusCode: 400,
        code: 'PAYROLL_DEBIT_ACCOUNT_UNSET',
        message:
          'This company has no payroll debit account on file. Every row of a transfer sheet ' +
          'names the account the money leaves from, so the sheet cannot be produced without it.',
      });
    }
    if (!DEBIT_ACCOUNT_PATTERN.test(debitAccount)) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'PAYROLL_DEBIT_ACCOUNT_INVALID',
        message: 'The debit account number should be 6 to 20 digits.',
      });
    }

    const byId = new Map(employees.map((e) => [e.id, e]));
    const excluded = new Set(options.excludeEmployeeIds ?? []);
    const leftOff: BankSheetLeftOff[] = [];
    const payable: {
      line: (typeof run.lineItems)[number];
      employee: (typeof employees)[number];
      name: string;
      account: string;
    }[] = [];

    for (const line of run.lineItems) {
      const employee = byId.get(line.employeeId);
      if (!employee) continue;
      const name = [employee.firstName, employee.lastName]
        .filter(Boolean)
        .join(' ')
        .trim();
      const base = {
        employeeId: employee.id,
        employeeCode: employee.employeeCode,
        name,
        netPay: line.netPay.toNumber(),
      };
      // 2026-10-17: only net pay above zero is a payment; a zero row is an instruction to move
      // nothing, which some banks reject outright.
      if (line.netPay.toNumber() <= 0) {
        leftOff.push({
          ...base,
          kind: 'nothing_to_pay',
          reason: 'Net pay is zero',
        });
        continue;
      }
      if (excluded.has(employee.id)) {
        leftOff.push({
          ...base,
          kind: 'excluded',
          reason:
            'Excluded when the sheet was generated — to be paid another way',
        });
        continue;
      }
      const account = this.pii.decrypt(employee.bankAccountNumberEncrypted);
      const refusal = this.refusalFor({
        account,
        ifsc: employee.ifscCode,
        holderName: employee.bankAccountHolderName,
      });
      if (refusal) {
        leftOff.push({ ...base, kind: 'bank_details', reason: refusal });
        continue;
      }
      payable.push({ line, employee, name, account: String(account) });
    }

    // FR-010. Applied before a single row is written, because the figure on the row is the transfer
    // and not the run's net pay. Idempotent — regenerating the sheet recovers nothing further, which
    // is the database's `@@unique([payrollRunId, salaryAdvanceId])` doing the work rather than a
    // check in this method.
    const transfers = await this.recoveries.apply(
      caller.rls,
      {
        id: run.id,
        companyId: run.companyId,
        // `generatedAt` where the run has one: that is when its figures were fixed, and an advance
        // taken after it is an advance the run could not have recovered.
        drawnUpAt: run.generatedAt ?? run.createdAt,
      },
      payable.map((p) => ({
        employeeId: p.employee.id,
        netPay: p.line.netPay.toNumber(),
      })),
      { write },
    );

    const rows = payable
      .map((p) => ({
        employeeId: p.employee.id,
        employeeCode: p.employee.employeeCode,
        name: p.name,
        holderName: p.employee.bankAccountHolderName as string,
        ifsc: (p.employee.ifscCode as string).trim().toUpperCase(),
        account: p.account,
        transfer: transfers.get(p.employee.id) ?? {
          employeeId: p.employee.id,
          netPay: p.line.netPay.toNumber(),
          recoveries: [],
          recoveredTotal: 0,
          transferAmount: p.line.netPay.toNumber(),
        },
      }))
      // A transfer an advance recovery took to zero moves nothing either.
      .filter((r) => r.transfer.transferAmount > 0);

    const sum = (values: number[]) =>
      Math.round(values.reduce((a, b) => a + b, 0) * 100) / 100;
    const transferTotal = sum(rows.map((r) => r.transfer.transferAmount));
    const recoveredTotal = sum(
      [...transfers.values()].map((t) => t.recoveredTotal),
    );
    const leftOffTotal = sum(leftOff.map((l) => l.netPay));
    const payrollNetTotal = sum(run.lineItems.map((l) => l.netPay.toNumber()));

    return {
      run,
      companyName: company?.name ?? '',
      debitAccount,
      defaultDebitAccount,
      rows,
      leftOff,
      transferTotal,
      recoveredTotal,
      leftOffTotal,
      payrollNetTotal,
      // The sheet's total, plus what advances took, plus everyone left off, must be the payroll's
      // net pay to the paisa. Anything else means someone was paid twice or not at all.
      reconciles:
        Math.abs(
          transferTotal + recoveredTotal + leftOffTotal - payrollNetTotal,
        ) < 0.01,
    };
  }

  /**
   * Why this employee cannot be on the transfer sheet, or `null` if they can (FR-008f, task T101).
   *
   * **Each reason names the field**, because the person reading this sheet is the person who has to
   * fix it before payment day, and "not transferable" sends them looking through four screens.
   */
  private refusalFor(input: {
    account: string | null;
    ifsc: string | null;
    holderName: string | null;
  }): string | null {
    if (!input.account) return 'No bank account number on file';
    if (!input.ifsc) return 'No IFSC code on file';
    if (!IFSC_PATTERN.test(input.ifsc.trim().toUpperCase())) {
      // Checked here rather than left to the bank. An IFSC is four letters, a zero, six
      // alphanumerics; anything else is a transfer that fails after the file was accepted.
      return `IFSC "${input.ifsc}" is not a valid IFSC (four letters, 0, then six characters)`;
    }
    if (!input.holderName?.trim()) {
      // FR-008e, task T100. **Not substituted with the employee's name.** In the sample these
      // disagree with any HR record because they match the beneficiary's own bank, and a name the
      // bank does not recognise is a returned payment. A silent fallback would move that discovery
      // to payment day; a refusal keeps it here, where somebody can still act on it.
      return 'No bank account holder name on file — the name the bank holds against this account';
    }
    return null;
  }

  /**
   * `Value Date` as **text** (FR-008c).
   *
   * Not a date cell. A real date is re-rendered by whatever locale opens the file, and `21/08/2026`
   * read as month 21 is a rejected file — which is a thing that happens on one machine and not
   * another, making it the worst class of bug to diagnose.
   */
  private valueDateFor(when: Date): string {
    const day = String(when.getDate()).padStart(2, '0');
    const month = String(when.getMonth() + 1).padStart(2, '0');
    const year = String(when.getFullYear());
    return this.format.valueDateFormat === 'YYYY-MM-DD'
      ? `${year}-${month}-${day}`
      : `${day}/${month}/${year}`;
  }
}
