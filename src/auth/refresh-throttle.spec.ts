import 'reflect-metadata';
import {
  THROTTLER_LIMIT,
  THROTTLER_TTL,
} from '@nestjs/throttler/dist/throttler.constants';

import { AuthController } from './auth.controller';
import config from '../common/configs/config';

/**
 * The renewal endpoint has a far higher allowance than the sign-in endpoint, and the
 * sign-in endpoint still has the low one.
 *
 * The access token is held in memory and never in storage, so **one full page load
 * costs exactly one call to `/auth/refresh-token`** — measured in a browser: six loads,
 * six calls. While both endpoints shared `/auth/*`'s allowance of ten per minute, ten
 * reloads a minute was the ceiling on using the application, and the limiter tracks by
 * source address, so one office behind one NAT shared those ten between everybody in
 * it. The eleventh answers 429, which `withAuth` cannot treat as a lapsed session
 * (only a 401 is), so the screen reported a load failure.
 *
 * **Both halves are asserted, and the second is the point.** `refreshLimit > limit` on
 * its own would also pass if somebody raised `/auth/login`'s allowance to match — which
 * is the change this must not become, because that is the endpoint where an attacker
 * supplies a guessable password. So login's absence of an override is asserted too.
 */
const named = (key: string) => `${key}default`;

describe('the renewal endpoint is rate-limited separately from sign-in', () => {
  const { limit, ttlSeconds, refreshLimit } = config().security.throttle;

  it('gives /auth/refresh-token its own, higher allowance', () => {
    const own = Reflect.getMetadata(
      named(THROTTLER_LIMIT),
      AuthController.prototype.refreshToken,
    );

    expect(own).toBe(refreshLimit);
    expect(own).toBeGreaterThan(limit);
  });

  it('leaves /auth/login on the low shared allowance', () => {
    // No per-handler override: login inherits `ThrottlerModule`'s configured limit.
    // Password guessing is what that number is for, and it must stay small.
    expect(
      Reflect.getMetadata(
        named(THROTTLER_LIMIT),
        AuthController.prototype.login,
      ),
    ).toBeUndefined();
    expect(limit).toBeLessThanOrEqual(10);
  });

  it('uses the one configured window, not a second copy of it', () => {
    // A window declared twice is a window that drifts; the decorator reads the same
    // config `ThrottlerModule` is built from.
    expect(
      Reflect.getMetadata(
        named(THROTTLER_TTL),
        AuthController.prototype.refreshToken,
      ),
    ).toBe(ttlSeconds * 1000);
  });
});
