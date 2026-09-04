import { UnprocessableEntityException } from '@nestjs/common';
import { Prisma, StockLedgerType } from '@prisma/client';

import { StockService } from './stock.service';

const decimal = (n: number) => new Prisma.Decimal(n);

/** A `StockBalance` row as the service reads it. */
const balance = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'bal-1',
  itemId: 'item-1',
  siteId: 'site-1',
  received: decimal(0),
  issued: decimal(0),
  transferIn: decimal(0),
  transferOut: decimal(0),
  avgRate: decimal(0),
  ...over,
});

/**
 * A transaction client that records what the service wrote, so the assertions can
 * be about the numbers rather than about which Prisma method was called.
 */
const makeTx = (existing: ReturnType<typeof balance> | null) => {
  const updates: Record<string, unknown>[] = [];
  const creates: Record<string, unknown>[] = [];
  return {
    updates,
    creates,
    tx: {
      stockBalance: {
        findUnique: jest.fn().mockResolvedValue(existing),
        create: jest.fn(async ({ data }: never) => {
          creates.push(data as Record<string, unknown>);
          return data;
        }),
        update: jest.fn(async ({ data }: never) => {
          updates.push(data as Record<string, unknown>);
          return data;
        }),
        updateMany: jest.fn(async ({ data }: never) => {
          updates.push(data as Record<string, unknown>);
          return { count: 1 };
        }),
      },
      stockLedgerEntry: { findMany: jest.fn().mockResolvedValue([]) },
      $queryRaw: jest.fn().mockResolvedValue([]),
    } as never,
  };
};

describe('StockService', () => {
  const service = new StockService();

  describe('weighted average rate on purchase (FR-008)', () => {
    it('sets the rate outright on the first receipt at a site', async () => {
      const { tx, creates } = makeTx(null);
      await service.upsertBalanceForPurchase(tx, {
        companyId: 'co-1',
        itemId: 'item-1',
        siteId: 'site-1',
        quantity: 100,
        rate: 350,
      });
      expect(creates[0]).toMatchObject({ received: 100, avgRate: 350 });
    });

    it('weights the new rate by the quantity already in stock', async () => {
      // 100 @ 350 already there, buying 100 @ 450 → (35000 + 45000) / 200 = 400.
      const { tx, updates } = makeTx(
        balance({ received: decimal(100), avgRate: decimal(350) }),
      );
      await service.upsertBalanceForPurchase(tx, {
        companyId: 'co-1',
        itemId: 'item-1',
        siteId: 'site-1',
        quantity: 100,
        rate: 450,
      });
      expect(updates[0].avgRate).toBe(400);
    });

    it('weights by stock on hand, not by everything ever received', async () => {
      // 100 received @ 300, 90 issued → 10 on hand. Buying 90 @ 400 gives
      // (10 × 300 + 90 × 400) / 100 = 390 — not the 350 a receipts-only average
      // would produce. The difference is the whole point of the clarification.
      const { tx, updates } = makeTx(
        balance({
          received: decimal(100),
          issued: decimal(90),
          avgRate: decimal(300),
        }),
      );
      await service.upsertBalanceForPurchase(tx, {
        companyId: 'co-1',
        itemId: 'item-1',
        siteId: 'site-1',
        quantity: 90,
        rate: 400,
      });
      expect(updates[0].avgRate).toBe(390);
    });

    it('takes the purchase rate outright when the site is at zero stock', async () => {
      // Everything received has been issued, so there is nothing to average
      // against and the denominator would be zero.
      const { tx, updates } = makeTx(
        balance({
          received: decimal(50),
          issued: decimal(50),
          avgRate: decimal(300),
        }),
      );
      await service.upsertBalanceForPurchase(tx, {
        companyId: 'co-1',
        itemId: 'item-1',
        siteId: 'site-1',
        quantity: 20,
        rate: 500,
      });
      expect(updates[0].avgRate).toBe(500);
    });
  });

  describe('recomputeWAR after a reversal (research.md §3)', () => {
    const ledger = (
      entries: {
        type: StockLedgerType;
        quantity: number;
        rate?: number;
        referenceId: string;
      }[],
    ) =>
      ({
        stockLedgerEntry: {
          findMany: jest.fn().mockResolvedValue(
            entries.map((entry) => ({
              type: entry.type,
              quantity: decimal(entry.quantity),
              rate: entry.rate === undefined ? null : decimal(entry.rate),
              referenceId: entry.referenceId,
            })),
          ),
        },
        stockBalance: { updateMany: jest.fn() },
      } as never);

    it('leaves the surviving purchase rate when the first is reversed', async () => {
      const tx = ledger([
        {
          type: StockLedgerType.purchase,
          quantity: 100,
          rate: 350,
          referenceId: 'p1',
        },
        {
          type: StockLedgerType.purchase,
          quantity: 100,
          rate: 450,
          referenceId: 'p2',
        },
        {
          type: StockLedgerType.purchase_reversal,
          quantity: 100,
          rate: 350,
          referenceId: 'p1',
        },
      ]);
      const war = await service.recomputeWAR(tx, {
        companyId: 'co-1',
        itemId: 'item-1',
        siteId: 'site-1',
      });
      expect(war).toBe(450);
    });

    it('reproduces the incremental sequence when issues fall between purchases', async () => {
      // 100 @ 300, issue 90, then 90 @ 400. Folding only the purchases would give
      // (100 × 300 + 90 × 400) / 190 ≈ 347.4 — the wrong answer, and not what the
      // live balance holds. Folding the issue too gives 390.
      const tx = ledger([
        {
          type: StockLedgerType.purchase,
          quantity: 100,
          rate: 300,
          referenceId: 'p1',
        },
        { type: StockLedgerType.issue, quantity: 90, referenceId: 'i1' },
        {
          type: StockLedgerType.purchase,
          quantity: 90,
          rate: 400,
          referenceId: 'p2',
        },
      ]);
      const war = await service.recomputeWAR(tx, {
        companyId: 'co-1',
        itemId: 'item-1',
        siteId: 'site-1',
      });
      expect(war).toBe(390);
    });

    it('returns to zero when every purchase has been reversed', async () => {
      const tx = ledger([
        {
          type: StockLedgerType.purchase,
          quantity: 100,
          rate: 350,
          referenceId: 'p1',
        },
        {
          type: StockLedgerType.purchase_reversal,
          quantity: 100,
          rate: 350,
          referenceId: 'p1',
        },
      ]);
      const war = await service.recomputeWAR(tx, {
        companyId: 'co-1',
        itemId: 'item-1',
        siteId: 'site-1',
      });
      expect(war).toBe(0);
    });
  });

  describe('validateAndLockStock (FR-003, research.md §4)', () => {
    const lockingTx = (row: ReturnType<typeof balance> | null) =>
      ({
        $queryRaw: jest.fn().mockResolvedValue(row ? [row] : []),
      } as never);

    it('takes a row lock rather than a plain read', async () => {
      const tx = lockingTx(balance({ received: decimal(100) }));
      await service.validateAndLockStock(tx, {
        itemId: 'item-1',
        siteId: 'site-1',
        quantity: 10,
      });
      const sql = (
        tx as unknown as { $queryRaw: jest.Mock }
      ).$queryRaw.mock.calls[0][0].join('?');
      expect(sql).toMatch(/FOR UPDATE/);
    });

    it('returns the available quantity when there is enough', async () => {
      const tx = lockingTx(
        balance({
          received: decimal(100),
          issued: decimal(20),
          transferIn: decimal(5),
          transferOut: decimal(10),
        }),
      );
      const available = await service.validateAndLockStock(tx, {
        itemId: 'item-1',
        siteId: 'site-1',
        quantity: 75,
      });
      expect(available).toBe(75);
    });

    it('refuses an over-issue with 422 and the available figure', async () => {
      const tx = lockingTx(balance({ received: decimal(10) }));
      const error = await service
        .validateAndLockStock(tx, {
          itemId: 'item-1',
          siteId: 'site-1',
          quantity: 11,
        })
        .catch((e) => e);

      expect(error).toBeInstanceOf(UnprocessableEntityException);
      expect(error.getResponse()).toMatchObject({ availableStock: 10 });
    });

    it('treats an item never received at the site as zero, not as an error', async () => {
      const tx = lockingTx(null);
      const error = await service
        .validateAndLockStock(tx, {
          itemId: 'item-1',
          siteId: 'site-1',
          quantity: 1,
        })
        .catch((e) => e);

      expect(error).toBeInstanceOf(UnprocessableEntityException);
      expect(error.getResponse()).toMatchObject({ availableStock: 0 });
    });

    it('permits a zero-quantity request against an empty site', async () => {
      const tx = lockingTx(null);
      await expect(
        service.validateAndLockStock(tx, {
          itemId: 'item-1',
          siteId: 'site-1',
          quantity: 0,
        }),
      ).resolves.toBe(0);
    });
  });

  describe('toRow (FR-014, research.md §11, §12)', () => {
    const item = {
      name: 'OPC 53 Cement',
      code: 'DC-ITM-0001',
      categoryName: 'CEMENT',
      unit: 'BAG',
      reorderLevel: null as number | null,
    };

    it('computes inStock from all four totals', () => {
      const row = service.toRow(
        balance({
          received: decimal(100),
          issued: decimal(30),
          transferIn: decimal(20),
          transferOut: decimal(15),
          avgRate: decimal(400),
        }),
        item,
        'Site A',
      );
      expect(row.inStock).toBe(75);
      expect(row.stockValue).toBe(30000);
    });

    it('rounds stock value to paise', () => {
      const row = service.toRow(
        balance({ received: decimal(3), avgRate: decimal(333.333333) }),
        item,
        'Site A',
      );
      expect(row.stockValue).toBe(1000);
    });

    it('still returns a row at zero stock', () => {
      const row = service.toRow(
        balance({
          received: decimal(10),
          issued: decimal(10),
          avgRate: decimal(50),
        }),
        item,
        'Site A',
      );
      expect(row.inStock).toBe(0);
      expect(row.stockValue).toBe(0);
    });

    it('flags an item below its reorder level', () => {
      const row = service.toRow(
        balance({ received: decimal(5), avgRate: decimal(10) }),
        { ...item, reorderLevel: 10 },
        'Site A',
      );
      expect(row.belowReorderLevel).toBe(true);
    });

    it('does not flag an item exactly at its reorder level', () => {
      // "Below" means below. At the threshold the stock floor has been reached,
      // not breached, and flagging it would put a permanent warning on every item
      // held at its intended level.
      const row = service.toRow(
        balance({ received: decimal(10), avgRate: decimal(10) }),
        { ...item, reorderLevel: 10 },
        'Site A',
      );
      expect(row.belowReorderLevel).toBe(false);
    });

    it('never flags an item that has no reorder level', () => {
      const row = service.toRow(
        balance({ received: decimal(0), avgRate: decimal(0) }),
        { ...item, reorderLevel: null },
        'Site A',
      );
      expect(row.belowReorderLevel).toBe(false);
      expect(row.reorderLevel).toBeNull();
    });
  });
});
