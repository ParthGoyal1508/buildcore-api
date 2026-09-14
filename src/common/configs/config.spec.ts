import type { Config } from './config.interface';

/**
 * The refresh cookie's `Secure` flag, and the one place it may be relaxed.
 *
 * The flag is evaluated when this module is first imported, so a bad value fails the
 * process at boot rather than at the first sign-in — which is the point. These tests
 * re-import under different environments to check that.
 */

async function loadConfig(
  env: Record<string, string | undefined>,
): Promise<Config> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    let loaded!: Config;
    // A fresh module registry per call, because the flag under test is evaluated once
    // when the module is first imported — which is the property that makes a bad value
    // fail at boot rather than at the first sign-in.
    await jest.isolateModulesAsync(async () => {
      const mod = (await import('./config')) as { default: () => Config };
      loaded = mod.default();
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
  it('marks the cookie Secure by default', async () => {
    const config = await loadConfig({
      REFRESH_COOKIE_SECURE: undefined,
      NODE_ENV: 'development',
    });
    expect(config.security.refreshCookie.secure).toBe(true);
  });

  it('allows Secure to be disabled outside production, for Safari on localhost', async () => {
    // Chrome and Firefox exempt localhost from the HTTPS requirement; Safari does not,
    // so without this the session flow cannot be exercised locally in the browser whose
    // cookie behaviour motivated the whole feature.
    const config = await loadConfig({
      REFRESH_COOKIE_SECURE: 'false',
      NODE_ENV: 'development',
    });
    expect(config.security.refreshCookie.secure).toBe(false);
  });

  it('refuses to start if Secure is disabled in production', async () => {
    // A warning would not do: a refresh cookie in clear text is a session-hijacking
    // primitive, and nobody reads boot logs until something has already gone wrong.
    await expect(
      loadConfig({ REFRESH_COOKIE_SECURE: 'false', NODE_ENV: 'production' }),
    ).rejects.toThrow(/REFRESH_COOKIE_SECURE cannot be disabled/);
  });

  it('ignores values that are not a recognised negative', async () => {
    const config = await loadConfig({
      REFRESH_COOKIE_SECURE: 'yes please',
      NODE_ENV: 'development',
    });
    expect(config.security.refreshCookie.secure).toBe(true);
  });

  it('defaults the cookie path to the pre-proxy value, so the API can deploy first', async () => {
    const config = await loadConfig({
      REFRESH_COOKIE_PATH: undefined,
      NODE_ENV: 'development',
    });
    expect(config.security.refreshCookie.path).toBe('/auth');
  });

  it('takes the cookie path from the environment when set', async () => {
    const config = await loadConfig({
      REFRESH_COOKIE_PATH: '/bff/auth',
      NODE_ENV: 'development',
    });
    expect(config.security.refreshCookie.path).toBe('/bff/auth');
  });
});

describe('normaliseRefreshCookiePath', () => {
  // Imported lazily so the suite above keeps full control of module state.
  const load = async () =>
    (await import('./config')).normaliseRefreshCookiePath;

  it('adds the leading slash a cookie path requires', async () => {
    // The exact production misconfiguration. Without a leading slash the attribute is
    // invalid and browsers silently substitute the default-path, so the value in the
    // dashboard stops describing what is actually stored.
    expect((await load())('bff/auth')).toBe('/bff/auth');
  });

  it('leaves a well-formed path alone', async () => {
    expect((await load())('/bff/auth')).toBe('/bff/auth');
  });

  it('strips a trailing slash, which would stop matching the path itself', async () => {
    expect((await load())('/bff/auth/')).toBe('/bff/auth');
  });

  it('keeps root as root', async () => {
    expect((await load())('/')).toBe('/');
  });

  it('falls back to the legacy default when unset or blank', async () => {
    const fn = await load();
    expect(fn(undefined)).toBe('/auth');
    expect(fn('   ')).toBe('/auth');
  });
});

describe('approvals.directorFinalActionTypes (016 FR-018a)', () => {
  it('defaults to the six action types FR-018 names', async () => {
    const config = await loadConfig({
      APPROVALS_DIRECTOR_FINAL_ACTIONS: undefined,
    });

    // Asserted against the constants in `src/approvals/default-chains.ts` rather than
    // against repeated string literals. The list lives in config because configuration
    // must not depend on the feature that reads it; this test is what keeps the two
    // halves of that separation honest, and it is the whole reason the duplication is
    // acceptable.
    const {
      ACTION_PAYMENT_RELEASE,
      ACTION_PAYROLL_RUN,
      ACTION_LETTER_WORK_ORDER,
      ACTION_LETTER_LOI,
      ACTION_LETTER_PURCHASE_ORDER,
      ACTION_FINAL_SETTLEMENT,
    } = await import('../../approvals/default-chains');

    expect(config.approvals.directorFinalActionTypes).toEqual([
      ACTION_PAYMENT_RELEASE,
      ACTION_PAYROLL_RUN,
      ACTION_LETTER_WORK_ORDER,
      ACTION_LETTER_LOI,
      ACTION_LETTER_PURCHASE_ORDER,
      ACTION_FINAL_SETTLEMENT,
    ]);
  });

  it('takes a comma-separated override', async () => {
    const config = await loadConfig({
      APPROVALS_DIRECTOR_FINAL_ACTIONS: 'payment_release, final_settlement',
    });
    expect(config.approvals.directorFinalActionTypes).toEqual([
      'payment_release',
      'final_settlement',
    ]);
  });

  it('treats an explicitly empty value as "none", not as "unset"', async () => {
    // The escape hatch. `??` rather than `||` is what makes this distinguishable, and
    // getting it wrong would silently restore the defaults for somebody who had
    // deliberately turned the fail-closed behaviour off.
    const config = await loadConfig({ APPROVALS_DIRECTOR_FINAL_ACTIONS: '' });
    expect(config.approvals.directorFinalActionTypes).toEqual([]);
  });
});
