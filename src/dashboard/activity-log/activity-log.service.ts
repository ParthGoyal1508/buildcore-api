import { Injectable } from '@nestjs/common';
import { AuditAction, Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import type {
  ActivityLogQueryDto,
  ActivityTimeRange,
} from './dto/activity-log-query.dto';
import {
  entityTypesForModule,
  moduleForEntityType,
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
    const entries = rows.slice(0, PAGE_SIZE).map((row) => ({
      id: row.id,
      actor: row.accountId ?? row.attemptedEmail ?? 'system',
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
    return rows.map((row) => {
      const { before, after } = this.beforeAfter(row.changes);
      return {
        timestamp: row.createdAt.toISOString(),
        user: row.accountId ?? row.attemptedEmail ?? 'system',
        action: row.action,
        module: moduleForEntityType(row.entityType),
        entity: `${row.entityType}${row.entityId ? `:${row.entityId}` : ''}`,
        before,
        after,
      };
    });
  }

  private where(
    user: AuthenticatedUser,
    query: ActivityLogQueryDto,
  ): Prisma.AuditLogEntryWhereInput {
    const types = entityTypesForModule(query.module);
    const since = this.since(query.timeRange);
    return {
      // RLS is not enforced on the legacy audit table, so scope explicitly here:
      // an ordinary caller sees only their own company, a Super Admin sees all.
      ...(rlsContextFor(user).isSuperAdmin
        ? {}
        : { companyId: user.companyId }),
      ...(types ? { entityType: { in: types } } : {}),
      ...(since ? { createdAt: { gte: since } } : {}),
    };
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
