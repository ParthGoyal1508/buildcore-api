import { PaymentMode, Prisma, PurchaseBillStatus } from '@prisma/client';

import {
  billStatusFilterTx,
  billWithoutHiddenCash,
  excludeHiddenCash,
  hiddenCashByBillTx,
} from './cash-hiding';

const decimal = (n: number) => new Prisma.Decimal(n);
const bill = (id: string, total: number, paid: number) => ({
  id,
  totalAmount: decimal(total),
  paidAmount: decimal(paid),
  paymentStatus:
    paid <= 0
      ? PurchaseBillStatus.unpaid
      : paid >= total
      ? PurchaseBillStatus.paid
      : PurchaseBillStatus.part_paid,
});

describe('cash-hiding helpers (038)', () => {
  it('filters nothing out when no company hides cash', () => {
    expect(excludeHiddenCash([])).toEqual({});
    expect(excludeHiddenCash(['co-1'])).toEqual({
      NOT: { paymentMode: PaymentMode.cash, companyId: { in: ['co-1'] } },
    });
  });

  it('reads a bill without its hidden cash, as a copy', () => {
    const row = bill('b1', 1000, 1000);
    const read = billWithoutHiddenCash(row, new Map([['b1', 1000]]));
    expect(read.paidAmount.toNumber()).toBe(0);
    expect(read.paymentStatus).toBe(PurchaseBillStatus.unpaid);
    expect(row.paidAmount.toNumber()).toBe(1000);
    expect(billWithoutHiddenCash(row, new Map())).toBe(row);
  });

  it('asks the database nothing when nothing is hidden', async () => {
    const tx = { paymentAllocation: { groupBy: jest.fn() } };
    expect(await hiddenCashByBillTx(tx as never, ['b1'], [])).toEqual(
      new Map(),
    );
    expect(tx.paymentAllocation.groupBy).not.toHaveBeenCalled();
    const matches = { paymentStatus: PurchaseBillStatus.paid };
    expect(
      await billStatusFilterTx(tx as never, {
        base: {},
        hidden: [],
        matches,
        accepts: () => true,
      }),
    ).toBe(matches);
  });

  it('filters cash-touched bills on the status they read as', async () => {
    const tx = {
      purchaseBill: {
        findMany: jest
          .fn()
          .mockResolvedValue([bill('b1', 1000, 1000), bill('b2', 1000, 1000)]),
      },
      paymentAllocation: {
        groupBy: jest.fn().mockResolvedValue([
          { billId: 'b1', _sum: { allocatedAmount: decimal(1000) } },
          { billId: 'b2', _sum: { allocatedAmount: decimal(200) } },
        ]),
      },
    };
    const where = await billStatusFilterTx(tx as never, {
      base: {},
      hidden: ['co-1'],
      matches: { paymentStatus: PurchaseBillStatus.unpaid },
      accepts: (s) => s === PurchaseBillStatus.unpaid,
    });
    expect(where).toEqual({
      OR: [
        {
          AND: [
            { paymentStatus: PurchaseBillStatus.unpaid },
            { id: { notIn: ['b1', 'b2'] } },
          ],
        },
        { id: { in: ['b1'] } },
      ],
    });
  });
});
