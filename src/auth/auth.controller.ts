import {
  Controller,
  Post,
  Body,
  Req,
  Res,
  UseGuards,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
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
import { AdminResetPasswordDto } from './dto/admin-reset-password.dto';
import { JwtAuthGuard } from './jwt-auth.guard';
import { AuthenticatedUser } from './authenticated-user';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { UserEntity } from '../common/decorators/user.decorator';
import { ConfigService } from '@nestjs/config';
import { SecurityConfig } from '../common/configs/config.interface';
import { SESSION_COOKIE_MISSING } from './session-error-codes';

const REFRESH_COOKIE_NAME = 'refreshToken';

@ApiTags('auth')
@UseGuards(ThrottlerGuard)
@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly auth: AuthService,
    private readonly configService: ConfigService,
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
    };
  }

  @Post('refresh-token')
  // Exempt: refusing this would end the session mid-change rather than protect
  // anything (010 FR-017a).
  @PasswordChangeExempt()
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
    await this.auth.logout(rawToken);
    // Cleared through the same helper that sets it, so the two cannot drift. A
    // browser matches a clearing Set-Cookie on name, path and domain, and the path
    // is now configurable — hardcoding `/auth` here would silently stop clearing the
    // cookie the moment the deployment moved it (015 FR-011).
    res.clearCookie(REFRESH_COOKIE_NAME, this.refreshCookieOptions());
  }

  @Post('admin/reset-password')
  @ApiBearerAuth()
  @ApiUnauthorizedResponse()
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(Permission.USER_MANAGEMENT)
  @ApiOkResponse()
  async adminResetPassword(
    @UserEntity() caller: AuthenticatedUser,
    @Body() { targetAccountId, temporaryPassword }: AdminResetPasswordDto,
    @Req() req: Request,
  ): Promise<{ success: true }> {
    await this.auth.adminResetPassword(
      caller,
      targetAccountId,
      temporaryPassword,
      req.ip,
    );
    return { success: true };
  }
}
