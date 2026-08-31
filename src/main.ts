import { ConfigService } from '@nestjs/config';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { PrismaClientExceptionFilter, PrismaService } from 'nestjs-prisma';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { configureApp } from './common/configure-app';
import { assertRlsEnforceable } from './common/prisma/rls-preflight';
import type {
  CorsConfig,
  NestConfig,
  SwaggerConfig,
} from './common/configs/config.interface';

async function bootstrap() {
  // `bodyParser: false` disables Nest's built-in parsers so the ones registered
  // below — with an explicit size limit — are the only ones handling a body.
  // Raising the limit on Nest's defaults after the fact is not reliable: they are
  // already installed by this point, so the first parser to see a request is the
  // one with the 100 KB default still applied.
  const app = await NestFactory.create(AppModule, { bodyParser: false });

  // Body parsers and the validation pipe — shared with the e2e suites so the app
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

  // Prisma Client Exception Filter for unhandled exceptions
  const { httpAdapter } = app.get(HttpAdapterHost);
  app.useGlobalFilters(new PrismaClientExceptionFilter(httpAdapter));

  const configService = app.get(ConfigService);
  const nestConfig = configService.get<NestConfig>('nest');
  const corsConfig = configService.get<CorsConfig>('cors');
  const swaggerConfig = configService.get<SwaggerConfig>('swagger');

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
    app.enableCors({ origin: corsConfig.origin, credentials: true });
  }

  await app.listen(process.env.PORT || nestConfig.port || 3000);
}
bootstrap();
