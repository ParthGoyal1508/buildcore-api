import { PaymentMode, Prisma, PurchaseBillStatus } from '@prisma/client';

import { toNumber } from '../stock/stock.types';

/**
 * Hiding cash (038) as the vendor-payment side of inventory applies it.
 *
 * A cash vendor payment is `inventory.Payment` with `paymentMode = cash`. While its company hides
 * cash, the payment is left out of every read, and so is every rupee it allocated: a bill's
 * `paidAmount` (and with it `paymentStatus` and the outstanding) is a **stored** running total
 * that includes cash allocations, so the non-cash figure is worked out on read — stored paid less
 * the hidden cash allocations — and never written back. Turning hiding off shows the stored
 * figures again, untouched.
 *
 * These helpers run inside the caller's own RLS transaction: `Company` is readable to every
 * caller, and a company the caller cannot see has no rows here for them anyway.
 */

/**
 * The companies, within a read's company scope, that hide cash. `scope.companyId` undefined is a
 * cross-company read (Super Admin with no company selected) — every company that hides cash.
 */
export async function cashHiddenCompaniesTx(
  tx: Prisma.TransactionClient,
  scope: { companyId?: string },
): Promise<string[]> {
  const rows = await tx.company.findMany({
    where: {
      hideCashTransactions: true,
      ...(scope.companyId !== undefined ? { id: scope.companyId } : {}),
    },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

/** Live cash payments of the hiding companies — the rows that do not exist while hidden. */
export function hiddenCashPayment(
  hidden: readonly string[],
): Prisma.PaymentWhereInput {
  return {
    paymentMode: PaymentMode.cash,
    deleted: false,
    companyId: { in: [...hidden] },
  };
}

/** A `Payment` filter that leaves out hidden cash. Empty when nothing is hidden. */
export function excludeHiddenCash(
  hidden: readonly string[],
): Prisma.PaymentWhereInput {
  return hidden.length > 0
    ? { NOT: { paymentMode: PaymentMode.cash, companyId: { in: [...hidden] } } }
    : {};
}

/** Per bill, what hidden cash payments allocated to it. Empty when nothing is hidden. */
export async function hiddenCashByBillTx(
  tx: Prisma.TransactionClient,
  billIds: readonly string[],
  hidden: readonly string[],
): Promise<Map<string, number>> {
  if (hidden.length === 0 || billIds.length === 0) return new Map();
  const rows = await tx.paymentAllocation.groupBy({
    by: ['billId'],
    where: {
      billId: { in: [...new Set(billIds)] },
      payment: hiddenCashPayment(hidden),
    },
    _sum: { allocatedAmount: true },
  });
  return new Map(
    rows.map((row) => [row.billId, toNumber(row._sum.allocatedAmount)]),
  );
}

const paise = (value: number) => Math.round(value * 100) / 100;

export function billStatusFor(total: number, paid: number): PurchaseBillStatus {
  if (paid <= 0) return PurchaseBillStatus.unpaid;
  return paid >= total ? PurchaseBillStatus.paid : PurchaseBillStatus.part_paid;
}

/**
 * The bill as it reads without its hidden cash: paid less the cash allocations, status from that.
 * A copy — the loaded row is not changed, and nothing is written.
 */
export function billWithoutHiddenCash<
  B extends {
    id: string;
    totalAmount: Prisma.Decimal;
    paidAmount: Prisma.Decimal;
    paymentStatus: PurchaseBillStatus;
  },
>(bill: B, cashByBill: ReadonlyMap<string, number>): B {
  const cash = cashByBill.get(bill.id);
  if (!cash) return bill;
  const paid = Math.max(0, paise(toNumber(bill.paidAmount) - cash));
  return {
    ...bill,
    paidAmount: new Prisma.Decimal(paid),
    paymentStatus: billStatusFor(toNumber(bill.totalAmount), paid),
  };
}

/**
 * A `PurchaseBill` filter for "status matches", corrected for hidden cash.
 *
 * Bills with no hidden cash allocation are filtered on the stored status as before. Bills that
 * have one are filtered on the status they read as without it, worked out here. `matches` is the
 * stored-status filter (e.g. `{ paymentStatus: 'paid' }` or `{ paymentStatus: { not: 'paid' } }`)
 * and `accepts` the same test on a computed status.
 */
export async function billStatusFilterTx(
  tx: Prisma.TransactionClient,
  params: {
    base: Prisma.PurchaseBillWhereInput;
    hidden: readonly string[];
    matches: Prisma.PurchaseBillWhereInput;
    accepts: (status: PurchaseBillStatus) => boolean;
  },
): Promise<Prisma.PurchaseBillWhereInput> {
  if (params.hidden.length === 0) return params.matches;
  const touched = await tx.purchaseBill.findMany({
    where: {
      ...params.base,
      allocations: { some: { payment: hiddenCashPayment(params.hidden) } },
    },
    select: {
      id: true,
      totalAmount: true,
      paidAmount: true,
      paymentStatus: true,
    },
  });
  if (touched.length === 0) return params.matches;
  const cash = await hiddenCashByBillTx(
    tx,
    touched.map((bill) => bill.id),
    params.hidden,
  );
  const accepted = touched
    .map((bill) => billWithoutHiddenCash(bill, cash))
    .filter((bill) => params.accepts(bill.paymentStatus))
    .map((bill) => bill.id);
  return {
    OR: [
      { AND: [params.matches, { id: { notIn: touched.map((b) => b.id) } }] },
      { id: { in: accepted } },
    ],
  };
}
