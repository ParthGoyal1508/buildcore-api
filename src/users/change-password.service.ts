import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { AuditEntityType } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';
import { AuditLogService } from '../auth/audit-log.service';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { PasswordService } from '../auth/password.service';
import { RefreshTokenService } from '../auth/refresh-token.service';
import { rlsContextFor, withRlsContext } from '../common/prisma/rls-context';
import { EmailService } from '../shared/email/email.service';
import { ChangePasswordDto } from './dto/change-password.dto';

/**
 * A signed-in user changing their own password (001 FR-007, 010 FR-017, 029 FR-005 to FR-008).
 *
 * Its own service rather than a method on `UsersService` because it needs sessions, audit and
 * email, none of which the rest of `UsersService` — an account-data service other modules import
 * — has any business depending on.
 */
@Injectable()
export class ChangePasswordService {
  private readonly logger = new Logger(ChangePasswordService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordService: PasswordService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly auditLog: AuditLogService,
    private readonly email: EmailService,
  ) {}

  async changePassword(
    caller: AuthenticatedUser,
    changePassword: ChangePasswordDto,
    ipAddress: string,
  ): Promise<AuthenticatedUser> {
    const passwordValid = await this.passwordService.validatePassword(
      changePassword.oldPassword,
      caller.password,
    );

    if (!passwordValid) {
      throw new BadRequestException('Invalid password');
    }

    // Reusing the current password is not a change. It matters most for an account
    // created with an admin-set password (010 FR-017): re-entering that value would
    // clear `mustChangePassword` below and leave in force precisely the credential
    // the forced change exists to retire, with the account's own screen having
    // reported success.
    //
    // Compared against the stored hash rather than the submitted `oldPassword`, so
    // it also holds for any other path that reaches here.
    const unchanged = await this.passwordService.validatePassword(
      changePassword.newPassword,
      caller.password,
    );
    if (unchanged) {
      throw new BadRequestException(
        'Your new password must be different from your current one.',
      );
    }

    const hashedPassword = await this.passwordService.hashPassword(
      changePassword.newPassword,
    );

    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.user.update({
          data: {
            password: hashedPassword,
            // Cleared in the same write as the hash (010 FR-017b). Two writes
            // could leave an account that has changed its password and is still
            // refused everything; left set entirely, the user is redirected on
            // every login with no way out.
            mustChangePassword: false,
          },
          where: { id: caller.id },
        }),
    );

    // Every other signed-in device is signed out; this one stays (029 FR-006). Changing a
    // password because it may be known to someone else achieves nothing while their session
    // lives on. A token from before 029 carries no session id, and then every session goes —
    // including this one, which simply signs in again: the safe direction to be wrong in.
    await this.refreshTokens.revokeAllForAccount(caller.id, caller.sessionId);

    await this.auditLog.recordAuthEvent(AuditEntityType.PASSWORD_CHANGED, {
      accountId: caller.id,
      companyId: caller.companyId,
      ipAddress,
      changes: { otherSessionsSignedOut: true },
    });

    try {
      await this.email.sendPasswordChangedEmail({
        to: caller.email,
        changedAt: updated.updatedAt,
        via: 'self',
      });
    } catch (error) {
      // The change has happened; a failed notice must not report it as failed.
      this.logger.error(
        `Password-changed notice failed for ${caller.email}. ${
          (error as Error).message
        }`,
      );
    }

    return {
      ...updated,
      permissions: caller.permissions,
      grants: caller.grants,
      roleNames: caller.roleNames,
      roleIds: caller.roleIds,
      homeModule: caller.homeModule,
    };
  }
}
