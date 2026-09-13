import * as crypto from 'crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'nestjs-prisma';
import { SecurityConfig } from '../common/configs/config.interface';
import { withRlsContext } from '../common/prisma/rls-context';

export type RotateResult =
  | { outcome: 'invalid' }
  | {
      outcome: 'reuse';
      accountId: string;
      familyId: string;
      /** Seconds past the grace window, or null if the token had no recorded use time. */
      lateBySeconds: number | null;
    }
  | {
      outcome: 'rotated';
      rawToken: string;
      accountId: string;
      companyId: string | null;
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

  /**
   * When a session issued or rotated *now* would expire (015 FR-001, FR-002).
   *
   * Called on every rotation, not just at login, which is what makes the window slide:
   * a session in continuous use never reaches its expiry, and only real inactivity ends
   * it. That behaviour predates this feature — what changed is that the answer no longer
   * depends on whether the user ticked a box.
   */
  private expiryFor(): Date {
    const { sessionDays } =
      this.configService.get<SecurityConfig>('security').refreshToken;
    return new Date(Date.now() + sessionDays * 24 * 60 * 60 * 1000);
  }

  /**
   * How long an already-rotated token may still be presented before it is read as a
   * replay (015 FR-005).
   *
   * The window tells one client renewing twice from two parties holding one credential.
   * It was a hardcoded 5 seconds, which a cold instance exceeds — so a slow response was
   * being classified as theft and destroying live sessions. A wall-clock window is kept
   * deliberately: the obvious alternative, tolerating only the immediate predecessor of
   * the family head, breaks above two-way concurrency, because the third of three
   * simultaneous renewals is already two generations back (research.md §2).
   */
  private reuseGraceMs(): number {
    const { reuseGraceSeconds } =
      this.configService.get<SecurityConfig>('security').refreshToken;
    return reuseGraceSeconds * 1000;
  }

  /** Issues a brand-new token family on login (spec FR-005/FR-006). */
  async issueFamily(params: {
    accountId: string;
    companyId: string | null;
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
          expiresAt: this.expiryFor(),
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
        const lateBy = record.usedAt
          ? Date.now() - record.usedAt.getTime()
          : Number.POSITIVE_INFINITY;
        const withinGrace = lateBy <= this.reuseGraceMs();

        if (!withinGrace) {
          await tx.refreshToken.updateMany({
            where: { familyId: record.familyId, revokedAt: null },
            data: { revokedAt: new Date() },
          });
          // Reported upward so the destruction is audited (015 FR-007). Without the
          // margin there is nothing afterwards to tell a genuine theft signal from
          // another false positive, which is how the previous 5-second window went
          // unnoticed while it destroyed five live sessions.
          return {
            outcome: 'reuse',
            accountId: record.accountId,
            familyId: record.familyId,
            lateBySeconds: Number.isFinite(lateBy)
              ? Math.round(lateBy / 1000)
              : null,
          };
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
          expiresAt: this.expiryFor(),
        },
      });

      return {
        outcome: 'rotated',
        rawToken: newRawToken,
        accountId: record.accountId,
        companyId: record.companyId,
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
