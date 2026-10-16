import { PrismaService } from 'nestjs-prisma';
import {
  AccessLevel,
  AuditAction,
  AuditEntityType,
  CredentialOrigin,
  Permission,
  User,
} from '@prisma/client';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PasswordService } from './password.service';
import { RefreshTokenService } from './refresh-token.service';
import { AuditLogService } from './audit-log.service';
import { EmailService } from '../shared/email/email.service';
import { TokenDto } from './dto/token.dto';
import { JwtDto } from './dto/jwt.dto';
import { ConfigService } from '@nestjs/config';
import { SecurityConfig } from '../common/configs/config.interface';
import { rlsContextFor, withRlsContext } from '../common/prisma/rls-context';
import { AuthenticatedUser, toAuthenticatedUser } from './authenticated-user';
import { SESSION_EXPIRED, SESSION_REVOKED } from './session-error-codes';
import {
  ConfirmationPurpose,
  PasswordConfirmationService,
} from './password-confirmation.service';
import { PasswordResetService } from './password-reset.service';
import { assertMayGrant } from '../settings/roles/grant-ceiling';
import { generateTemporaryPassword } from './password-policy';
import {
  AdminResetMethod,
  AdminResetPasswordResultDto,
} from './dto/admin-reset-password.dto';

const GENERIC_INVALID_CREDENTIALS = 'Invalid email or password';

export interface LoginSuccess extends TokenDto {
  rawRefreshToken: string;
}

export interface RefreshSuccess {
  accessToken: string;
  rawRefreshToken: string;
}

function displayName(
  user: Pick<User, 'firstname' | 'lastname' | 'username'>,
): string {
  const full = [user.firstname, user.lastname].filter(Boolean).join(' ').trim();
  return full || user.username;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
    private readonly passwordService: PasswordService,
    private readonly configService: ConfigService,
    private readonly refreshTokenService: RefreshTokenService,
    private readonly auditLogService: AuditLogService,
    private readonly emailService: EmailService,
    private readonly passwordConfirmation: PasswordConfirmationService,
    private readonly passwordReset: PasswordResetService,
  ) {}

  /** `sessionId` is the refresh-token family the token is minted for (029 FR-006). */
  private accessTokenFor(user: AuthenticatedUser, sessionId: string): string {
    const payload: Omit<JwtDto, 'iat' | 'exp'> = {
      userId: user.id,
      permissions: user.permissions,
      companyId: user.companyId,
      mustChangePassword: user.mustChangePassword,
      name: displayName(user),
      sid: sessionId,
    };
    return this.jwtService.sign(payload);
  }

  /**
   * Looked up by identifier before any credential check — there's no company
   * context to scope by yet, so this runs as system/bypass (rls-context.ts).
   */
  private async findByIdentifier(
    identifier: string,
  ): Promise<AuthenticatedUser | null> {
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
          include: { userRoles: { include: { role: true } } },
        }),
    );
    return user ? toAuthenticatedUser(user) : null;
  }

  async login(
    identifier: string,
    password: string,
    ipAddress: string,
  ): Promise<LoginSuccess> {
    const { maxAttempts, durationMinutes } =
      this.configService.get<SecurityConfig>('security').lockout;

    const user = await this.findByIdentifier(identifier);

    if (!user) {
      await this.auditLogService.recordAuthEvent(
        AuditEntityType.LOGIN_FAILURE,
        {
          attemptedEmail: identifier,
          ipAddress,
        },
      );
      throw new UnauthorizedException(GENERIC_INVALID_CREDENTIALS);
    }

    // Locked accounts are rejected before any credential check, regardless of
    // password correctness (FR-014).
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new HttpException(
        {
          message: `Account temporarily locked. Try again after ${user.lockedUntil.toISOString()}.`,
        },
        423,
      );
    }

    const passwordValid = await this.passwordService.validatePassword(
      password,
      user.password,
    );

    if (!passwordValid || user.status !== 'active') {
      // Only a wrong password against an otherwise-active account counts toward
      // the brute-force counter — a deactivated account is already rejected
      // structurally and doesn't need lockout on top of that (spec FR-012's
      // brute-force-protection intent doesn't extend to an account that can't
      // succeed regardless).
      if (!passwordValid && user.status === 'active') {
        await this.registerFailedAttempt(user, maxAttempts, durationMinutes);
      }
      await this.auditLogService.recordAuthEvent(
        AuditEntityType.LOGIN_FAILURE,
        {
          accountId: user.id,
          companyId: user.companyId,
          ipAddress,
        },
      );
      throw new UnauthorizedException(GENERIC_INVALID_CREDENTIALS);
    }

    // System context, not the caller's own company scope: this is the server's own
    // post-authentication bookkeeping on a row it has just identified by verified
    // credentials — one of the lookups rls-context.ts calls out as legitimately
    // running with the bypass. Under the caller's scope it silently matches no row
    // for an account with no companyId (and no CROSS_COMPANY_ACCESS), which makes
    // login fail outright wherever RLS is actually enforced.
    await withRlsContext(this.prisma, { isSuperAdmin: true }, (tx) =>
      tx.user.update({
        where: { id: user.id },
        data: {
          consecutiveFailures: 0,
          // Stamped on every successful authentication (002 FR-017); surfaced by
          // the Settings Users list (FR-013).
          lastLoginAt: new Date(),
        },
      }),
    );

    const { rawToken, familyId } = await this.refreshTokenService.issueFamily({
      accountId: user.id,
      companyId: user.companyId,
    });

    await this.auditLogService.recordAuthEvent(AuditEntityType.LOGIN_SUCCESS, {
      accountId: user.id,
      companyId: user.companyId,
      ipAddress,
    });

    return {
      accessToken: this.accessTokenFor(user, familyId),
      rawRefreshToken: rawToken,
      name: displayName(user),
      mustChangePassword: user.mustChangePassword,
      homeModule: user.homeModule,
    };
  }

  private async registerFailedAttempt(
    user: AuthenticatedUser,
    maxAttempts: number,
    durationMinutes: number,
  ): Promise<void> {
    const consecutiveFailures = user.consecutiveFailures + 1;
    const justLocked = consecutiveFailures >= maxAttempts;
    const lockedUntil = justLocked
      ? new Date(Date.now() + durationMinutes * 60 * 1000)
      : null;

    await withRlsContext(this.prisma, rlsContextFor(user), (tx) =>
      tx.user.update({
        where: { id: user.id },
        data: { consecutiveFailures, lockedUntil },
      }),
    );

    if (justLocked) {
      await this.emailService.sendAccountLockedEmail({
        to: user.email,
        unlockAt: lockedUntil,
      });
      await this.auditLogService.recordAuthEvent(
        AuditEntityType.ACCOUNT_LOCKED,
        {
          accountId: user.id,
          companyId: user.companyId,
          ipAddress: '',
        },
      );
    }
  }

  async refresh(rawToken: string, ipAddress: string): Promise<RefreshSuccess> {
    const result = await this.refreshTokenService.rotate(rawToken);

    // Both refusals are 401 and carry a machine-readable code, so the client can say
    // "your session expired" rather than showing a bare sign-in form (015 FR-008). The
    // code, never the message — the distinction `ApiError.code` and
    // PASSWORD_CHANGE_REQUIRED already established.
    if (result.outcome === 'invalid') {
      throw new UnauthorizedException({
        statusCode: 401,
        message: 'Your session has expired. Please sign in again.',
        code: SESSION_EXPIRED,
      });
    }

    if (result.outcome === 'reuse') {
      await this.auditLogService.recordAuthEvent(
        AuditEntityType.REFRESH_REUSE_DETECTED,
        {
          accountId: result.accountId,
          ipAddress,
          // Recorded so a genuine theft signal can be told from another false positive
          // afterwards (015 FR-007). The previous 5-second window destroyed five live
          // sessions without leaving anything to distinguish them by. `lateBySeconds`
          // is the discriminator: a few seconds past the window is a slow client, while
          // hours past it is a credential someone kept.
          changes: {
            familyId: result.familyId,
            lateBySeconds: result.lateBySeconds,
          },
        },
      );
      // 401, not the previous 403: a destroyed session means "present credentials
      // again", which is what 401 says. 403 means "authenticated but not permitted",
      // which this is not — and the client's 401 handler is what signs the user out.
      throw new UnauthorizedException({
        statusCode: 401,
        message:
          'Your session was ended for security reasons. Please sign in again.',
        code: SESSION_REVOKED,
      });
    }

    const user = await this.loadUserWithPermissions(result.accountId);
    if (!user || user.status !== 'active') {
      throw new UnauthorizedException();
    }

    return {
      accessToken: this.accessTokenFor(user, result.familyId),
      rawRefreshToken: result.rawToken,
    };
  }

  async logout(rawToken: string, ipAddress = 'unknown'): Promise<void> {
    const session = await this.refreshTokenService.revokeFamilyByToken(
      rawToken,
    );
    // `LOGOUT` was in the audit vocabulary from feature 001 and never written (029 FR-040).
    if (session) {
      await this.auditLogService.recordAuthEvent(AuditEntityType.LOGOUT, {
        accountId: session.accountId,
        companyId: session.companyId,
        ipAddress,
      });
    }
  }

  /**
   * Looked up by id from the server's own signed JWT claim — nothing for a caller
   * to forge here, so this runs as system/bypass (rls-context.ts). Used by
   * jwt.strategy.ts's per-request re-validation (FR-009) and by refresh().
   */
  async loadUserWithPermissions(
    userId: string,
  ): Promise<AuthenticatedUser | null> {
    const user = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      (tx) =>
        tx.user.findUnique({
          where: { id: userId },
          // `rolePermissions` rides along in a query that already runs on every request
          // (jwt.strategy.ts re-validates rather than trusting the token's claims), so
          // 019's level model costs no extra round trip — which is what settles T019's
          // "resolve at token issue or per request?" without a measurement.
          include: {
            userRoles: {
              include: { role: { include: { rolePermissions: true } } },
            },
          },
        }),
    );
    return user ? toAuthenticatedUser(user) : null;
  }

  /**
   * Re-checks the signed-in caller's own password before a sensitive act and returns a
   * short-lived confirmation for it (2026-10-14 — "To reveal it, the Super Admin must enter
   * their own password in Settings").
   *
   * **The same brute-force rules as sign-in.** A session left open on a shared machine is
   * exactly the attacker this exists to stop, so a wrong password here counts toward the same
   * lockout counter `login()` keeps — otherwise this endpoint would be a password-guessing
   * channel that never locks. A locked account is refused before the password is looked at,
   * as at sign-in. The controller adds the per-address rate limit sign-in already has.
   *
   * **Every attempt is audited.** A refusal is recorded as a `LOGIN_FAILURE`, so it surfaces
   * wherever failed sign-ins are already watched; a success as a read of the caller's own
   * account, with the purpose it was spent on.
   *
   * **403, never 401**, for every refusal — see `PasswordConfirmationService` for why a 401
   * would sign the user out.
   */
  async confirmPassword(
    caller: AuthenticatedUser,
    password: string,
    purpose: ConfirmationPurpose,
    ipAddress: string,
  ): Promise<{ confirmationToken: string; expiresAt: string }> {
    const required = this.passwordConfirmation.requiredPermission(purpose);
    if (!required || !caller.permissions.includes(required)) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'CONFIRMATION_NOT_PERMITTED',
        message:
          'Your role does not include the setting this confirmation is for.',
      });
    }

    if (caller.lockedUntil && caller.lockedUntil > new Date()) {
      throw new HttpException(
        {
          message: `Account temporarily locked. Try again after ${caller.lockedUntil.toISOString()}.`,
        },
        423,
      );
    }

    const valid = await this.passwordService.validatePassword(
      password,
      caller.password,
    );
    if (!valid) {
      const { maxAttempts, durationMinutes } =
        this.configService.get<SecurityConfig>('security').lockout;
      await this.registerFailedAttempt(caller, maxAttempts, durationMinutes);
      await this.auditLogService.recordAuthEvent(
        AuditEntityType.LOGIN_FAILURE,
        {
          accountId: caller.id,
          companyId: caller.companyId,
          ipAddress,
          changes: { event: 'password_confirmation_failed', purpose },
        },
      );
      throw new ForbiddenException({
        statusCode: 403,
        code: 'PASSWORD_INCORRECT',
        message: 'That password is not correct.',
      });
    }

    if (caller.consecutiveFailures > 0) {
      // A correct password clears the count, exactly as a successful sign-in does — or a few
      // typos spread over a week would lock somebody out on their next honest slip.
      await withRlsContext(this.prisma, { isSuperAdmin: true }, (tx) =>
        tx.user.update({
          where: { id: caller.id },
          data: { consecutiveFailures: 0 },
        }),
      );
    }

    await this.auditLogService.record({
      entityType: AuditEntityType.USER_ACCOUNT,
      action: AuditAction.READ,
      entityId: caller.id,
      accountId: caller.id,
      companyId: caller.companyId,
      ipAddress,
      changes: { event: 'password_confirmed', purpose },
    });

    return this.passwordConfirmation.issue(caller.id, purpose);
  }

  /**
   * Admin-only: gets a user back into their account (FR-022, 029 FR-014 to FR-016).
   *
   * Two ways, chosen by `method` — see `AdminResetPasswordDto`. Restricted to the caller's own
   * company unless they hold CROSS_COMPANY_ACCESS (FR-022a), enforced here and again by RLS (the
   * read runs under the caller's own context, so a cross-company target is simply not found).
   *
   * **Nobody resets the password of an account that holds more than they do** (029 FR-017). A
   * temporary password is a working credential the admin knows; for an account above them it is
   * a way to become that account. A link is safer — it goes to the holder's inbox — but the same
   * rule keeps one answer for "may I act on this account's sign-in", rather than two.
   */
  async adminResetPassword(
    caller: AuthenticatedUser,
    targetAccountId: string,
    options: { method?: AdminResetMethod; temporaryPassword?: string },
    ipAddress: string,
  ): Promise<AdminResetPasswordResultDto> {
    const found = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.user.findUnique({
          where: { id: targetAccountId },
          include: {
            userRoles: {
              include: { role: { include: { rolePermissions: true } } },
            },
          },
        }),
    );

    if (!found) {
      throw new NotFoundException();
    }
    const target = toAuthenticatedUser(found);
    if (
      !caller.permissions.includes(Permission.CROSS_COMPANY_ACCESS) &&
      target.companyId !== caller.companyId
    ) {
      throw new ForbiddenException();
    }
    if (target.id === caller.id) {
      throw new BadRequestException(
        'Use Change password to change your own password.',
      );
    }
    if (target.status === 'pending') {
      throw new ConflictException(
        'That account has not accepted its invite yet, so it has no password to reset. Resend the invite instead.',
      );
    }
    if (target.status === 'deactivated') {
      throw new ConflictException(
        'That account is deactivated. Reactivate it before resetting its password.',
      );
    }
    // The same ceiling as giving someone a role (`grant-ceiling.ts`), so "may I act on this
    // account" has one answer. A legacy-array area with no level rows counts at both levels, as
    // `roleGrants` reads it.
    const levelled = new Set(target.grants.map((grant) => grant.permission));
    assertMayGrant(
      caller,
      [
        ...target.grants,
        ...target.permissions
          .filter((permission) => !levelled.has(permission))
          .flatMap((permission) => [
            { permission, level: AccessLevel.read },
            { permission, level: AccessLevel.write },
          ]),
      ],
      "reset this account's password",
    );

    const method: AdminResetMethod =
      options.method ??
      (options.temporaryPassword ? 'temporary_password' : 'link');

    if (method === 'link') {
      if (options.temporaryPassword) {
        throw new BadRequestException(
          'A temporary password is only used with method "temporary_password".',
        );
      }
      const { emailDispatchFailed } = await this.passwordReset.issue(target, {
        requestedById: caller.id,
        ttlMs:
          this.configService.get<SecurityConfig>('security').passwordReset
            .adminTtlHours * 3_600_000,
        ipAddress,
      });
      await this.auditLogService.recordAuthEvent(
        AuditEntityType.ADMIN_PASSWORD_RESET,
        {
          accountId: target.id,
          companyId: target.companyId,
          ipAddress,
          changes: { method, byAccountId: caller.id, emailDispatchFailed },
        },
      );
      return { method, emailDispatchFailed };
    }

    const generated = options.temporaryPassword === undefined;
    const temporaryPassword =
      options.temporaryPassword ?? generateTemporaryPassword();
    const hashed = await this.passwordService.hashPassword(temporaryPassword);

    await withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
      tx.user.update({
        where: { id: target.id },
        data: {
          password: hashed,
          mustChangePassword: true,
          // The forced-change refusal applies to this origin since 029 FR-016: the admin
          // knows this value, which is the whole reason the change is forced.
          credentialOrigin: CredentialOrigin.admin_reset,
          // An admin resetting a locked-out account's password is the
          // account's way back in — leaving the lockout in place would make
          // the reset useless for its most common real case.
          consecutiveFailures: 0,
          lockedUntil: null,
        },
      }),
    );

    await this.refreshTokenService.revokeAllForAccount(target.id);

    let emailDispatchFailed = false;
    try {
      await this.emailService.sendAdminPasswordResetEmail({ to: target.email });
    } catch (error) {
      emailDispatchFailed = true;
      this.logger.error(
        `Admin-reset notice failed for ${target.email}. ${
          (error as Error).message
        }`,
      );
    }

    await this.auditLogService.recordAuthEvent(
      AuditEntityType.ADMIN_PASSWORD_RESET,
      {
        accountId: target.id,
        companyId: target.companyId,
        ipAddress,
        // Who, how, and whether the server chose it — never the value, in any form.
        changes: {
          method,
          generated,
          byAccountId: caller.id,
          emailDispatchFailed,
        },
      },
    );

    return {
      method,
      // Only a value the admin has not already seen. One they typed, they know.
      ...(generated ? { temporaryPassword } : {}),
      emailDispatchFailed,
    };
  }
}
