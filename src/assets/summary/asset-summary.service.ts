import { Injectable } from '@nestjs/common';
import { AssetStatus } from '@prisma/client';
import * as ExcelJS from 'exceljs';
import { PrismaService } from 'nestjs-prisma';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { companyScope } from '../../settings/company-scope';
import { AssetsRefsService } from '../assets-refs.service';
import { todayUtc } from '../dates';
import { accumulatedDepreciation, bookValue } from '../depreciation';

export interface SummaryBucket {
  key: string;
  label: string;
  count: number;
  purchaseCost: number;
  accumulatedDepreciation: number;
  bookValue: number;
}

export interface AssetSummary {
  asOf: Date;
  totals: {
    count: number;
    purchaseCost: number;
    accumulatedDepreciation: number;
    bookValue: number;
  };
  byCategory: SummaryBucket[];
  byStatus: SummaryBucket[];
  byProject: SummaryBucket[];
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * The register's summary and its export (spec FR-032, FR-037).
 *
 * The export is synchronous: the workbook is built in the request and streamed
 * back. The spec asks for an async job above a size threshold, but the
 * infrastructure that would run one (004's US7 queue) has not shipped, and a
 * "threshold" that falls through to the same synchronous path either way would be a
 * fiction in the contract. `MAX_PAGE_SIZE` bounds every other read in this module;
 * this one is bounded by the company's own register, which is the figure the
 * threshold was meant to protect against and is worth revisiting when the queue
 * lands.
 *
 * Every figure is computed from the asset's own columns through `depreciation.ts`,
 * so the summary and the register can never report different book values.
 */
@Injectable()
export class AssetSummaryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly refs: AssetsRefsService,
  ) {}

  async build(
    caller: AuthenticatedUser,
    companyId?: string,
  ): Promise<AssetSummary> {
    const today = todayUtc();
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.asset.findMany({
          where: { ...companyScope(caller, companyId), deletedAt: null },
          select: {
            id: true,
            categoryId: true,
            status: true,
            purchaseCost: true,
            depreciationRatePercent: true,
            salvageValue: true,
            capitalisationDate: true,
            allocations: {
              where: { status: 'open', deletedAt: null },
              select: { projectId: true },
              take: 1,
            },
          },
        }),
    );

    const categories = await this.refs.categoriesByIds(
      caller,
      rows.map((row) => row.categoryId),
    );

    const byCategory = new Map<string, SummaryBucket>();
    const byStatus = new Map<string, SummaryBucket>();
    const byProject = new Map<string, SummaryBucket>();
    const totals = {
      count: 0,
      purchaseCost: 0,
      accumulatedDepreciation: 0,
      bookValue: 0,
    };

    const add = (
      bucket: Map<string, SummaryBucket>,
      key: string,
      label: string,
      figures: { cost: number; depreciation: number; value: number },
    ): void => {
      const entry = bucket.get(key) ?? {
        key,
        label,
        count: 0,
        purchaseCost: 0,
        accumulatedDepreciation: 0,
        bookValue: 0,
      };
      entry.count += 1;
      entry.purchaseCost += figures.cost;
      entry.accumulatedDepreciation += figures.depreciation;
      entry.bookValue += figures.value;
      bucket.set(key, entry);
    };

    for (const row of rows) {
      const depreciable = {
        purchaseCost: Number(row.purchaseCost),
        depreciationRatePercent: Number(row.depreciationRatePercent),
        salvageValue: Number(row.salvageValue),
        capitalisationDate: row.capitalisationDate,
      };
      const figures = {
        cost: depreciable.purchaseCost,
        depreciation: accumulatedDepreciation(depreciable, today),
        value: bookValue(depreciable, today),
      };

      totals.count += 1;
      totals.purchaseCost += figures.cost;
      totals.accumulatedDepreciation += figures.depreciation;
      totals.bookValue += figures.value;

      add(
        byCategory,
        row.categoryId,
        categories.get(row.categoryId)?.name ?? 'Unknown category',
        figures,
      );
      add(byStatus, row.status, row.status, figures);
      // An asset with no open allocation is not on a project — bucketed explicitly
      // rather than dropped, so the project column still adds up to the total.
      const projectId = row.allocations[0]?.projectId ?? 'unallocated';
      add(byProject, projectId, projectId, figures);
    }

    const finish = (bucket: Map<string, SummaryBucket>): SummaryBucket[] =>
      [...bucket.values()]
        .map((entry) => ({
          ...entry,
          purchaseCost: round2(entry.purchaseCost),
          accumulatedDepreciation: round2(entry.accumulatedDepreciation),
          bookValue: round2(entry.bookValue),
        }))
        .sort((a, b) => b.bookValue - a.bookValue);

    return {
      asOf: today,
      totals: {
        count: totals.count,
        purchaseCost: round2(totals.purchaseCost),
        accumulatedDepreciation: round2(totals.accumulatedDepreciation),
        bookValue: round2(totals.bookValue),
      },
      byCategory: finish(byCategory),
      byStatus: finish(byStatus),
      byProject: finish(byProject),
    };
  }

  /** The register as a workbook: one row per asset, plus the summary sheet. */
  async export(
    caller: AuthenticatedUser,
    companyId?: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const today = todayUtc();
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.asset.findMany({
          where: { ...companyScope(caller, companyId), deletedAt: null },
          orderBy: { assetCode: 'asc' },
        }),
    );

    const [categories, siteNames, summary] = await Promise.all([
      this.refs.categoriesByIds(
        caller,
        rows.map((row) => row.categoryId),
      ),
      this.refs.siteNames(
        caller,
        rows.map((row) => row.currentSiteId),
      ),
      this.build(caller, companyId),
    ]);

    const workbook = new ExcelJS.Workbook();
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Asset Register');
    sheet.columns = [
      { header: 'Asset Code', key: 'code', width: 18 },
      { header: 'Name', key: 'name', width: 32 },
      { header: 'Category', key: 'category', width: 22 },
      { header: 'Tracking', key: 'tracking', width: 12 },
      { header: 'Serial Number', key: 'serial', width: 22 },
      { header: 'Quantity', key: 'quantity', width: 10 },
      { header: 'Site', key: 'site', width: 24 },
      { header: 'Status', key: 'status', width: 16 },
      { header: 'Purchase Date', key: 'purchaseDate', width: 14 },
      { header: 'Purchase Cost', key: 'cost', width: 16 },
      { header: 'Accumulated Depreciation', key: 'depreciation', width: 24 },
      { header: 'Book Value', key: 'value', width: 16 },
    ];
    sheet.getRow(1).font = { bold: true };

    for (const row of rows) {
      const depreciable = {
        purchaseCost: Number(row.purchaseCost),
        depreciationRatePercent: Number(row.depreciationRatePercent),
        salvageValue: Number(row.salvageValue),
        capitalisationDate: row.capitalisationDate,
      };
      sheet.addRow({
        code: row.assetCode,
        name: row.name,
        category: categories.get(row.categoryId)?.name ?? 'Unknown category',
        tracking: row.trackingMode,
        serial: row.serialNumber ?? '',
        quantity: Number(row.quantity),
        site: siteNames.get(row.currentSiteId) ?? 'Unknown site',
        status: row.status,
        purchaseDate: row.purchaseDate
          ? row.purchaseDate.toISOString().slice(0, 10)
          : '',
        cost: depreciable.purchaseCost,
        depreciation: accumulatedDepreciation(depreciable, today),
        value: bookValue(depreciable, today),
      });
    }

    const summarySheet = workbook.addWorksheet('Summary by Category');
    summarySheet.columns = [
      { header: 'Category', key: 'label', width: 28 },
      { header: 'Assets', key: 'count', width: 10 },
      { header: 'Purchase Cost', key: 'cost', width: 16 },
      { header: 'Accumulated Depreciation', key: 'depreciation', width: 24 },
      { header: 'Book Value', key: 'value', width: 16 },
    ];
    summarySheet.getRow(1).font = { bold: true };
    for (const bucket of summary.byCategory) {
      summarySheet.addRow({
        label: bucket.label,
        count: bucket.count,
        cost: bucket.purchaseCost,
        depreciation: bucket.accumulatedDepreciation,
        value: bucket.bookValue,
      });
    }

    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    return {
      buffer,
      filename: `asset-register-${today.toISOString().slice(0, 10)}.xlsx`,
    };
  }

  /** Status labels, so a caller can render the status buckets without hardcoding
   * the enum. */
  static readonly STATUSES: readonly AssetStatus[] = Object.values(AssetStatus);
}
