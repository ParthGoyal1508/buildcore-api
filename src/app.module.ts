import { Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { PrismaModule, loggingMiddleware } from 'nestjs-prisma';
import { AppController } from './app.controller';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AppService } from './app.service';
import { PasswordChangeInterceptor } from './auth/password-change.interceptor';
import { AccountCreationModule } from './account-creation/account-creation.module';
import { AuthModule } from './auth/auth.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { HrModule } from './hr/hr.module';
import { PartnersModule } from './partners/partners.module';
import { PayrollModule } from './payroll/payroll.module';
import { ProjectsModule } from './projects/projects.module';
import { SettingsModule } from './settings/settings.module';
import { EmailModule } from './shared/email/email.module';
import { StorageModule } from './common/storage/storage.module';
import { UsersModule } from './users/users.module';
import config from './common/configs/config';
import type { SecurityConfig } from './common/configs/config.interface';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [config] }),
    ThrottlerModule.forRootAsync({
      useFactory: (configService: ConfigService) => {
        const { ttlSeconds, limit } =
          configService.get<SecurityConfig>('security').throttle;
        return [{ ttl: ttlSeconds * 1000, limit }];
      },
      inject: [ConfigService],
    }),
    PrismaModule.forRoot({
      isGlobal: true,
      prismaServiceOptions: {
        middlewares: [
          // configure your prisma middleware
          loggingMiddleware({
            logger: new Logger('PrismaMiddleware'),
            logLevel: 'log',
          }),
        ],
      },
    }),

    // Both first used by 007. The scheduler drives the monthly compliance check; the
    // event bus carries its `compliance.missing` events, which feature 004's reminders
    // engine will subscribe to. Nothing subscribes today — see the cron for why that
    // is deliberate rather than an omission.
    ScheduleModule.forRoot(),
    EventEmitterModule.forRoot(),

    StorageModule,
    EmailModule,

    AuthModule,
    UsersModule,
    SettingsModule,
    ProjectsModule,
    HrModule,
    AccountCreationModule,
    PayrollModule,
    PartnersModule,
    DashboardModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      // Global so a route that never considers the forced-change rule is refused
      // rather than silently exempt (010 FR-017a). An interceptor rather than a
      // guard because global guards run *before* controller-level ones, and
      // JwtAuthGuard is per-controller here — a global guard would see no
      // `request.user` and allow everything.
      provide: APP_INTERCEPTOR,
      useClass: PasswordChangeInterceptor,
    },
  ],
})
export class AppModule {}
