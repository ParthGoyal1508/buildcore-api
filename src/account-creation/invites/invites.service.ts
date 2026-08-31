import { HttpException, Injectable } from '@nestjs/common';
import { AuditAction, AuditEntityType, UserStatus } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';
import { AuditLogService } from '../../auth/audit-log.service';
import { PasswordService } from '../../auth/password.service';
import { withRlsContext } from '../../common/prisma/rls-context';
import { TokenService } from './token.service';

/** HTTP 410 Gone — the contract's status for a spent or expired invite. Spelled out
 * because Nest's HttpStatus has no member for it and a bare 410 reads as a magic
 * number. */
const HTTP_STATUS_GONE = 410;

export type InviteInvalidReason = 'expired' | 'consumed' | 'not_found';

export type InviteValidation =
  | { valid: true; email: string }
  | { valid: false; reason: InviteInvalidReason };

@Injectable()
export class InvitesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly passwords: PasswordService,
    private readonly auditLog: AuditLogService,
  ) {}

  /**
   * Looks a raw token up by hash and reports whether it is usable.
   *
   * Runs under the system context, like login's own lookup: the caller is
   * unauthenticated by design, and the row is identified by a value only the real
   * recipient could hold rather than by any company-scoped filter.
   *
   * Reports *why* an invite is unusable, which is a deliberate disclosure. The
   * alternative — one flat "invalid" — leaves someone whose link expired unable to
   * tell that from a mistyped URL, and the information is only meaningful to
   * whoever already holds a 32-byte token.
   */
  async validate(rawToken: string): Promise<InviteValidation> {
    const tokenHash = this.tokens.hash(rawToken);
    const invite = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      (tx) =>
        tx.inviteToken.findUnique({
          where: { tokenHash },
          select: {
            id: true,
            userId: true,
            expiresAt: true,
            consumedAt: true,
            createdAt: true,
            user: { select: { email: true, status: true } },
          },
        }),
    );

    if (!invite) {
      return { valid: false, reason: 'not_found' };
    }
    if (invite.consumedAt) {
      return { valid: false, reason: 'consumed' };
    }
    if (invite.expiresAt.getTime() <= Date.now()) {
      return { valid: false, reason: 'expired' };
    }
    // A resend supersedes earlier invites without deleting them (FR-014). "Current"
    // is therefore derived — newest row wins — rather than stored in a flag that
    // could disagree with the rows themselves.
    const isSuperseded = await this.isSuperseded(
      invite.userId,
      invite.createdAt,
    );
    if (isSuperseded) {
      return { valid: false, reason: 'consumed' };
    }
    // An account that already activated has nothing left to set.
    if (invite.user.status !== UserStatus.pending) {
      return { valid: false, reason: 'consumed' };
    }

    return { valid: true, email: invite.user.email };
  }

  private async isSuperseded(
    userId: string,
    createdAt: Date,
  ): Promise<boolean> {
    const newer = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      (tx) =>
        tx.inviteToken.findFirst({
          where: { userId, createdAt: { gt: createdAt } },
          select: { id: true },
        }),
    );
    return Boolean(newer);
  }

  /**
   * Consumes an invite and activates the account.
   *
   * Re-validates inside the transaction rather than trusting the caller's earlier
   * `validate()` — between the two requests the invite may have been superseded by a
   * resend or already spent, and only the write path can settle that atomically.
   */
  async setPassword(
    rawToken: string,
    password: string,
    ipAddress = 'unknown',
  ): Promise<void> {
    const validation = await this.validate(rawToken);
    if (validation.valid === false) {
      throw new HttpException(
        validation.reason === 'expired'
          ? 'That invite link has expired. Ask an administrator to resend it.'
          : 'That invite link has already been used or is no longer valid.',
        HTTP_STATUS_GONE,
      );
    }

    const tokenHash = this.tokens.hash(rawToken);
    const passwordHash = await this.passwords.hashPassword(password);
    let activatedUserId = '';

    await withRlsContext(this.prisma, { isSuperAdmin: true }, async (tx) => {
      // Conditional update: `consumedAt: null` in the where clause means two
      // simultaneous submissions of the same link cannot both succeed — the second
      // matches zero rows rather than silently resetting the password again.
      const consumed = await tx.inviteToken.updateMany({
        where: { tokenHash, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      if (consumed.count === 0) {
        throw new HttpException(
          'That invite link has already been used.',
          HTTP_STATUS_GONE,
        );
      }

      const invite = await tx.inviteToken.findUnique({
        where: { tokenHash },
        select: { userId: true },
      });
      await tx.user.update({
        where: { id: invite.userId },
        data: {
          password: passwordHash,
          status: UserStatus.active,
          // The invitee chose this password themselves, so unlike an admin reset
          // there is nothing to force them to change on first login.
          mustChangePassword: false,
          consecutiveFailures: 0,
          lockedUntil: null,
        },
      });
      activatedUserId = invite.userId;
    });

    // FR-014's third audited event. Activation is the moment an invite becomes a
    // usable credential, so it is the one of the three most worth being able to
    // find in the Activity Log later. Attributed to the account itself: nobody else
    // performed this, and the invitee has no session yet.
    const activated = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      (tx) =>
        tx.user.findUnique({
          where: { id: activatedUserId },
          select: { companyId: true },
        }),
    );
    await this.auditLog.record({
      entityType: AuditEntityType.USER_ACCOUNT,
      action: AuditAction.UPDATE,
      entityId: activatedUserId,
      // No token, raw or hashed — an audit row must not carry a credential.
      changes: { activatedViaInvite: true },
      accountId: activatedUserId,
      companyId: activated?.companyId ?? null,
      ipAddress,
    });
  }
}
