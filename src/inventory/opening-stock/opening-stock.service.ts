import { randomUUID } from 'crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AuditAction,
  AuditEntityType,
  Prisma,
  StockLedgerType,
} from '@prisma/client';
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
  nameKey,
  readSheetRows,
} from '../imports/sheet-rows';
import { InventoryRefsService } from '../inventory-refs.service';
import { StockService } from '../stock/stock.service';
import {
  CreateOpeningStockDto,
  ReplaceOpeningStockDto,
} from './dto/opening-stock.dto';

export const OPENING_STOCK_ERRORS = {
  /** The item already has an opening entry at that store; replace it instead (051). */
  exists: 'OPENING_STOCK_EXISTS',
  /** Something has moved at that store since the opening entry, so it can no longer change. */
  hasMovements: 'OPENING_STOCK_HAS_MOVEMENTS',
  /** An as-on date after today. */
  futureDate: 'OPENING_STOCK_FUTURE_DATE',
  /** An import whose sheet still has rows in error; nothing was written. */
  importInvalid: 'OPENING_STOCK_IMPORT_INVALID',
} as const;

/** The client's Opening Stock sheet, column for column (051). */
export const OPENING_STOCK_COLUMNS: SheetColumn<
  'store' | 'item' | 'quantity' | 'rate' | 'asOn'
>[] = [
  {
    key: 'store',
    label: 'Store / Site',
    headers: ['store', 'site', 'storename', 'sitename'],
    required: true,
  },
  { key: 'item', label: 'Item Name', headers: ['item'], required: true },
  { key: 'quantity', label: 'Quantity', headers: ['qty'], required: true },
  {
    key: 'rate',
    label: 'Rate (₹ per Unit)',
    headers: ['rate', 'rateperunit', 'rateunit'],
    required: false,
  },
  {
    key: 'asOn',
    label: 'As On Date',
    headers: ['ason', 'date', 'asondateddmmyyyy'],
    required: false,
  },
];

export interface OpeningStockView {
  id: string;
  companyId: string;
  siteId: string;
  siteName: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  unit: string;
  quantity: number;
  /** ₹ per unit; 0 when the entry has no rate. */
  rate: number;
  /** No rate was given: the stock is valued at 0 until one is (051). */
  noRate: boolean;
  /** `quantity × rate`, to the paisa. */
  value: number;
  asOnDate: string;
  /** False once anything has moved at the store since: it can then be neither replaced nor deleted. */
  editable: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** One row of the sheet, as validation read it. */
export interface OpeningImportRow {
  line: number;
  store: string | null;
  item: string | null;
  siteId: string | null;
  siteName: string | null;
  itemId: string | null;
  itemName: string | null;
  unit: string | null;
  quantity: number | null;
  rate: number | null;
  noRate: boolean;
  asOnDate: string | null;
  value: number;
  /** The item already has an opening entry at this store; confirming replaces it. */
  replaces: boolean;
  errors: string[];
}

export interface OpeningImportReport {
  rows: OpeningImportRow[];
  summary: {
    rows: number;
    valid: number;
    invalid: number;
    noRate: number;
    replacing: number;
    value: number;
  };
  /** Each name the sheet used that matched nothing in the company, once. */
  unmatched: { stores: string[]; items: string[] };
  /** No row is in error. Confirming still needs `replaceExisting` when `replacing` is not 0. */
  canConfirm: boolean;
}

/** What one write posts, already validated. */
interface OpeningInput {
  siteId: string;
  itemId: string;
  quantity: number;
  rate: number | null;
  asOnDate: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const decimals = (n: number) => (String(n).split('.')[1] ?? '').length;
const day = (date: Date) => date.toISOString().slice(0, 10);

/**
 * Opening stock (051): what a store already held when the company started recording it here.
 *
 * ## Why not a purchase
 *
 * Stock only ever entered through a purchase, a transfer or a returned issue. Booking the opening
 * count as a purchase would raise a bill, and with it a payable to a vendor for material bought
 * years ago, and would fix an agreed rate (028) for that vendor. So it is its own ledger type,
 * `opening`, with no document behind it but this row.
 *
 * ## How it counts
 *
 * Into `StockBalance.received`, and into the weighted average like a receipt (`recomputeWAR` values
 * it as one). Received rather than a fifth column because "in stock" is computed from those four
 * columns in eight places, two of them SQL; an opening count *is* stock received into the store,
 * and the item ledger still shows it as its own "Opening stock" line.
 *
 * ## Changing one
 *
 * One entry per item per store. It may be replaced or deleted only while nothing has moved for that
 * item at that store since it was recorded: after an issue, a transfer or a purchase, the balance,
 * the average and every document since were built on it. Replacing removes its ledger row rather
 * than appending a reversal — with nothing after it, the ledger is then exactly as if it had been
 * recorded right the first time, and the audit log keeps what it was.
 */
@Injectable()
export class OpeningStockService {
  private readonly timeZone: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockService,
    private readonly refs: InventoryRefsService,
    private readonly auditLog: AuditLogService,
    configService: ConfigService,
  ) {
    this.timeZone = configService.get<SettingsConfig>('settings').timezone;
  }

  /** Today in the business time zone, `YYYY-MM-DD`. */
  today(): string {
    return zonedDateOnly(new Date(), this.timeZone);
  }

  async list(
    caller: AuthenticatedUser,
    query: { siteId?: string; companyId?: string },
  ): Promise<{
    rows: OpeningStockView[];
    totals: { value: number; noRate: number };
  }> {
    const companyId = this.refs.targetCompanyOf(caller, query.companyId);
    const { rows, locked } = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const rows = await tx.openingStock.findMany({
          where: {
            companyId,
            ...(query.siteId ? { siteId: query.siteId } : {}),
          },
          orderBy: [{ siteId: 'asc' }, { createdAt: 'asc' }],
          take: 5000,
        });
        return { rows, locked: await this.movedSince(tx, rows) };
      },
    );
    const views = await this.views(caller, rows, locked);
    views.sort(
      (a, b) =>
        a.siteName.localeCompare(b.siteName) ||
        a.itemName.localeCompare(b.itemName),
    );
    return {
      rows: views,
      totals: {
        value: round2(views.reduce((sum, row) => sum + row.value, 0)),
        noRate: views.filter((row) => row.noRate).length,
      },
    };
  }

  async create(
    caller: AuthenticatedUser,
    dto: CreateOpeningStockDto,
    ipAddress: string,
    requestedCompanyId?: string,
  ): Promise<OpeningStockView> {
    const companyId = this.refs.targetCompanyOf(caller, requestedCompanyId);
    await this.refs.requireSiteName(caller, dto.siteId, companyId);
    const item = await this.refs.requireItem(caller, dto.itemId, companyId);
    if (!item.active) {
      throw new BadRequestException(
        `${item.name} is inactive. Reactivate it in the item master first.`,
      );
    }
    const input: OpeningInput = {
      siteId: dto.siteId,
      itemId: dto.itemId,
      quantity: dto.quantity,
      rate: dto.rate ?? null,
      asOnDate: this.asOn(dto.asOnDate),
    };

    const [row] = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) => this.post(tx, companyId, caller.id, [input], false),
    );
    await this.audit(caller, companyId, ipAddress, AuditAction.CREATE, {
      entityId: input.itemId,
      openingStockId: row.id,
      after: this.auditFigures(input),
    });
    return this.one(caller, row.id);
  }

  async replace(
    caller: AuthenticatedUser,
    id: string,
    dto: ReplaceOpeningStockDto,
    ipAddress: string,
  ): Promise<OpeningStockView> {
    const existing = await this.find(caller, id);
    const input: OpeningInput = {
      siteId: existing.siteId,
      itemId: existing.itemId,
      quantity: dto.quantity,
      rate: dto.rate ?? null,
      asOnDate: this.asOn(dto.asOnDate),
    };
    await withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
      this.post(tx, existing.companyId, caller.id, [input], true),
    );
    await this.audit(
      caller,
      existing.companyId,
      ipAddress,
      AuditAction.UPDATE,
      {
        entityId: existing.itemId,
        openingStockId: id,
        before: this.auditFigures(existing),
        after: this.auditFigures(input),
      },
    );
    return this.one(caller, id);
  }

  async remove(
    caller: AuthenticatedUser,
    id: string,
    ipAddress: string,
  ): Promise<{ id: string; deleted: true }> {
    const existing = await this.find(caller, id);
    await withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
      const { itemId, siteId, companyId } = existing;
      // The balance lock first, as every movement takes it: an issue racing this delete either
      // committed before it (and is found below) or waits for it (and sees the stock gone).
      await this.stock.lockAvailable(tx, { itemId, siteId });
      const row = await tx.openingStock.findUnique({ where: { id } });
      if (!row) throw new NotFoundException(`Opening stock ${id} not found`);
      this.assertUnmoved(await this.movedSince(tx, [row]), row.id);

      await tx.stockLedgerEntry.deleteMany({
        where: { referenceId: id, type: StockLedgerType.opening },
      });
      await tx.openingStock.delete({ where: { id } });
      const others = await tx.stockLedgerEntry.count({
        where: { companyId, itemId, siteId },
      });
      if (others === 0) {
        // Nothing else ever moved here: the balance row existed only for this entry.
        await tx.stockBalance.deleteMany({ where: { itemId, siteId } });
      } else {
        await tx.stockBalance.updateMany({
          where: { itemId, siteId },
          data: { received: { decrement: row.quantity } },
        });
        await this.stock.recomputeWAR(tx, { companyId, itemId, siteId });
      }
    });
    await this.audit(
      caller,
      existing.companyId,
      ipAddress,
      AuditAction.DELETE,
      {
        entityId: existing.itemId,
        openingStockId: id,
        before: this.auditFigures(existing),
      },
    );
    return { id, deleted: true };
  }

  /** The import template: the client's Opening Stock columns and nothing else. */
  async template(): Promise<Buffer> {
    return buildWorkbook(
      'Opening Stock',
      OPENING_STOCK_COLUMNS.map((column) => ({
        header: column.label,
        width: column.key === 'item' ? 36 : column.key === 'store' ? 28 : 18,
        value: () => null,
      })),
      [],
    );
  }

  /**
   * Reads the sheet and reports every row — matched, in error, or replacing an entry — writing
   * nothing. Names are matched case- and space-insensitively within the company.
   */
  async validateImport(
    caller: AuthenticatedUser,
    fileBase64: string,
    requestedCompanyId?: string,
  ): Promise<OpeningImportReport> {
    const companyId = this.refs.targetCompanyOf(caller, requestedCompanyId);
    const sheet = await readSheetRows(
      fileBase64,
      OPENING_STOCK_COLUMNS,
      'the Opening Stock sheet',
    );
    const [sites, items] = await Promise.all([
      this.refs.companySites(caller, companyId),
      this.refs.companyItems(caller, companyId),
    ]);
    const siteIndex = indexByName(sites, (s) => s.name, nameKey);
    const itemIndex = indexByName(items, (i) => i.name, nameKey);
    const { existing, locked } = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.openingStock.findMany({
          where: { companyId },
        });
        return { existing, locked: await this.movedSince(tx, existing) };
      },
    );
    const existingByPair = new Map(
      existing.map((row) => [`${row.itemId}|${row.siteId}`, row]),
    );

    const today = this.today();
    const firstLineOf = new Map<string, number>();
    const unmatchedStores = new Set<string>();
    const unmatchedItems = new Set<string>();

    const rows = sheet.map(({ line, cells }): OpeningImportRow => {
      const errors: string[] = [];
      const store = cellText(cells.store);
      const itemName = cellText(cells.item);

      let site: { id: string; name: string } | null = null;
      if (!store) errors.push('Store / Site is blank.');
      else {
        const found = siteIndex.get(nameKey(store)) ?? [];
        if (found.length === 0) {
          errors.push(`No store named "${store}" in this company.`);
          unmatchedStores.add(store);
        } else if (found.length > 1) {
          errors.push(`More than one store is named "${store}".`);
        } else site = found[0];
      }

      let item: ItemView | null = null;
      if (!itemName) errors.push('Item Name is blank.');
      else {
        const found = itemIndex.get(nameKey(itemName)) ?? [];
        if (found.length === 0) {
          errors.push(`No item named "${itemName}" in the item master.`);
          unmatchedItems.add(itemName);
        } else if (found.length > 1) {
          errors.push(`More than one item is named "${itemName}".`);
        } else if (!found[0].active) {
          errors.push(`${found[0].name} is inactive in the item master.`);
        } else item = found[0];
      }

      const quantity = cellNumber(cells.quantity);
      if (quantity === null) errors.push('Quantity is blank.');
      else if (Number.isNaN(quantity) || quantity <= 0)
        errors.push('Quantity must be a number more than 0.');
      else if (decimals(quantity) > 3)
        errors.push('Quantity has more than 3 decimal places.');

      const rate = cellNumber(cells.rate);
      if (rate !== null && (Number.isNaN(rate) || rate < 0))
        errors.push('Rate must be a number, 0 or more.');
      else if (rate !== null && decimals(rate) > 2)
        errors.push('Rate has more than 2 decimal places.');

      const date = cellDate(cells.asOn);
      let asOnDate: string | null = date === 'invalid' ? null : date ?? today;
      if (date === 'invalid') {
        errors.push('As On Date is not a date. Use DD-MM-YYYY.');
      } else if (asOnDate > today) {
        errors.push('As On Date is in the future.');
        asOnDate = null;
      }

      let replaces = false;
      if (site && item) {
        const pair = `${item.id}|${site.id}`;
        const first = firstLineOf.get(pair);
        if (first !== undefined) {
          errors.push(`Same store and item as row ${first}.`);
        } else {
          firstLineOf.set(pair, line);
        }
        const current = existingByPair.get(pair);
        if (current) {
          replaces = true;
          if (locked.has(current.id)) {
            errors.push(
              'Already has an opening entry, and stock has moved at this store since, so it cannot be replaced.',
            );
          }
        }
      }

      const goodQuantity =
        quantity !== null && !Number.isNaN(quantity) ? quantity : null;
      const goodRate = rate !== null && !Number.isNaN(rate) ? rate : null;
      return {
        line,
        store,
        item: itemName,
        siteId: site?.id ?? null,
        siteName: site?.name ?? null,
        itemId: item?.id ?? null,
        itemName: item?.name ?? null,
        unit: item?.unit ?? null,
        quantity: goodQuantity,
        rate: goodRate,
        noRate: goodRate === null || goodRate === 0,
        asOnDate,
        value: round2((goodQuantity ?? 0) * (goodRate ?? 0)),
        replaces,
        errors,
      };
    });

    const valid = rows.filter((row) => row.errors.length === 0);
    return {
      rows,
      summary: {
        rows: rows.length,
        valid: valid.length,
        invalid: rows.length - valid.length,
        noRate: valid.filter((row) => row.noRate).length,
        replacing: valid.filter((row) => row.replaces).length,
        value: round2(valid.reduce((sum, row) => sum + row.value, 0)),
      },
      unmatched: {
        stores: [...unmatchedStores],
        items: [...unmatchedItems],
      },
      canConfirm: valid.length === rows.length,
    };
  }

  /**
   * Validates the sheet again and writes every row in one transaction — or nothing, when any row
   * is in error. Rows replacing an existing entry need `replaceExisting`.
   */
  async confirmImport(
    caller: AuthenticatedUser,
    fileBase64: string,
    replaceExisting: boolean,
    ipAddress: string,
    requestedCompanyId?: string,
  ): Promise<{
    created: number;
    replaced: number;
    report: OpeningImportReport;
  }> {
    const companyId = this.refs.targetCompanyOf(caller, requestedCompanyId);
    const report = await this.validateImport(caller, fileBase64, companyId);
    if (!report.canConfirm) {
      throw new BadRequestException({
        statusCode: 400,
        code: OPENING_STOCK_ERRORS.importInvalid,
        message: `${report.summary.invalid} of ${report.summary.rows} rows are in error. Nothing was imported.`,
        report,
      });
    }
    if (report.summary.replacing > 0 && !replaceExisting) {
      throw new ConflictException({
        statusCode: 409,
        code: OPENING_STOCK_ERRORS.exists,
        message:
          `${report.summary.replacing} rows name an item that already has opening stock at that store. ` +
          'Confirm again with replace ticked to replace those entries.',
      });
    }

    const inputs: OpeningInput[] = report.rows.map((row) => ({
      siteId: row.siteId,
      itemId: row.itemId,
      quantity: row.quantity,
      rate: row.rate,
      asOnDate: row.asOnDate,
    }));
    await withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
      this.post(tx, companyId, caller.id, inputs, true),
    );

    // One entry for the import, carrying every row, rather than hundreds: a reader of the activity
    // log sees "opening stock imported, 412 rows" as the one act it was. Keyed on the company,
    // because the act spans its stores and items.
    await this.auditLog.record({
      entityType: AuditEntityType.COMPANY,
      action: AuditAction.CREATE,
      entityId: companyId,
      changes: {
        openingStockImport: {
          rows: report.rows.map((row) => ({
            line: row.line,
            siteId: row.siteId,
            itemId: row.itemId,
            quantity: row.quantity,
            rate: row.rate,
            asOnDate: row.asOnDate,
            replaced: row.replaces,
          })),
        },
      } as Prisma.InputJsonValue,
      accountId: caller.id,
      companyId,
      ipAddress,
    });

    return {
      created: report.summary.rows - report.summary.replacing,
      replaced: report.summary.replacing,
      report,
    };
  }

  /**
   * Posts opening entries in the caller's transaction, in a fixed number of statements however many
   * rows there are — an import of a few hundred lines must fit the interactive transaction's
   * time limit as easily as one entry does.
   *
   * @param replace whether an existing entry for a pair may be replaced; refused (409) otherwise.
   */
  private async post(
    tx: Prisma.TransactionClient,
    companyId: string,
    userId: string,
    inputs: OpeningInput[],
    replace: boolean,
  ): Promise<{ id: string }[]> {
    const itemIds = inputs.map((input) => input.itemId);
    const siteIds = inputs.map((input) => input.siteId);

    // Every balance row exists and is locked before anything is read, as a purchase does it.
    await tx.$executeRaw`
      INSERT INTO "inventory"."StockBalance" ("id", "companyId", "itemId", "siteId", "updatedAt")
      SELECT gen_random_uuid()::text, ${companyId}, p."itemId", p."siteId", NOW()
      FROM unnest(${itemIds}::text[], ${siteIds}::text[]) AS p("itemId", "siteId")
      ON CONFLICT ("itemId", "siteId") DO NOTHING
    `;
    const balances = await tx.$queryRaw<
      { id: string; itemId: string; siteId: string }[]
    >`
      SELECT b."id", b."itemId", b."siteId"
      FROM "inventory"."StockBalance" b
      JOIN unnest(${itemIds}::text[], ${siteIds}::text[]) AS p("itemId", "siteId")
        ON b."itemId" = p."itemId" AND b."siteId" = p."siteId"
      ORDER BY b."id"
      FOR UPDATE OF b
    `;
    const balanceOf = new Map(
      balances.map((b) => [`${b.itemId}|${b.siteId}`, b.id]),
    );

    const existing = await tx.openingStock.findMany({
      where: { itemId: { in: itemIds }, siteId: { in: siteIds } },
    });
    const pairs = new Set(inputs.map((i) => `${i.itemId}|${i.siteId}`));
    const replaced = new Map(
      existing
        .filter((row) => pairs.has(`${row.itemId}|${row.siteId}`))
        .map((row) => [`${row.itemId}|${row.siteId}`, row]),
    );
    if (replaced.size > 0 && !replace) {
      const [row] = [...replaced.values()];
      throw new ConflictException({
        statusCode: 409,
        code: OPENING_STOCK_ERRORS.exists,
        message:
          'This item already has opening stock at this store. Replace that entry instead of adding a second.',
        openingStockId: row.id,
      });
    }
    const locked = await this.movedSince(tx, [...replaced.values()]);
    for (const row of replaced.values()) this.assertUnmoved(locked, row.id);

    // Which pairs have any other movement: those need the average replayed from the ledger. The
    // rest hold only this entry, so the average is simply its rate.
    const moved = await tx.stockLedgerEntry.groupBy({
      by: ['itemId', 'siteId'],
      where: {
        companyId,
        itemId: { in: itemIds },
        siteId: { in: siteIds },
        type: { not: StockLedgerType.opening },
      },
    });
    const hasOthers = new Set(moved.map((m) => `${m.itemId}|${m.siteId}`));

    if (replaced.size > 0) {
      await tx.stockLedgerEntry.deleteMany({
        where: {
          referenceId: { in: [...replaced.values()].map((row) => row.id) },
          type: StockLedgerType.opening,
        },
      });
    }

    const ids: { id: string }[] = [];
    const fresh: Prisma.OpeningStockCreateManyInput[] = [];
    const ledger: Prisma.StockLedgerEntryCreateManyInput[] = [];
    const balanceIds: string[] = [];
    const deltas: string[] = [];
    const rates: string[] = [];
    for (const input of inputs) {
      const pair = `${input.itemId}|${input.siteId}`;
      const before = replaced.get(pair);
      const id = before?.id ?? randomUUID();
      const asOnDate = this.refs.parseDate(input.asOnDate);
      if (before) {
        await tx.openingStock.update({
          where: { id },
          data: {
            quantity: input.quantity,
            rate: input.rate,
            asOnDate,
            createdByUserId: userId,
          },
        });
      } else {
        fresh.push({
          id,
          companyId,
          siteId: input.siteId,
          itemId: input.itemId,
          quantity: input.quantity,
          rate: input.rate,
          asOnDate,
          createdByUserId: userId,
        });
      }
      ledger.push({
        companyId,
        itemId: input.itemId,
        siteId: input.siteId,
        type: StockLedgerType.opening,
        quantity: input.quantity,
        rate: input.rate ?? 0,
        referenceId: id,
        date: asOnDate,
      });
      balanceIds.push(balanceOf.get(pair));
      deltas.push(
        new Prisma.Decimal(input.quantity)
          .minus(before?.quantity ?? 0)
          .toString(),
      );
      // The average is set outright only where this entry is the pair's whole history.
      rates.push(hasOthers.has(pair) ? '' : String(input.rate ?? 0));
      ids.push({ id });
    }
    if (fresh.length > 0) await tx.openingStock.createMany({ data: fresh });
    await tx.stockLedgerEntry.createMany({ data: ledger });
    await tx.$executeRaw`
      UPDATE "inventory"."StockBalance" b
      SET "received" = b."received" + v."delta"::numeric,
          "avgRate" = COALESCE(NULLIF(v."rate", '')::numeric, b."avgRate"),
          "updatedAt" = NOW()
      FROM unnest(${balanceIds}::text[], ${deltas}::text[], ${rates}::text[])
        AS v("id", "delta", "rate")
      WHERE b."id" = v."id"
    `;
    for (const input of inputs) {
      if (hasOthers.has(`${input.itemId}|${input.siteId}`)) {
        await this.stock.recomputeWAR(tx, {
          companyId,
          itemId: input.itemId,
          siteId: input.siteId,
        });
      }
    }
    return ids;
  }

  /**
   * The opening entries something has moved after, by id: any other ledger row of the same item at
   * the same store recorded after the entry's own. Two queries for any number of entries.
   */
  private async movedSince(
    tx: Prisma.TransactionClient,
    rows: { id: string; companyId: string; itemId: string; siteId: string }[],
  ): Promise<Set<string>> {
    if (rows.length === 0) return new Set();
    const [own, latest] = await Promise.all([
      tx.stockLedgerEntry.findMany({
        where: {
          referenceId: { in: rows.map((row) => row.id) },
          type: StockLedgerType.opening,
        },
        select: { referenceId: true, createdAt: true },
      }),
      tx.stockLedgerEntry.groupBy({
        by: ['itemId', 'siteId'],
        where: {
          itemId: { in: rows.map((row) => row.itemId) },
          siteId: { in: rows.map((row) => row.siteId) },
          type: { not: StockLedgerType.opening },
        },
        _max: { createdAt: true },
      }),
    ]);
    const postedAt = new Map(own.map((o) => [o.referenceId, o.createdAt]));
    const lastMove = new Map(
      latest.map((l) => [`${l.itemId}|${l.siteId}`, l._max.createdAt]),
    );
    const locked = new Set<string>();
    for (const row of rows) {
      const last = lastMove.get(`${row.itemId}|${row.siteId}`);
      const at = postedAt.get(row.id);
      if (last && at && last.getTime() > at.getTime()) locked.add(row.id);
    }
    return locked;
  }

  private assertUnmoved(locked: Set<string>, id: string): void {
    if (!locked.has(id)) return;
    throw new ConflictException({
      statusCode: 409,
      code: OPENING_STOCK_ERRORS.hasMovements,
      message:
        'Stock of this item has moved at this store since its opening entry was recorded, so the ' +
        'entry can no longer be replaced or deleted. Correct it with a purchase, issue or transfer.',
    });
  }

  /** A request's as-on date, or today; never after today. */
  private asOn(value?: string): string {
    const today = this.today();
    const date = value ? value.slice(0, 10) : today;
    if (date > today) {
      throw new BadRequestException({
        statusCode: 400,
        code: OPENING_STOCK_ERRORS.futureDate,
        message: 'The as-on date cannot be in the future.',
      });
    }
    return date;
  }

  private async find(caller: AuthenticatedUser, id: string) {
    const row = await withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
      tx.openingStock.findUnique({ where: { id } }),
    );
    if (!row) throw new NotFoundException(`Opening stock ${id} not found`);
    return row;
  }

  private async one(
    caller: AuthenticatedUser,
    id: string,
  ): Promise<OpeningStockView> {
    const { row, locked } = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const row = await tx.openingStock.findUniqueOrThrow({ where: { id } });
        return { row, locked: await this.movedSince(tx, [row]) };
      },
    );
    const [view] = await this.views(caller, [row], locked);
    return view;
  }

  private async views(
    caller: AuthenticatedUser,
    rows: {
      id: string;
      companyId: string;
      siteId: string;
      itemId: string;
      quantity: Prisma.Decimal;
      rate: Prisma.Decimal | null;
      asOnDate: Date;
      createdAt: Date;
      updatedAt: Date;
    }[],
    locked: Set<string>,
  ): Promise<OpeningStockView[]> {
    const [items, siteNames] = await Promise.all([
      this.refs.itemsByIds(
        caller,
        rows.map((row) => row.itemId),
      ),
      this.refs.siteNames(
        caller,
        rows.map((row) => row.siteId),
      ),
    ]);
    return rows.map((row) => {
      const item = items.get(row.itemId);
      const quantity = row.quantity.toNumber();
      const rate = row.rate?.toNumber() ?? 0;
      return {
        id: row.id,
        companyId: row.companyId,
        siteId: row.siteId,
        siteName: siteNames.get(row.siteId) ?? 'Unknown store',
        itemId: row.itemId,
        itemCode: item?.code ?? '',
        itemName: item?.name ?? 'Unknown item',
        unit: item?.unit ?? '',
        quantity,
        rate,
        noRate: rate === 0,
        value: round2(quantity * rate),
        asOnDate: day(row.asOnDate),
        editable: !locked.has(row.id),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    });
  }

  private auditFigures(row: {
    siteId: string;
    itemId: string;
    quantity: number | Prisma.Decimal;
    rate: number | Prisma.Decimal | null;
    asOnDate: string | Date;
  }) {
    return {
      siteId: row.siteId,
      itemId: row.itemId,
      quantity: Number(row.quantity),
      rate: row.rate === null ? null : Number(row.rate),
      asOnDate:
        typeof row.asOnDate === 'string' ? row.asOnDate : day(row.asOnDate),
    };
  }

  /**
   * Audited under `ITEM`, keyed on the item, as 050's daily rates are: opening stock is a fact about
   * an item at a store, and an activity log filtered to the item should find it.
   */
  private async audit(
    caller: AuthenticatedUser,
    companyId: string,
    ipAddress: string,
    action: AuditAction,
    { entityId, ...changes }: { entityId: string } & Record<string, unknown>,
  ): Promise<void> {
    await this.auditLog.record({
      entityType: AuditEntityType.ITEM,
      action,
      entityId,
      changes: { openingStock: changes } as Prisma.InputJsonValue,
      accountId: caller.id,
      companyId,
      ipAddress,
    });
  }
}
