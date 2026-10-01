import { Strategy, ExtractJwt } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { JwtDto } from './dto/jwt.dto';
import { AuthenticatedUser } from './authenticated-user';
import { SecurityConfig } from '../common/configs/config.interface';
import { CompanySelectionService } from '../settings/company-selection/company-selection.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly authService: AuthService,
    // 019 FR-008: resolved once per request here rather than in every service that scopes by
    // company — see `validate` below.
    private readonly companySelection: CompanySelectionService,
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

    // 019 FR-008, FR-010. Resolved here, once, so every `rlsContextFor(caller)` and
    // `resolveCompanyId(caller, ...)` in the codebase respects the selection without any of
    // them changing. Doing it per-service would mean every one of them had to remember.
    //
    // Re-validated on every request rather than trusted because it is stored: the spec's own
    // edge case is cross-company access being revoked while the other company is selected, and
    // a stored selection honoured at read time is how that becomes a cross-tenant read.
    user.selectedCompanyId = await this.companySelection.resolve(user);
    return user;
  }
}
