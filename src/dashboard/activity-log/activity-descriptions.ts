import { AuditAction, AuditEntityType, Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { actorNamesFor } from '../../common/actor-name';
import { withRlsContext } from '../../common/prisma/rls-context';

/**
 * What an activity-log row is about, in words (2026-10-15).
 *
 * The feed printed `entityId` as the target, so a Super Admin confirming their password read
 * "Viewed cmu40n37h0001123njsvg08v5" and turning cash amounts back on read "Updated
 * cmu40n37q0004123n5lj36wq3" — the client: "what is this activity". Two things fix that:
 *
 * - **A sentence for the events that have one.** A row whose `changes` names an event the reader
 *   would not guess from "Viewed" or "Updated" gets the sentence instead.
 * - **A name for the record.** The target is looked up — the company's name, the project's code
 *   and name — and where it cannot be (a kind of record not listed here, or one since deleted),
 *   the kind of record is said instead of its id.
 */

type Row = {
  entityType: AuditEntityType;
  action: AuditAction;
  entityId: string | null;
  changes: Prisma.JsonValue | null;
};

const asRecord = (value: Prisma.JsonValue | null) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const PURPOSES: Record<string, string> = {
  'cash-visibility': 'Personal Settings',
};

/** A sentence for an event "Viewed" or "Updated" would misdescribe; `null` for every other row. */
export function describeEvent(row: Row): string | null {
  const changes = asRecord(row.changes);
  if (!changes) return null;
  if (changes.event === 'password_confirmed') {
    const purpose = PURPOSES[String(changes.purpose)] ?? 'a sensitive setting';
    return `Confirmed their password for ${purpose}`;
  }
  // The cash switch. Rows written before 2026-10-15 carry no `event`, so they are known by
  // their shape: a company update holding only the switch and the confirmation.
  if (
    changes.event === 'cash_visibility_changed' ||
    (row.entityType === AuditEntityType.COMPANY &&
      'hideCashTransactions' in changes &&
      'confirmedByPassword' in changes)
  ) {
    return changes.hideCashTransactions
      ? 'Hid cash transactions'
      : 'Showed cash transactions';
  }
  if (changes.event === 'bulk_shift_change') {
    const n = Number(changes.count);
    return `Moved ${n} employee${n === 1 ? '' : 's'} to the ${String(
      changes.shiftName,
    )} shift`;
  }
  return null;
}

/** `GOODS_RECEIPT_NOTE` → `goods receipt note`: the kind of record, when its name is not known. */
export function kindOf(type: AuditEntityType): string {
  const words: Partial<Record<AuditEntityType, string>> = {
    DWR: 'daily work report',
    BOQ_GROUP: 'BOQ group',
    BOQ_ITEM: 'BOQ item',
    BOQ_IMPORT: 'BOQ import',
    CLIENT_RECEIPT: 'client receipt',
    CLIENT_HOLD_RELEASE: 'retention / CPBG release',
    RA_BILL: 'RA bill',
    BOCW_PAYMENT: 'BOCW payment',
    USER_ACCOUNT: 'user account',
  };
  return words[type] ?? type.toLowerCase().replace(/_/g, ' ');
}

type Lookup = (
  tx: Prisma.TransactionClient,
  ids: string[],
) => Promise<{ id: string; label: string }[]>;

const codeName = (code: string | null | undefined, name: string) =>
  code ? `${code} — ${name}` : name;

/** The record kinds that have a name worth showing, and how to read it. */
const LOOKUPS: Partial<Record<AuditEntityType, Lookup>> = {
  COMPANY: async (tx, ids) =>
    (
      await tx.company.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true },
      })
    ).map((r) => ({ id: r.id, label: r.name })),
  PROJECT: async (tx, ids) =>
    (
      await tx.project.findMany({
        where: { id: { in: ids } },
        select: { id: true, code: true, name: true },
      })
    ).map((r) => ({ id: r.id, label: codeName(r.code, r.name) })),
  CLIENT: async (tx, ids) =>
    (
      await tx.client.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true },
      })
    ).map((r) => ({ id: r.id, label: r.name })),
  SITE: async (tx, ids) =>
    (
      await tx.site.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true },
      })
    ).map((r) => ({ id: r.id, label: r.name })),
  VENDOR: async (tx, ids) =>
    (
      await tx.vendor.findMany({
        where: { id: { in: ids } },
        select: { id: true, code: true, name: true },
      })
    ).map((r) => ({ id: r.id, label: codeName(r.code, r.name) })),
  ASSET: async (tx, ids) =>
    (
      await tx.asset.findMany({
        where: { id: { in: ids } },
        select: { id: true, assetCode: true, name: true },
      })
    ).map((r) => ({ id: r.id, label: codeName(r.assetCode, r.name) })),
  EMPLOYEE: async (tx, ids) =>
    (
      await tx.employee.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          employeeCode: true,
          firstName: true,
          lastName: true,
        },
      })
    ).map((r) => ({
      id: r.id,
      label: codeName(
        r.employeeCode,
        [r.firstName, r.lastName].filter(Boolean).join(' '),
      ),
    })),
  ROLE: async (tx, ids) =>
    (
      await tx.role.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true },
      })
    ).map((r) => ({ id: r.id, label: r.name })),
  DEPARTMENT: async (tx, ids) =>
    (
      await tx.department.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true },
      })
    ).map((r) => ({ id: r.id, label: r.name })),
  DOCUMENT_TYPE: async (tx, ids) =>
    (
      await tx.documentType.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true },
      })
    ).map((r) => ({ id: r.id, label: r.name })),
  ITEM: async (tx, ids) =>
    (
      await tx.item.findMany({
        where: { id: { in: ids } },
        select: { id: true, code: true, name: true },
      })
    ).map((r) => ({ id: r.id, label: codeName(r.code, r.name) })),
  ITEM_CATEGORY: async (tx, ids) =>
    (
      await tx.itemCategory.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true },
      })
    ).map((r) => ({ id: r.id, label: r.name })),
  ASSET_CATEGORY: async (tx, ids) =>
    (
      await tx.assetCategory.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true },
      })
    ).map((r) => ({ id: r.id, label: r.name })),
  VENDOR_CATEGORY: async (tx, ids) =>
    (
      await tx.vendorCategory.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true },
      })
    ).map((r) => ({ id: r.id, label: r.name })),
  EQUIPMENT: async (tx, ids) =>
    (
      await tx.equipment.findMany({
        where: { id: { in: ids } },
        select: { id: true, code: true, name: true },
      })
    ).map((r) => ({ id: r.id, label: codeName(r.code, r.name) })),
  SPARE_PART: async (tx, ids) =>
    (
      await tx.sparePart.findMany({
        where: { id: { in: ids } },
        select: { id: true, partNumber: true, name: true },
      })
    ).map((r) => ({ id: r.id, label: codeName(r.partNumber, r.name) })),
  DWR: async (tx, ids) =>
    (
      await tx.dailyWorkReport.findMany({
        where: { id: { in: ids } },
        select: { id: true, dprNumber: true },
      })
    ).map((r) => ({ id: r.id, label: r.dprNumber })),
};

/**
 * A label for each row's target, keyed `${entityType}:${entityId}`. Read as Super Admin, as the
 * actor names are: the rows themselves were already scoped to what the caller may see, and this
 * only names the records those rows point at.
 */
export async function targetLabelsFor(
  prisma: PrismaService,
  rows: Row[],
): Promise<Map<string, string>> {
  const byType = new Map<AuditEntityType, Set<string>>();
  for (const row of rows) {
    if (!row.entityId) continue;
    if (
      row.entityType !== AuditEntityType.USER_ACCOUNT &&
      !LOOKUPS[row.entityType]
    ) {
      continue;
    }
    const set = byType.get(row.entityType) ?? new Set<string>();
    set.add(row.entityId);
    byType.set(row.entityType, set);
  }
  const labels = new Map<string, string>();

  const accounts = byType.get(AuditEntityType.USER_ACCOUNT);
  if (accounts) {
    const names = await actorNamesFor(prisma, [...accounts]);
    for (const [id, name] of names) labels.set(`USER_ACCOUNT:${id}`, name);
    byType.delete(AuditEntityType.USER_ACCOUNT);
  }
  if (byType.size === 0) return labels;

  await withRlsContext(prisma, { isSuperAdmin: true }, async (tx) => {
    for (const [type, ids] of byType) {
      const lookup = LOOKUPS[type];
      if (!lookup) continue;
      const found = await lookup(tx, [...ids]);
      for (const { id, label } of found) labels.set(`${type}:${id}`, label);
    }
  });
  return labels;
}

/** The target as a reader should see it: its name, or the kind of record it was. */
export function targetLabelOf(row: Row, labels: Map<string, string>) {
  if (!row.entityId) return null;
  // A password confirmation's target is the person's own account — the actor, named already.
  if (asRecord(row.changes)?.event === 'password_confirmed') return null;
  return (
    labels.get(`${row.entityType}:${row.entityId}`) ??
    `a ${kindOf(row.entityType)}`
  );
}
