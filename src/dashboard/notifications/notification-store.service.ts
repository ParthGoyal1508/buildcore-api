import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import type { InboxNotification, NotificationRow } from './notification.types';

/** How long a resolved notification is remembered before it is deleted (036 D6). */
export const RESOLVED_RETENTION_DAYS = 30;

/**
 * The bell's inbox (036 D6): read/unread state for the notifications the providers compute.
 *
 * ## Why stored, when the notifications are computed
 *
 * The providers answer "what is true now" — leave awaiting a decision, approvals in the caller's
 * queue, reminders due — and that stays the source of truth: a stored copy of "3 RA bills await
 * you" would be wrong the moment one was approved. What the bell could not do was say what is
 * *new*: it counted everything true, so a director who had looked at the same two items every
 * morning for a week still saw a red 2, and learnt to ignore it. This table holds only what a
 * computation cannot know — whether this person has read this notification since it last changed.
 *
 * ## How a computed row meets its stored one
 *
 * By `key` (stable: "approvals of this kind", "this reminder"), per person and per company scope.
 * A new key is stored unread. A known key whose `fingerprint` changed (a newer item joined the
 * queue, a reminder turned overdue) goes back to unread with its new content. A stored key no
 * longer computed is marked resolved and leaves the bell; it is kept for
 * {@link RESOLVED_RETENTION_DAYS} days, so a condition that flickers off and on does not return as
 * unread with nothing new in it.
 *
 * ## Scope
 *
 * `companyId` is the company the rows were computed for — the selected one — or `''` for a Super
 * Admin with no company selected. A cross-company caller switching companies therefore has one
 * inbox per company, matching what the providers compute for each.
 *
 * No email is sent from here, or anywhere for notifications (product decision, 036 plan §4).
 */
@Injectable()
export class NotificationStore {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records the caller's currently computed rows and returns them with their inbox state, in the
   * order given. Writes only what changed, so a poll of an unchanged bell is one read.
   */
  async sync(
    user: AuthenticatedUser,
    rows: NotificationRow[],
    now: Date = new Date(),
  ): Promise<InboxNotification[]> {
    const ctx = rlsContextFor(user);
    const companyId = scopeOf(ctx);
    const computed = dedupeByKey(rows);
    const keys = computed.map((r) => r.key);

    return withRlsContext(this.prisma, ctx, async (tx) => {
      const stored = await tx.notification.findMany({
        where: {
          userId: user.id,
          companyId,
          OR: [{ resolvedAt: null }, { key: { in: keys } }],
        },
      });
      const byKey = new Map(stored.map((n) => [n.key, n]));

      const fresh = computed.filter((r) => !byKey.has(r.key));
      if (fresh.length > 0) {
        // `skipDuplicates`: the list and the badge count can sync at the same moment, and the
        // second insert of the same key is the same notification, not an error.
        await tx.notification.createMany({
          data: fresh.map((r) => ({
            userId: user.id,
            companyId,
            key: r.key,
            fingerprint: r.fingerprint,
            type: r.type,
            severity: r.severity,
            title: r.title,
            subtitle: r.subtitle,
            actionLink: r.actionLink,
            occurredAt: validDate(r.occurredAt, now),
          })),
          skipDuplicates: true,
        });
      }

      for (const r of computed) {
        const n = byKey.get(r.key);
        if (!n) continue;
        const renewed = n.fingerprint !== r.fingerprint;
        const changed =
          renewed ||
          n.resolvedAt !== null ||
          n.severity !== r.severity ||
          n.title !== r.title ||
          n.subtitle !== r.subtitle ||
          n.actionLink !== r.actionLink ||
          n.type !== r.type;
        if (!changed) continue;
        await tx.notification.update({
          where: { id: n.id },
          data: {
            type: r.type,
            severity: r.severity,
            title: r.title,
            subtitle: r.subtitle,
            actionLink: r.actionLink,
            resolvedAt: null,
            ...(renewed
              ? {
                  fingerprint: r.fingerprint,
                  occurredAt: validDate(r.occurredAt, now),
                  readAt: null,
                }
              : {}),
          },
        });
      }

      const gone = stored
        .filter((n) => n.resolvedAt === null && !keys.includes(n.key))
        .map((n) => n.id);
      if (gone.length > 0) {
        await tx.notification.updateMany({
          where: { id: { in: gone } },
          data: { resolvedAt: now },
        });
      }
      await tx.notification.deleteMany({
        where: {
          userId: user.id,
          companyId,
          resolvedAt: {
            lt: new Date(now.getTime() - RESOLVED_RETENTION_DAYS * 86_400_000),
          },
        },
      });

      if (keys.length === 0) return [];
      const current = await tx.notification.findMany({
        where: { userId: user.id, companyId, key: { in: keys } },
      });
      const currentByKey = new Map(current.map((n) => [n.key, n]));
      return computed.flatMap((r) => {
        const n = currentByKey.get(r.key);
        if (!n) return [];
        return [
          {
            type: n.type,
            severity: r.severity,
            title: n.title,
            subtitle: n.subtitle,
            actionLink: n.actionLink,
            occurredAt: n.occurredAt.toISOString(),
            key: n.key,
            fingerprint: n.fingerprint,
            id: n.id,
            read: n.readAt !== null,
            readAt: n.readAt ? n.readAt.toISOString() : null,
          },
        ];
      });
    });
  }

  /** Marks one of the caller's own notifications read. Someone else's is a 404, not a 403. */
  async markRead(
    user: AuthenticatedUser,
    id: string,
    now: Date = new Date(),
  ): Promise<{ id: string; read: true }> {
    const ctx = rlsContextFor(user);
    const updated = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.notification.updateMany({
        where: { id, userId: user.id, companyId: scopeOf(ctx), readAt: null },
        data: { readAt: now },
      }),
    );
    if (updated.count === 0) {
      const exists = await withRlsContext(this.prisma, ctx, (tx) =>
        tx.notification.count({
          where: { id, userId: user.id, companyId: scopeOf(ctx) },
        }),
      );
      if (exists === 0) throw new NotFoundException('Notification not found');
    }
    return { id, read: true };
  }

  /** Marks every unread, current notification of the caller's read, in the current scope. */
  async markAllRead(
    user: AuthenticatedUser,
    now: Date = new Date(),
  ): Promise<{ updated: number }> {
    const ctx = rlsContextFor(user);
    const { count } = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.notification.updateMany({
        where: {
          userId: user.id,
          companyId: scopeOf(ctx),
          readAt: null,
          resolvedAt: null,
        },
        data: { readAt: now },
      }),
    );
    return { updated: count };
  }
}

/** The company scope a caller's inbox lives in: the selected company, or `''` for all. */
function scopeOf(ctx: { isSuperAdmin: boolean; companyId?: string | null }) {
  return ctx.isSuperAdmin ? '' : ctx.companyId ?? '';
}

/** Each row with its key and fingerprint resolved; a repeated key keeps its first row. */
function dedupeByKey(
  rows: NotificationRow[],
): (NotificationRow & { key: string; fingerprint: string })[] {
  const seen = new Set<string>();
  const out: (NotificationRow & { key: string; fingerprint: string })[] = [];
  for (const row of rows) {
    const key = row.key ?? row.type;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      ...row,
      key,
      fingerprint: row.fingerprint ?? `${row.title}\n${row.subtitle}`,
    });
  }
  return out;
}

function validDate(iso: string, fallback: Date): Date {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? fallback : d;
}
