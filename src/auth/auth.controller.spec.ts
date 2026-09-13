import { UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthController } from './auth.controller';
import { SESSION_COOKIE_MISSING } from './session-error-codes';

/**
 * How the refresh cookie is issued, and what happens when it does not come back.
 *
 * Both halves of one defect. A cookie scoped to a path the frontend never renews at is
 * stored by the browser and silently withheld, and the refusal that follows used to be
 * an uncoded 401 — which the client rendered as "your session expired". A deployment
 * fault was therefore indistinguishable from ninety days of not visiting, in the UI and
 * in the logs alike, which is exactly how it survived a verification pass and then
 * signed everyone out on their first page refresh.
 */

const SESSION_DAYS = 90;

function build(refreshCookie: {
  path: string;
  sameSite: 'strict' | 'lax' | 'none';
  secure: boolean;
}) {
  const configService = {
    get: () => ({
      refreshCookie,
      refreshToken: { sessionDays: SESSION_DAYS },
    }),
  } as never;
  const auth = {
    login: jest.fn(),
    refresh: jest.fn(),
    logout: jest.fn().mockResolvedValue(undefined),
  } as never;

  const controller = new AuthController(auth, configService);
  // The warning is deliberate behaviour, but it should not colour the test output.
  jest
    .spyOn(
      (controller as unknown as { logger: { warn: (m: string) => void } })
        .logger,
      'warn',
    )
    .mockImplementation(() => undefined);

  const res = {
    cookie: jest.fn(),
    clearCookie: jest.fn(),
  } as unknown as Response;

  return { controller, res, auth: auth as unknown as { logout: jest.Mock } };
}

const req = (cookies: Record<string, string> = {}) =>
  ({
    cookies,
    method: 'POST',
    originalUrl: '/auth/refresh-token',
    ip: '127.0.0.1',
  }) as unknown as Request;

describe('AuthController refresh cookie', () => {
  const proxied = { path: '/bff/auth', sameSite: 'lax' as const, secure: true };

  it('refuses a renewal with SESSION_COOKIE_MISSING when no cookie arrived', async () => {
    const { controller, res } = build(proxied);

    const err = await controller
      .refreshToken(req(), res)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UnauthorizedException);
    expect((err as UnauthorizedException).getResponse()).toMatchObject({
      statusCode: 401,
      code: SESSION_COOKIE_MISSING,
    });
  });

  it('names the cookie attributes in the warning, since the mismatch is invisible otherwise', async () => {
    const { controller, res } = build(proxied);
    const warn = jest.spyOn(
      (controller as unknown as { logger: { warn: (m: string) => void } })
        .logger,
      'warn',
    );

    await controller.refreshToken(req(), res).catch(() => undefined);

    const message = warn.mock.calls[0][0] as string;
    expect(message).toContain('Path=/bff/auth');
    expect(message).toContain('REFRESH_COOKIE_PATH');
  });

  it('issues the cookie at the configured path, not a hardcoded one', async () => {
    const { controller, res } = build(proxied);
    (
      controller as unknown as {
        setRefreshCookie: (r: Response, t: string) => void;
      }
    ).setRefreshCookie(res, 'raw-token');

    const [name, value, options] = (res.cookie as jest.Mock).mock.calls[0];
    expect(name).toBe('refreshToken');
    expect(value).toBe('raw-token');
    expect(options).toMatchObject({
      path: '/bff/auth',
      sameSite: 'lax',
      secure: true,
      httpOnly: true,
    });
  });

  it('always sets Max-Age, so the cookie outlives the browser window', () => {
    const { controller, res } = build(proxied);
    (
      controller as unknown as {
        setRefreshCookie: (r: Response, t: string) => void;
      }
    ).setRefreshCookie(res, 'raw-token');

    const [, , options] = (res.cookie as jest.Mock).mock.calls[0];
    expect(options.maxAge).toBe(SESSION_DAYS * 24 * 60 * 60 * 1000);
  });

  it('clears the cookie with the same attributes it was set with', async () => {
    const { controller, res } = build(proxied);

    await controller.logout(req({ refreshToken: 'raw-token' }), res);

    const [name, options] = (res.clearCookie as jest.Mock).mock.calls[0];
    expect(name).toBe('refreshToken');
    // A browser matches a clearing Set-Cookie on name, path and domain. Drift here
    // leaves the credential in place after a sign-out, which is the one thing a
    // sign-out has to accomplish.
    expect(options).toMatchObject({
      path: '/bff/auth',
      sameSite: 'lax',
      secure: true,
      httpOnly: true,
    });
  });

  it('honours a non-default path rather than assuming /bff/auth', () => {
    const { controller, res } = build({
      path: '/auth',
      sameSite: 'strict',
      secure: false,
    });
    (
      controller as unknown as {
        setRefreshCookie: (r: Response, t: string) => void;
      }
    ).setRefreshCookie(res, 'raw-token');

    const [, , options] = (res.cookie as jest.Mock).mock.calls[0];
    expect(options).toMatchObject({
      path: '/auth',
      sameSite: 'strict',
      secure: false,
    });
  });
});
