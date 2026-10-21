import { ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { CompositeItemsService } from '../../settings/item-masters/composite-items.service';
import { ItemsService } from '../../settings/item-masters/items.service';

/**
 * The inventory-side composition of the item master.
 *
 * The table lives in `settings` and its CRUD lives with it. What lives here is the
 * one rule that needs both modules: an item may not be deleted while any movement
 * references it. Answering that means counting `inventory` rows, which the settings
 * module may not read — Principle I — and asking settings to import inventory would
 * make the dependency circular.
 *
 * Exactly the split `PartnerVendorCategoriesService` documents for vendor
 * categories, and for the same reason.
 */
@Injectable()
export class InventoryItemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly items: ItemsService,
    private readonly compositeItems: CompositeItemsService,
  ) {}

  /** Every movement kind that would be orphaned by deleting this item. */
  private async usageOf(
    caller: AuthenticatedUser,
    itemId: string,
  ): Promise<{
    purchases: number;
    issues: number;
    transfers: number;
    indents: number;
    composites: number;
  }> {
    const [counts, composites] = await Promise.all([
      withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
        const [purchases, issues, transfers, indents] = await Promise.all([
          tx.purchase.count({ where: { itemId } }),
          tx.issue.count({ where: { itemId } }),
          tx.stockTransfer.count({ where: { itemId } }),
          tx.materialIndentLine.count({ where: { itemId } }),
        ]);
        return { purchases, issues, transfers, indents };
      }),
      // 039: a composite's recipe names the item; deleting it would leave the recipe pointing at
      // nothing. Counted in `settings`, the recipe's own schema.
      this.compositeItems.countUsingItem(caller, itemId),
    ]);
    return { ...counts, composites };
  }

  /**
   * Deletes an item once nothing references it.
   *
   * Soft-deleted movements count as references: the row is still there, the ledger
   * still points at the item, and a stock reconstruction would render an unknown
   * item where a name used to be. An item with history is retired by setting
   * `active: false`, which is what the `active` column is for.
   */
  async remove(
    caller: AuthenticatedUser,
    id: string,
    ipAddress: string,
  ): Promise<void> {
    const usage = await this.usageOf(caller, id);
    const total =
      usage.purchases +
      usage.issues +
      usage.transfers +
      usage.indents +
      usage.composites;
    if (total > 0) {
      const parts = [
        usage.purchases && `${usage.purchases} purchase(s)`,
        usage.issues && `${usage.issues} issue(s)`,
        usage.transfers && `${usage.transfers} transfer(s)`,
        usage.indents && `${usage.indents} indent line(s)`,
        usage.composites && `${usage.composites} composite item(s)`,
      ].filter(Boolean);
      throw new ConflictException(
        `This item is referenced by ${parts.join(
          ', ',
        )}. Retire it instead of deleting it.`,
      );
    }
    await this.items.remove(caller, id, ipAddress);
  }

  /**
   * Deletes a composite item (039) once no issue names it. A composite that has been issued is
   * retired with `active: false` instead: the issue rows still carry its id, and the list and slip
   * name the mix from it.
   */
  async removeComposite(
    caller: AuthenticatedUser,
    id: string,
    ipAddress: string,
  ): Promise<void> {
    // Soft-deleted issues count, for the reason `remove` gives for items.
    const issued = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.issue.findFirst({
          where: { compositeItemId: id },
          select: { id: true },
        }),
    );
    if (issued) {
      throw new ConflictException(
        'This composite item has been issued. Deactivate it instead of deleting it.',
      );
    }
    await this.compositeItems.remove(caller, id, ipAddress);
  }
}
