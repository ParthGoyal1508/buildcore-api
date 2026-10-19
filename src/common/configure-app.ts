import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import type { NestConfig } from './configs/config.interface';
import { ApiExceptionFilter } from './filters/api-exception.filter';
import { installBodyParsers } from './uploads/large-body';
import { DEFAULT_REQUEST_BODY_LIMIT } from './uploads/upload-limits';

/**
 * Request-handling configuration shared by the real server and the e2e suites.
 *
 * This exists because the two used to be configured separately — `main.ts` set up
 * its pipes and parsers, and each e2e suite hand-copied the parts it remembered.
 * That divergence is not hypothetical: the API shipped with Express's 100 KB body
 * default still in place, rejecting every real photo upload with
 * `413 request entity too large`, while a fully green e2e suite ran against an app
 * configured differently from the one users would actually hit.
 *
 * Anything that changes how a request is parsed or validated belongs here, so the
 * application under test stays the application that ships.
 */
export function configureApp(app: INestApplication): void {
  const nest = app.get(ConfigService).get<NestConfig>('nest');

  /**
   * Whether `req.ip` is the caller's address or the proxy's — see NestConfig.trustProxy.
   *
   * Set here rather than in `main.ts` for the reason this whole file exists: the auth
   * rate limiter, the audit log and the sign-in lockout all key on `req.ip`, and an e2e
   * suite running against an app that resolves addresses differently from the one that
   * ships is a suite that cannot see any of those three being wrong.
   */
  app.getHttpAdapter().getInstance().set('trust proxy', nest.trustProxy);

  // Security headers (036 B9): `X-Content-Type-Options: nosniff` above all — uploaded files are
  // served with their stored type, and nosniff stops a browser second-guessing it into HTML —
  // plus HSTS, a frame-ancestors restriction and the rest of helmet's defaults.
  //
  // Two defaults relaxed, each for a reason that would otherwise break something real:
  // - CSP allows inline styles and `data:` images, which Swagger UI needs; scripts stay 'self'.
  // - `Cross-Origin-Resource-Policy: cross-origin`, so a file the web app loads from a different
  //   origin in local development is not blocked. Access is still decided by the bearer token.
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          frameAncestors: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  // Two body limits (036 B8): the upload limit on the routes that carry files, derived from
  // their DTOs, and a small default everywhere else — see `uploads/large-body.ts`. Read from
  // config rather than written inline, per Principle III.
  installBodyParsers(app, {
    defaultLimit: nest.defaultRequestBodySize ?? DEFAULT_REQUEST_BODY_LIMIT,
    uploadLimit: nest.maxRequestBodySize,
  });

  // whitelist/forbidNonWhitelisted reject any unexpected field (Principle II,
  // FR-001/FR-018); transform coerces payloads to their DTO classes.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // One error body for every refusal, and Prisma's errors mapped to the status they deserve
  // with no schema text (036 B10) — see `filters/api-exception.filter.ts`. Registered here, not
  // in `main.ts`, so the e2e app answers errors exactly as production does.
  app.useGlobalFilters(new ApiExceptionFilter(app.getHttpAdapter()));
}
