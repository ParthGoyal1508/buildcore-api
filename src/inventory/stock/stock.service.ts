import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { Prisma, StockLedgerType } from '@prisma/client';

import { ItemView } from '../../settings/item-masters/items.service';
import { BalanceTotals, StockRow, inStockOf, toNumber } from './stock.types';

/** A ledger row as the WAR replay needs it. */
interface ReplayEntry {
  type: StockLedgerType;
  quantity: Prisma.Decimal;
  rate: Prisma.Decimal | null;
  referenceId: string;
}

/**
 * Stock arithmetic: the running balances, the weighted average rate, and the
 * `SELECT FOR UPDATE` that makes quantity validation safe under concurrency.
 *
 * Every method here takes a transaction client rather than opening its own. The
 * dual write of FR-002 — a ledger row and a balance update — is only atomic if it
 * happens inside the caller's transaction, and a service that quietly opened its own
 * would break that guarantee without changing a single call site.
 */
@Injectable()
export class StockService {
  /**
   * Applies a purchase to the item-site balance, creating the row if this is the
   * first receipt there (research.md §5 — lazy creation).
   *
   * The WAR moves by the incremental formula the clarification fixed:
   *
   *   newWAR = (existingStock × existingWAR + newQty × newRate) / (existingStock + newQty)
   *
   * `existingStock` is the *current* balance, not the total ever received, so
   * material already issued does not keep weighting the average.
   *
   * A denominator of zero is possible and is not an error: a site that received 10
   * and issued 10 is at zero stock, and the next purchase simply sets the rate
   * outright rather than dividing by nothing.
   */
  async upsertBalanceForPurchase(
    tx: Prisma.TransactionClient,
    params: {
      companyId: string;
      itemId: string;
      siteId: string;
      quantity: number;
      rate: number;
    },
  ): Promise<void> {
    const { companyId, itemId, siteId, quantity, rate } = params;

    const existing = await tx.stockBalance.findUnique({
      where: { itemId_siteId: { itemId, siteId } },
    });

    if (!existing) {
      await tx.stockBalance.create({
        data: {
          companyId,
          itemId,
          siteId,
          received: quantity,
          avgRate: rate,
        },
      });
      return;
    }

    const existingStock = inStockOf(this.totalsOf(existing));
    const denominator = existingStock + quantity;
    const newWar =
      denominator === 0
        ? rate
        : (existingStock * toNumber(existing.avgRate) + quantity * rate) /
          denominator;

    await tx.stockBalance.update({
      where: { id: existing.id },
      data: {
        received: { increment: quantity },
        avgRate: newWar,
      },
    });
  }

  /**
   * Recomputes the WAR from the ledger after a purchase is reversed (research.md §3).
   *
   * Replays *every* movement chronologically, not only the purchases. research.md §3
   * says "replay all non-deleted purchase ledger entries", which would compute the
   * quantity-weighted average of the surviving purchase rates — but that is not what
   * the incremental formula above produces whenever material was issued between two
   * purchases, because the incremental formula weights by current stock. Replaying
   * only purchases would therefore let deleting a purchase silently restate the rate
   * of a site whose remaining purchases were never touched.
   *
   * Folding the whole movement history reproduces the incremental sequence exactly,
   * so a purchase created and then deleted leaves the balance identical to one that
   * was never created at all — which is the property the reversal is for.
   *
   * A reversed purchase is identified by its `referenceId` appearing on a
   * `purchase_reversal` row: the ledger is append-only, so the original entry is
   * still there and must be skipped rather than deleted.
   */
  async recomputeWAR(
    tx: Prisma.TransactionClient,
    params: { companyId: string; itemId: string; siteId: string },
  ): Promise<number> {
    const { companyId, itemId, siteId } = params;

    const entries = (await tx.stockLedgerEntry.findMany({
      where: { companyId, itemId, siteId },
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
      select: { type: true, quantity: true, rate: true, referenceId: true },
    })) as ReplayEntry[];

    const reversed = new Set(
      entries
        .filter((entry) => entry.type === StockLedgerType.purchase_reversal)
        .map((entry) => entry.referenceId),
    );

    let stock = 0;
    let war = 0;

    for (const entry of entries) {
      const quantity = toNumber(entry.quantity);
      switch (entry.type) {
        case StockLedgerType.purchase: {
          if (reversed.has(entry.referenceId)) break;
          const rate = toNumber(entry.rate);
          const denominator = stock + quantity;
          war =
            denominator === 0
              ? rate
              : (stock * war + quantity * rate) / denominator;
          stock += quantity;
          break;
        }
        case StockLedgerType.transfer_in:
          // Adds quantity at the destination's existing rate. The clarification
          // moves the WAR on purchase only; a transfer is a relocation, not a
          // repricing.
          stock += quantity;
          break;
        case StockLedgerType.issue:
        case StockLedgerType.transfer_out:
          stock -= quantity;
          break;
        case StockLedgerType.issue_reversal:
        case StockLedgerType.transfer_out_reversal:
          stock += quantity;
          break;
        case StockLedgerType.transfer_in_reversal:
          stock -= quantity;
          break;
        case StockLedgerType.purchase_reversal:
          // The pair it cancels was skipped above; counting the reversal too would
          // subtract the quantity twice.
          break;
      }
    }

    await tx.stockBalance.updateMany({
      where: { itemId, siteId },
      data: { avgRate: war },
    });
    return war;
  }

  /**
   * Locks the item-site balance and refuses an issue or transfer that would take
   * more than is there (FR-003, research.md §4).
   *
   * `SELECT ... FOR UPDATE` rather than a read followed by a write: two concurrent
   * issues for the last unit would otherwise both read the same balance, both pass
   * validation, and both commit, leaving the balance negative. The lock is held for
   * the remainder of the caller's transaction, so the second request blocks until
   * the first commits and then re-reads the balance it actually left behind.
   *
   * Returns the available quantity, which the caller needs anyway.
   *
   * A missing balance row is not an error: an item never received at a site has no
   * row (research.md §5) and its available stock is zero, so any positive request
   * against it is refused with the same 422 as an over-issue.
   */
  async validateAndLockStock(
    tx: Prisma.TransactionClient,
    params: {
      itemId: string;
      siteId: string;
      quantity: number;
      /** Named in the 422 so the message says which side of a transfer ran out. */
      label?: string;
    },
  ): Promise<number> {
    const { itemId, siteId, quantity, label = 'this site' } = params;

    const rows = await tx.$queryRaw<
      {
        received: Prisma.Decimal;
        issued: Prisma.Decimal;
        transferIn: Prisma.Decimal;
        transferOut: Prisma.Decimal;
        avgRate: Prisma.Decimal;
      }[]
    >`
      SELECT "received", "issued", "transferIn", "transferOut", "avgRate"
      FROM "inventory"."StockBalance"
      WHERE "itemId" = ${itemId} AND "siteId" = ${siteId}
      FOR UPDATE
    `;

    const available = rows.length === 0 ? 0 : inStockOf(this.totalsOf(rows[0]));

    if (quantity > available) {
      // 422 rather than 400: the request is well-formed and the quantity is a
      // perfectly valid number — it is the current stock that forbids it, which is
      // a distinction the client needs in order to show the available figure
      // against the quantity field instead of a generic validation error.
      throw new UnprocessableEntityException({
        message: `Insufficient stock at ${label}: ${available} available, ${quantity} requested.`,
        availableStock: available,
      });
    }
    return available;
  }

  /** Appends one ledger row. The only way this module writes to the ledger. */
  async appendLedgerEntry(
    tx: Prisma.TransactionClient,
    entry: {
      companyId: string;
      itemId: string;
      siteId: string;
      type: StockLedgerType;
      quantity: number;
      rate?: number | null;
      referenceId: string;
      date: Date;
    },
  ): Promise<void> {
    await tx.stockLedgerEntry.create({
      data: {
        companyId: entry.companyId,
        itemId: entry.itemId,
        siteId: entry.siteId,
        type: entry.type,
        quantity: entry.quantity,
        rate: entry.rate ?? null,
        referenceId: entry.referenceId,
        date: entry.date,
      },
    });
  }

  /**
   * Ensures a balance row exists so a transfer can land at a site that has never
   * received this item (H-001: the destination may not exist yet, so this must be
   * an upsert and not an update).
   */
  async ensureBalance(
    tx: Prisma.TransactionClient,
    params: { companyId: string; itemId: string; siteId: string },
  ): Promise<void> {
    await tx.stockBalance.upsert({
      where: {
        itemId_siteId: { itemId: params.itemId, siteId: params.siteId },
      },
      create: {
        companyId: params.companyId,
        itemId: params.itemId,
        siteId: params.siteId,
      },
      update: {},
    });
  }

  /** Assembles the view row from a balance and the item and site it refers to. */
  toRow(
    balance: {
      itemId: string;
      siteId: string;
      received: Prisma.Decimal;
      issued: Prisma.Decimal;
      transferIn: Prisma.Decimal;
      transferOut: Prisma.Decimal;
      avgRate: Prisma.Decimal;
    },
    item: Pick<
      ItemView,
      'name' | 'code' | 'categoryName' | 'unit' | 'reorderLevel'
    >,
    siteName: string,
  ): StockRow {
    const totals = this.totalsOf(balance);
    const inStock = inStockOf(totals);
    const stockValue = inStock * totals.avgRate;

    return {
      itemId: balance.itemId,
      itemName: item.name,
      itemCode: item.code,
      siteId: balance.siteId,
      siteName,
      category: item.categoryName,
      unit: item.unit,

      received: totals.received,
      issued: totals.issued,
      transferIn: totals.transferIn,
      transferOut: totals.transferOut,

      inStock,
      avgRate: totals.avgRate,
      // Rounded to paise on the way out: the rate carries six decimal places so the
      // running average does not drift, but a value in rupees with six decimals is
      // noise on a screen and misleading in a total.
      stockValue: Math.round(stockValue * 100) / 100,

      reorderLevel: item.reorderLevel,
      belowReorderLevel:
        item.reorderLevel !== null && inStock < item.reorderLevel,
    };
  }

  private totalsOf(balance: {
    received: Prisma.Decimal;
    issued: Prisma.Decimal;
    transferIn: Prisma.Decimal;
    transferOut: Prisma.Decimal;
    avgRate: Prisma.Decimal;
  }): BalanceTotals {
    return {
      received: toNumber(balance.received),
      issued: toNumber(balance.issued),
      transferIn: toNumber(balance.transferIn),
      transferOut: toNumber(balance.transferOut),
      avgRate: toNumber(balance.avgRate),
    };
  }
}
