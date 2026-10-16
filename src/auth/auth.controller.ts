import {
  Controller,
  Header,
  HttpCode,
  Post,
  Body,
  Req,
  Res,
  UseGuards,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { ThrottlerGuard, Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Permission } from '@prisma/client';
import { PasswordChangeExempt } from '../common/decorators/password-change-exempt.decorator';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { TokenDto } from './dto/token.dto';
import {
  AdminResetPasswordDto,
  AdminResetPasswordResultDto,
} from './dto/admin-reset-password.dto';
import {
  ForgotPasswordDto,
  ResetPasswordDto,
  ResetTokenDto,
} from './dto/password-reset.dto';
import {
  PasswordResetService,
  ResetLinkValidation,
} from './password-reset.service';
import {
  ConfirmPasswordDto,
  ConfirmPasswordResultDto,
} from './dto/confirm-password.dto';
import { SelfService } from '../common/decorators/route-access.decorator';
import { JwtAuthGuard } from './jwt-auth.guard';
import { AuthenticatedUser } from './authenticated-user';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { UserEntity } from '../common/decorators/user.decorator';
import { ConfigService } from '@nestjs/config';
import { SecurityConfig } from '../common/configs/config.interface';
import { SESSION_COOKIE_MISSING } from './session-error-codes';
import config from '../common/configs/config';

const REFRESH_COOKIE_NAME = 'refreshToken';

/**
 * Forgot Password's own per-address allowance (029 FR-011): lower than sign-in's, because each
 * accepted request can send an email to somebody, and well above what one person retrying needs.
 * The per-account limits in `PasswordResetService` are the other half.
 */
const RESET_REQUEST_THROTTLE = { limit: 5, ttl: 60_000 };

/** Every answer from this controller carries a credential or says something about one. */
const NO_STORE = 'no-store';

/**
 * The renewal endpoint's own rate limit, read at class-definition time.
 *
 * `@Throttle` is a decorator, so its numbers are fixed when this class is defined and
 * `ConfigService` does not exist yet. Read from the same config module `ThrottlerModule`
 * is configured from, so there is one definition of the window and not two that drift.
 */
const REFRESH_THROTTLE = (() => {
  const { ttlSeconds, refreshLimit } = config().security.throttle;
  return { limit: refreshLimit, ttl: ttlSeconds * 1000 };
})();

@ApiTags('auth')
@UseGuards(ThrottlerGuard)
@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly auth: AuthService,
    private readonly configService: ConfigService,
    private readonly passwordReset: PasswordResetService,
  ) {}

  /** The attributes the refresh cookie is set and cleared with; shared so the two
   * cannot drift, because a mismatch leaves the credential in place after a logout
   * (015 FR-011). */
  private refreshCookieOptions() {
    const { sameSite, secure, path } =
      this.configService.get<SecurityConfig>('security').refreshCookie;
    return { httpOnly: true, secure, sameSite, path } as const;
  }

  private setRefreshCookie(res: Response, rawToken: string): void {
    const security = this.configService.get<SecurityConfig>('security');
    const { sessionDays } = security.refreshToken;
    res.cookie(REFRESH_COOKIE_NAME, rawToken, {
      ...this.refreshCookieOptions(),
      // Always set (015 FR-001). It used to be omitted unless "remember me" was
      // ticked, which made the cookie die with the browser — and since 74 of 89
      // sign-ins left that box unticked, most sessions did not survive a restart.
      maxAge: sessionDays * 24 * 60 * 60 * 1000,
    });
  }

  /**
   * The refresh credential, or a refusal that says the cookie never arrived.
   *
   * The refusal is deliberately distinguishable from an expiry. This used to throw a
   * bare `UnauthorizedException`, which the client rendered as "your session expired" —
   * so a cookie the browser was never going to send looked exactly like a session that
   * had legitimately run out, in the UI and in the logs alike. That is how a one-line
   * `REFRESH_COOKIE_PATH` omission survived a full verification pass and then signed
   * everyone out on their first page refresh.
   *
   * The warning names the attributes the cookie is actually issued with, because the
   * mismatch is between those and where the browser is presenting it — which is the one
   * fact nobody can see from either side alone.
   */
  private readRefreshCookie(req: Request): string {
    const token = req.cookies?.[REFRESH_COOKIE_NAME];
    if (!token) {
      const { path, sameSite, secure } = this.refreshCookieOptions();
      this.logger.warn(
        `No "${REFRESH_COOKIE_NAME}" cookie on ${req.method} ${req.originalUrl}. ` +
          `It is issued with Path=${path}; SameSite=${sameSite}; Secure=${secure}. ` +
          `If the frontend proxies this API under a prefix, that Path must match where ` +
          `its renewal request lands — see REFRESH_COOKIE_PATH.`,
      );
      throw new UnauthorizedException({
        statusCode: 401,
        message: 'Your session has ended. Please sign in again.',
        code: SESSION_COOKIE_MISSING,
      });
    }
    return token;
  }

  @Post('login')
  // Never kept by a browser or service-worker HTTP cache (029 FR-050): the body is an access token.
  @Header('Cache-Control', NO_STORE)
  @ApiOkResponse({ type: TokenDto })
  async login(
    // `rememberMe` is accepted by the DTO and deliberately not destructured here:
    // every session lasts the same length now (015 FR-003).
    @Body() { identifier, password }: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TokenDto> {
    const result = await this.auth.login(identifier, password, req.ip);
    this.setRefreshCookie(res, result.rawRefreshToken);
    return {
      accessToken: result.accessToken,
      name: result.name,
      mustChangePassword: result.mustChangePassword,
      homeModule: result.homeModule,
    };
  }

  @Post('refresh-token')
  // Exempt: refusing this would end the session mid-change rather than protect
  // anything (010 FR-017a).
  @PasswordChangeExempt()
  /**
   * Its own, far higher allowance — see `SecurityConfig.throttle.refreshLimit`.
   *
   * The access token is held in memory only, so every full page load spends exactly one
   * call here. Sharing `/auth/login`'s allowance of ten made ten reloads a minute the
   * ceiling on using the product, and the limiter tracks by source address, so one
   * office behind one NAT shares that ten between everybody in it.
   */
  @Throttle({ default: REFRESH_THROTTLE })
  @Header('Cache-Control', NO_STORE)
  @ApiOkResponse({ type: TokenDto })
  async refreshToken(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Pick<TokenDto, 'accessToken'>> {
    const rawToken = this.readRefreshCookie(req);
    const result = await this.auth.refresh(rawToken, req.ip);
    this.setRefreshCookie(res, result.rawRefreshToken);
    return { accessToken: result.accessToken };
  }

  @Post('logout')
  // Exempt: leaving must always be possible (010 FR-017a).
  @PasswordChangeExempt()
  @ApiOkResponse()
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const rawToken = this.readRefreshCookie(req);
    await this.auth.logout(rawToken, req.ip);
    // Cleared through the same helper that sets it, so the two cannot drift. A
    // browser matches a clearing Set-Cookie on name, path and domain, and the path
    // is now configurable — hardcoding `/auth` here would silently stop clearing the
    // cookie the moment the deployment moved it (015 FR-011).
    res.clearCookie(REFRESH_COOKIE_NAME, this.refreshCookieOptions());
  }

  /**
   * Re-enter your own password before a sensitive act (2026-10-14).
   *
   * Returns a ten-minute confirmation scoped to one purpose and one account, which the act's
   * own endpoint then requires in `X-Confirmation-Token` — so hiding the control in the
   * interface is not the only thing standing between a borrowed session and the setting.
   *
   * `@SelfService()`: it acts only on the caller's own credential. Which callers may confirm
   * for which purpose is decided per purpose in `AuthService.confirmPassword`.
   *
   * Rate-limited by the controller's `ThrottlerGuard` at sign-in's allowance (no override),
   * because it is the same guess-a-password surface sign-in is.
   */
  @Post('confirm-password')
  @HttpCode(200)
  @Header('Cache-Control', NO_STORE)
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @SelfService()
  @ApiOkResponse({ type: ConfirmPasswordResultDto })
  async confirmPassword(
    @UserEntity() caller: AuthenticatedUser,
    @Body() { password, purpose }: ConfirmPasswordDto,
    @Req() req: Request,
  ): Promise<ConfirmPasswordResultDto> {
    return this.auth.confirmPassword(caller, password, purpose, req.ip);
  }

  @Post('admin/reset-password')
  @ApiBearerAuth()
  @ApiUnauthorizedResponse()
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(Permission.USER_MANAGEMENT)
  @HttpCode(200)
  // The body may hold a temporary password: no cache anywhere may keep it.
  @Header('Cache-Control', NO_STORE)
  @ApiOkResponse({ type: AdminResetPasswordResultDto })
  async adminResetPassword(
    @UserEntity() caller: AuthenticatedUser,
    @Body()
    { targetAccountId, method, temporaryPassword }: AdminResetPasswordDto,
    @Req() req: Request,
  ): Promise<AdminResetPasswordResultDto & { success: true }> {
    const result = await this.auth.adminResetPassword(
      caller,
      targetAccountId,
      { method, temporaryPassword },
      req.ip,
    );
    // `success` kept for any caller written against the pre-029 response.
    return { success: true, ...result };
  }

  /**
   * Forgot Password (029 FR-010, FR-011). Always 202 with the same body: it must not say
   * whether the address has an account.
   */
  @Post('forgot-password')
  @HttpCode(202)
  @Throttle({ default: RESET_REQUEST_THROTTLE })
  @Header('Cache-Control', NO_STORE)
  @ApiOkResponse()
  async forgotPassword(
    @Body() { identifier }: ForgotPasswordDto,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    await this.passwordReset.requestSelfService(identifier, req.ip);
    return {
      message:
        'If that matches an active account, a link to reset its password is on its way. Check your inbox.',
    };
  }

  /** Whether a reset link still works, so the page can say so before the user types (029 FR-012). */
  @Post('reset-password/validate')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Header('Cache-Control', NO_STORE)
  @ApiOkResponse()
  async validateResetLink(
    @Body() { token }: ResetTokenDto,
  ): Promise<ResetLinkValidation> {
    return this.passwordReset.validate(token);
  }

  /** Sets the new password and signs out every device (029 FR-013). */
  @Post('reset-password')
  @HttpCode(200)
  @Throttle({ default: RESET_REQUEST_THROTTLE })
  @Header('Cache-Control', NO_STORE)
  @ApiOkResponse()
  async resetPassword(
    @Body() { token, password }: ResetPasswordDto,
    @Req() req: Request,
  ): Promise<{ success: true }> {
    await this.passwordReset.complete(token, password, req.ip);
    return { success: true };
  }
}
