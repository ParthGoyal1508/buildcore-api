import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';
import * as ExcelJS from 'exceljs';

import { withRlsContext } from '../../common/prisma/rls-context';
import type { Caller } from '../../hr/biometrics/face-enrolment.service';
import { PiiCipherService } from '../../hr/employees/pii-cipher.service';

/**
 * The bank transfer sheet for a payroll run (005 FR-017).
 *
 * Deliberately renders the *unmasked* account number: this file is handed to a bank
 * to move money, and a masked account number would make it useless. That makes the
 * export a PII disclosure, so it is gated on the `PAYROLL` permission like the rest
 * of the run surface, and the decryption happens here rather than in a general read
 * path that anything could call.
 */
@Injectable()
export class BankSheetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pii: PiiCipherService,
  ) {}

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

    const employees = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.employee.findMany({
        where: { id: { in: run.lineItems.map((l) => l.employeeId) } },
      }),
    );
    const byId = new Map(employees.map((e) => [e.id, e]));

    const workbook = new ExcelJS.Workbook();
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Bank Transfer');
    sheet.columns = [
      { header: 'Employee Code', key: 'code', width: 16 },
      { header: 'Employee Name', key: 'name', width: 28 },
      { header: 'Bank Name', key: 'bank', width: 24 },
      { header: 'Branch', key: 'branch', width: 20 },
      { header: 'Account Number', key: 'account', width: 24 },
      { header: 'IFSC', key: 'ifsc', width: 14 },
      { header: 'Net Pay', key: 'net', width: 14 },
    ];
    sheet.getRow(1).font = { bold: true };

    // Employees with no account cannot be paid by transfer. They are listed on a
    // second sheet rather than dropped, because a bank sheet whose total silently
    // differs from the payroll total is how someone goes unpaid without anyone
    // noticing.
    const unpayable = workbook.addWorksheet('No Bank Account');
    unpayable.columns = [
      { header: 'Employee Code', key: 'code', width: 16 },
      { header: 'Employee Name', key: 'name', width: 28 },
      { header: 'Net Pay', key: 'net', width: 14 },
      { header: 'Reason', key: 'reason', width: 40 },
    ];
    unpayable.getRow(1).font = { bold: true };

    let payableTotal = 0;
    let heldTotal = 0;

    for (const line of run.lineItems) {
      const e = byId.get(line.employeeId);
      if (!e) continue;
      const name = [e.firstName, e.lastName].filter(Boolean).join(' ').trim();
      const net = line.netPay.toNumber();
      const account = this.pii.decrypt(e.bankAccountNumberEncrypted);

      if (!account || !e.ifscCode) {
        heldTotal += net;
        unpayable.addRow({
          code: e.employeeCode,
          name,
          net,
          reason: !account
            ? 'No bank account on file'
            : 'No IFSC code on file',
        });
        continue;
      }

      payableTotal += net;
      sheet.addRow({
        code: e.employeeCode,
        name,
        bank: e.bankName ?? '',
        branch: e.bankBranch ?? '',
        // Text format: a long account number in a numeric cell loses its leading
        // zeros and can render in scientific notation, which the bank rejects.
        account: account.toString(),
        ifsc: e.ifscCode,
        net,
      });
    }

    sheet.getColumn('account').numFmt = '@';
    sheet.getColumn('net').numFmt = '#,##0.00';
    unpayable.getColumn('net').numFmt = '#,##0.00';

    const totalRow = sheet.addRow({
      code: '',
      name: '',
      bank: '',
      branch: '',
      account: '',
      ifsc: 'TOTAL',
      net: payableTotal,
    });
    totalRow.font = { bold: true };

    if (heldTotal > 0) {
      const held = unpayable.addRow({
        code: '',
        name: '',
        net: heldTotal,
        reason: 'TOTAL NOT TRANSFERABLE',
      });
      held.font = { bold: true };
    }

    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    return {
      buffer,
      filename: `bank-transfer-${run.period}${run.isFnf ? '-fnf' : ''}.xlsx`,
    };
  }
}
