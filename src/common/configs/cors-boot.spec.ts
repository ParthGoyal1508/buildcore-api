import { assertCorsConfigured } from './config';

describe('assertCorsConfigured (036 B9)', () => {
  it('refuses a production boot with CORS_ORIGINS unset or blank', () => {
    expect(() => assertCorsConfigured({ NODE_ENV: 'production' })).toThrow(
      /CORS_ORIGINS is not set/,
    );
    expect(() =>
      assertCorsConfigured({ NODE_ENV: 'production', CORS_ORIGINS: '  ' }),
    ).toThrow();
  });

  it('starts in production with origins listed, or with `none`', () => {
    expect(() =>
      assertCorsConfigured({
        NODE_ENV: 'production',
        CORS_ORIGINS: 'https://app.example.com',
      }),
    ).not.toThrow();
    expect(() =>
      assertCorsConfigured({ NODE_ENV: 'production', CORS_ORIGINS: 'none' }),
    ).not.toThrow();
  });

  it('does not care outside production', () => {
    expect(() =>
      assertCorsConfigured({ NODE_ENV: 'development' }),
    ).not.toThrow();
  });
});
