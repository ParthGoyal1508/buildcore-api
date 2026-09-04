import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';

import { AuthenticatedUser } from '../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../common/prisma/rls-context';
import { ProjectSourcesRegistry } from '../projects/portfolio/project-sources.registry';
import { ProjectsService } from '../projects/portfolio/projects.service';
import { ItemsService } from '../settings/item-masters/items.service';
import { companyScope } from '../settings/company-scope';
import { PurchasesService } from './purchases/purchases.service';
import { inStockOf, toNumber } from './stock/stock.types';

/** One linked item's position, as feature 006's spare-parts reconciliation needs
 * it (006 FR-024). Deliberately smaller than a `StockRow`: the caller is putting
 * two balances beside each other, not rendering the stock screen. */
export interface ItemStockTotals {
  itemId: string;
  itemName: string;
  itemCode: string;
  /** Summed across every site — the question is "how much of this exists",
   * not "where". */
  inStock: number;
  /** Quantity-weighted across sites, so a divergence in rate is as visible as
   * one in quantity. */
  avgRate: number;
}

/**
 * The inventory module's outward contract.
 *
 * Three methods: the material cost feeding 008's Project P&L (FR-009), the material
 * list behind its project-detail tab, and the item-stock lookup feature 006's
 * spare-parts reconciliation reads (006 FR-024).
 * Everything another module needs from `inventory` arrives through here — a table
 * in this schema is never read from outside it (Principle I).
 */
@Injectable()
export class InventoryService implements OnModuleInit {
  private readonly logger = new Logger(InventoryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
    private readonly purchases: PurchasesService,
    private readonly items: ItemsService,
    private readonly sources: ProjectSourcesRegistry,
  ) {}

  /** Announces this module to the project page — see `ProjectSourcesRegistry` for
   * why registration rather than an import back. */
  onModuleInit(): void {
    this.sources.registerMaterialsSource(this);
  }

  /** True once this module can answer, so a P&L can distinguish "no material cost"
   * from "inventory has not shipped". */
  isAvailable(): boolean {
    return true;
  }

  /**
   * Total material purchased for a project's sites in a date range (FR-009).
   *
   * Site resolution goes through `ProjectsService.getSitesByProject()` rather than
   * a join, because the sites live in the `projects` schema (Principle I). That
   * method is a real query now that 008 has shipped `Site.projectId`, so this
   * returns measured figures rather than the zero the original task list expected
   * from a stub.
   *
   * Returns 0 rather than throwing when the project has no sites or the lookup
   * fails: a P&L that renders every other cost line and shows zero material is more
   * useful than one that fails outright, and the caller is expected to say which of
   * its sources were unavailable. The failure is logged so a persistent zero is not
   * mistaken for a measurement.
   */
  async getMaterialCostByProject(
    projectId: string,
    companyId: string,
    dateRange: { from: Date; to: Date },
  ): Promise<number> {
    try {
      const siteIds = await this.projects.getSitesByProject(projectId, {
        isSuperAdmin: false,
        companyId,
      });
      if (siteIds.length === 0) return 0;
      return await this.purchases.materialCostForSites(
        siteIds,
        companyId,
        dateRange,
      );
    } catch (error) {
      this.logger.warn(
        `Material cost for project ${projectId} could not be computed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 0;
    }
  }

  /**
   * Materials issued to a project's sites, per item (008's project-detail tab).
   *
   * Written when feature 006 landed and the same tab's `machinery` half became
   * real: leaving `materials` empty while `machinery` filled in would have made the
   * project page say "inventory has not shipped" about a module that had.
   *
   * Issues net of their reversals, because the ledger is append-only — a reversed
   * issue is still two rows, and counting only the first would report material as
   * consumed that went back on the shelf.
   *
   * Returns an empty list rather than throwing, for the same reason
   * `getMaterialCostByProject` returns 0.
   */
  async getMaterialsByProject(
    caller: AuthenticatedUser,
    projectId: string,
    companyId: string,
  ): Promise<
    {
      itemId: string;
      itemName: string;
      itemCode: string;
      unit: string;
      issuedQuantity: number;
    }[]
  > {
    try {
      const siteIds = await this.projects.getSitesByProject(projectId, {
        isSuperAdmin: false,
        companyId,
      });
      if (siteIds.length === 0) return [];

      const grouped = await withRlsContext(
        this.prisma,
        rlsContextFor(caller),
        (tx) =>
          tx.stockLedgerEntry.groupBy({
            by: ['itemId', 'type'],
            where: {
              companyId,
              siteId: { in: siteIds },
              type: { in: ['issue', 'issue_reversal'] },
            },
            _sum: { quantity: true },
          }),
      );
      if (grouped.length === 0) return [];

      const itemIds = [...new Set(grouped.map((row) => row.itemId))];
      const items = await this.items.getItemsByIds(caller, itemIds);

      return itemIds
        .map((itemId) => {
          const issued = grouped.find(
            (row) => row.itemId === itemId && row.type === 'issue',
          );
          const reversed = grouped.find(
            (row) => row.itemId === itemId && row.type === 'issue_reversal',
          );
          const item = items.get(itemId);
          return {
            itemId,
            itemName: item?.name ?? 'Unknown item',
            itemCode: item?.code ?? '',
            unit: item?.unit ?? '',
            issuedQuantity:
              Math.round(
                (Number(issued?._sum.quantity ?? 0) -
                  Number(reversed?._sum.quantity ?? 0)) *
                  1000,
              ) / 1000,
          };
        })
        .filter((row) => row.issuedQuantity !== 0)
        .sort((a, b) => a.itemName.localeCompare(b.itemName));
    } catch (error) {
      this.logger.warn(
        `Materials for project ${projectId} could not be listed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return [];
    }
  }

  /**
   * Company-wide stock position for a set of items (006 FR-024).
   *
   * Added for feature 006, whose spare parts may declare an inventory-item link.
   * The two stocks are independent by design — a workshop shelf and a site store
   * are different places — so this exists to let 006 show both balances side by
   * side and make a divergence visible, rather than to reconcile them.
   *
   * Exported as a service method rather than left as a table for 006 to read:
   * Principle I forbids `plant` querying the `inventory` schema, and this is the
   * seam that keeps that true.
   */
  async getItemStockTotals(
    caller: AuthenticatedUser,
    itemIds: string[],
  ): Promise<Map<string, ItemStockTotals>> {
    const unique = [...new Set(itemIds)];
    if (unique.length === 0) return new Map();

    const [balances, items] = await Promise.all([
      withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
        tx.stockBalance.findMany({
          where: { itemId: { in: unique }, ...companyScope(caller) },
        }),
      ),
      this.items.getItemsByIds(caller, unique),
    ]);

    const totals = new Map<string, ItemStockTotals>();
    for (const itemId of unique) {
      const item = items.get(itemId);
      // An item that exists but has never been received anywhere is a real answer:
      // zero stock, not a missing row. Omitting it would make the reconciliation
      // view silently drop the very pairs most worth looking at.
      const rows = balances.filter((row) => row.itemId === itemId);
      let quantity = 0;
      let value = 0;
      for (const row of rows) {
        const inStock = inStockOf({
          received: toNumber(row.received),
          issued: toNumber(row.issued),
          transferIn: toNumber(row.transferIn),
          transferOut: toNumber(row.transferOut),
          avgRate: toNumber(row.avgRate),
        });
        quantity += inStock;
        value += inStock * toNumber(row.avgRate);
      }
      totals.set(itemId, {
        itemId,
        itemName: item?.name ?? 'Unknown item',
        itemCode: item?.code ?? '',
        inStock: Math.round(quantity * 1000) / 1000,
        avgRate:
          quantity === 0 ? 0 : Math.round((value / quantity) * 1e6) / 1e6,
      });
    }
    return totals;
  }
}
