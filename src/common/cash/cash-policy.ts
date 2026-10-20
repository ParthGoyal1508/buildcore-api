import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { withRlsContext } from '../prisma/rls-context';

/**
 * Hiding cash for a company (038, 2026-10-20) — the rule every module follows.
 *
 * When `Company.hideCashTransactions` is on, cash does not exist as far as the app shows it:
 * - **Reads**: no cash transaction appears anywhere — not as a row, not inside a total, a report, an
 *   export, a PDF, a dashboard tile, the P&L or the activity log. Totals are computed without the cash
 *   rows, as if they had never been recorded. A by-id read of a cash row answers 404.
 * - **Writes**: nobody — Super Admin included — can record, edit, delete, approve or disburse a cash
 *   transaction until the setting is turned off again. Refused with 403 `CASH_HIDDEN`.
 * - It applies to everyone, Super Admin included; turning it off (password-confirmed, audited) is how
 *   cash is seen or entered again.
 *
 * This replaces 019 FR-017a ("hiding governs display only"): the client asked for hide **and** block.
 * The `CASH_ENTRY` permission still decides who may enter cash while it is *not* hidden.
 *
 * What counts as cash: a vendor payment with `paymentMode = cash`, an RA bill payment with
 * `instrument = cash`, a labour payment-sheet line disbursed in cash, a direct-engagement (cash) labour
 * payment sheet, a labour advance (always paid in cash at site), and an equipment disposal whose sale
 * was received in cash.
 */
export const CASH_HIDDEN_CODE = 'CASH_HIDDEN';

/** Whether cash is hidden for one company. Read under the system bypass: it is company config. */
export async function isCashHidden(
  prisma: PrismaService,
  companyId: string | null | undefined,
): Promise<boolean> {
  if (!companyId) return false;
  return withRlsContext(prisma, { isSuperAdmin: true }, (tx) =>
    isCashHiddenTx(tx, companyId),
  );
}

/** The same, inside a transaction the caller already holds (Company is readable to every caller). */
export async function isCashHiddenTx(
  tx: Prisma.TransactionClient,
  companyId: string | null | undefined,
): Promise<boolean> {
  if (!companyId) return false;
  const company = await tx.company.findUnique({
    where: { id: companyId },
    select: { hideCashTransactions: true },
  });
  return company?.hideCashTransactions === true;
}

/** The companies, among `companyIds`, that hide cash — for a read spanning several companies. */
export async function cashHiddenCompanyIds(
  prisma: PrismaService,
  companyIds: readonly string[],
): Promise<Set<string>> {
  if (companyIds.length === 0) return new Set();
  const rows = await withRlsContext(prisma, { isSuperAdmin: true }, (tx) =>
    tx.company.findMany({
      where: {
        id: { in: [...new Set(companyIds)] },
        hideCashTransactions: true,
      },
      select: { id: true },
    }),
  );
  return new Set(rows.map((row) => row.id));
}

/** The company a request is served for — the header's selection, else the caller's own. */
export function servedCompanyOf(
  user: Pick<AuthenticatedUser, 'selectedCompanyId' | 'companyId'> | undefined,
): string | null {
  return user?.selectedCompanyId ?? user?.companyId ?? null;
}

export function cashHiddenError(): ForbiddenException {
  return new ForbiddenException({
    statusCode: 403,
    code: CASH_HIDDEN_CODE,
    message:
      'Cash transactions are turned off for this company. A Super Admin can turn them back on ' +
      'in Settings → Personal settings → Cash transaction visibility.',
  });
}

/**
 * Injectable form of the above, for services. `assertCashAllowed` is the one call a write path makes
 * before recording, changing, approving or disbursing anything cash.
 */
@Injectable()
export class CashPolicyService {
  constructor(private readonly prisma: PrismaService) {}

  isHidden(companyId: string | null | undefined): Promise<boolean> {
    return isCashHidden(this.prisma, companyId);
  }

  hiddenAmong(companyIds: readonly string[]): Promise<Set<string>> {
    return cashHiddenCompanyIds(this.prisma, companyIds);
  }

  async assertCashAllowed(companyId: string | null | undefined): Promise<void> {
    if (await this.isHidden(companyId)) throw cashHiddenError();
  }
}
