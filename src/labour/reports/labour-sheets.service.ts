import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AttendanceType, MusterStatus } from '@prisma/client';
import * as ExcelJS from 'exceljs';
import { PrismaService } from 'nestjs-prisma';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { assertInScope } from '../../settings/company-scope';
import { LabourRefsService } from '../labour-refs.service';
import { dayFractionOf } from '../payment-sheets/wage-calc.util';
import { SupervisorSiteService } from '../supervisor-sites/supervisor-site.service';

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
  ) {}

  /**
   * One row per labour, one column per day of the month: P for a full day (in and out), H for a
   * half day (in only), blank when absent. A second tab lists every punch with its times. Without a
   * `siteId`, every site the caller can see is included, with a Site column to tell them apart.
   */
  async attendanceSheet(
    caller: AuthenticatedUser,
    query: { siteId?: string; year: number; month: number },
  ): Promise<SheetFile> {
    const sites = await this.supervisorSites.mySites(caller);
    if (query.siteId && !sites.some((s) => s.id === query.siteId)) {
      await this.supervisorSites.assertSiteAllowed(caller, query.siteId);
      throw new NotFoundException('Site not found');
    }
    const chosen = query.siteId
      ? sites.filter((s) => s.id === query.siteId)
      : sites;
    if (chosen.length === 0) {
      throw new BadRequestException('You have no sites to report on');
    }
    const siteIds = chosen.map((s) => s.id);
    const siteName = new Map(chosen.map((s) => [s.id, s.name]));

    const from = new Date(Date.UTC(query.year, query.month - 1, 1));
    const to = new Date(Date.UTC(query.year, query.month, 0));
    const daysInMonth = to.getUTCDate();

    const { lines, punches, workers } = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const lines = await tx.musterLine.findMany({
          where: {
            muster: {
              siteId: { in: siteIds },
              date: { gte: from, lte: to },
              status: MusterStatus.approved,
              deletedAt: null,
            },
          },
          include: { muster: { select: { date: true, siteId: true } } },
        });
        const punches = await tx.labourPunch.findMany({
          where: { siteId: { in: siteIds }, punchDate: { gte: from, lte: to } },
          orderBy: [{ punchDate: 'asc' }, { punchedAt: 'asc' }],
        });
        const workedIds = new Set(lines.map((l) => l.workerId));
        // Everyone active at these sites, and anyone who worked here this month and has since
        // left or moved — a month-end sheet that dropped them would under-report the month.
        const workers = await tx.labourWorker.findMany({
          where: {
            deletedAt: null,
            OR: [
              { siteId: { in: siteIds }, status: 'active' },
              { id: { in: Array.from(workedIds) } },
            ],
          },
          orderBy: { labourCode: 'asc' },
        });
        return { lines, punches, workers };
      },
    );

    // workerId → site → day → attendance
    const grid = new Map<string, Map<string, Map<number, AttendanceType>>>();
    for (const line of lines) {
      const bySite = grid.get(line.workerId) ?? new Map();
      const byDay = bySite.get(line.muster.siteId) ?? new Map();
      byDay.set(line.muster.date.getUTCDate(), line.attendanceType);
      bySite.set(line.muster.siteId, byDay);
      grid.set(line.workerId, bySite);
    }

    const workbook = new ExcelJS.Workbook();
    workbook.created = new Date();
    const sheet = workbook.addWorksheet('Attendance', {
      views: [{ state: 'frozen', xSplit: 3, ySplit: 3 }],
    });
    const monthLabel = `${MONTHS[query.month - 1]} ${query.year}`;
    const title = query.siteId
      ? `Labour attendance — ${siteName.get(query.siteId)} — ${monthLabel}`
      : `Labour attendance — all sites — ${monthLabel}`;
    sheet.addRow([title]).font = { bold: true, size: 13 };
    sheet.addRow([
      'P = full day (punched in and out)   H = half day (punched in only)',
    ]).font = {
      italic: true,
      color: { argb: 'FF555555' },
    };

    const dayHeaders = Array.from({ length: daysInMonth }, (_, i) => {
      const d = new Date(Date.UTC(query.year, query.month - 1, i + 1));
      return `${i + 1}\n${'SMTWTFS'[d.getUTCDay()]}`;
    });
    const header = sheet.addRow([
      'Code',
      'Name',
      "Father's name",
      'Gender',
      ...(query.siteId ? [] : ['Site']),
      ...dayHeaders,
      'Full days',
      'Half days',
      'Total days',
    ]);
    header.font = { bold: true };
    header.alignment = {
      wrapText: true,
      horizontal: 'center',
      vertical: 'middle',
    };
    header.height = 30;
    header.eachCell((c) => (c.fill = HEADER_FILL));

    const fixedCols = query.siteId ? 4 : 5;
    let grandTotal = 0;
    for (const w of workers) {
      const bySite = grid.get(w.id);
      // A worker who moved mid-month gets a row per site they worked at.
      const rowSites =
        bySite && bySite.size > 0 ? Array.from(bySite.keys()) : [w.siteId];
      for (const siteId of rowSites) {
        if (!siteIds.includes(siteId)) continue;
        const byDay = bySite?.get(siteId) ?? new Map<number, AttendanceType>();
        let full = 0;
        let half = 0;
        const cells = Array.from({ length: daysInMonth }, (_, i) => {
          const t = byDay.get(i + 1);
          if (t === AttendanceType.full_day) {
            full += 1;
            return 'P';
          }
          if (t === AttendanceType.half_day) {
            half += 1;
            return 'H';
          }
          return '';
        });
        const total = full + half * dayFractionOf(AttendanceType.half_day);
        grandTotal += total;
        sheet.addRow([
          w.labourCode,
          w.fullName,
          w.fatherName ?? '',
          w.gender ? capitalise(w.gender) : '',
          ...(query.siteId ? [] : [siteName.get(siteId) ?? '']),
          ...cells,
          full,
          half,
          total,
        ]);
      }
    }
    const totalsRow = sheet.addRow([
      'Total',
      ...Array(fixedCols - 1 + daysInMonth + 2).fill(''),
      grandTotal,
    ]);
    totalsRow.font = { bold: true };

    sheet.getColumn(1).width = 11;
    sheet.getColumn(2).width = 24;
    sheet.getColumn(3).width = 22;
    sheet.getColumn(4).width = 8;
    if (!query.siteId) sheet.getColumn(5).width = 20;
    for (let i = 0; i < daysInMonth; i++) {
      const col = sheet.getColumn(fixedCols + 1 + i);
      col.width = 4;
      col.alignment = { horizontal: 'center' };
    }
    for (let i = 1; i <= 3; i++)
      sheet.getColumn(fixedCols + daysInMonth + i).width = 10;

    this.addPunchesTab(workbook, punches, workers, siteName);

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
      const deductions = l.grossWage.toNumber() - l.netPayable.toNumber();
      const row = ws.addRow([
        i + 1,
        w?.labourCode ?? '',
        w?.fullName ?? '',
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

  private addPunchesTab(
    workbook: ExcelJS.Workbook,
    punches: {
      workerId: string;
      siteId: string;
      punchDate: Date;
      type: 'in' | 'out';
      punchedAt: Date;
      geofenceViolation: boolean;
    }[],
    workers: { id: string; labourCode: string; fullName: string }[],
    siteName: Map<string, string>,
  ) {
    const ws = workbook.addWorksheet('Punch times', {
      views: [{ state: 'frozen', ySplit: 1 }],
    });
    const header = ws.addRow([
      'Date',
      'Code',
      'Name',
      'Site',
      'In',
      'Out',
      'Day',
      'Location flagged',
    ]);
    header.font = { bold: true };
    header.eachCell((c) => (c.fill = HEADER_FILL));

    const byId = new Map(workers.map((w) => [w.id, w]));
    const days = new Map<
      string,
      { in?: (typeof punches)[0]; out?: (typeof punches)[0] }
    >();
    for (const p of punches) {
      const key = `${p.punchDate.toISOString().slice(0, 10)}|${p.workerId}|${
        p.siteId
      }`;
      const entry = days.get(key) ?? {};
      entry[p.type] = p;
      days.set(key, entry);
    }
    const time = new Intl.DateTimeFormat('en-IN', {
      timeZone: this.refs.timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
    for (const [key, entry] of days) {
      const [date, workerId, siteId] = key.split('|');
      const w = byId.get(workerId);
      ws.addRow([
        date,
        w?.labourCode ?? '',
        w?.fullName ?? '',
        siteName.get(siteId) ?? '',
        entry.in ? time.format(entry.in.punchedAt) : '',
        entry.out ? time.format(entry.out.punchedAt) : '',
        entry.out ? 'Full' : 'Half',
        entry.in?.geofenceViolation || entry.out?.geofenceViolation
          ? 'Yes'
          : '',
      ]);
    }
    [12, 11, 24, 20, 10, 10, 7, 16].forEach(
      (w, i) => (ws.getColumn(i + 1).width = w),
    );
  }
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
