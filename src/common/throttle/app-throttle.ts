import { ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerOptions } from '@nestjs/throttler';

/**
 * The app-wide rate limit and the export limit (036 B9).
 *
 * ## Three named throttlers
 *
 * | name | applies to | limit (default) | key |
 * |---|---|---|---|
 * | `default` | routes that attach `ThrottlerGuard` themselves (auth, invites, password) | 10/min, overridden per route by `@Throttle({ default: … })` | per route, per address |
 * | `app` | **every** route, via the global {@link AppThrottlerGuard} | 1000/min (`APP_THROTTLE_LIMIT`) | per address, across all routes |
 * | `export` | routes marked {@link ExportThrottle} | 10/min (`EXPORT_THROTTLE_LIMIT`) | per route, per address |
 *
 * `default` is the sign-in limit, which is why the global guard must not apply it: Wave 0 found
 * a global `ThrottlerGuard` would have capped every route at ten a minute (plan.md, B1). So the
 * global guard runs `app` and `export` only, and the auth routes keep exactly the limits they had.
 */
export const APP_THROTTLER = 'app';
export const EXPORT_THROTTLER = 'export';
export const DEFAULT_THROTTLER = 'default';

const EXPORT_THROTTLE_KEY = 'exportThrottle';

/** Marks a route as an export: a full scan, held to the tighter `export` limit. */
export const ExportThrottle = () => SetMetadata(EXPORT_THROTTLE_KEY, true);

export function throttlersFor(config: {
  ttlSeconds: number;
  limit: number;
  appLimit: number;
  appTtlSeconds: number;
  exportLimit: number;
  exportTtlSeconds: number;
}): ThrottlerOptions[] {
  return [
    {
      name: DEFAULT_THROTTLER,
      ttl: config.ttlSeconds * 1000,
      limit: config.limit,
    },
    {
      name: APP_THROTTLER,
      ttl: config.appTtlSeconds * 1000,
      limit: config.appLimit,
      // One bucket per address for the whole API, not one per route: a flood spread across
      // routes is still a flood.
      generateKey: (_context, tracker, name) => `${name}-${tracker}`,
    },
    {
      name: EXPORT_THROTTLER,
      ttl: config.exportTtlSeconds * 1000,
      limit: config.exportLimit,
      skipIf: (context: ExecutionContext) =>
        !Reflect.getMetadata(EXPORT_THROTTLE_KEY, context.getHandler()),
    },
  ];
}

/**
 * The global guard: `app` and `export`, never `default`. Registered as `APP_GUARD`.
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  async onModuleInit(): Promise<void> {
    await super.onModuleInit();
    this.throttlers = this.throttlers.filter(
      (throttler) => throttler.name !== DEFAULT_THROTTLER,
    );
  }
}
