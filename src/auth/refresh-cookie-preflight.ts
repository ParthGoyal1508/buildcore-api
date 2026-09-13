import { Logger } from '@nestjs/common';
import type { SecurityConfig } from '../common/configs/config.interface';
import { LEGACY_REFRESH_COOKIE_PATH } from '../common/configs/config';

/**
 * Says the refresh cookie's effective attributes out loud at boot.
 *
 * There is no way for this process to detect the fault it is guarding against. The
 * frontend proxies the API under `/bff`, so a renewal reaches us as `/auth/refresh-token`
 * with the prefix already stripped — the browser-facing path, the one the cookie's `Path`
 * has to match, is never visible in the request. Nor does anything fail loudly when they
 * disagree: the browser stores the credential, silently declines to send it, and the user
 * is signed out on their first page refresh.
 *
 * So this does the only useful thing available: prints the values, and flags the one
 * combination that is known-suspicious. A wrong value becomes visible the moment anyone
 * looks at the log, instead of after an afternoon of reading session code that was right
 * all along.
 */
export function logRefreshCookieConfig(security: SecurityConfig): void {
  const logger = new Logger('RefreshCookie');
  const { path, sameSite, secure } = security.refreshCookie;
  const { sessionDays } = security.refreshToken;

  logger.log(
    `Path=${path}; SameSite=${sameSite}; Secure=${secure}; ` +
      `Max-Age=${sessionDays}d`,
  );

  // The legacy default is correct only while no proxied frontend is being served. That
  // window is real — the API is meant to deploy ahead of the frontend — so this warns
  // rather than refuses. It is worded to be actionable by someone who has never read
  // this file.
  if (path === LEGACY_REFRESH_COOKIE_PATH) {
    logger.warn(
      `REFRESH_COOKIE_PATH is unset, so the refresh cookie is scoped to ` +
        `"${LEGACY_REFRESH_COOKIE_PATH}". buildcore-web proxies this API at /bff and ` +
        `renews at /bff/auth/refresh-token, which that path does not cover — the ` +
        `browser will keep the cookie and never send it, signing users out on their ` +
        `first page refresh. Set REFRESH_COOKIE_PATH=/bff/auth for any deployment ` +
        `serving buildcore-web.`,
    );
  }

  if (!secure) {
    logger.warn(
      `REFRESH_COOKIE_SECURE is disabled: the refresh cookie will be sent over plain ` +
        `HTTP. Intended only for local development (Safari refuses Secure cookies on ` +
        `http://localhost). NODE_ENV=production refuses this outright.`,
    );
  }
}
