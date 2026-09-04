import { Injectable } from '@nestjs/common';
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
        return { rows: [], total: 0, page, pageSize };
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

    const { balances, total } = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        if (filterInMemory) {
          const balances = await tx.stockBalance.findMany({
            where,
            orderBy: [{ itemId: 'asc' }, { siteId: 'asc' }],
          });
          return { balances, total: balances.length };
        }
        const [balances, total] = await Promise.all([
          tx.stockBalance.findMany({
            where,
            orderBy: [{ itemId: 'asc' }, { siteId: 'asc' }],
            skip: (page - 1) * pageSize,
            take: pageSize,
          }),
          tx.stockBalance.count({ where }),
        ]);
        return { balances, total };
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

    if (!filterInMemory) {
      return { rows, total, page, pageSize };
    }

    const matching = rows.filter((row) => row.belowReorderLevel);
    return {
      rows: matching.slice((page - 1) * pageSize, page * pageSize),
      // The count of rows that actually match, so the caller's page arithmetic is
      // about what it can reach rather than about what was scanned.
      total: matching.length,
      page,
      pageSize,
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
