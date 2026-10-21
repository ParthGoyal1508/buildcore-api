import { BadRequestException, Injectable } from '@nestjs/common';
import { AuditAction, AuditEntityType, Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import {
  ACTOR_NAME_SELECT,
  actorNameOf,
  actorNamesFor,
} from '../../common/actor-name';
import config from '../../common/configs/config';
import { zonedDateOnly, zonedDayBounds } from '../../hr/leave/leave-days';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import type {
  ActivityLogQueryDto,
  ActivityTimeRange,
} from './dto/activity-log-query.dto';
import {
  entityTypesForModule,
  moduleForEntityType,
  visibleEntityTypes,
} from './module-bucket-mapping';
import {
  describeEvent,
  targetLabelOf,
  targetLabelsFor,
} from './activity-descriptions';
import { hiddenCashEntryIds } from './cash-entries';

/** One row of the Activity Log feed (contracts/dashboard-api.md). */
export interface ActivityLogEntry {
  id: string;
  actor: string;
  action: AuditAction;
  module: string;
  /** The record's id, as recorded. */
  target: string | null;
  /** The record as a reader should see it — its name, or the kind of record (2026-10-15). */
  targetLabel: string | null;
  /** A sentence for an event "Viewed"/"Updated" would misdescribe; shown instead of both. */
  description: string | null;
  timestamp: string;
}

/** One row of the CSV export — richer than the feed (before/after included). */
export interface ActivityLogExportRow {
  timestamp: string;
  user: string;
  action: AuditAction;
  module: string;
  entity: string;
  before: string;
  after: string;
}

const PAGE_SIZE = 25;
/** One page of the User filter's picker (036 E3). */
const ACTOR_PAGE_SIZE = 25;

/**
 * Reads the shared audit trail as the Activity Log (spec FR-007/FR-008, US3).
 *
 * `AuditLogEntry` lives in `shared`, the same schema this feature's own `ExportJob`
 * table lives in — so this is a same-schema read, not a cross-module one
 * (research.md §4). Company scoping is by the caller's own `companyId`, with the
 * Super Admin cross-company exception honoured; module and time-range filters narrow
 * it further, ordered newest-first.
 */
/** The most rows one activity-log export returns (036 B13). */
export const ACTIVITY_EXPORT_MAX_ROWS = 50_000;

@Injectable()
export class ActivityLogService {
  constructor(private readonly prisma: PrismaService) {}

  /** The paginated feed. Fetches one extra row to answer `hasMore` without a count. */
  async feed(
    user: AuthenticatedUser,
    query: ActivityLogQueryDto,
  ): Promise<{ entries: ActivityLogEntry[]; hasMore: boolean }> {
    const page = query.page ?? 1;
    const where = await this.where(user, query);
    const rows = await withRlsContext(this.prisma, rlsContextFor(user), (tx) =>
      tx.auditLogEntry.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE + 1,
      }),
    );
    const hasMore = rows.length > PAGE_SIZE;
    const page_ = rows.slice(0, PAGE_SIZE);
    const [names, labels] = await Promise.all([
      actorNamesFor(
        this.prisma,
        page_.map((row) => row.accountId),
      ),
      targetLabelsFor(this.prisma, page_),
    ]);
    const entries = page_.map((row) => ({
      id: row.id,
      actor: this.actorOf(row, names),
      action: row.action,
      module: moduleForEntityType(row.entityType),
      target: row.entityId,
      targetLabel: targetLabelOf(row, labels),
      description: describeEvent(row),
      timestamp: row.createdAt.toISOString(),
    }));
    return { entries, hasMore };
  }

  /**
   * The filtered result set, for the CSV export (spec FR-024). No pagination — but bounded
   * (036 B13/B14): with no time range the export covers the last 90 days rather than the whole
   * audit log, and it never returns more than {@link ACTIVITY_EXPORT_MAX_ROWS} rows (newest
   * first). An unbounded export loaded every audit row the company had into memory per click.
   */
  async exportRows(
    user: AuthenticatedUser,
    query: ActivityLogQueryDto,
  ): Promise<ActivityLogExportRow[]> {
    // A custom range bounds the export itself; only a request with no range at all falls back.
    const bounded =
      query.from || query.to
        ? query
        : { ...query, timeRange: query.timeRange ?? '90d' };
    const where = await this.where(user, bounded);
    const rows = await withRlsContext(this.prisma, rlsContextFor(user), (tx) =>
      tx.auditLogEntry.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: ACTIVITY_EXPORT_MAX_ROWS,
      }),
    );
    const [names, labels] = await Promise.all([
      actorNamesFor(
        this.prisma,
        rows.map((row) => row.accountId),
      ),
      targetLabelsFor(this.prisma, rows),
    ]);
    return rows.map((row) => {
      const { before, after } = this.beforeAfter(row.changes);
      return {
        timestamp: row.createdAt.toISOString(),
        user: this.actorOf(row, names),
        action: row.action,
        module: moduleForEntityType(row.entityType),
        // The name beside the id, so the export reads as well as the screen and still joins back.
        entity: [
          describeEvent(row) ?? targetLabelOf(row, labels),
          row.entityId ? `(${row.entityType}:${row.entityId})` : row.entityType,
        ]
          .filter(Boolean)
          .join(' '),
        before,
        after,
      };
    });
  }

  /**
   * Accounts the User filter can pick from (036 E3): the caller's company (or the selected one;
   * every company for an unscoped Super Admin), searched by name or address, a page at a time.
   * The Activity Log already names these people on every row it shows, so listing them for the
   * picker discloses nothing new; `/settings/users` was not usable here, being gated on
   * `USER_MANAGEMENT`.
   */
  async actors(
    user: AuthenticatedUser,
    query: { q?: string; page?: number },
  ): Promise<{ items: { id: string; name: string }[]; total: number }> {
    const ctx = rlsContextFor(user);
    const q = query.q?.trim();
    const where: Prisma.UserWhereInput = {
      ...(ctx.isSuperAdmin ? {} : { companyId: ctx.companyId ?? null }),
      ...(q
        ? {
            OR: [
              { displayName: { contains: q, mode: 'insensitive' } },
              { firstname: { contains: q, mode: 'insensitive' } },
              { lastname: { contains: q, mode: 'insensitive' } },
              { username: { contains: q, mode: 'insensitive' } },
              { email: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const page = Math.max(query.page ?? 1, 1);
    const [rows, total] = await withRlsContext(this.prisma, ctx, (tx) =>
      Promise.all([
        tx.user.findMany({
          where,
          select: ACTOR_NAME_SELECT,
          orderBy: [{ displayName: 'asc' }, { username: 'asc' }, { id: 'asc' }],
          skip: (page - 1) * ACTOR_PAGE_SIZE,
          take: ACTOR_PAGE_SIZE,
        }),
        tx.user.count({ where }),
      ]),
    );
    return {
      items: rows.map((row) => ({ id: row.id, name: actorNameOf(row) })),
      total,
    };
  }

  /**
   * Who did it, as a person's name.
   *
   * `accountId` is a cuid, and both surfaces used to render it directly — so the Activity
   * Log's User column read `cmu40n37h0001123njsvg08v5` on every action by a signed-in user,
   * and so did every row of the CSV export. An audit trail exists to answer "who", and that
   * is the one question it was not answering; `actor-name.ts` says in its own header that
   * printing an id instead is the defect it exists to fix.
   *
   * `attemptedEmail` stays the fallback, and is the whole answer for a failed sign-in: there
   * is no account to name, and the address someone typed is the only identity the event has.
   * `system` last, for an entry with neither — a scheduled job, not a person.
   */
  private actorOf(
    row: { accountId: string | null; attemptedEmail: string | null },
    names: Map<string, string>,
  ): string {
    return (
      (row.accountId ? names.get(row.accountId) : null) ??
      row.attemptedEmail ??
      row.accountId ??
      'system'
    );
  }

  private async where(
    user: AuthenticatedUser,
    query: ActivityLogQueryDto,
  ): Promise<Prisma.AuditLogEntryWhereInput> {
    const createdAt = this.rangeOf(query);
    const ctx = rlsContextFor(user);
    const q = query.q?.trim();
    let search: Prisma.AuditLogEntryWhereInput | null = null;
    if (q) {
      // 036 E3: who acted, by name or address, or the record's id. Accounts are looked up first
      // and bounded; the search only narrows rows the caller may already read.
      const people = await withRlsContext(
        this.prisma,
        { isSuperAdmin: true },
        (tx) =>
          tx.user.findMany({
            where: {
              OR: [
                { displayName: { contains: q, mode: 'insensitive' } },
                { firstname: { contains: q, mode: 'insensitive' } },
                { lastname: { contains: q, mode: 'insensitive' } },
                { username: { contains: q, mode: 'insensitive' } },
                { email: { contains: q, mode: 'insensitive' } },
              ],
            },
            select: { id: true },
            take: 200,
          }),
      );
      search = {
        OR: [
          { attemptedEmail: { contains: q, mode: 'insensitive' } },
          { entityId: q },
          ...(people.length
            ? [{ accountId: { in: people.map((p) => p.id) } }]
            : []),
        ],
      };
    }
    const base: Prisma.AuditLogEntryWhereInput = {
      // RLS is not enforced on the legacy audit table, so scope explicitly here:
      // an ordinary caller sees only their own company, a Super Admin sees all — or, having
      // selected a company, that company. Not `user.companyId`: that is the **home** company,
      // and a Super Admin who had selected another one was shown the wrong log (036 B3).
      ...(ctx.isSuperAdmin ? {} : { companyId: ctx.companyId }),
      entityType: { in: this.permittedTypes(user, query) },
      ...(createdAt ? { createdAt } : {}),
      ...(query.userId ? { accountId: query.userId } : {}),
      ...(search ? { AND: [search] } : {}),
    };
    // 038: an entry about a cash transaction of a company hiding cash is left out, as if the
    // transaction had never been recorded — from the feed and the CSV export alike.
    const hidden = await hiddenCashEntryIds(this.prisma, ctx, base);
    return hidden.length ? { AND: [base, { id: { notIn: hidden } }] } : base;
  }

  /** A custom `from`/`to` (business-timezone days, inclusive) or the preset (036 E3). */
  private rangeOf(query: ActivityLogQueryDto): Prisma.DateTimeFilter | null {
    if (query.from || query.to) {
      const zone = config().settings.timezone;
      try {
        const range: Prisma.DateTimeFilter = {};
        if (query.from) range.gte = zonedDayBounds(query.from, zone).start;
        if (query.to) range.lt = zonedDayBounds(query.to, zone).end;
        if (range.gte && range.lt && range.gte >= range.lt) {
          throw new BadRequestException({
            code: 'VALIDATION_FAILED',
            message: 'The From date must not be after the To date.',
          });
        }
        return range;
      } catch (error) {
        if (error instanceof RangeError) {
          throw new BadRequestException({
            code: 'VALIDATION_FAILED',
            message: 'That is not a real calendar date.',
          });
        }
        throw error;
      }
    }
    const since = this.since(query.timeRange);
    return since ? { gte: since } : null;
  }

  /**
   * The entity types this request may return: what the caller's permissions admit,
   * intersected with the module filter they asked for (2026-10-10).
   *
   * **Always a positive list, never an absent filter.** The earlier code omitted
   * `entityType` entirely when no module was selected, which is how an unfiltered feed
   * came to return every module's audit rows to anybody holding `DASHBOARD` — payroll
   * runs, salary advances, role changes, each with its before/after values, and the same
   * set again as a CSV. A caller holding nothing now gets an empty `in` list and so an
   * empty feed, which is the correct answer and not an error (spec Edge Cases already
   * says a bucket with no rows returns an empty feed).
   *
   * Asking for a module the caller cannot see yields the intersection — empty — rather
   * than a 403: the module filter is a list of buckets, and refusing would confirm which
   * of them hold rows.
   *
   * Nothing falls through the gaps: `module-bucket-mapping.spec.ts` asserts every
   * `AuditEntityType` sits in exactly one bucket, so a type added without a bucket fails
   * that test rather than quietly becoming invisible here.
   */
  private permittedTypes(
    user: AuthenticatedUser,
    query: ActivityLogQueryDto,
  ): AuditEntityType[] {
    const permitted = visibleEntityTypes(user.permissions);
    const asked = entityTypesForModule(query.module);
    if (!asked) return permitted;
    const allowed = new Set(permitted);
    return asked.filter((type) => allowed.has(type));
  }

  private since(range: ActivityTimeRange | undefined): Date | null {
    if (!range) return null;
    const now = new Date();
    switch (range) {
      case 'today':
        // The business day, not the server's: on a UTC host `setHours(0)` started "today" at
        // 05:30 IST and hid the first five and a half hours of every day (036 E3).
        return zonedDayBounds(
          zonedDateOnly(now, config().settings.timezone),
          config().settings.timezone,
        ).start;
      case '7d':
        return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      case '30d':
        return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      case '90d':
        return new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    }
  }

  private beforeAfter(changes: Prisma.JsonValue | null): {
    before: string;
    after: string;
  } {
    if (
      changes &&
      typeof changes === 'object' &&
      !Array.isArray(changes) &&
      ('before' in changes || 'after' in changes)
    ) {
      const record = changes as Record<string, unknown>;
      return {
        before: record.before ? JSON.stringify(record.before) : '',
        after: record.after ? JSON.stringify(record.after) : '',
      };
    }
    // A flat change payload has no before/after split — record it whole as "after".
    return { before: '', after: changes ? JSON.stringify(changes) : '' };
  }
}
