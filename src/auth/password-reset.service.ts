import { createHash, randomBytes } from 'crypto';
import { HttpException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditEntityType, UserStatus } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';
import type {
  EmailConfig,
  SecurityConfig,
} from '../common/configs/config.interface';
import { withRlsContext } from '../common/prisma/rls-context';
import { EmailService } from '../shared/email/email.service';
import { AuditLogService } from './audit-log.service';
import { PasswordService } from './password.service';
import { RefreshTokenService } from './refresh-token.service';

/** HTTP 410 Gone — a spent or expired link, as the invite flow answers. */
const HTTP_STATUS_GONE = 410;

/** 32 bytes, as an invite token: unguessable, and short enough to sit in a URL. */
const RESET_TOKEN_BYTES = 32;

export type ResetLinkValidation =
  | { valid: true }
  | { valid: false; reason: 'not_found' | 'expired' | 'consumed' };

/** The account a link is issued for. */
interface ResetTarget {
  id: string;
  email: string;
  companyId: string | null;
}

/**
 * Password reset links (029 FR-010 to FR-015): Forgot Password, and the link an admin sends.
 *
 * Mirrors the invite flow on purpose — SHA-256 of the token at rest, newest unconsumed row wins,
 * consumption by a conditional update — because that flow has already been reviewed for exactly
 * these properties, and a second token design is a second thing to get right.
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly passwords: PasswordService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly auditLog: AuditLogService,
    private readonly email: EmailService,
  ) {}

  private get settings(): SecurityConfig['passwordReset'] {
    return this.configService.get<SecurityConfig>('security').passwordReset;
  }

  private hash(rawToken: string): string {
    return createHash('sha256').update(rawToken).digest('hex');
  }

  private resetUrl(rawToken: string): string {
    const base = this.configService.get<EmailConfig>('email').appBaseUrl;
    return `${base.replace(/\/+$/, '')}/reset-password/${rawToken}`;
  }

  /**
   * Forgot Password (029 FR-010, FR-011). **Answers identically whatever happens** — no account,
   * a deactivated one, a throttled one, a sent link — so the endpoint cannot be used to learn
   * which addresses have accounts.
   *
   * Timing is part of "identically": the email is dispatched without being awaited, because a
   * provider round trip is hundreds of milliseconds and only one branch would pay it. The
   * database work that remains costs about the same on every branch.
   */
  async requestSelfService(
    identifier: string,
    ipAddress: string,
  ): Promise<void> {
    const normalized = identifier.trim().toLowerCase();
    const user = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      (tx) =>
        tx.user.findFirst({
          where: {
            OR: [
              { email: { equals: normalized, mode: 'insensitive' } },
              { username: { equals: normalized, mode: 'insensitive' } },
            ],
          },
          select: { id: true, email: true, companyId: true, status: true },
        }),
    );

    // A pending account has no password to reset — its invite is the way in, and only an admin
    // may re-send that. A deactivated one must not be able to mint itself a credential.
    if (!user || user.status !== UserStatus.active) {
      await this.auditLog.recordAuthEvent(
        AuditEntityType.PASSWORD_RESET_REQUESTED,
        {
          accountId: user?.id ?? null,
          attemptedEmail: user ? null : normalized,
          companyId: user?.companyId ?? null,
          ipAddress,
          changes: { outcome: user ? `account_${user.status}` : 'no_account' },
        },
      );
      return;
    }

    if (await this.isThrottled(user.id)) {
      await this.auditLog.recordAuthEvent(
        AuditEntityType.PASSWORD_RESET_REQUESTED,
        {
          accountId: user.id,
          companyId: user.companyId,
          ipAddress,
          changes: { outcome: 'throttled' },
        },
      );
      return;
    }

    void this.issue(user, {
      requestedById: null,
      ttlMs: this.settings.selfServiceTtlMinutes * 60_000,
      ipAddress,
    }).catch((error: Error) =>
      // Already logged with the recipient by the adapter; this is the request's own trace.
      this.logger.error(`Forgot Password dispatch failed: ${error.message}`),
    );
  }

  /** Too soon after the last self-service link, or too many in the hour (029 FR-011). */
  private async isThrottled(userId: string): Promise<boolean> {
    const { minIntervalSeconds, maxPerHour } = this.settings;
    const hourAgo = new Date(Date.now() - 3_600_000);
    const recent = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      (tx) =>
        tx.passwordResetToken.findMany({
          where: { userId, requestedById: null, createdAt: { gt: hourAgo } },
          select: { createdAt: true },
          orderBy: { createdAt: 'desc' },
        }),
    );
    if (recent.length >= maxPerHour) return true;
    const last = recent[0]?.createdAt.getTime();
    return last !== undefined && Date.now() - last < minIntervalSeconds * 1000;
  }

  /**
   * Issues a link and emails it. Used by Forgot Password and by an admin's "send reset link"
   * (029 FR-014), which awaits it so a failed send can be reported back to the admin.
   *
   * Issuing does not touch the current password or any session: until the link is used, the
   * holder can still sign in. A link sent to an address someone else reads must not also lock
   * the real owner out.
   */
  async issue(
    user: ResetTarget,
    options: { requestedById: string | null; ttlMs: number; ipAddress: string },
  ): Promise<{ emailDispatchFailed: boolean; expiresAt: Date }> {
    const raw = randomBytes(RESET_TOKEN_BYTES).toString('hex');
    const expiresAt = new Date(Date.now() + options.ttlMs);
    await withRlsContext(this.prisma, { isSuperAdmin: true }, (tx) =>
      tx.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: this.hash(raw),
          expiresAt,
          requestedById: options.requestedById,
        },
      }),
    );

    let emailDispatchFailed = false;
    try {
      await this.email.sendPasswordResetEmail({
        to: user.email,
        companyId: user.companyId,
        resetUrl: this.resetUrl(raw),
        expiresAt,
        requestedByAdmin: options.requestedById !== null,
      });
    } catch (error) {
      emailDispatchFailed = true;
      this.logger.error(
        `Password reset email failed for ${user.email}. ${
          (error as Error).message
        }`,
      );
    }

    await this.auditLog.recordAuthEvent(
      AuditEntityType.PASSWORD_RESET_REQUESTED,
      {
        accountId: user.id,
        companyId: user.companyId,
        ipAddress: options.ipAddress,
        // The token is never in the audit row, raw or hashed — it would be a second copy of a
        // live credential-setting link.
        changes: {
          outcome: 'sent',
          requestedById: options.requestedById,
          emailDispatchFailed,
        },
      },
    );
    return { emailDispatchFailed, expiresAt };
  }

  /**
   * Whether a link can still be used (029 FR-012). Says *why* not, as the invite check does:
   * "expired, ask again" and "already used" call for different next steps, and the reason is
   * only disclosed to someone already holding a 32-byte token.
   */
  async validate(rawToken: string): Promise<ResetLinkValidation> {
    const token = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      (tx) =>
        tx.passwordResetToken.findUnique({
          where: { tokenHash: this.hash(rawToken) },
          select: {
            userId: true,
            createdAt: true,
            expiresAt: true,
            consumedAt: true,
            user: { select: { status: true } },
          },
        }),
    );
    if (!token) return { valid: false, reason: 'not_found' };
    if (token.consumedAt) return { valid: false, reason: 'consumed' };
    if (token.expiresAt.getTime() <= Date.now()) {
      return { valid: false, reason: 'expired' };
    }
    // Deactivated since the link was sent: it must not become a way back in.
    if (token.user.status !== UserStatus.active) {
      return { valid: false, reason: 'consumed' };
    }
    // A newer link supersedes this one, as a re-sent invite does — so the link in the latest
    // email is the only one that works, which is what the holder will assume anyway.
    const newer = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      (tx) =>
        tx.passwordResetToken.findFirst({
          where: { userId: token.userId, createdAt: { gt: token.createdAt } },
          select: { id: true },
        }),
    );
    return newer ? { valid: false, reason: 'consumed' } : { valid: true };
  }

  /**
   * Redeems a link: sets the password, ends every session, and tells the holder (029 FR-013).
   *
   * Also clears a lockout — proving control of the inbox is a stronger check than the password
   * the lockout protects, and a locked-out user is the person most likely to be here.
   */
  async complete(
    rawToken: string,
    password: string,
    ipAddress: string,
  ): Promise<void> {
    const validation = await this.validate(rawToken);
    if (validation.valid === false) {
      throw new HttpException(
        validation.reason === 'expired'
          ? 'That reset link has expired. Ask for a new one.'
          : 'That reset link has already been used or is no longer valid. Ask for a new one.',
        HTTP_STATUS_GONE,
      );
    }

    const tokenHash = this.hash(rawToken);
    const passwordHash = await this.passwords.hashPassword(password);
    const now = new Date();

    const user = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      async (tx) => {
        // Conditional on still being unconsumed and unexpired, so two submissions of one link
        // cannot both succeed — the re-check `validate()` cannot make atomically.
        const consumed = await tx.passwordResetToken.updateMany({
          where: { tokenHash, consumedAt: null, expiresAt: { gt: now } },
          data: { consumedAt: now },
        });
        if (consumed.count === 0) {
          throw new HttpException(
            'That reset link has already been used.',
            HTTP_STATUS_GONE,
          );
        }
        const { userId } = await tx.passwordResetToken.findUniqueOrThrow({
          where: { tokenHash },
          select: { userId: true },
        });
        // Any other outstanding link for the account dies with this one.
        await tx.passwordResetToken.updateMany({
          where: { userId, consumedAt: null },
          data: { consumedAt: now },
        });
        return tx.user.update({
          where: { id: userId },
          data: {
            password: passwordHash,
            // The holder chose it, so there is nothing left to force.
            mustChangePassword: false,
            consecutiveFailures: 0,
            lockedUntil: null,
          },
          select: { id: true, email: true, companyId: true },
        });
      },
    );

    // Every device, this browser included: whoever reset the password may not be whoever was
    // signed in, and that is the case a reset most often exists for.
    await this.refreshTokens.revokeAllForAccount(user.id);

    await this.auditLog.recordAuthEvent(
      AuditEntityType.PASSWORD_RESET_COMPLETED,
      { accountId: user.id, companyId: user.companyId, ipAddress },
    );

    try {
      await this.email.sendPasswordChangedEmail({
        to: user.email,
        companyId: user.companyId,
        changedAt: now,
        via: 'reset_link',
      });
    } catch (error) {
      // The password is changed either way; a failed notice must not report the reset as failed.
      this.logger.error(
        `Password-changed notice failed for ${user.email}. ${
          (error as Error).message
        }`,
      );
    }
  }
}
