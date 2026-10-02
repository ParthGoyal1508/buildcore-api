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
import { withRlsContext } from '../../common/prisma/rls-context';
import type { Caller } from '../../hr/biometrics/face-enrolment.service';
import { PiiCipherService } from '../../hr/employees/pii-cipher.service';
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
    configService: ConfigService,
  ) {
    this.format = configService.get<BankSheetConfig>(
      'bankSheet',
    ) as BankSheetConfig;
  }

  async build(
    caller: Caller,
    runId: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
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
          select: { payrollDebitAccountNumber: true },
        }),
      ),
      withRlsContext(this.prisma, caller.rls, (tx) =>
        tx.employee.findMany({
          where: { id: { in: run.lineItems.map((l) => l.employeeId) } },
        }),
      ),
    ]);

    const debitAccount = company?.payrollDebitAccountNumber?.trim();
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

    const byId = new Map(employees.map((e) => [e.id, e]));
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

    for (const line of run.lineItems) {
      const employee = byId.get(line.employeeId);
      if (!employee) continue;
      const name = [employee.firstName, employee.lastName]
        .filter(Boolean)
        .join(' ')
        .trim();
      const net = line.netPay.toNumber();
      const account = this.pii.decrypt(employee.bankAccountNumberEncrypted);

      const refusal = this.refusalFor({
        account,
        ifsc: employee.ifscCode,
        holderName: employee.bankAccountHolderName,
      });
      if (refusal) {
        unpayable.addRow({
          code: employee.employeeCode,
          name,
          net,
          reason: refusal,
        });
        continue;
      }

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
      row[BANK_SHEET_COLUMN.beneficiaryName] =
        employee.bankAccountHolderName as string;
      // The one genuinely numeric cell. An amount is arithmetic and the bank totals the column.
      row[BANK_SHEET_COLUMN.paymentAmount] = net;
      row[BANK_SHEET_COLUMN.ifsc] = (employee.ifscCode as string).toUpperCase();
      row[BANK_SHEET_COLUMN.beneficiaryAccount] = String(account);
      row[BANK_SHEET_COLUMN.transactionTypeCode] =
        this.format.transactionTypeCode;

      sheet.addRow(row);
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

    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    return {
      buffer,
      filename: `bank-transfer-${run.period}${run.isFnf ? '-fnf' : ''}.xlsx`,
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
