import { createHmac } from 'node:crypto';

import { ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Permission } from '@prisma/client';

import { SecurityConfig } from '../common/configs/config.interface';

/**
 * What a password confirmation may be spent on (2026-10-14).
 *
 * A closed list rather than a free string, so a token minted for one sensitive act cannot be
 * presented to another: the purpose is signed into the token and checked by name where it is
 * spent. Each purpose also names the permission the caller must hold to be issued one at all —
 * there is no point proving your password for an act you could not perform anyway, and refusing
 * up front keeps the endpoint from being a general-purpose "is this my password?" oracle.
 */
export const CONFIRMATION_PURPOSES = {
  /**
   * Revealing and changing the company's cash visibility setting. Super Admin only — the
   * client's words were "a sensitive permission ... only Super Admins should be able to reach
   * it" — and Super Admin is `CROSS_COMPANY_ACCESS` in this codebase, never the role's display
   * name (see `users-admin.service.ts` for why a capability must not be keyed to a role name).
   */
  'cash-visibility': Permission.CROSS_COMPANY_ACCESS,
} as const satisfies Record<string, Permission>;

export type ConfirmationPurpose = keyof typeof CONFIRMATION_PURPOSES;

/** The header a confirmed request carries its token in. Lower-case, as Express reads it. */
export const CONFIRMATION_TOKEN_HEADER = 'x-confirmation-token';

/**
 * How long a confirmation lasts. Long enough to flip the switch and flip it back while the
 * room is being cleared; short enough that a laptop left open afterwards does not leave the
 * setting one click away for whoever sits down next.
 */
export const CONFIRMATION_TTL_SECONDS = 10 * 60;

/** The refusal code for a missing, expired, foreign or mis-purposed token. */
export const CONFIRMATION_REQUIRED = 'PASSWORD_CONFIRMATION_REQUIRED';

interface ConfirmationClaims {
  sub: string;
  purpose: ConfirmationPurpose;
}

/**
 * Issues and checks the short-lived proof that a caller re-entered their own password
 * (2026-10-14, the "Hide Cash" move into Settings).
 *
 * ## Why a token and not a server-side flag
 *
 * The confirmation has to survive from the password prompt to the toggle — two requests — and
 * this API keeps no per-session state beyond the refresh family. A signed token carries the
 * proof itself, expires by itself, and needs no table or cleanup job.
 *
 * ## Why its own secret
 *
 * It is a JWT, and so is the access token. Signed with the access secret, a confirmation token
 * would be one forged claim away from being accepted by `JwtStrategy` as a session — and the
 * other way round, any access token would verify here. The key is derived from the access
 * secret with an HMAC under a fixed label, so there is still one secret to configure and rotate,
 * but the two token kinds cannot be confused for each other by construction.
 *
 * ## Why 403 and never 401
 *
 * The web client treats any 401 as "your session has lapsed" and renews it, signing the user
 * out if that fails. A wrong password or a stale confirmation is neither, so every refusal here
 * is a 403 with a machine-readable code the client branches on.
 */
@Injectable()
export class PasswordConfirmationService {
  private readonly jwt: JwtService;

  constructor(configService: ConfigService) {
    const { jwtAccessSecret } = configService.get<SecurityConfig>('security');
    this.jwt = new JwtService({
      secret: createHmac('sha256', jwtAccessSecret)
        .update('buildcore:password-confirmation:v1')
        .digest('hex'),
    });
  }

  /** The permission a purpose requires, or undefined for a purpose that does not exist. */
  requiredPermission(purpose: string): Permission | undefined {
    return Object.prototype.hasOwnProperty.call(CONFIRMATION_PURPOSES, purpose)
      ? CONFIRMATION_PURPOSES[purpose as ConfirmationPurpose]
      : undefined;
  }

  issue(
    userId: string,
    purpose: ConfirmationPurpose,
  ): { confirmationToken: string; expiresAt: string } {
    const claims: ConfirmationClaims = { sub: userId, purpose };
    return {
      confirmationToken: this.jwt.sign(claims, {
        expiresIn: CONFIRMATION_TTL_SECONDS,
      }),
      expiresAt: new Date(
        Date.now() + CONFIRMATION_TTL_SECONDS * 1000,
      ).toISOString(),
    };
  }

  /**
   * Refuses unless `token` is a live confirmation, for this purpose, minted for this caller.
   *
   * The caller check is what stops a token lifted from one administrator's browser being
   * replayed under another account's session.
   */
  assertConfirmed(
    token: string | string[] | undefined,
    userId: string,
    purpose: ConfirmationPurpose,
  ): void {
    const raw = Array.isArray(token) ? token[0] : token;
    let claims: ConfirmationClaims | null = null;
    if (raw) {
      try {
        claims = this.jwt.verify<ConfirmationClaims>(raw);
      } catch {
        claims = null;
      }
    }
    if (!claims || claims.sub !== userId || claims.purpose !== purpose) {
      throw new ForbiddenException({
        statusCode: 403,
        code: CONFIRMATION_REQUIRED,
        message:
          'Confirm your password to change this setting. A confirmation lasts ten minutes.',
      });
    }
  }
}
