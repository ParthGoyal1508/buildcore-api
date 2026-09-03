import { Prisma } from '@prisma/client';

/** One row of the stock view (data-model.md). Every figure is a `number`: the
 * columns behind them are Prisma `Decimal`s, which serialise as strings, and every
 * consumer of a stock figure does arithmetic or a comparison with it. */
export interface StockRow {
  itemId: string;
  itemName: string;
  itemCode: string;
  siteId: string;
  siteName: string;
  category: string;
  unit: string;

  received: number;
  issued: number;
  transferIn: number;
  transferOut: number;

  /** `received + transferIn − issued − transferOut`. Never stored (FR-014). */
  inStock: number;
  avgRate: number;
  /** `inStock × avgRate`. Never stored (research.md §11). */
  stockValue: number;

  reorderLevel: number | null;
  /** `inStock < reorderLevel`. False when the item has no reorder level at all —
   * an item without a floor cannot be below one (research.md §12). */
  belowReorderLevel: boolean;
}

/** What the Issue and Transfer forms ask for before letting someone type a
 * quantity. Deliberately smaller than a `StockRow`: the form needs the number and
 * the rate, not the whole row. */
export interface StockHint {
  itemId: string;
  siteId: string;
  inStock: number;
  avgRate: number;
  unit: string | null;
}

/** The four running totals, as plain numbers. */
export interface BalanceTotals {
  received: number;
  issued: number;
  transferIn: number;
  transferOut: number;
  avgRate: number;
}

export const toNumber = (value: Prisma.Decimal | number | null): number =>
  value === null ? 0 : typeof value === 'number' ? value : value.toNumber();

/** `received + transferIn − issued − transferOut`, the one definition of "in stock". */
export const inStockOf = (totals: BalanceTotals): number =>
  totals.received + totals.transferIn - totals.issued - totals.transferOut;
