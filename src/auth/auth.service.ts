import { PrismaService } from 'nestjs-prisma';
import { AuditEntityType, Permission, User } from '@prisma/client';
import {
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PasswordService } from './password.service';
import { RefreshTokenService } from './refresh-token.service';
import { AuditLogService } from './audit-log.service';
import { MailService } from './mail.service';
import { TokenDto } from './dto/token.dto';
import { JwtDto } from './dto/jwt.dto';
import { ConfigService } from '@nestjs/config';
import { SecurityConfig } from '../common/configs/config.interface';
import { rlsContextFor, withRlsContext } from '../common/prisma/rls-context';
import { AuthenticatedUser, toAuthenticatedUser } from './authenticated-user';

const GENERIC_INVALID_CREDENTIALS = 'Invalid email or password';

export interface LoginSuccess extends TokenDto {
  rawRefreshToken: string;
  rememberMe: boolean;
}

export interface RefreshSuccess {
  accessToken: string;
  rawRefreshToken: string;
  rememberMe: boolean;
}

function displayName(
  user: Pick<User, 'firstname' | 'lastname' | 'username'>,
): string {
  const full = [user.firstname, user.lastname].filter(Boolean).join(' ').trim();
  return full || user.username;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
    private readonly passwordService: PasswordService,
    private readonly configService: ConfigService,
    private readonly refreshTokenService: RefreshTokenService,
    private readonly auditLogService: AuditLogService,
    private readonly mailService: MailService,
  ) {}

  private accessTokenFor(user: AuthenticatedUser): string {
    const payload: Omit<JwtDto, 'iat' | 'exp'> = {
      userId: user.id,
      permissions: user.permissions,
      companyId: user.companyId,
      mustChangePassword: user.mustChangePassword,
      name: displayName(user),
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
    rememberMe: boolean,
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

    const { rawToken } = await this.refreshTokenService.issueFamily({
      accountId: user.id,
      companyId: user.companyId,
      rememberMe,
    });

    await this.auditLogService.recordAuthEvent(AuditEntityType.LOGIN_SUCCESS, {
      accountId: user.id,
      companyId: user.companyId,
      ipAddress,
    });

    return {
      accessToken: this.accessTokenFor(user),
      rawRefreshToken: rawToken,
      rememberMe,
      name: displayName(user),
      mustChangePassword: user.mustChangePassword,
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
      await this.mailService.sendAccountLockedEmail(user.email, lockedUntil);
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

    if (result.outcome === 'invalid') {
      throw new UnauthorizedException();
    }

    if (result.outcome === 'reuse') {
      await this.auditLogService.recordAuthEvent(
        AuditEntityType.REFRESH_REUSE_DETECTED,
        {
          accountId: result.accountId,
          ipAddress,
        },
      );
      throw new ForbiddenException();
    }

    const user = await this.loadUserWithPermissions(result.accountId);
    if (!user || user.status !== 'active') {
      throw new UnauthorizedException();
    }

    return {
      accessToken: this.accessTokenFor(user),
      rawRefreshToken: result.rawToken,
      rememberMe: result.rememberMe,
    };
  }

  async logout(rawToken: string): Promise<void> {
    await this.refreshTokenService.revokeFamilyByToken(rawToken);
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
          include: { userRoles: { include: { role: true } } },
        }),
    );
    return user ? toAuthenticatedUser(user) : null;
  }

  /**
   * Admin-only: sets a target account's password to a temporary value and forces a
   * change on next login (FR-022). Restricted to the caller's own company unless
   * the caller holds CROSS_COMPANY_ACCESS (FR-022a) — enforced both here
   * (service-layer check) and by RLS (the update runs under the caller's own
   * context, so a cross-company target simply isn't visible to update,
   * defense-in-depth against a bug in this check).
   */
  async adminResetPassword(
    caller: AuthenticatedUser,
    targetAccountId: string,
    temporaryPassword: string,
    ipAddress: string,
  ): Promise<void> {
    const target = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) => tx.user.findUnique({ where: { id: targetAccountId } }),
    );

    if (!target) {
      throw new NotFoundException();
    }
    if (
      !caller.permissions.includes(Permission.CROSS_COMPANY_ACCESS) &&
      target.companyId !== caller.companyId
    ) {
      throw new ForbiddenException();
    }

    const hashed = await this.passwordService.hashPassword(temporaryPassword);

    await withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
      tx.user.update({
        where: { id: target.id },
        data: {
          password: hashed,
          mustChangePassword: true,
          // An admin resetting a locked-out account's password is the
          // account's way back in — leaving the lockout in place would make
          // the reset useless for its most common real case.
          consecutiveFailures: 0,
          lockedUntil: null,
        },
      }),
    );

    await this.refreshTokenService.revokeAllForAccount(target.id);

    await this.auditLogService.recordAuthEvent(
      AuditEntityType.ADMIN_PASSWORD_RESET,
      {
        accountId: target.id,
        companyId: target.companyId,
        ipAddress,
      },
    );
  }
}
