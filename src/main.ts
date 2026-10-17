import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { PrismaService } from 'nestjs-prisma';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { configureApp } from './common/configure-app';
import { assertCorsConfigured } from './common/configs/config';
import { COMPANY_HEADER } from './settings/company-selection/company-header.interceptor';
import { assertRlsEnforceable } from './common/prisma/rls-preflight';
import { logRefreshCookieConfig } from './auth/refresh-cookie-preflight';
import type {
  CorsConfig,
  NestConfig,
  SecurityConfig,
  SwaggerConfig,
} from './common/configs/config.interface';

async function bootstrap() {
  // Before anything else: a production server that would allow every origin does not start.
  assertCorsConfigured();

  // `bodyParser: false` disables Nest's built-in parsers so the ones registered
  // below — with an explicit size limit — are the only ones handling a body.
  // Raising the limit on Nest's defaults after the fact is not reliable: they are
  // already installed by this point, so the first parser to see a request is the
  // one with the 100 KB default still applied.
  const app = await NestFactory.create(AppModule, { bodyParser: false });

  // Body parsers, the validation pipe and the Prisma error filter — shared with the e2e suites so the app
  // under test is configured exactly like the one that ships.
  configureApp(app);

  // Refresh tokens are delivered/read exclusively as HttpOnly cookies (FR-006) —
  // req.cookies is otherwise undefined under Express.
  app.use(cookieParser());

  // Refuse to serve traffic if the database role silently bypasses row-level
  // security — in production that means no tenant isolation at all, with nothing
  // in the logs to say so.
  await assertRlsEnforceable(
    app.get(PrismaService),
    process.env.NODE_ENV === 'production',
  );

  // enable shutdown hook
  app.enableShutdownHooks();

  const configService = app.get(ConfigService);
  const nestConfig = configService.get<NestConfig>('nest');
  const corsConfig = configService.get<CorsConfig>('cors');
  const swaggerConfig = configService.get<SwaggerConfig>('swagger');

  // Printed every boot. The one attribute that matters here — whether the cookie's Path
  // covers where the frontend actually renews — cannot be checked from inside this
  // process, and gets no error when it is wrong, so making it visible is the whole
  // mitigation.
  logRefreshCookieConfig(configService.get<SecurityConfig>('security'));

  // Swagger Api
  if (swaggerConfig.enabled) {
    const options = new DocumentBuilder()
      .setTitle(swaggerConfig.title || 'Nestjs')
      .setDescription(swaggerConfig.description || 'The nestjs API description')
      .setVersion(swaggerConfig.version || '1.0')
      .build();
    const document = SwaggerModule.createDocument(app, options);

    SwaggerModule.setup(swaggerConfig.path || 'api', app, document);
  }

  // Cors
  if (corsConfig.enabled) {
    // credentials: true is required for the browser to accept/send the
    // HttpOnly refresh-token cookie cross-origin (frontend and backend are
    // separate origins in both local dev and production) — without it the
    // Set-Cookie response header is silently ignored by the browser.
    app.enableCors({
      origin: corsConfig.origin,
      credentials: true,
      // Readable cross-origin only when listed. Without these a download from the web app could not
      // see the file name the server chose, nor the header fields a bill printed blank.
      // `X-Company-Id`: the company each response was served for (036 B17).
      // `X-Total-Count`: the full count behind a paged list that is still a plain array. It used to
      // be exposed by the two controllers that send it, whose own header replaced this list and so
      // hid `X-Company-Id` on exactly those responses.
      exposedHeaders: [
        'Content-Disposition',
        'X-Bill-Package-Missing-Fields',
        'X-Total-Count',
        COMPANY_HEADER,
      ],
      // No `allowedHeaders`: left unset, the cors middleware reflects whatever request headers the
      // preflight asks for, which already admits `X-Expected-Company-Id` (036 B17) alongside
      // `X-Confirmation-Token` and the rest. An explicit list would have to be kept in step with
      // every header the web sends, and the one forgotten would fail only cross-origin.
    });
  }

  await app.listen(process.env.PORT || nestConfig.port || 3000);
}
bootstrap();
