import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { json, urlencoded } from 'express';
import type { NestConfig } from './configs/config.interface';

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
  // Photo payloads (base64 enrolment and punch images) are far larger than
  // Express's default allows — see NestConfig.maxRequestBodySize. Read from config
  // rather than written inline, per Principle III.
  const bodyLimit = app
    .get(ConfigService)
    .get<NestConfig>('nest').maxRequestBodySize;
  app.use(json({ limit: bodyLimit }));
  app.use(urlencoded({ extended: true, limit: bodyLimit }));

  // whitelist/forbidNonWhitelisted reject any unexpected field (Principle II,
  // FR-001/FR-018); transform coerces payloads to their DTO classes.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
}
