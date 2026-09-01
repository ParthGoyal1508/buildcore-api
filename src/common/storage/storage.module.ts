import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { StorageConfig } from '../configs/config.interface';
import { LocalStorageAdapter } from './local-storage.adapter';
import { S3StorageAdapter } from './s3-storage.adapter';
import { StorageService } from './storage.service';

/**
 * Binds `StorageService` to whichever adapter the configuration selects.
 *
 * Global because blob storage is infrastructure several modules will need (`hr`
 * today; documents and attachments later), and re-importing it everywhere would be
 * noise — the same reasoning `PrismaModule.forRoot({ isGlobal: true })` already
 * applies in `app.module.ts`.
 */
@Global()
@Module({
  providers: [
    {
      provide: StorageService,
      useFactory: (configService: ConfigService): StorageService => {
        const logger = new Logger('StorageModule');
        const config = configService.get<StorageConfig>('storage');

        if (config.driver === 's3') {
          const adapter = new S3StorageAdapter(configService);
          logger.log(`Blob storage: ${adapter.describe()}`);
          return adapter;
        }

        // Refused outright rather than warned about. The consequence of getting
        // this wrong is not an error anyone sees: the app boots cleanly, serves
        // every enrolment and punch correctly, and then loses every stored photo
        // the next time the host redeploys or spins down idle — taking the
        // retention and deletion obligations of FR-026 with it, and leaving only a
        // log line behind. Failing to boot is the safer outcome for a
        // misconfiguration whose symptom is otherwise invisible until the data is
        // already gone.
        //
        // A preview or staging deployment can opt out: it sets NODE_ENV=production
        // like everything else but serves nobody real. The opt-out is explicit and
        // never inferred, so a real production environment that simply forgets to
        // configure R2 still fails loudly.
        if (
          process.env.NODE_ENV === 'production' &&
          !config.allowLocalInProduction
        ) {
          throw new Error(
            'STORAGE_DRIVER is "local" in production. This host\'s filesystem is ephemeral, so every stored biometric photo would be destroyed on the next deploy or idle spin-down — silently, with the app still serving correctly. Set STORAGE_DRIVER=s3 with STORAGE_S3_ENDPOINT, STORAGE_S3_BUCKET, STORAGE_S3_ACCESS_KEY_ID and STORAGE_S3_SECRET_ACCESS_KEY — or, for a preview environment that serves no real users, set ALLOW_LOCAL_STORAGE=true.',
          );
        }

        const adapter = new LocalStorageAdapter(configService);
        if (process.env.NODE_ENV === 'production') {
          // Loud, and every time. This deployment discards stored photos on every
          // restart; that must not be something anyone discovers by accident later.
          logger.warn(
            'ALLOW_LOCAL_STORAGE is set: biometric photos are being written to an EPHEMERAL filesystem and will be lost on the next deploy or restart. Never use this for a deployment with real users.',
          );
        }
        logger.log(`Blob storage: ${adapter.describe()}`);
        return adapter;
      },
      inject: [ConfigService],
    },
  ],
  exports: [StorageService],
})
export class StorageModule {}
