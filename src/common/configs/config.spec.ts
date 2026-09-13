import type { Config } from './config.interface';

/**
 * The refresh cookie's `Secure` flag, and the one place it may be relaxed.
 *
 * The flag is evaluated when this module is first imported, so a bad value fails the
 * process at boot rather than at the first sign-in — which is the point. These tests
 * re-import under different environments to check that.
 */

function loadConfig(env: Record<string, string | undefined>): Config {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    let loaded!: Config;
    jest.isolateModules(() => {
      loaded = (require('./config') as { default: () => Config }).default();
    });
    return loaded;
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('refresh cookie configuration', () => {
  it('marks the cookie Secure by default', () => {
    const config = loadConfig({
      REFRESH_COOKIE_SECURE: undefined,
      NODE_ENV: 'development',
    });
    expect(config.security.refreshCookie.secure).toBe(true);
  });

  it('allows Secure to be disabled outside production, for Safari on localhost', () => {
    // Chrome and Firefox exempt localhost from the HTTPS requirement; Safari does not,
    // so without this the session flow cannot be exercised locally in the browser whose
    // cookie behaviour motivated the whole feature.
    const config = loadConfig({
      REFRESH_COOKIE_SECURE: 'false',
      NODE_ENV: 'development',
    });
    expect(config.security.refreshCookie.secure).toBe(false);
  });

  it('refuses to start if Secure is disabled in production', () => {
    // A warning would not do: a refresh cookie in clear text is a session-hijacking
    // primitive, and nobody reads boot logs until something has already gone wrong.
    expect(() =>
      loadConfig({ REFRESH_COOKIE_SECURE: 'false', NODE_ENV: 'production' }),
    ).toThrow(/REFRESH_COOKIE_SECURE cannot be disabled/);
  });

  it('ignores values that are not a recognised negative', () => {
    const config = loadConfig({
      REFRESH_COOKIE_SECURE: 'yes please',
      NODE_ENV: 'development',
    });
    expect(config.security.refreshCookie.secure).toBe(true);
  });

  it('defaults the cookie path to the pre-proxy value, so the API can deploy first', () => {
    const config = loadConfig({
      REFRESH_COOKIE_PATH: undefined,
      NODE_ENV: 'development',
    });
    expect(config.security.refreshCookie.path).toBe('/auth');
  });

  it('takes the cookie path from the environment when set', () => {
    const config = loadConfig({
      REFRESH_COOKIE_PATH: '/bff/auth',
      NODE_ENV: 'development',
    });
    expect(config.security.refreshCookie.path).toBe('/bff/auth');
  });
});
