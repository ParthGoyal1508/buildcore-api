import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditAction, AuditEntityType, Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { SettingsConfig } from '../../common/configs/config.interface';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { zonedDateOnly } from '../../hr/leave/leave-days';
import { ItemView } from '../../settings/item-masters/items.service';
import { buildWorkbook } from '../exports/inventory-workbook';
import {
  SheetColumn,
  cellDate,
  cellNumber,
  cellText,
  indexByName,
  looseNameKey,
  readSheetRows,
} from '../imports/sheet-rows';
import { InventoryRefsService } from '../inventory-refs.service';
import { VendorItemRateService } from './vendor-item-rate.service';

export const AGREED_RATE_ERRORS = {
  /** An import whose sheet still has rows in error; nothing was written (051). */
  importInvalid: 'VENDOR_RATE_IMPORT_INVALID',
} as const;

/** The client's Vendor Rates sheet, column for column (051). */
export const VENDOR_RATE_COLUMNS: SheetColumn<
  'vendor' | 'item' | 'rate' | 'validFrom'
>[] = [
  { key: 'vendor', label: 'Vendor Name', headers: ['vendor'], required: true },
  { key: 'item', label: 'Item Name', headers: ['item'], required: true },
  {
    key: 'rate',
    label: 'Rate (₹ per Unit)',
    headers: ['rate', 'rateperunit', 'rateunit', 'agreedrate'],
    required: true,
  },
  {
    key: 'validFrom',
    label: 'Valid From',
    headers: ['effectivefrom', 'from', 'date', 'validfromddmmyyyy'],
    required: false,
  },
];

/** One agreed rate in force, as the screen lists it. */
export interface AgreedRateRow {
  id: string;
  vendorId: string;
  vendorName: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  unit: string;
  rate: number;
  effectiveFrom: string;
  /** `purchase` when a first purchase set it (028), `import` when it was entered up front (051). */
  source: 'purchase' | 'import';
}

/**
 * What a row of the sheet comes to:
 * - `create`: the pair has no rate in force; confirming records this one.
 * - `unchanged`: the same rate is already in force; nothing to do.
 * - `conflict`: a different rate is in force. Not overwritten — a change goes through approval.
 * - `daily`: the item's rate changes daily (050); those are set on Daily rates, not agreed.
 * - `error`: see `errors`.
 */
export type VendorRateImportStatus =
  | 'create'
  | 'unchanged'
  | 'conflict'
  | 'daily'
  | 'error';

export interface VendorRateImportRow {
  line: number;
  vendor: string | null;
  item: string | null;
  vendorId: string | null;
  vendorName: string | null;
  itemId: string | null;
  itemName: string | null;
  unit: string | null;
  rate: number | null;
  validFrom: string | null;
  status: VendorRateImportStatus;
  /** The rate in force for the pair, when there is one. */
  current: { rate: number; effectiveFrom: string } | null;
  errors: string[];
}

export interface VendorRateImportReport {
  rows: VendorRateImportRow[];
  summary: Record<VendorRateImportStatus, number> & { rows: number };
  unmatched: { vendors: string[]; items: string[] };
  /** No row is in error. Conflicts and daily-rate rows do not block; they are reported, not written. */
  canConfirm: boolean;
}

const day = (date: Date) => date.toISOString().slice(0, 10);
const decimals = (n: number) => (String(n).split('.')[1] ?? '').length;

/**
 * Agreed vendor rates entered up front (051), from the client's Vendor Rates sheet.
 *
 * 028 let only a vendor's first purchase establish the rate agreed for an item. A company moving
 * onto the product already has those rates on paper, and the first purchase is the wrong place to
 * type them: it would make the clerk who receives the first load the one who sets the contract.
 *
 * An imported rate is an ordinary `VendorItemRate` with no `establishedByPurchaseId`, so purchases
 * read it through `currentFor` and are held to it exactly as to an established one. The import
 * never changes a rate already in force: a pair with a different rate is reported as a conflict,
 * because changing an agreed rate is the approved-change path's job (see `VendorItemRateService`).
 */
@Injectable()
export class AgreedRatesService {
  private readonly timeZone: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly rates: VendorItemRateService,
    private readonly refs: InventoryRefsService,
    private readonly auditLog: AuditLogService,
    configService: ConfigService,
  ) {
    this.timeZone = configService.get<SettingsConfig>('settings').timezone;
  }

  /** The agreed rates in force, by vendor and item. */
  async list(
    caller: AuthenticatedUser,
    query: { vendorId?: string; itemId?: string; companyId?: string },
  ): Promise<{ rows: AgreedRateRow[] }> {
    const companyId = this.refs.targetCompanyOf(caller, query.companyId);
    const rates = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.vendorItemRate.findMany({
          where: {
            companyId,
            effectiveTo: null,
            ...(query.vendorId ? { vendorId: query.vendorId } : {}),
            ...(query.itemId ? { itemId: query.itemId } : {}),
          },
          orderBy: { effectiveFrom: 'desc' },
          take: 5000,
        }),
    );
    const [vendorNames, items] = await Promise.all([
      this.refs.vendorNames(
        caller,
        rates.map((r) => r.vendorId),
      ),
      this.refs.itemsByIds(
        caller,
        rates.map((r) => r.itemId),
      ),
    ]);
    const rows = rates.map((rate): AgreedRateRow => {
      const item = items.get(rate.itemId);
      return {
        id: rate.id,
        vendorId: rate.vendorId,
        vendorName: vendorNames.get(rate.vendorId) ?? 'Unknown vendor',
        itemId: rate.itemId,
        itemCode: item?.code ?? '',
        itemName: item?.name ?? 'Unknown item',
        unit: item?.unit ?? '',
        rate: rate.rate.toNumber(),
        effectiveFrom: day(rate.effectiveFrom),
        source: rate.establishedByPurchaseId ? 'purchase' : 'import',
      };
    });
    rows.sort(
      (a, b) =>
        a.vendorName.localeCompare(b.vendorName) ||
        a.itemName.localeCompare(b.itemName),
    );
    return { rows };
  }

  /** The import template: the client's Vendor Rates columns and nothing else. */
  async template(): Promise<Buffer> {
    return buildWorkbook(
      'Vendor Rates',
      VENDOR_RATE_COLUMNS.map((column) => ({
        header: column.label,
        width: column.key === 'rate' || column.key === 'validFrom' ? 18 : 36,
        value: () => null,
      })),
      [],
    );
  }

  /**
   * Reads the sheet and says what each row would do, writing nothing. Vendor and item names are
   * matched on their letters and digits alone, ignoring case, spaces and punctuation.
   */
  async validateImport(
    caller: AuthenticatedUser,
    fileBase64: string,
    requestedCompanyId?: string,
  ): Promise<VendorRateImportReport> {
    const companyId = this.refs.targetCompanyOf(caller, requestedCompanyId);
    const sheet = await readSheetRows(
      fileBase64,
      VENDOR_RATE_COLUMNS,
      'the Vendor Rates sheet',
    );
    const [vendors, items] = await Promise.all([
      this.refs.companyVendors(caller, companyId),
      this.refs.companyItems(caller, companyId),
    ]);
    const vendorIndex = indexByName(vendors, (v) => v.name, looseNameKey);
    const itemIndex = indexByName(items, (i) => i.name, looseNameKey);
    const current = await this.currentRates(caller, companyId);

    const today = zonedDateOnly(new Date(), this.timeZone);
    const firstLineOf = new Map<string, number>();
    const unmatchedVendors = new Set<string>();
    const unmatchedItems = new Set<string>();

    const rows = sheet.map(({ line, cells }): VendorRateImportRow => {
      const errors: string[] = [];
      const vendorName = cellText(cells.vendor);
      const itemName = cellText(cells.item);

      let vendor: { id: string; name: string } | null = null;
      if (!vendorName) errors.push('Vendor Name is blank.');
      else {
        const found = vendorIndex.get(looseNameKey(vendorName)) ?? [];
        if (found.length === 0) {
          errors.push(`No vendor named "${vendorName}" in this company.`);
          unmatchedVendors.add(vendorName);
        } else if (found.length > 1) {
          errors.push(`More than one vendor is named like "${vendorName}".`);
        } else vendor = found[0];
      }

      let item: ItemView | null = null;
      if (!itemName) errors.push('Item Name is blank.');
      else {
        const found = itemIndex.get(looseNameKey(itemName)) ?? [];
        if (found.length === 0) {
          errors.push(`No item named "${itemName}" in the item master.`);
          unmatchedItems.add(itemName);
        } else if (found.length > 1) {
          errors.push(`More than one item is named like "${itemName}".`);
        } else item = found[0];
      }

      const rate = cellNumber(cells.rate);
      if (rate === null) errors.push('Rate is blank.');
      else if (Number.isNaN(rate) || rate <= 0)
        errors.push('Rate must be a number more than 0.');
      else if (decimals(rate) > 2)
        errors.push('Rate has more than 2 decimal places.');

      const date = cellDate(cells.validFrom);
      let validFrom: string | null = date === 'invalid' ? null : date ?? today;
      if (date === 'invalid') {
        errors.push('Valid From is not a date. Use DD-MM-YYYY.');
      } else if (validFrom > today) {
        errors.push('Valid From is in the future.');
        validFrom = null;
      }

      let inForce: { rate: number; effectiveFrom: string } | null = null;
      if (vendor && item) {
        const pair = `${vendor.id}|${item.id}`;
        const first = firstLineOf.get(pair);
        if (first !== undefined) {
          errors.push(`Same vendor and item as row ${first}.`);
        } else {
          firstLineOf.set(pair, line);
        }
        const agreed = current.get(pair);
        if (agreed) {
          inForce = {
            rate: agreed.rate.toNumber(),
            effectiveFrom: day(agreed.effectiveFrom),
          };
        }
      }

      const goodRate = rate !== null && !Number.isNaN(rate) ? rate : null;
      let status: VendorRateImportStatus;
      if (errors.length > 0) status = 'error';
      else if (item.dailyRate) status = 'daily';
      else if (!inForce) status = 'create';
      else
        status = current
          .get(`${vendor.id}|${item.id}`)
          .rate.equals(new Prisma.Decimal(goodRate))
          ? 'unchanged'
          : 'conflict';

      return {
        line,
        vendor: vendorName,
        item: itemName,
        vendorId: vendor?.id ?? null,
        vendorName: vendor?.name ?? null,
        itemId: item?.id ?? null,
        itemName: item?.name ?? null,
        unit: item?.unit ?? null,
        rate: goodRate,
        validFrom,
        status,
        current: inForce,
        errors,
      };
    });

    const count = (status: VendorRateImportStatus) =>
      rows.filter((row) => row.status === status).length;
    return {
      rows,
      summary: {
        rows: rows.length,
        create: count('create'),
        unchanged: count('unchanged'),
        conflict: count('conflict'),
        daily: count('daily'),
        error: count('error'),
      },
      unmatched: {
        vendors: [...unmatchedVendors],
        items: [...unmatchedItems],
      },
      canConfirm: count('error') === 0,
    };
  }

  /**
   * Validates again and records every `create` row in one transaction — or nothing, when any row is
   * in error. Unchanged, conflicting and daily-rate rows are reported and left alone.
   */
  async confirmImport(
    caller: AuthenticatedUser,
    fileBase64: string,
    ipAddress: string,
    requestedCompanyId?: string,
  ): Promise<{
    created: number;
    unchanged: number;
    conflicts: number;
    daily: number;
    report: VendorRateImportReport;
  }> {
    const companyId = this.refs.targetCompanyOf(caller, requestedCompanyId);
    const report = await this.validateImport(caller, fileBase64, companyId);
    if (!report.canConfirm) {
      throw new BadRequestException({
        statusCode: 400,
        code: AGREED_RATE_ERRORS.importInvalid,
        message: `${report.summary.error} of ${report.summary.rows} rows are in error. Nothing was imported.`,
        report,
      });
    }

    const toCreate = report.rows.filter((row) => row.status === 'create');
    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        // Read again inside the transaction: a purchase between validate and confirm may have
        // established one of these pairs, and that rate stands.
        const now = await tx.vendorItemRate.findMany({
          where: {
            companyId,
            effectiveTo: null,
            vendorId: { in: toCreate.map((row) => row.vendorId) },
          },
          select: { vendorId: true, itemId: true },
        });
        const taken = new Set(now.map((r) => `${r.vendorId}|${r.itemId}`));
        const fresh = toCreate.filter(
          (row) => !taken.has(`${row.vendorId}|${row.itemId}`),
        );
        await this.rates.recordAgreed(
          tx,
          fresh.map((row) => ({
            companyId,
            vendorId: row.vendorId,
            itemId: row.itemId,
            rate: row.rate,
            effectiveFrom: this.refs.parseDate(row.validFrom),
          })),
        );
        return fresh;
      },
    );

    // One entry per vendor, carrying every rate agreed with them: the vendor's activity shows
    // "rates agreed for cement, steel, sand" as the one act it was.
    const byVendor = new Map<string, VendorRateImportRow[]>();
    for (const row of created) {
      byVendor.set(row.vendorId, [...(byVendor.get(row.vendorId) ?? []), row]);
    }
    for (const [vendorId, rows] of byVendor) {
      await this.auditLog.record({
        entityType: AuditEntityType.VENDOR,
        action: AuditAction.UPDATE,
        entityId: vendorId,
        changes: {
          agreedRatesImported: rows.map((row) => ({
            itemId: row.itemId,
            rate: row.rate,
            effectiveFrom: row.validFrom,
          })),
        } as Prisma.InputJsonValue,
        accountId: caller.id,
        companyId,
        ipAddress,
      });
    }

    return {
      created: created.length,
      unchanged: report.summary.unchanged,
      conflicts: report.summary.conflict,
      daily: report.summary.daily,
      report,
    };
  }

  /** Every rate in force in the company, by `vendorId|itemId`. */
  private async currentRates(
    caller: AuthenticatedUser,
    companyId: string,
  ): Promise<Map<string, { rate: Prisma.Decimal; effectiveFrom: Date }>> {
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.vendorItemRate.findMany({
          where: { companyId, effectiveTo: null },
          // Oldest first, so a later row left open by mistake wins the map — `currentFor`'s order.
          orderBy: { effectiveFrom: 'asc' },
          select: {
            vendorId: true,
            itemId: true,
            rate: true,
            effectiveFrom: true,
          },
        }),
    );
    return new Map(rows.map((row) => [`${row.vendorId}|${row.itemId}`, row]));
  }
}
