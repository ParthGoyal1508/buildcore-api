import { Injectable, Logger } from '@nestjs/common';
import { AccessLevel, Permission } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { withRlsContext } from '../prisma/rls-context';

/**
 * Records refused requests (019 FR-003).
 *
 * Separate from the guard because a guard must stay synchronous — `canActivate` returning a
 * promise would make every request wait on a write that has nothing to do with whether it is
 * allowed. So the guard decides, and this records, without the decision awaiting the record.
 */
@Injectable()
export class PermissionRefusalService {
  private readonly logger = new Logger(PermissionRefusalService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Writes one refusal, and **never throws**.
   *
   * A failure to log a refusal must not turn a 403 into a 500: the caller was correctly
   * refused either way, and the difference between those two responses is the difference
   * between a working system and an apparently broken one. The loss is logged instead.
   *
   * Deliberately not awaited by the guard. Ordering between concurrent refusals is not
   * meaningful — `createdAt` is what orders the log — and making a rejected request slower
   * than an accepted one is its own small oracle.
   */
  record(input: {
    companyId: string | null;
    userId: string;
    method: string;
    path: string;
    requiredPermission: Permission;
    requiredLevel: AccessLevel;
    heldLevel: AccessLevel | null;
  }): void {
    // A caller with no company cannot be recorded against one, and this table is
    // tenant-scoped. Rare enough to drop rather than invent a tenant for.
    if (!input.companyId) return;

    void withRlsContext(
      this.prisma,
      { isSuperAdmin: false, companyId: input.companyId },
      (tx) =>
        tx.permissionRefusal.create({
          data: {
            companyId: input.companyId as string,
            userId: input.userId,
            method: input.method,
            path: input.path,
            requiredPermission: input.requiredPermission,
            requiredLevel: input.requiredLevel,
            heldLevel: input.heldLevel,
          },
        }),
    ).catch((error) => {
      this.logger.warn(
        `Could not record a permission refusal for user ${input.userId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  /** How long a refusal is kept. A security log with no stated lifetime is how a small table
   * becomes an incident, so the number is here rather than nowhere. */
  static readonly RETENTION_DAYS = 180;

  /** Deletes refusals older than the retention window. Called by the cron. */
  async sweep(now = new Date()): Promise<number> {
    const cutoff = new Date(now);
    cutoff.setUTCDate(
      cutoff.getUTCDate() - PermissionRefusalService.RETENTION_DAYS,
    );
    const result = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      (tx) =>
        tx.permissionRefusal.deleteMany({
          where: { createdAt: { lt: cutoff } },
        }),
    );
    return result.count;
  }
}
