import { Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { PrismaModule, loggingMiddleware } from 'nestjs-prisma';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AccountCreationModule } from './account-creation/account-creation.module';
import { AuthModule } from './auth/auth.module';
import { HrModule } from './hr/hr.module';
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

    StorageModule,
    EmailModule,

    AuthModule,
    UsersModule,
    SettingsModule,
    ProjectsModule,
    HrModule,
    AccountCreationModule,
    PayrollModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
