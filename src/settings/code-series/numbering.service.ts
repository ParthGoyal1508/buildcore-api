import { BadRequestException, Injectable } from '@nestjs/common';
import { CodeSeriesType, Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { withRlsContext } from '../../common/prisma/rls-context';
import {
  CODE_SERIES_FORMATS,
  COUNTED_SERIES,
  type CountedSeries,
  NAMED_SERIES,
  NAMED_SERIES_DEFAULT,
  type NamedSeries,
  type NumberingSeries,
  formatCode,
  namedCode,
} from './code-series.formats';
import { CodeSeriesService } from './code-series.service';

/** One series as Settings → Numbering shows it. */
export interface NumberingEntry {
  series: NumberingSeries;
  label: string;
  /** `counted`: prefix + (start + n × gap). `named`: letters from the name, serial, year. */
  kind: 'counted' | 'named';
  prefix: string;
  base: number;
  step: number;
  width: number;
  separator: string;
  /** True while the company has not changed the built-in format. */
  isDefault: boolean;
  /** The first three codes the format produces, from a fresh start. */
  examples: string[];
  /** The code the next record will actually get — counted series only. */
  nextCode: string | null;
}

export interface NumberingInput {
  prefix?: string;
  base?: number;
  step?: number;
  width?: number;
  separator?: string;
}

const LABELS: Record<NumberingSeries, string> = {
  PROJECTS: 'Project code',
  VENDORS: 'Vendor code',
  WORK_ORDER: 'Work order number',
  JOB_CARD: 'Maintenance job card number',
  ISSUE_SLIP: 'Material issue slip number',
  DELIVERY_CHALLAN: 'Delivery challan number',
  STOCK_TRANSFER: 'Stock transfer slip number',
  EQUIPMENT: 'Plant & machinery code',
  ASSETS: 'Asset code',
};

const isCounted = (series: string): series is CountedSeries =>
  (COUNTED_SERIES as readonly string[]).includes(series);
const isNamed = (series: string): series is NamedSeries =>
  (NAMED_SERIES as readonly string[]).includes(series);

/**
 * Settings → Numbering (2026-10-15): how a company numbers its projects, vendors, work orders,
 * machines and assets. The client: "Can we give a setting to configure the Project Code, Vendor
 * Code, Work Order Number, Plant and Machinery and Assets".
 *
 * A company that never opens this screen keeps the built-in formats, which are Parth Realcon's —
 * projects 1010, 1020…; vendors 2022001…; work orders 1500001…; machines and assets JCB01/2027.
 *
 * ## Changing a counted format restarts it
 *
 * Saving a counted series sets its counter back to zero, so the next code is the new start plus
 * one gap — what "start from" means to the person setting it. Codes already in use are stepped
 * over on allocation, so a restarted series never collides with what it numbered before.
 */
@Injectable()
export class NumberingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly codeSeries: CodeSeriesService,
  ) {}

  async list(companyId: string): Promise<NumberingEntry[]> {
    return withRlsContext(this.prisma, { isSuperAdmin: true }, async (tx) => {
      const rows = await tx.codeFormat.findMany({ where: { companyId } });
      const byKey = new Map(rows.map((row) => [row.series, row]));
      const entries: NumberingEntry[] = [];
      for (const series of [...COUNTED_SERIES, ...NAMED_SERIES]) {
        entries.push(
          await this.entry(tx, companyId, series, byKey.get(series)),
        );
      }
      return entries;
    });
  }

  async update(
    companyId: string,
    series: string,
    input: NumberingInput,
  ): Promise<NumberingEntry> {
    const values = this.validate(series, input);
    return withRlsContext(this.prisma, { isSuperAdmin: true }, async (tx) => {
      const row = await tx.codeFormat.upsert({
        where: { companyId_series: { companyId, series } },
        create: { companyId, series, ...values },
        update: values,
      });
      if (isCounted(series)) await this.restart(tx, companyId, series);
      return this.entry(tx, companyId, series as NumberingSeries, row);
    });
  }

  /** Back to the built-in format — deletes the company's own. */
  async reset(companyId: string, series: string): Promise<NumberingEntry> {
    if (!isCounted(series) && !isNamed(series)) {
      throw new BadRequestException(`Unknown numbering series ${series}`);
    }
    return withRlsContext(this.prisma, { isSuperAdmin: true }, async (tx) => {
      await tx.codeFormat.deleteMany({ where: { companyId, series } });
      if (isCounted(series)) await this.restart(tx, companyId, series);
      return this.entry(tx, companyId, series, undefined);
    });
  }

  private async restart(
    tx: Prisma.TransactionClient,
    companyId: string,
    series: CountedSeries,
  ): Promise<void> {
    await tx.codeSequence.updateMany({
      where: { companyId, seriesType: series as CodeSeriesType },
      data: { lastNumber: 0 },
    });
  }

  private validate(series: string, input: NumberingInput) {
    if (isCounted(series)) {
      const prefix = (input.prefix ?? '').trim();
      const base = input.base ?? 0;
      const step = input.step ?? 1;
      const width = input.width ?? 0;
      if (!/^[A-Za-z0-9/-]{0,12}$/.test(prefix)) {
        throw new BadRequestException(
          'The prefix may hold letters, digits, "/" and "-", up to 12 characters.',
        );
      }
      if (!Number.isInteger(base) || base < 0 || base > 99_999_999) {
        throw new BadRequestException(
          'Start must be a whole number, 0 or more.',
        );
      }
      if (!Number.isInteger(step) || step < 1 || step > 1000) {
        throw new BadRequestException('The gap must be between 1 and 1000.');
      }
      if (!Number.isInteger(width) || width < 0 || width > 8) {
        throw new BadRequestException('Digits must be between 0 and 8.');
      }
      return { prefix, base, step, width, separator: '' };
    }
    if (isNamed(series)) {
      const width = input.width ?? NAMED_SERIES_DEFAULT.width;
      const separator = input.separator ?? NAMED_SERIES_DEFAULT.separator;
      if (!Number.isInteger(width) || width < 1 || width > 4) {
        throw new BadRequestException('Serial digits must be between 1 and 4.');
      }
      if (!/^[/\-_.]?$/.test(separator)) {
        throw new BadRequestException(
          'The separator is one of "/", "-", "_", "." or nothing.',
        );
      }
      return { prefix: '', base: 0, step: 1, width, separator };
    }
    throw new BadRequestException(`Unknown numbering series ${series}`);
  }

  private async entry(
    tx: Prisma.TransactionClient,
    companyId: string,
    series: NumberingSeries,
    row:
      | {
          prefix: string;
          base: number;
          step: number;
          width: number;
          separator: string;
        }
      | undefined,
  ): Promise<NumberingEntry> {
    if (isNamed(series)) {
      const format = row
        ? { width: row.width, separator: row.separator }
        : NAMED_SERIES_DEFAULT;
      return {
        series,
        label: LABELS[series],
        kind: 'named',
        prefix: '',
        base: 0,
        step: 1,
        width: format.width,
        separator: format.separator,
        isDefault: !row,
        examples: [
          namedCode(format, 'JCB', 1, 2027),
          namedCode(format, 'TM', 1, 2024),
          namedCode(format, 'JCB', 2, 2025),
        ],
        nextCode: null,
      };
    }
    const type = series as CodeSeriesType;
    const format = row
      ? { prefix: row.prefix, base: row.base, step: row.step, width: row.width }
      : CODE_SERIES_FORMATS[type] ?? { prefix: '', base: 0, step: 1, width: 0 };
    const nextCode = await this.codeSeries.peek(tx, companyId, type, (code) =>
      this.isTaken(tx, companyId, series, code),
    );
    return {
      series,
      label: LABELS[series],
      kind: 'counted',
      prefix: format.prefix,
      base: format.base,
      step: format.step,
      width: format.width,
      separator: '',
      isDefault: !row,
      examples: [1, 2, 3].map((n) => formatCode(format, n)),
      nextCode,
    };
  }

  /**
   * Whether `code` is already used by a record of `series` — what a restarted series steps over.
   *
   * Public (2026-10-15) because two modules allocate from `WORK_ORDER` — subcontract work orders
   * and vehicle hire orders — and each must step over the other's numbers, not just its own.
   */
  async isTaken(
    tx: Prisma.TransactionClient,
    companyId: string,
    series: CountedSeries,
    code: string,
  ): Promise<boolean> {
    const hit = (row: { id: string } | null) => !!row;
    const select = { id: true } as const;
    switch (series) {
      case 'PROJECTS':
        return hit(
          await tx.project.findFirst({ where: { companyId, code }, select }),
        );
      case 'VENDORS':
        return hit(
          await tx.vendor.findFirst({ where: { companyId, code }, select }),
        );
      case 'WORK_ORDER':
        return (
          hit(
            await tx.workOrder.findFirst({
              where: { companyId, code },
              select,
            }),
          ) ||
          hit(
            await tx.hireOrder.findFirst({
              where: { companyId, code },
              select,
            }),
          )
        );
      case 'JOB_CARD':
        return hit(
          await tx.maintenanceJob.findFirst({
            where: { companyId, jobCardNo: code },
            select,
          }),
        );
      case 'ISSUE_SLIP':
        return hit(
          await tx.issue.findFirst({
            where: { companyId, slipNo: code },
            select,
          }),
        );
      case 'DELIVERY_CHALLAN':
        return hit(
          await tx.stockTransfer.findFirst({
            where: { companyId, challanNo: code },
            select,
          }),
        );
      case 'STOCK_TRANSFER':
        return hit(
          await tx.stockTransfer.findFirst({
            where: { companyId, transferNo: code },
            select,
          }),
        );
    }
  }
}
