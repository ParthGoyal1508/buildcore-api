import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EmailConfig } from '../../common/configs/config.interface';
import { ConsoleEmailAdapter } from './console-email.adapter';
import { EmailService } from './email.service';
import { ResendEmailAdapter } from './resend-email.adapter';

/**
 * Binds `EmailService` to whichever adapter the configuration selects.
 *
 * Global for the same reason `StorageModule` is: transactional email is
 * infrastructure several features need — account creation today, 001's lockout
 * notification here too, and 003's outstanding leave/exception notifications next —
 * and re-importing it everywhere would be noise.
 */
@Global()
@Module({
  providers: [
    {
      provide: EmailService,
      useFactory: (configService: ConfigService): EmailService => {
        const logger = new Logger('EmailModule');
        const config = configService.get<EmailConfig>('email');

        if (config.driver === 'resend') {
          const adapter = new ResendEmailAdapter(configService);
          logger.log(`Email transport: ${adapter.describe()}`);
          return adapter;
        }

        // Refused outright rather than warned about. The console adapter logs the
        // full set-password link, so running it in production would write live
        // credential-setting URLs into the log stream — and invites would silently
        // never reach anyone. Both failures are worse than not booting.
        if (process.env.NODE_ENV === 'production') {
          throw new Error(
            'EMAIL_DRIVER is "console" in production. That would log set-password links instead of sending them, and no invite would ever be delivered. Set EMAIL_DRIVER=resend with RESEND_API_KEY, EMAIL_FROM_ADDRESS and APP_BASE_URL.',
          );
        }

        const adapter = new ConsoleEmailAdapter();
        logger.log(`Email transport: ${adapter.describe()}`);
        return adapter;
      },
      inject: [ConfigService],
    },
  ],
  exports: [EmailService],
})
export class EmailModule {}
