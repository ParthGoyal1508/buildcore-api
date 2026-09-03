import { ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
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
  }> {
    return withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
      const [purchases, issues, transfers, indents] = await Promise.all([
        tx.purchase.count({ where: { itemId } }),
        tx.issue.count({ where: { itemId } }),
        tx.stockTransfer.count({ where: { itemId } }),
        tx.materialIndentLine.count({ where: { itemId } }),
      ]);
      return { purchases, issues, transfers, indents };
    });
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
      usage.purchases + usage.issues + usage.transfers + usage.indents;
    if (total > 0) {
      const parts = [
        usage.purchases && `${usage.purchases} purchase(s)`,
        usage.issues && `${usage.issues} issue(s)`,
        usage.transfers && `${usage.transfers} transfer(s)`,
        usage.indents && `${usage.indents} indent line(s)`,
      ].filter(Boolean);
      throw new ConflictException(
        `This item is referenced by ${parts.join(
          ', ',
        )}. Retire it instead of deleting it.`,
      );
    }
    await this.items.remove(caller, id, ipAddress);
  }
}
