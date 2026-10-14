import { ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Permission } from '@prisma/client';

import {
  CONFIRMATION_REQUIRED,
  PasswordConfirmationService,
} from './password-confirmation.service';

/**
 * The proof that a Super Admin re-entered their password before touching cash visibility
 * (2026-10-14). What matters is everything it refuses: the interface hiding the switch is only
 * an affordance, and this is the check that makes the API itself refuse a borrowed session.
 */

const ACCESS_SECRET = 'access-secret-for-tests';

function build() {
  const config = {
    get: () => ({ jwtAccessSecret: ACCESS_SECRET }),
  } as never;
  return new PasswordConfirmationService(config);
}

function refusalCode(fn: () => void): string | undefined {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ForbiddenException);
    return ((err as ForbiddenException).getResponse() as { code?: string })
      .code;
  }
  return undefined;
}

describe('PasswordConfirmationService', () => {
  it('accepts its own token, for the caller and purpose it was minted for', () => {
    const service = build();
    const { confirmationToken, expiresAt } = service.issue(
      'user-1',
      'cash-visibility',
    );
    expect(() =>
      service.assertConfirmed(confirmationToken, 'user-1', 'cash-visibility'),
    ).not.toThrow();
    // Ten minutes, give or take the test's own runtime.
    const minutes = (Date.parse(expiresAt) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(9.9);
    expect(minutes).toBeLessThanOrEqual(10);
  });

  it('refuses a missing token with a 403 the client can branch on, never a 401', () => {
    expect(
      refusalCode(() =>
        build().assertConfirmed(undefined, 'user-1', 'cash-visibility'),
      ),
    ).toBe(CONFIRMATION_REQUIRED);
  });

  it("refuses another account's token — a token lifted from one browser is not portable", () => {
    const service = build();
    const { confirmationToken } = service.issue('user-1', 'cash-visibility');
    expect(
      refusalCode(() =>
        service.assertConfirmed(confirmationToken, 'user-2', 'cash-visibility'),
      ),
    ).toBe(CONFIRMATION_REQUIRED);
  });

  it('refuses an access token: the two kinds are signed with different keys', () => {
    // Signed with the access secret and even carrying the right claims — what a forged
    // confirmation would look like if both used the same key.
    const accessSigned = new JwtService({ secret: ACCESS_SECRET }).sign({
      sub: 'user-1',
      purpose: 'cash-visibility',
    });
    expect(
      refusalCode(() =>
        build().assertConfirmed(accessSigned, 'user-1', 'cash-visibility'),
      ),
    ).toBe(CONFIRMATION_REQUIRED);
  });

  it('refuses an expired token', () => {
    jest.useFakeTimers({ now: new Date('2026-10-14T10:00:00Z') });
    try {
      const service = build();
      const { confirmationToken } = service.issue('user-1', 'cash-visibility');
      jest.setSystemTime(new Date('2026-10-14T10:10:01Z'));
      expect(
        refusalCode(() =>
          service.assertConfirmed(
            confirmationToken,
            'user-1',
            'cash-visibility',
          ),
        ),
      ).toBe(CONFIRMATION_REQUIRED);
    } finally {
      jest.useRealTimers();
    }
  });

  it('refuses garbage rather than throwing something other than a 403', () => {
    expect(
      refusalCode(() =>
        build().assertConfirmed('not-a-jwt', 'user-1', 'cash-visibility'),
      ),
    ).toBe(CONFIRMATION_REQUIRED);
  });

  it('knows which permission each purpose needs, and no purpose it was not given', () => {
    const service = build();
    expect(service.requiredPermission('cash-visibility')).toBe(
      Permission.CROSS_COMPANY_ACCESS,
    );
    expect(service.requiredPermission('toString')).toBeUndefined();
    expect(service.requiredPermission('anything-else')).toBeUndefined();
  });
});
