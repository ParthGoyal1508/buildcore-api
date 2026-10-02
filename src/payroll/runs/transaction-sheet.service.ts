import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'nestjs-prisma';
import * as ExcelJS from 'exceljs';

import type { BankSheetConfig } from '../../common/configs/config.interface';
import type { RlsContext } from '../../common/prisma/rls-context';
import { withRlsContext } from '../../common/prisma/rls-context';
import {
  BANK_SHEET_COLUMN,
  BANK_SHEET_COLUMN_COUNT,
} from './bank-sheet.service';

/** A line as the bank's file gave it, before anything was matched. */
export interface ParsedSheetLine {
  rowNumber: number;
  beneficiaryName: string | null;
  beneficiaryAccount: string | null;
  ifsc: string | null;
  amount: number | null;
  /** Why this row could not be read at all, if it could not. */
  parseError: string | null;
}

/** One line of the reconciliation report (FR-009, FR-011). */
export interface ReconciledLine {
  rowNumber: number;
  beneficiaryName: string | null;
  beneficiaryAccount: string | null;
  /** Carried through so the stored row keeps every field the file gave. */
  ifsc: string | null;
  sheetAmount: number | null;
  matchedEmployeeId: string | null;
  matchedEmployeeCode: string | null;
  /** The run's own figure for the matched employee, for the difference below. */
  runAmount: number | null;
  /** Sheet minus run. Null when there is nothing to compare. */
  difference: number | null;
  unmatchedReason: string | null;
}

export interface ReconciliationReport {
  runId: string;
  period: string;
  totalLines: number;
  matched: number;
  unmatched: number;
  /** Employees in the run with no line in the sheet — money that did not move. */
  missingFromSheet: {
    employeeId: string;
    employeeCode: string;
    runAmount: number;
  }[];
  lines: ReconciledLine[];
}

/**
 * Reconciling the bank's own transaction sheet against the run (021 FR-008 to FR-011) — the second
 * half of `bugs.md` item 8.
 *
 * ## An unparseable row uploads and is reported
 *
 * **The upload succeeds; the reconciliation is what is incomplete.** A parser that refuses on the
 * first unrecognised row reports nothing at all — which is the opposite of useful when a bank has
 * changed a column and somebody needs to know which rows still line up. SC-004 asks that every line
 * be either matched or reported, and a thrown exception reports none of them.
 *
 * So there is exactly one case this refuses: a file that is not a workbook. Everything inside a
 * workbook that can be opened becomes rows, and rows that cannot be read become rows with a reason.
 *
 * ## Matching is on the account number
 *
 * Not the name. The beneficiary name is whatever the beneficiary's bank holds — misspelled against
 * any HR record in the client's own sample — which makes it the one field in the file least able to
 * identify anybody. The account number is what the transfer was executed against.
 *
 * ## The report says "missing" and "unmatched" separately
 *
 * An employee in the run with no line in the sheet is money that **did not move**. A line in the
 * sheet matching no employee is money that moved to somebody the run does not know about. Those need
 * different people to look at them, and a single "discrepancies" count would send both to whoever
 * asked first.
 */
@Injectable()
export class TransactionSheetService {
  private readonly format: BankSheetConfig;

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
  ) {
    this.format = configService.get<BankSheetConfig>(
      'bankSheet',
    ) as BankSheetConfig;
  }

  /**
   * Parses an uploaded workbook into lines, reading **by column position**.
   *
   * By position and not by header text, because the header is for a human and a bank that renames a
   * column has not changed its file's shape. A sheet whose columns were genuinely reordered produces
   * unmatched lines with reasons, which is the reportable outcome rather than the fatal one.
   */
  async parse(file: Buffer): Promise<ParsedSheetLine[]> {
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(file as never);
    } catch (error) {
      // The one fatal case: this is not a workbook at all. Refused with a code, because the remedy
      // is to upload a different file rather than to look at a report.
      throw new BadRequestException({
        statusCode: 400,
        code: 'TRANSACTION_SHEET_UNREADABLE',
        message:
          'This file could not be opened as a spreadsheet. Upload the .xlsx the bank returned.',
        detail: error instanceof Error ? error.message : undefined,
      });
    }

    const sheet = workbook.worksheets[0];
    if (!sheet) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'TRANSACTION_SHEET_EMPTY',
        message: 'This workbook has no sheets in it.',
      });
    }

    const lines: ParsedSheetLine[] = [];
    sheet.eachRow((row, rowNumber) => {
      // Row 1 is the header. Detected by position rather than by matching its text: a bank that
      // renamed a column still puts its headers on the first row.
      if (rowNumber === 1) return;

      const cell = (index: number): unknown =>
        row.getCell(index + 1).value ?? null;
      const account = asText(cell(BANK_SHEET_COLUMN.beneficiaryAccount));
      const amount = asNumber(cell(BANK_SHEET_COLUMN.paymentAmount));

      // A row where **every** cell is empty is a trailing blank, not a defect. Excel files are full
      // of them, and reporting each as a problem would bury the real ones.
      //
      // Deliberately not "no account and no amount": a row carrying a name, a date and an IFSC but
      // no account is a row somebody has to see, and the first version of this skipped exactly
      // those — including a sheet whose columns the bank had reordered, which it reported as a
      // clean file with nothing in it. Caught by the test for T059.
      const everyCellEmpty = Array.from(
        { length: BANK_SHEET_COLUMN_COUNT },
        (_, index) => asText(cell(index)),
      ).every((value) => value === null);
      if (everyCellEmpty) return;

      lines.push({
        rowNumber,
        beneficiaryName: asText(cell(BANK_SHEET_COLUMN.beneficiaryName)),
        beneficiaryAccount: account,
        ifsc: asText(cell(BANK_SHEET_COLUMN.ifsc)),
        amount,
        parseError:
          !account || amount === null
            ? [
                !account ? 'no beneficiary account number' : null,
                amount === null ? 'no payment amount' : null,
              ]
                .filter(Boolean)
                .join(' and ')
            : null,
      });
    });

    return lines;
  }

  /**
   * Matches parsed lines against the run and reports the differences (FR-009, FR-011).
   *
   * Stores every line, matched or not (T055). The row that could not be read is a row somebody has
   * to see.
   */
  async reconcile(
    ctx: RlsContext,
    runId: string,
    lines: ParsedSheetLine[],
    decrypt: (value: string | null) => string | null,
  ): Promise<ReconciliationReport> {
    const run = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.payrollRun.findFirst({
        where: { id: runId },
        include: { lineItems: true },
      }),
    );
    if (!run) throw new NotFoundException('Payroll run not found');

    const employees = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.employee.findMany({
        where: { id: { in: run.lineItems.map((l) => l.employeeId) } },
        select: {
          id: true,
          employeeCode: true,
          bankAccountNumberEncrypted: true,
        },
      }),
    );

    // Keyed on the **account number**, normalised. A leading zero the bank's file kept and ours
    // dropped (or the reverse) would otherwise look like a different account entirely.
    const byAccount = new Map<string, { id: string; employeeCode: string }>();
    for (const employee of employees) {
      const account = normaliseAccount(
        decrypt(employee.bankAccountNumberEncrypted),
      );
      if (account) {
        byAccount.set(account, {
          id: employee.id,
          employeeCode: employee.employeeCode,
        });
      }
    }
    const runAmountOf = new Map(
      run.lineItems.map((l) => [l.employeeId, l.netPay.toNumber()]),
    );
    // The stored match points at the payroll **line item**, not at the employee: a line item is the
    // thing a transfer corresponds to, and an employee could appear in two runs.
    const lineItemIdOf = new Map(
      run.lineItems.map((l) => [l.employeeId, l.id]),
    );

    const seen = new Set<string>();
    const reconciled: ReconciledLine[] = lines.map((line) => {
      if (line.parseError) {
        return {
          rowNumber: line.rowNumber,
          beneficiaryName: line.beneficiaryName,
          beneficiaryAccount: line.beneficiaryAccount,
          ifsc: line.ifsc,
          sheetAmount: line.amount,
          matchedEmployeeId: null,
          matchedEmployeeCode: null,
          runAmount: null,
          difference: null,
          // The parse problem verbatim: "could not match" would hide that the row was never readable.
          unmatchedReason: `Row could not be read — ${line.parseError}`,
        };
      }

      const key = normaliseAccount(line.beneficiaryAccount);
      const employee = key ? byAccount.get(key) : undefined;
      if (!employee) {
        return {
          rowNumber: line.rowNumber,
          beneficiaryName: line.beneficiaryName,
          beneficiaryAccount: line.beneficiaryAccount,
          ifsc: line.ifsc,
          sheetAmount: line.amount,
          matchedEmployeeId: null,
          matchedEmployeeCode: null,
          runAmount: null,
          difference: null,
          unmatchedReason:
            'No employee in this run has that bank account number',
        };
      }

      seen.add(employee.id);
      const runAmount = runAmountOf.get(employee.id) ?? null;
      return {
        rowNumber: line.rowNumber,
        beneficiaryName: line.beneficiaryName,
        beneficiaryAccount: line.beneficiaryAccount,
        ifsc: line.ifsc,
        sheetAmount: line.amount,
        matchedEmployeeId: employee.id,
        matchedEmployeeCode: employee.employeeCode,
        runAmount,
        // Sheet minus run: positive means the bank moved more than the run said. Reported rather
        // than judged — a transfer short by a recovery is correct, and this service does not know
        // which differences are expected.
        difference:
          line.amount !== null && runAmount !== null
            ? Math.round((line.amount - runAmount) * 100) / 100
            : null,
        unmatchedReason: null,
      };
    });

    // T055. Every line stored, matched or not, and the run's previous upload replaced rather than
    // appended to: a second upload is a correction of the first, and two sets of lines for one run
    // would make "unmatched" a number nobody could interpret.
    await withRlsContext(this.prisma, ctx, async (tx) => {
      await tx.bankTransactionLine.deleteMany({
        where: { payrollRunId: runId },
      });
      if (reconciled.length > 0) {
        await tx.bankTransactionLine.createMany({
          data: reconciled.map((line) => ({
            companyId: run.companyId,
            payrollRunId: runId,
            rowNumber: line.rowNumber,
            beneficiaryName: line.beneficiaryName,
            beneficiaryAccount: line.beneficiaryAccount,
            ifsc: line.ifsc,
            amount: line.sheetAmount,
            matchedPayrollLineItemId: line.matchedEmployeeId
              ? lineItemIdOf.get(line.matchedEmployeeId) ?? null
              : null,
            unmatchedReason: line.unmatchedReason,
          })),
        });
      }
    });

    return {
      runId,
      period: run.period,
      totalLines: reconciled.length,
      matched: reconciled.filter((l) => l.matchedEmployeeId !== null).length,
      unmatched: reconciled.filter((l) => l.matchedEmployeeId === null).length,
      // Money that did **not** move. A separate list from the unmatched lines, because this is the
      // half somebody chases the bank about and the other half is the one somebody chases HR about.
      missingFromSheet: employees
        .filter((e) => !seen.has(e.id))
        .map((e) => ({
          employeeId: e.id,
          employeeCode: e.employeeCode,
          runAmount: runAmountOf.get(e.id) ?? 0,
        })),
      lines: reconciled,
    };
  }
}

/** A cell as trimmed text, whatever type it arrived as. `null` when there is nothing in it. */
function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && 'text' in value) {
    // A rich-text or hyperlink cell. ExcelJS hands these back as objects, and reading `.toString()`
    // on one yields "[object Object]" — which would then be matched against and never match.
    const text = (value as { text?: unknown }).text;
    return typeof text === 'string' ? text.trim() || null : null;
  }
  const text = String(value).trim();
  return text || null;
}

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value;
  // A numeric column the bank wrote as text. Accepted, because refusing it would report a readable
  // row as unreadable; commas are stripped because Indian-format amounts carry them.
  const parsed = Number(String(value).replace(/,/g, '').trim());
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * An account number comparable between two files.
 *
 * Strips whitespace and leading zeros, so a number Excel kept as `0060311000001404` in one file and
 * `60311000001404` in another matches itself. **Only for matching** — never stored or displayed this
 * way, because the leading zero is part of the account number at the bank.
 */
function normaliseAccount(value: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\s/g, '').replace(/^0+/, '');
  return digits || null;
}
