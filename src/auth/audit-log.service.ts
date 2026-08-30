import { Injectable } from '@nestjs/common';
import { AuditAction, AuditEntityType, Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';
import { withRlsContext } from '../common/prisma/rls-context';

/**
 * The login-lifecycle events feature 001 records. Each maps onto the generalized
 * `entityType`/`action` pair one-to-one — the event *is* both what happened and
 * what it happened to — so 001's call sites stay single-line after feature 002
 * generalized the table (002 research.md §9, tasks T008/T021).
 */
export type AuthAuditEvent = Extract<
  AuditEntityType,
  | 'LOGIN_SUCCESS'
  | 'LOGIN_FAILURE'
  | 'ACCOUNT_LOCKED'
  | 'LOGOUT'
  | 'REFRESH_REUSE_DETECTED'
  | 'ADMIN_PASSWORD_RESET'
>;

export interface AuditLogEntryInput {
  entityType: AuditEntityType;
  action: AuditAction;
  /** The row affected; null for login-related events. */
  entityId?: string | null;
  /** Optional before/after snapshot for update actions. */
  changes?: Prisma.InputJsonValue | null;
  accountId?: string | null;
  attemptedEmail?: string | null;
  companyId?: string | null;
  ipAddress: string;
}

/** Write-only in both features that use it (001 spec.md 2026-08-26 clarification) —
 * reading/querying the audit log is a separate, later Activity Log feature. */
@Injectable()
export class AuditLogService {
  constructor(private readonly prisma: PrismaService) {}

  /** Records any audited change. Feature 002 calls this directly with an entity
   * type and a CREATE/UPDATE/DELETE action (FR-025). */
  async record(entry: AuditLogEntryInput): Promise<void> {
    // A write describing the event itself, not a company-scoped read — runs as
    // system/bypass rather than under a company context (rls-context.ts).
    await withRlsContext(this.prisma, { isSuperAdmin: true }, (tx) =>
      tx.auditLogEntry.create({
        data: {
          entityType: entry.entityType,
          action: entry.action,
          entityId: entry.entityId ?? null,
          changes: entry.changes ?? Prisma.DbNull,
          accountId: entry.accountId ?? null,
          attemptedEmail: entry.attemptedEmail ?? null,
          companyId: entry.companyId ?? null,
          ipAddress: entry.ipAddress,
        },
      }),
    );
  }

  /** Convenience wrapper for feature 001's login-lifecycle events, where the event
   * name serves as both `entityType` and `action`. */
  async recordAuthEvent(
    event: AuthAuditEvent,
    entry: Omit<AuditLogEntryInput, 'entityType' | 'action'>,
  ): Promise<void> {
    await this.record({
      ...entry,
      entityType: event,
      action: event as unknown as AuditAction,
    });
  }
}
