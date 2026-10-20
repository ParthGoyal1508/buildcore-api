import { AuditEntityType, Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import type { RlsContext } from '../../common/prisma/rls-context';
import { withRlsContext } from '../../common/prisma/rls-context';

/** Spellings of the cash mode a free-text or JSON field may carry. */
const CASH_SPELLINGS = ['cash', 'Cash', 'CASH'];

/** Where, inside an audit entry's `changes`, a payment mode may have been recorded. */
const MODE_PATHS = [
  ['paymentMode'],
  ['after', 'paymentMode'],
  ['before', 'paymentMode'],
  ['instrument'],
  ['after', 'instrument'],
];

/**
 * The audit entries, among those `base` selects, that are about a cash transaction of a company
 * hiding cash (038 FR-001) — so the Activity Log can leave them out, as if never recorded.
 *
 * An entry maps to its record by `entityType` + `entityId`:
 * - `LABOUR_ADVANCE` — every advance is cash (D3);
 * - `PAYMENT` — a vendor payment whose `paymentMode` is cash;
 * - `LABOUR_PAYMENT_SHEET` — a direct-engagement (cash) sheet;
 * - `EQUIPMENT_DISPOSAL` — a sale received in cash (free text, so any case);
 * - any entry of a hiding company whose `changes` records a cash mode (covers a record since
 *   deleted, when the writing module put the mode in the entry).
 *
 * Read positively and excluded by entry id, never as `NOT (json-path …)`: SQL's NULL logic would
 * make a negated JSON-path test drop every entry that has no such path — almost all of them.
 * An empty result when no company in scope hides cash, so the log is untouched when it is off.
 */
export async function hiddenCashEntryIds(
  prisma: PrismaService,
  ctx: RlsContext,
  base: Prisma.AuditLogEntryWhereInput,
): Promise<string[]> {
  return withRlsContext(prisma, { isSuperAdmin: true }, async (tx) => {
    const hiding = await tx.company.findMany({
      where: {
        hideCashTransactions: true,
        ...(ctx.isSuperAdmin ? {} : { id: ctx.companyId ?? '' }),
      },
      select: { id: true },
    });
    if (hiding.length === 0) return [];
    const companyId = { in: hiding.map((c) => c.id) };

    const [payments, sheets, advances, disposals] = await Promise.all([
      tx.payment.findMany({
        where: { companyId, paymentMode: 'cash' },
        select: { id: true },
      }),
      tx.labourPaymentSheet.findMany({
        where: { companyId, engagementType: 'direct' },
        select: { id: true },
      }),
      tx.labourAdvance.findMany({ where: { companyId }, select: { id: true } }),
      tx.equipmentDisposal.findMany({
        where: {
          companyId,
          paymentMode: { equals: 'cash', mode: 'insensitive' },
        },
        select: { id: true },
      }),
    ]);
    const byId = (
      entityType: AuditEntityType,
      rows: { id: string }[],
    ): Prisma.AuditLogEntryWhereInput[] =>
      rows.length
        ? [{ entityType, entityId: { in: rows.map((r) => r.id) } }]
        : [];

    const matchers: Prisma.AuditLogEntryWhereInput[] = [
      { entityType: AuditEntityType.LABOUR_ADVANCE, companyId },
      ...byId(AuditEntityType.LABOUR_ADVANCE, advances),
      ...byId(AuditEntityType.PAYMENT, payments),
      ...byId(AuditEntityType.LABOUR_PAYMENT_SHEET, sheets),
      ...byId(AuditEntityType.EQUIPMENT_DISPOSAL, disposals),
      ...MODE_PATHS.flatMap((path) =>
        CASH_SPELLINGS.map((value) => ({
          companyId,
          changes: { path, equals: value },
        })),
      ),
    ];

    const entries = await tx.auditLogEntry.findMany({
      where: { AND: [base, { OR: matchers }] },
      select: { id: true },
    });
    return entries.map((e) => e.id);
  });
}
