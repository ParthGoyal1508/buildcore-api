import { Injectable, NotFoundException } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { PrismaService } from 'nestjs-prisma';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { assertInScope } from '../../settings/company-scope';
import { LabourRefsService } from '../labour-refs.service';
import type {
  LabourDayFlag,
  LabourDayStatus,
} from '../attendance/labour-day.util';
import {
  monthRange,
  MusterAttendanceService,
  type MusterDay,
  type MusterWorkerRef,
} from '../attendance/muster-attendance.service';
import { SupervisorSiteService } from '../supervisor-sites/supervisor-site.service';
import { deductionEntries } from '../payment-sheets/payment-sheet.rules';

export interface SheetFile {
  buffer: Buffer;
  filename: string;
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

const HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFE8EEF5' },
};

/**
 * The two spreadsheets 031 adds: the month-end consolidated attendance sheet and a payment sheet
 * as a printable workbook. Both read the same muster lines payment sheets price, so the sheet
 * HR checks and the money paid can never disagree.
 */
@Injectable()
export class LabourSheetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly refs: LabourRefsService,
    private readonly supervisorSites: SupervisorSiteService,
    private readonly muster: MusterAttendanceService,
  ) {}

  /**
   * One row per labour, one column per day of the month (034): P full day, H half day, S short, ?
   * unresolved (a missing or wrong punch, highlighted, and not counted until corrected), O still on
   * site today, M marked on a muster before punches. Totals give full, half, short and unresolved
   * days, payable days, hours and overtime. A second tab lists every day's punch in and out with
   * hours, status, overtime and flags. Without a `siteId`, every site the caller can see is
   * included, with a Site column to tell them apart.
   */
  async attendanceSheet(
    caller: AuthenticatedUser,
    query: { siteId?: string; year: number; month: number },
  ): Promise<SheetFile> {
    const chosen = await this.muster.chosenSites(caller, query.siteId);
    const siteName = new Map(chosen.map((s) => [s.id, s.name]));
    const { from, to, daysInMonth } = monthRange(query.year, query.month);
    const grid = await this.muster.collect(caller, chosen, from, to);

    const workbook = new ExcelJS.Workbook();
    workbook.created = new Date();
    const fixedCols = query.siteId ? 5 : 6;
    const sheet = workbook.addWorksheet('Attendance', {
      views: [{ state: 'frozen', xSplit: fixedCols, ySplit: 3 }],
    });
    const monthLabel = `${MONTHS[query.month - 1]} ${query.year}`;
    const title = query.siteId
      ? `Labour attendance — ${siteName.get(query.siteId)} — ${monthLabel}`
      : `Labour attendance — all sites — ${monthLabel}`;
    sheet.addRow([title]).font = { bold: true, size: 13 };
    sheet.addRow([
      'P = full day   H = half day   S = short (not paid)   ? = missing or wrong punch, not counted until corrected   O = on site today   M = marked before punches',
    ]).font = { italic: true, color: { argb: 'FF555555' } };

    const dayHeaders = Array.from({ length: daysInMonth }, (_, i) => {
      const d = new Date(Date.UTC(query.year, query.month - 1, i + 1));
      return `${i + 1}\n${'SMTWTFS'[d.getUTCDay()]}`;
    });
    const header = sheet.addRow([
      'Code',
      'Name',
      "Father's name",
      'Gender',
      'Contractor / Gang',
      ...(query.siteId ? [] : ['Site']),
      ...dayHeaders,
      'Full days',
      'Half days',
      'Short days',
      'Unresolved',
      'Payable days',
      'Hours',
      'OT hours',
    ]);
    header.font = { bold: true };
    header.alignment = {
      wrapText: true,
      horizontal: 'center',
      vertical: 'middle',
    };
    header.height = 30;
    header.eachCell((c) => (c.fill = HEADER_FILL));

    const totals = { payable: 0, hours: 0, ot: 0, unresolved: 0 };
    for (const { ref, days } of grid) {
      let full = 0;
      let half = 0;
      let short = 0;
      let unresolved = 0;
      let hours = 0;
      let ot = 0;
      const flagged: number[] = [];
      const cells = Array.from({ length: daysInMonth }, (_, i) => {
        const date = `${from.slice(0, 8)}${String(i + 1).padStart(2, '0')}`;
        const day = days.get(date);
        if (!day) return '';
        hours += day.hours ?? 0;
        ot += day.overtimeHours;
        switch (day.status) {
          case 'full_day':
            full += 1;
            return day.manual ? 'M' : 'P';
          case 'half_day':
            half += 1;
            return day.manual ? 'M' : 'H';
          case 'short':
            short += 1;
            return 'S';
          case 'unresolved':
            unresolved += 1;
            flagged.push(i);
            return '?';
          case 'on_site':
            return 'O';
          default:
            return '';
        }
      });
      const payable = full + half * 0.5;
      totals.payable += payable;
      totals.hours += hours;
      totals.ot += ot;
      totals.unresolved += unresolved;
      const row = sheet.addRow([
        ref.labourCode,
        ref.fullName,
        ref.fatherName ?? '',
        ref.gender ? capitalise(ref.gender) : '',
        contractorGang(ref),
        ...(query.siteId ? [] : [ref.siteName]),
        ...cells,
        full,
        half,
        short,
        unresolved,
        payable,
        round2(hours),
        round2(ot),
      ]);
      for (const i of flagged) {
        row.getCell(fixedCols + 1 + i).fill = FLAG_FILL;
      }
      if (unresolved > 0)
        row.getCell(fixedCols + daysInMonth + 4).fill = FLAG_FILL;
    }
    const totalsRow = sheet.addRow([
      'Total',
      ...Array(fixedCols - 1 + daysInMonth + 3).fill(''),
      totals.unresolved,
      totals.payable,
      round2(totals.hours),
      round2(totals.ot),
    ]);
    totalsRow.font = { bold: true };

    [11, 24, 22, 8, 22].forEach((w, i) => (sheet.getColumn(i + 1).width = w));
    if (!query.siteId) sheet.getColumn(6).width = 20;
    for (let i = 0; i < daysInMonth; i++) {
      const col = sheet.getColumn(fixedCols + 1 + i);
      col.width = 4;
      col.alignment = { horizontal: 'center' };
    }
    for (let i = 1; i <= 7; i++)
      sheet.getColumn(fixedCols + daysInMonth + i).width = 10;

    this.addPunchesTab(workbook, grid);

    const slug = query.siteId
      ? slugify(siteName.get(query.siteId) ?? 'site')
      : 'all-sites';
    return {
      buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
      filename: `labour-attendance-${slug}-${query.year}-${String(
        query.month,
      ).padStart(2, '0')}.xlsx`,
    };
  }

  /** A payment sheet as a printable workbook, with a signature column for cash payment. */
  async paymentSheet(
    caller: AuthenticatedUser,
    id: string,
  ): Promise<SheetFile> {
    const sheet = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.labourPaymentSheet.findUnique({
          where: { id },
          include: { lines: true },
        }),
    );
    if (!sheet || sheet.deletedAt) {
      throw new NotFoundException(`Payment sheet ${id} not found`);
    }
    assertInScope(caller, sheet, `Payment sheet ${id}`);
    if (sheet.siteId) {
      await this.supervisorSites.assertSiteAllowed(caller, sheet.siteId);
    }

    const workers = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.labourWorker.findMany({
          where: { id: { in: sheet.lines.map((l) => l.workerId) } },
        }),
    );
    const byId = new Map(workers.map((w) => [w.id, w]));
    const sites = await this.supervisorSites.mySites(caller);
    const site = sites.find((s) => s.id === sheet.siteId)?.name ?? '';

    const from = sheet.periodFrom.toISOString().slice(0, 10);
    const to = sheet.periodTo.toISOString().slice(0, 10);

    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet('Payment sheet', {
      pageSetup: {
        orientation: 'landscape',
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
      },
      views: [{ state: 'frozen', ySplit: 4 }],
    });
    ws.addRow([`Labour payment sheet${site ? ` — ${site}` : ''}`]).font = {
      bold: true,
      size: 13,
    };
    ws.addRow([
      `${from} to ${to}`,
      '',
      '',
      '',
      '',
      `Status: ${capitalise(sheet.status.replace('_', ' '))}`,
    ]);
    ws.addRow([]);
    const header = ws.addRow([
      'S.No',
      'Code',
      'Name',
      "Father's name",
      'Gender',
      'Days',
      'Daily rate',
      'Gross',
      'Deductions',
      'Net payable',
      'Signature / thumb',
    ]);
    header.font = { bold: true };
    header.eachCell((c) => (c.fill = HEADER_FILL));

    const lines = [...sheet.lines].sort((a, b) =>
      (byId.get(a.workerId)?.labourCode ?? '').localeCompare(
        byId.get(b.workerId)?.labourCode ?? '',
      ),
    );
    lines.forEach((l, i) => {
      const w = byId.get(l.workerId);
      // 036 O4: a carry-forward line pays an earlier shortfall, so its net is above its (zero)
      // gross; gross − net would print a negative deduction. Sum the entries instead.
      const deductions = deductionEntries(l.deductions).reduce(
        (sum, d) => sum + d.amount,
        0,
      );
      const name = w?.fullName ?? '';
      const row = ws.addRow([
        i + 1,
        w?.labourCode ?? '',
        l.carriedFromLineId ? `${name} (balance carried forward)` : name,
        w?.fatherName ?? '',
        w?.gender ? capitalise(w.gender) : '',
        l.daysWorked.toNumber(),
        l.resolvedRate.toNumber(),
        l.grossWage.toNumber(),
        Math.round(deductions * 100) / 100,
        l.netPayable.toNumber(),
        '',
      ]);
      row.height = 26;
    });
    const totals = ws.addRow([
      '',
      '',
      'Total',
      '',
      '',
      lines.reduce((s, l) => s + l.daysWorked.toNumber(), 0),
      '',
      sheet.grossTotal.toNumber(),
      sheet.deductionTotal.toNumber(),
      sheet.netTotal.toNumber(),
      '',
    ]);
    totals.font = { bold: true };

    const widths = [6, 11, 24, 22, 8, 7, 11, 12, 12, 13, 22];
    widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));
    for (const col of [7, 8, 9, 10]) ws.getColumn(col).numFmt = '#,##0.00';
    ws.eachRow((row, n) => {
      if (n < 4) return;
      row.eachCell({ includeEmpty: true }, (c) => {
        c.border = {
          top: { style: 'thin' },
          bottom: { style: 'thin' },
          left: { style: 'thin' },
          right: { style: 'thin' },
        };
      });
    });

    return {
      buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
      filename: `labour-payment-${slugify(
        site || 'sheet',
      )}-${from}-to-${to}.xlsx`,
    };
  }

  /** Every punched day with its times, hours, status and flags, by date then code. */
  private addPunchesTab(
    workbook: ExcelJS.Workbook,
    grid: { ref: MusterWorkerRef; days: Map<string, MusterDay> }[],
  ) {
    const ws = workbook.addWorksheet('Punch times', {
      views: [{ state: 'frozen', ySplit: 1 }],
    });
    const header = ws.addRow([
      'Date',
      'Code',
      'Name',
      'Contractor / Gang',
      'Site',
      'Punch in',
      'Punch out',
      'Hours',
      'Status',
      'OT hours',
      'Flag',
      'Corrected',
      'Recorded by',
      'Location flagged',
    ]);
    header.font = { bold: true };
    header.eachCell((c) => (c.fill = HEADER_FILL));

    const time = new Intl.DateTimeFormat('en-IN', {
      timeZone: this.refs.timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
    const rows = grid
      .flatMap(({ ref, days }) =>
        [...days.values()]
          .filter((d) => d.punchIn || d.punchOut)
          .map((d) => ({ ref, d })),
      )
      .sort(
        (a, b) =>
          a.d.date.localeCompare(b.d.date) ||
          a.ref.labourCode.localeCompare(b.ref.labourCode),
      );
    for (const { ref, d } of rows) {
      const recordedBy = [d.punchIn?.recordedBy, d.punchOut?.recordedBy]
        .filter((n): n is string => !!n)
        .filter((n, i, all) => all.indexOf(n) === i)
        .join(', ');
      const row = ws.addRow([
        d.date,
        ref.labourCode,
        ref.fullName,
        contractorGang(ref),
        ref.siteName,
        d.punchIn ? time.format(new Date(d.punchIn.at)) : '',
        d.punchOut ? time.format(new Date(d.punchOut.at)) : '',
        d.hours ?? '',
        STATUS_LABEL[d.status],
        d.overtimeHours || '',
        d.flag ? FLAG_LABEL[d.flag] : '',
        d.punchIn?.corrected || d.punchOut?.corrected ? 'Yes' : '',
        recordedBy,
        d.punchIn?.outsideFence || d.punchOut?.outsideFence ? 'Yes' : '',
      ]);
      if (d.flag) row.getCell(11).fill = FLAG_FILL;
    }
    [12, 11, 24, 22, 20, 10, 10, 7, 11, 9, 18, 10, 22, 16].forEach(
      (w, i) => (ws.getColumn(i + 1).width = w),
    );
  }
}

const FLAG_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFFDE68A' },
};

const STATUS_LABEL: Record<LabourDayStatus, string> = {
  full_day: 'Full day',
  half_day: 'Half day',
  short: 'Short',
  on_site: 'On site',
  unresolved: 'Unresolved',
  absent: 'Absent',
};

const FLAG_LABEL: Record<LabourDayFlag, string> = {
  missing_punch_out: 'Missing punch out',
  missing_punch_in: 'Missing punch in',
  out_before_in: 'Out before in',
};

function contractorGang(ref: MusterWorkerRef): string {
  return [ref.contractorName, ref.gangName].filter(Boolean).join(' / ');
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'site'
  );
}
