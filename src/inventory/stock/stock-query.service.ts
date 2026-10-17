import { Injectable } from '@nestjs/common';
import { StockLedgerType } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { companyScope } from '../../settings/company-scope';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from '../constants/inventory.constants';
import { InventoryRefsService } from '../inventory-refs.service';
import { ListStockDto } from './dto/stock.dto';
import { StockService } from './stock.service';
import { StockHint, StockRow, inStockOf, toNumber } from './stock.types';

/** Whether a ledger movement adds to the store (+1) or takes from it (−1). */
const DIRECTION: Record<StockLedgerType, 1 | -1> = {
  purchase: 1,
  purchase_reversal: -1,
  issue: -1,
  issue_reversal: 1,
  transfer_in: 1,
  transfer_out: -1,
  transfer_in_reversal: -1,
  transfer_out_reversal: 1,
};

/** What each movement is called on the ledger screen and in its download. */
const LABEL: Record<StockLedgerType, string> = {
  purchase: 'Received (purchase)',
  purchase_reversal: 'Purchase deleted',
  issue: 'Issued',
  issue_reversal: 'Returned to store',
  transfer_in: 'Transfer in',
  transfer_out: 'Transfer out',
  transfer_in_reversal: 'Transfer in reversed',
  transfer_out_reversal: 'Transfer out reversed',
};

export interface StockLedgerLine {
  id: string;
  date: Date;
  type: StockLedgerType;
  label: string;
  /** The GRN, issue slip or transfer number the movement was recorded under. */
  reference: string | null;
  /** Who or where: the vendor, whom it was issued to, the other store. */
  counterparty: string | null;
  quantityIn: number;
  quantityOut: number;
  rate: number | null;
  /** The store's balance after this movement. */
  balance: number;
}

export interface StockLedger {
  itemId: string;
  itemName: string;
  itemCode: string;
  unit: string;
  siteId: string;
  siteName: string;
  dateFrom: string | null;
  dateTo: string | null;
  openingQuantity: number;
  inQuantity: number;
  outQuantity: number;
  closingQuantity: number;
  /** The weighted average rate today, and the closing quantity valued at it. */
  avgRate: number;
  closingValue: number;
  entries: StockLedgerLine[];
}

/**
 * The read side of stock.
 *
 * Split from `StockService`, which is entirely transactional and takes someone
 * else's `tx`. Nothing here writes, and keeping the two apart means the arithmetic
 * that has to run inside a lock cannot accidentally acquire a connection of its own.
 */
@Injectable()
export class StockQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockService,
    private readonly refs: InventoryRefsService,
  ) {}

  /**
   * Paginated stock rows.
   *
   * Filtering by item attributes (search, category) resolves the matching item ids
   * through `ItemsService` first and constrains the balance query by them, rather
   * than joining: the items live in `settings` and this module may not join across
   * that boundary (Principle I).
   *
   * `belowReorderLevel` is applied after the page is fetched, and is the one filter
   * that cannot be pushed into SQL — the flag compares a computed `inStock` against
   * a threshold held in another schema's table. Documented rather than hidden: a
   * page filtered this way can come back shorter than `pageSize`.
   */
  async list(
    caller: AuthenticatedUser,
    query: ListStockDto,
  ): Promise<{
    rows: StockRow[];
    /** Every matching row valued at its weighted average rate — all pages (036 M13). */
    totals: { stockValue: number };
    total: number;
    page: number;
    pageSize: number;
  }> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(
      query.pageSize ?? DEFAULT_PAGE_SIZE,
      MAX_PAGE_SIZE,
    );

    let itemIdFilter: string[] | undefined;
    if (query.search || query.categoryId) {
      itemIdFilter = await this.refs.itemIdsMatching(caller, {
        search: query.search,
        categoryId: query.categoryId,
        companyId: query.companyId,
      });
      if (itemIdFilter.length === 0) {
        return {
          rows: [],
          totals: { stockValue: 0 },
          total: 0,
          page,
          pageSize,
        };
      }
    }

    const where = {
      ...companyScope(caller, query.companyId),
      ...(query.siteId ? { siteId: query.siteId } : {}),
      ...(itemIdFilter ? { itemId: { in: itemIdFilter } } : {}),
    };

    // `belowReorderLevel` cannot be pushed into SQL: it compares a computed
    // `inStock` against a threshold held in another schema's table, and Principle I
    // forbids the join that would let the database decide. So when it is asked for,
    // the rows are fetched whole, filtered, and paged in memory.
    //
    // Filtering the page instead would be wrong, not merely slower: page 1 would
    // come back with two rows while page 2 held ten more matches, and `total` would
    // count rows that were never going to be shown. The set is bounded by the
    // item-site pairs one company has, which is the same set this screen renders.
    const filterInMemory = query.belowReorderLevel === true;

    const { balances, total, allValue } = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        if (filterInMemory) {
          const balances = await tx.stockBalance.findMany({
            where,
            orderBy: [{ itemId: 'asc' }, { siteId: 'asc' }],
          });
          return { balances, total: balances.length, allValue: null };
        }
        const [balances, total, every] = await Promise.all([
          tx.stockBalance.findMany({
            where,
            orderBy: [{ itemId: 'asc' }, { siteId: 'asc' }],
            skip: (page - 1) * pageSize,
            take: pageSize,
          }),
          tx.stockBalance.count({ where }),
          // 036 M13: the valuation of the whole filter, not the page. Four quantities and a rate
          // per item-site pair — the same bounded set the in-memory filter above reads whole.
          tx.stockBalance.findMany({
            where,
            select: {
              received: true,
              issued: true,
              transferIn: true,
              transferOut: true,
              avgRate: true,
            },
          }),
        ]);
        const allValue = every.reduce((sum, balance) => {
          const inStock = inStockOf({
            received: toNumber(balance.received),
            issued: toNumber(balance.issued),
            transferIn: toNumber(balance.transferIn),
            transferOut: toNumber(balance.transferOut),
            avgRate: toNumber(balance.avgRate),
          });
          return sum + inStock * toNumber(balance.avgRate);
        }, 0);
        return { balances, total, allValue };
      },
    );

    const [items, siteNames] = await Promise.all([
      this.refs.itemsByIds(
        caller,
        balances.map((balance) => balance.itemId),
      ),
      this.refs.siteNames(
        caller,
        balances.map((balance) => balance.siteId),
      ),
    ]);

    const rows = balances.map((balance) => {
      const item = items.get(balance.itemId);
      return this.stock.toRow(
        balance,
        {
          name: item?.name ?? 'Unknown item',
          code: item?.code ?? '',
          categoryName: item?.categoryName ?? '',
          unit: item?.unit ?? '',
          reorderLevel: item?.reorderLevel ?? null,
        },
        siteNames.get(balance.siteId) ?? 'Unknown store',
      );
    });

    const round2 = (n: number) => Math.round(n * 100) / 100;
    if (!filterInMemory) {
      return {
        rows,
        totals: { stockValue: round2(allValue ?? 0) },
        total,
        page,
        pageSize,
      };
    }

    const matching = rows.filter((row) => row.belowReorderLevel);
    return {
      rows: matching.slice((page - 1) * pageSize, page * pageSize),
      totals: {
        stockValue: round2(
          matching.reduce((sum, row) => sum + row.stockValue, 0),
        ),
      },
      // The count of rows that actually match, so the caller's page arithmetic is
      // about what it can reach rather than about what was scanned.
      total: matching.length,
      page,
      pageSize,
    };
  }

  /**
   * One item at one store, movement by movement (036 M13): an opening balance at `dateFrom`, each
   * receipt, issue, return and transfer in date order with the balance after it, and the closing
   * balance at `dateTo`. Each movement names what it was recorded under — the GRN, the issue slip,
   * the transfer number — and who or where it came from or went to.
   *
   * Read straight off `StockLedgerEntry`, the append-only record every balance is the sum of, so
   * the closing figure here is the stock screen's figure (when `dateTo` is today or later).
   */
  async ledger(
    caller: AuthenticatedUser,
    itemId: string,
    siteId: string,
    range: { dateFrom?: string; dateTo?: string; companyId?: string },
  ): Promise<StockLedger> {
    const companyId = this.refs.targetCompanyOf(caller, range.companyId);
    const [item, siteName] = await Promise.all([
      this.refs.requireItem(caller, itemId, companyId),
      this.refs.requireSiteName(caller, siteId, companyId),
    ]);
    const from = range.dateFrom ? this.refs.parseDate(range.dateFrom) : null;
    const to = range.dateTo ? this.refs.parseDate(range.dateTo) : null;
    const scope = { companyId, itemId, siteId };

    const { before, entries, balance, purchases, issues, transfers } =
      await withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
        const [before, entries, balance] = await Promise.all([
          from
            ? tx.stockLedgerEntry.groupBy({
                by: ['type'],
                where: { ...scope, date: { lt: from } },
                _sum: { quantity: true },
              })
            : Promise.resolve([]),
          tx.stockLedgerEntry.findMany({
            where: {
              ...scope,
              ...(from || to
                ? {
                    date: {
                      ...(from ? { gte: from } : {}),
                      ...(to ? { lte: to } : {}),
                    },
                  }
                : {}),
            },
            orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
            take: 5000,
          }),
          tx.stockBalance.findUnique({
            where: { itemId_siteId: { itemId, siteId } },
          }),
        ]);
        const ids = (types: StockLedgerType[]) => [
          ...new Set(
            entries
              .filter((entry) => types.includes(entry.type))
              .map((entry) => entry.referenceId),
          ),
        ];
        const [purchases, issues, transfers] = await Promise.all([
          tx.purchase.findMany({
            where: {
              id: {
                in: ids([
                  StockLedgerType.purchase,
                  StockLedgerType.purchase_reversal,
                ]),
              },
            },
            select: {
              id: true,
              vendorId: true,
              grn: { select: { grnNumber: true } },
            },
          }),
          tx.issue.findMany({
            where: {
              id: {
                in: ids([
                  StockLedgerType.issue,
                  StockLedgerType.issue_reversal,
                ]),
              },
            },
            select: { id: true, slipNo: true, issuedTo: true },
          }),
          tx.stockTransfer.findMany({
            where: {
              id: {
                in: ids([
                  StockLedgerType.transfer_in,
                  StockLedgerType.transfer_out,
                  StockLedgerType.transfer_in_reversal,
                  StockLedgerType.transfer_out_reversal,
                ]),
              },
            },
            select: {
              id: true,
              transferNo: true,
              fromSiteId: true,
              toSiteId: true,
            },
          }),
        ]);
        return { before, entries, balance, purchases, issues, transfers };
      });

    const [vendorNames, siteNames] = await Promise.all([
      this.refs.vendorNames(
        caller,
        purchases.map((p) => p.vendorId),
      ),
      this.refs.siteNames(
        caller,
        transfers.flatMap((t) => [t.fromSiteId, t.toSiteId]),
      ),
    ]);
    const purchaseById = new Map(purchases.map((p) => [p.id, p]));
    const issueById = new Map(issues.map((i) => [i.id, i]));
    const transferById = new Map(transfers.map((t) => [t.id, t]));

    // Summed in thousandths, the column's precision, so the running balance never drifts.
    const milli = (n: number) => Math.round(n * 1000);
    const opening = before.reduce(
      (sum, group) =>
        sum + DIRECTION[group.type] * milli(toNumber(group._sum.quantity)),
      0,
    );
    let running = opening;
    let totalIn = 0;
    let totalOut = 0;
    const lines: StockLedgerLine[] = entries.map((entry) => {
      const quantity = milli(toNumber(entry.quantity));
      const direction = DIRECTION[entry.type];
      running += direction * quantity;
      if (direction > 0) totalIn += quantity;
      else totalOut += quantity;
      let reference: string | null = null;
      let counterparty: string | null = null;
      const purchase = purchaseById.get(entry.referenceId);
      const issue = issueById.get(entry.referenceId);
      const transfer = transferById.get(entry.referenceId);
      if (purchase) {
        reference = purchase.grn?.grnNumber ?? null;
        counterparty = vendorNames.get(purchase.vendorId) ?? null;
      } else if (issue) {
        reference = issue.slipNo;
        counterparty = issue.issuedTo;
      } else if (transfer) {
        reference = transfer.transferNo;
        const other =
          transfer.fromSiteId === siteId
            ? transfer.toSiteId
            : transfer.fromSiteId;
        counterparty = siteNames.get(other) ?? null;
      }
      return {
        id: entry.id,
        date: entry.date,
        type: entry.type,
        label: LABEL[entry.type],
        reference,
        counterparty,
        quantityIn: direction > 0 ? quantity / 1000 : 0,
        quantityOut: direction < 0 ? quantity / 1000 : 0,
        rate: entry.rate === null ? null : toNumber(entry.rate),
        balance: running / 1000,
      };
    });

    const avgRate = balance ? toNumber(balance.avgRate) : 0;
    return {
      itemId,
      itemName: item.name,
      itemCode: item.code,
      unit: item.unit,
      siteId,
      siteName,
      dateFrom: range.dateFrom?.slice(0, 10) ?? null,
      dateTo: range.dateTo?.slice(0, 10) ?? null,
      openingQuantity: opening / 1000,
      inQuantity: totalIn / 1000,
      outQuantity: totalOut / 1000,
      closingQuantity: running / 1000,
      avgRate,
      closingValue: Math.round((running / 1000) * avgRate * 100) / 100,
      entries: lines,
    };
  }

  /**
   * One item-site figure, for the Issue and Transfer forms.
   *
   * An item never received at this site has no balance row, and the honest answer
   * is zero rather than a 404: the form is asking "how much is here", and "none" is
   * a valid answer it needs to display.
   */
  async hint(
    caller: AuthenticatedUser,
    itemId: string,
    siteId: string,
  ): Promise<StockHint> {
    const balance = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.stockBalance.findUnique({
          where: { itemId_siteId: { itemId, siteId } },
        }),
    );
    const item = await this.refs.findItem(caller, itemId);

    if (!balance) {
      return {
        itemId,
        siteId,
        inStock: 0,
        avgRate: 0,
        unit: item?.unit ?? null,
      };
    }
    return {
      itemId,
      siteId,
      inStock: inStockOf({
        received: toNumber(balance.received),
        issued: toNumber(balance.issued),
        transferIn: toNumber(balance.transferIn),
        transferOut: toNumber(balance.transferOut),
        avgRate: toNumber(balance.avgRate),
      }),
      avgRate: toNumber(balance.avgRate),
      unit: item?.unit ?? null,
    };
  }
}
