import { Logger } from '@nestjs/common';
import { logRefreshCookieConfig } from './refresh-cookie-preflight';
import type { SecurityConfig } from '../common/configs/config.interface';

/**
 * The boot-time announcement of the refresh cookie's attributes.
 *
 * This exists because the fault it describes cannot be detected from inside the
 * process: the `/bff` prefix is stripped before a request arrives, so the path the
 * browser presents the cookie at is never visible here, and nothing errors when it
 * disagrees with the configured one. Printing the values is the entire mitigation, so
 * the printing is worth testing.
 */

function security(
  overrides: Partial<SecurityConfig['refreshCookie']> = {},
): SecurityConfig {
  return {
    refreshCookie: {
      path: '/bff/auth',
      sameSite: 'lax',
      secure: true,
      ...overrides,
    },
    refreshToken: { sessionDays: 90 },
  } as SecurityConfig;
}

describe('logRefreshCookieConfig', () => {
  let log: jest.SpyInstance;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('states the attributes that have to match the frontend', () => {
    logRefreshCookieConfig(security());

    const line = log.mock.calls[0][0] as string;
    expect(line).toContain('Path=/bff/auth');
    expect(line).toContain('SameSite=lax');
    expect(line).toContain('Secure=true');
    expect(line).toContain('Max-Age=90d');
  });

  it('says nothing alarming when the path is configured for the proxy', () => {
    logRefreshCookieConfig(security());
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns when left on the legacy path, which no proxied frontend can use', () => {
    logRefreshCookieConfig(security({ path: '/auth' }));

    const message = warn.mock.calls[0][0] as string;
    // Actionable for someone who has never read the source: it has to name the
    // variable and the value, not merely observe that something looks off.
    expect(message).toContain('REFRESH_COOKIE_PATH=/bff/auth');
    expect(message).toContain('/bff/auth/refresh-token');
  });

  it('warns when Secure is off, which is only ever acceptable locally', () => {
    logRefreshCookieConfig(security({ secure: false }));

    expect(
      warn.mock.calls.some((c) =>
        (c[0] as string).includes('REFRESH_COOKIE_SECURE'),
      ),
    ).toBe(true);
  });
});
