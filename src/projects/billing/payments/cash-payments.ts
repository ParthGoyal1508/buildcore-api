import { PaymentInstrument, Prisma } from '@prisma/client';

import { isCashHiddenTx } from '../../../common/cash/cash-policy';
import type { RlsContext } from '../../../common/prisma/rls-context';

/**
 * Which RA bill payments are cash, and which companies hide them (038).
 *
 * A bill payment is cash when its `instrument` is `cash` **or** its free-text `mode` says Cash — the
 * advice form offers "Cash" as a mode beside NEFT/RTGS, and a payment recorded as a bank transfer
 * with mode "Cash" prints "made a payment to you in cash" on its advice. Either way it is cash, and
 * the request interceptor's exact `'cash'` match misses the capitalised mode, so this is the check
 * the service makes.
 *
 * Filtered in code rather than in the query: every reader here already loads the bill's payments to
 * sum them, and one predicate applied to the rows is one definition the tests exercise directly.
 */
export function isCashPayment(payment: {
  instrument?: PaymentInstrument | string | null;
  mode?: string | null;
}): boolean {
  return (
    payment.instrument === PaymentInstrument.cash ||
    payment.mode?.trim().toLowerCase() === 'cash'
  );
}

/**
 * The companies whose cash is hidden, as far as `ctx` can see: the scoped company, or — for a
 * cross-company caller with no selection — every company that hides cash, so each company's rows
 * follow that company's own setting (FR-006).
 */
export async function cashHiddenCompaniesTx(
  tx: Prisma.TransactionClient,
  ctx: RlsContext,
): Promise<Set<string>> {
  if (!ctx.isSuperAdmin) {
    return (await isCashHiddenTx(tx, ctx.companyId))
      ? new Set([ctx.companyId as string])
      : new Set();
  }
  const rows = await tx.company.findMany({
    where: { hideCashTransactions: true },
    select: { id: true },
  });
  return new Set(rows.map((row) => row.id));
}

/** False for a cash payment of a company that hides cash — a payment that, for now, does not exist. */
export function paymentVisible(
  hidden: ReadonlySet<string>,
  companyId: string | null | undefined,
  payment: {
    instrument?: PaymentInstrument | string | null;
    mode?: string | null;
  },
): boolean {
  if (hidden.size === 0 || !companyId || !hidden.has(companyId)) return true;
  return !isCashPayment(payment);
}
