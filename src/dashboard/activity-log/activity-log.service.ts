import { Injectable } from '@nestjs/common';
import { AuditAction, AuditEntityType, Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { actorNamesFor } from '../../common/actor-name';
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

/** One row of the Activity Log feed (contracts/dashboard-api.md). */
export interface ActivityLogEntry {
  id: string;
  actor: string;
  action: AuditAction;
  module: string;
  target: string | null;
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

/**
 * Reads the shared audit trail as the Activity Log (spec FR-007/FR-008, US3).
 *
 * `AuditLogEntry` lives in `shared`, the same schema this feature's own `ExportJob`
 * table lives in — so this is a same-schema read, not a cross-module one
 * (research.md §4). Company scoping is by the caller's own `companyId`, with the
 * Super Admin cross-company exception honoured; module and time-range filters narrow
 * it further, ordered newest-first.
 */
@Injectable()
export class ActivityLogService {
  constructor(private readonly prisma: PrismaService) {}

  /** The paginated feed. Fetches one extra row to answer `hasMore` without a count. */
  async feed(
    user: AuthenticatedUser,
    query: ActivityLogQueryDto,
  ): Promise<{ entries: ActivityLogEntry[]; hasMore: boolean }> {
    const page = query.page ?? 1;
    const rows = await withRlsContext(this.prisma, rlsContextFor(user), (tx) =>
      tx.auditLogEntry.findMany({
        where: this.where(user, query),
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE + 1,
      }),
    );
    const hasMore = rows.length > PAGE_SIZE;
    const page_ = rows.slice(0, PAGE_SIZE);
    const names = await actorNamesFor(
      this.prisma,
      page_.map((row) => row.accountId),
    );
    const entries = page_.map((row) => ({
      id: row.id,
      actor: this.actorOf(row, names),
      action: row.action,
      module: moduleForEntityType(row.entityType),
      target: row.entityId,
      timestamp: row.createdAt.toISOString(),
    }));
    return { entries, hasMore };
  }

  /** The full filtered result set, for the CSV export (spec FR-024). No pagination. */
  async exportRows(
    user: AuthenticatedUser,
    query: ActivityLogQueryDto,
  ): Promise<ActivityLogExportRow[]> {
    const rows = await withRlsContext(this.prisma, rlsContextFor(user), (tx) =>
      tx.auditLogEntry.findMany({
        where: this.where(user, query),
        orderBy: { createdAt: 'desc' },
      }),
    );
    const names = await actorNamesFor(
      this.prisma,
      rows.map((row) => row.accountId),
    );
    return rows.map((row) => {
      const { before, after } = this.beforeAfter(row.changes);
      return {
        timestamp: row.createdAt.toISOString(),
        user: this.actorOf(row, names),
        action: row.action,
        module: moduleForEntityType(row.entityType),
        entity: `${row.entityType}${row.entityId ? `:${row.entityId}` : ''}`,
        before,
        after,
      };
    });
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

  private where(
    user: AuthenticatedUser,
    query: ActivityLogQueryDto,
  ): Prisma.AuditLogEntryWhereInput {
    const since = this.since(query.timeRange);
    return {
      // RLS is not enforced on the legacy audit table, so scope explicitly here:
      // an ordinary caller sees only their own company, a Super Admin sees all.
      ...(rlsContextFor(user).isSuperAdmin
        ? {}
        : { companyId: user.companyId }),
      entityType: { in: this.permittedTypes(user, query) },
      ...(since ? { createdAt: { gte: since } } : {}),
    };
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
      case 'today': {
        const start = new Date(now);
        start.setHours(0, 0, 0, 0);
        return start;
      }
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
