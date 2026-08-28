import { Strategy, ExtractJwt } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { JwtDto } from './dto/jwt.dto';
import { AuthenticatedUser } from './authenticated-user';
import { SecurityConfig } from '../common/configs/config.interface';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly authService: AuthService,
    readonly configService: ConfigService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey:
        configService.get<SecurityConfig>('security').jwtAccessSecret,
    });
  }

  /**
   * Re-validates the account's current status and effective permissions on every
   * request (FR-009) — a still-unexpired access token is not trusted on its own.
   * An account that's been deactivated MUST be rejected even though the token
   * itself hasn't expired. Permissions are always re-loaded fresh from the DB
   * (not read from the token's own claims) since a role's permissions, or which
   * roles this account holds, can change at any time.
   */
  async validate(payload: JwtDto): Promise<AuthenticatedUser> {
    const user = await this.authService.loadUserWithPermissions(payload.userId);
    if (!user || user.status !== 'active') {
      throw new UnauthorizedException();
    }
    return user;
  }
}
