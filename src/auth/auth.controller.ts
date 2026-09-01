import {
  Controller,
  Post,
  Body,
  Req,
  Res,
  UseGuards,
  UnauthorizedException,
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

const REFRESH_COOKIE_NAME = 'refreshToken';

@ApiTags('auth')
@UseGuards(ThrottlerGuard)
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly configService: ConfigService,
  ) {}

  private setRefreshCookie(
    res: Response,
    rawToken: string,
    rememberMe: boolean,
  ): void {
    const security = this.configService.get<SecurityConfig>('security');
    const { rememberMeDays } = security.refreshToken;
    const { sameSite, secure } = security.refreshCookie;
    res.cookie(REFRESH_COOKIE_NAME, rawToken, {
      httpOnly: true,
      // Both from config: in production the frontend and API sit on different
      // registrable domains, where a 'strict' cookie is never sent at all — see
      // SecurityConfig.refreshCookie. `secure` stays true everywhere (FR-019);
      // browsers exempt localhost from its HTTPS requirement.
      secure,
      sameSite,
      path: '/auth',
      // Omitting maxAge makes it a session cookie (cleared on browser close) when
      // "remember me" wasn't checked (FR-006).
      ...(rememberMe ? { maxAge: rememberMeDays * 24 * 60 * 60 * 1000 } : {}),
    });
  }

  private readRefreshCookie(req: Request): string {
    const token = req.cookies?.[REFRESH_COOKIE_NAME];
    if (!token) {
      throw new UnauthorizedException();
    }
    return token;
  }

  @Post('login')
  @ApiOkResponse({ type: TokenDto })
  async login(
    @Body() { identifier, password, rememberMe }: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TokenDto> {
    const result = await this.auth.login(
      identifier,
      password,
      rememberMe,
      req.ip,
    );
    this.setRefreshCookie(res, result.rawRefreshToken, result.rememberMe);
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
    this.setRefreshCookie(res, result.rawRefreshToken, result.rememberMe);
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
    // Must repeat the same sameSite/secure attributes used when setting it: a
    // cross-site response carrying a Set-Cookie without `SameSite=None; Secure`
    // is rejected outright, which would leave the cookie in place after logout.
    const { sameSite, secure } =
      this.configService.get<SecurityConfig>('security').refreshCookie;
    res.clearCookie(REFRESH_COOKIE_NAME, {
      path: '/auth',
      httpOnly: true,
      secure,
      sameSite,
    });
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
