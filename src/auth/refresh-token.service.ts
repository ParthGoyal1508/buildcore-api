import * as crypto from 'crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'nestjs-prisma';
import { SecurityConfig } from '../common/configs/config.interface';
import { withRlsContext } from '../common/prisma/rls-context';

/** Tolerates a benign concurrent-refresh race (e.g. a duplicate in-flight request
 * from the same client) without treating it as a stolen-token replay. Deliberately a
 * narrow implementation constant, not a business-facing setting (research.md §2). */
const REUSE_GRACE_WINDOW_MS = 5_000;

export type RotateResult =
  | { outcome: 'invalid' }
  | { outcome: 'reuse'; accountId: string }
  | {
      outcome: 'rotated';
      rawToken: string;
      accountId: string;
      companyId: string | null;
      rememberMe: boolean;
    };

@Injectable()
export class RefreshTokenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  private hash(rawToken: string): string {
    const { refreshTokenHashSecret } =
      this.configService.get<SecurityConfig>('security');
    return crypto
      .createHmac('sha256', refreshTokenHashSecret)
      .update(rawToken)
      .digest('hex');
  }

  private generateRawToken(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  private expiryFor(rememberMe: boolean): Date {
    const { rememberMeDays, defaultDays } =
      this.configService.get<SecurityConfig>('security').refreshToken;
    const days = rememberMe ? rememberMeDays : defaultDays;
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  }

  /** Issues a brand-new token family on login (spec FR-005/FR-006). */
  async issueFamily(params: {
    accountId: string;
    companyId: string | null;
    rememberMe: boolean;
  }): Promise<{ rawToken: string }> {
    const rawToken = this.generateRawToken();
    const familyId = crypto.randomUUID();

    // The account row was just authenticated by password — this create doesn't
    // filter by company, it just attaches one, so it runs as system/bypass rather
    // than under a not-yet-established company context (rls-context.ts).
    await withRlsContext(this.prisma, { isSuperAdmin: true }, (tx) =>
      tx.refreshToken.create({
        data: {
          tokenHash: this.hash(rawToken),
          familyId,
          accountId: params.accountId,
          companyId: params.companyId,
          rememberMe: params.rememberMe,
          expiresAt: this.expiryFor(params.rememberMe),
        },
      }),
    );

    return { rawToken };
  }

  /**
   * Validates and rotates a presented raw refresh token (spec FR-007/FR-008).
   * Looked up by its own unique hash — a value the caller can't forge — so this runs
   * as system/bypass rather than under a company context (rls-context.ts).
   */
  async rotate(rawToken: string): Promise<RotateResult> {
    const tokenHash = this.hash(rawToken);

    return withRlsContext(this.prisma, { isSuperAdmin: true }, async (tx) => {
      const record = await tx.refreshToken.findUnique({
        where: { tokenHash },
      });

      if (!record || record.revokedAt || record.expiresAt < new Date()) {
        return { outcome: 'invalid' };
      }

      if (record.used) {
        const withinGrace =
          !!record.usedAt &&
          Date.now() - record.usedAt.getTime() <= REUSE_GRACE_WINDOW_MS;

        if (!withinGrace) {
          await tx.refreshToken.updateMany({
            where: { familyId: record.familyId, revokedAt: null },
            data: { revokedAt: new Date() },
          });
          return { outcome: 'reuse', accountId: record.accountId };
        }
        // Within the grace window: fall through and rotate again, as if this were
        // a fresh valid presentation of the family.
      }

      const newRawToken = this.generateRawToken();
      await tx.refreshToken.update({
        where: { id: record.id },
        data: { used: true, usedAt: new Date() },
      });
      await tx.refreshToken.create({
        data: {
          tokenHash: this.hash(newRawToken),
          familyId: record.familyId,
          accountId: record.accountId,
          companyId: record.companyId,
          rememberMe: record.rememberMe,
          expiresAt: this.expiryFor(record.rememberMe),
        },
      });

      return {
        outcome: 'rotated',
        rawToken: newRawToken,
        accountId: record.accountId,
        companyId: record.companyId,
        rememberMe: record.rememberMe,
      };
    });
  }

  /** Revokes every active token in the presented token's family (spec FR-011, logout). */
  async revokeFamilyByToken(rawToken: string): Promise<void> {
    const tokenHash = this.hash(rawToken);
    await withRlsContext(this.prisma, { isSuperAdmin: true }, async (tx) => {
      const record = await tx.refreshToken.findUnique({
        where: { tokenHash },
      });
      if (!record) return;
      await tx.refreshToken.updateMany({
        where: { familyId: record.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
  }

  /** Revokes every active session for an account (admin-reset-password FR-022, or
   * deactivation cleanup). */
  async revokeAllForAccount(accountId: string): Promise<void> {
    await withRlsContext(this.prisma, { isSuperAdmin: true }, (tx) =>
      tx.refreshToken.updateMany({
        where: { accountId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    );
  }
}
