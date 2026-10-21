import { Prisma } from '@prisma/client';

import { CompositeItemView } from '../../settings/item-masters/composite-items.service';

/** One sub-item of a composite issue, with the quantity it takes from the store. */
export interface CompositeLine {
  itemId: string;
  itemName: string;
  itemCode: string;
  unit: string;
  qtyPerUnit: number;
  /** `quantity × qtyPerUnit`, rounded half-up to 3 decimals — the issue column's precision. */
  quantity: Prisma.Decimal;
}

/**
 * The sub-item quantities for `quantity` units of a composite (039).
 *
 * Decimal arithmetic, not floats: 10 × 0.827 must be 8.27 exactly, and a float product rounded
 * after the fact can land a thousandth off on a half. Each line is rounded on its own to the
 * three decimals the `Issue.quantity` column holds, half-up; the lines are not re-balanced to a
 * total, since each is a separate material with its own stock.
 *
 * Sorted by item id, the order the balances are locked in: two composite issues sharing
 * sub-items then always lock in the same order and cannot deadlock on each other.
 */
export function compositeLines(
  composite: Pick<CompositeItemView, 'components'>,
  quantity: number | string | Prisma.Decimal,
): CompositeLine[] {
  const units = new Prisma.Decimal(quantity);
  return composite.components
    .map((component) => ({
      itemId: component.itemId,
      itemName: component.itemName,
      itemCode: component.itemCode,
      unit: component.itemUnit,
      qtyPerUnit: component.qtyPerUnit,
      quantity: units
        .mul(new Prisma.Decimal(component.qtyPerUnit))
        .toDecimalPlaces(3, Prisma.Decimal.ROUND_HALF_UP),
    }))
    .sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0));
}
