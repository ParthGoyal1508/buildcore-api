import { Injectable } from '@nestjs/common';
import { AuditEventType } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';
import { withRlsContext } from '../common/prisma/rls-context';

/** Write-only in this feature (spec.md 2026-08-26 clarification) — reading/querying
 * the audit log is a separate, later Activity Log feature. */
@Injectable()
export class AuditLogService {
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: {
    eventType: AuditEventType;
    accountId?: string | null;
    attemptedEmail?: string | null;
    companyId?: string | null;
    ipAddress: string;
  }): Promise<void> {
    // A write describing the event itself, not a company-scoped read — runs as
    // system/bypass rather than under a company context (rls-context.ts).
    await withRlsContext(this.prisma, { isSuperAdmin: true }, (tx) =>
      tx.auditLogEntry.create({
        data: {
          eventType: entry.eventType,
          accountId: entry.accountId ?? null,
          attemptedEmail: entry.attemptedEmail ?? null,
          companyId: entry.companyId ?? null,
          ipAddress: entry.ipAddress,
        },
      }),
    );
  }
}
