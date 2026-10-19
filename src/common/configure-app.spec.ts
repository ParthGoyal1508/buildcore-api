import { ApiExceptionFilter } from './filters/api-exception.filter';
import { configureApp } from './configure-app';

/**
 * That the configured proxy depth reaches Express.
 *
 * Separated from `trust-proxy.e2e-spec.ts` on purpose. That suite proves what the setting
 * *does* — whether a client-written `X-Forwarded-For` becomes the audited address — by
 * setting Express directly. It cannot also prove the wiring, because `TRUST_PROXY` is
 * unset under test and `trustedProxyHops(undefined)` is `false`, which is Express's own
 * default: an assertion there passes whether `configureApp` sets anything or not.
 * Confirmed by deleting the line and watching all three of its tests stay green.
 *
 * So this asserts the one remaining link, with a value Express would never arrive at by
 * itself. `3` for that reason alone.
 */
describe('configureApp hands Express the configured proxy depth', () => {
  function fakeApp(trustProxy: number | false) {
    const settings: Record<string, unknown> = {};
    const filters: unknown[] = [];
    return {
      app: {
        get: () => ({
          get: () => ({ maxRequestBodySize: '10mb', trustProxy }),
        }),
        getHttpAdapter: () => ({
          getInstance: () => ({
            set: (key: string, value: unknown) => {
              settings[key] = value;
            },
          }),
        }),
        use: () => undefined,
        useGlobalPipes: () => undefined,
        useGlobalFilters: (...added: unknown[]) => {
          filters.push(...added);
        },
      },
      filters,
      settings,
    };
  }

  it('sets trust proxy to the configured hop count', () => {
    const { app, settings } = fakeApp(3);

    configureApp(app as never);

    expect(settings['trust proxy']).toBe(3);
  });

  it('sets it to false when no proxy is configured, rather than leaving it unset', () => {
    // `false` and "never set" render the same today, but they are different intentions
    // and only one of them survives someone changing Express's default.
    const { app, settings } = fakeApp(false);

    configureApp(app as never);

    expect(settings).toHaveProperty('trust proxy');
    expect(settings['trust proxy']).toBe(false);
  });
});

/**
 * The error filter (Prisma mapping included) is part of the shared configuration, so the e2e app answers a unique
 * violation with 409 exactly as production does (036 B10). It used to live in `main.ts` alone.
 */
describe('configureApp registers the API exception filter', () => {
  it('adds the ApiExceptionFilter, which also maps Prisma errors', () => {
    const filters: unknown[] = [];
    const adapter = { getInstance: () => ({ set: () => undefined }) };
    const app = {
      get: () => ({
        get: () => ({ maxRequestBodySize: '10mb', trustProxy: false }),
      }),
      getHttpAdapter: () => adapter,
      use: () => undefined,
      useGlobalPipes: () => undefined,
      useGlobalFilters: (...added: unknown[]) => filters.push(...added),
    };

    configureApp(app as never);

    expect(filters).toHaveLength(1);
    expect(filters[0]).toBeInstanceOf(ApiExceptionFilter);
  });
});
