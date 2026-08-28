import type { Config } from './config.interface';

const config: Config = {
  nest: {
    port: 3000,
  },
  cors: {
    enabled: true,
    // CORS_ORIGINS: comma-separated allowed origins for prod (e.g. the deployed
    // frontend's URL). Unset → allow all, matching prior local-dev behavior.
    origin: process.env.CORS_ORIGINS
      ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim())
      : true,
  },
  swagger: {
    enabled: true,
    title: 'BuildCore API',
    description: 'BuildCore ERP — REST API',
    version: '1.0',
    path: 'api',
  },
  security: {
    expiresIn: '15m',
    jwtAccessSecret: process.env.JWT_ACCESS_SECRET,
    refreshTokenHashSecret: process.env.JWT_REFRESH_SECRET,
    lockout: {
      maxAttempts: 5,
      durationMinutes: 15,
    },
    refreshCookie: {
      // Defaults to 'none' wherever CORS_ORIGINS is set, since that's precisely the
      // split-origin deployment where 'strict' would silently drop the cookie; local
      // dev (frontend and API both on localhost, same-site regardless of port) keeps
      // the stronger 'strict'. REFRESH_COOKIE_SAMESITE overrides either way.
      sameSite:
        (process.env.REFRESH_COOKIE_SAMESITE as 'strict' | 'lax' | 'none') ||
        (process.env.CORS_ORIGINS ? 'none' : 'strict'),
      secure: true,
    },
    refreshToken: {
      rememberMeDays: 30,
      defaultDays: 1,
    },
    throttle: {
      ttlSeconds: 60,
      limit: 10,
    },
  },
};

export default (): Config => config;
