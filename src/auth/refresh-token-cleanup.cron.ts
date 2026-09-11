import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from 'nestjs-prisma';

import { SecurityConfig } from '../common/configs/config.interface';
import { withRlsContext } from '../common/prisma/rls-context';

/**
 * Removes refresh tokens that can no longer authorise anything (015 FR-013).
 *
 * A ninety-day sliding window produces far more rows than the one-day window it
 * replaced — every renewal leaves its predecessor behind, and predecessors now live
 * ninety days rather than one. The table sits on the hot path of every renewal, so it
 * cannot be allowed to grow without bound.
 *
 * Deletion is deliberately delayed past expiry by `cleanupRetentionDays`. When replay
 * protection destroys a family it writes an audit entry describing it, and those rows
 * are the only evidence of what actually happened; deleting them the moment they
 * expired would leave the audit entry pointing at nothing, which is precisely the
 * question FR-007 exists to let someone answer afterwards.
 *
 * Runs with the cross-company bypass because it is a system job with no caller, the
 * same reason `RefreshTokenService` reads and rotates that way: a refresh token is
 * located by an unforgeable hash and belongs to no company context until resolved.
 */
@Injectable()
export class RefreshTokenCleanupCron {
  private readonly logger = new Logger(RefreshTokenCleanupCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'refresh-token-cleanup' })
  async removeDeadTokens(): Promise<void> {
    const { cleanupRetentionDays } =
      this.configService.get<SecurityConfig>('security').refreshToken;
    const cutoff = new Date(
      Date.now() - cleanupRetentionDays * 24 * 60 * 60 * 1000,
    );

    const { count } = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      (tx) =>
        tx.refreshToken.deleteMany({
          // Either condition is enough: an expired token is dead by time, a revoked
          // one by decision. A revoked token may still be far from its expiry, so
          // keying only on `expiresAt` would keep destroyed families for months.
          where: {
            OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }],
          },
        }),
    );

    if (count > 0) {
      this.logger.log(
        `Removed ${count} refresh token(s) dead since before ${cutoff.toISOString()}`,
      );
    }
  }
}
