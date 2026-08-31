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

        const adapter = new LocalStorageAdapter(configService);
        if (process.env.NODE_ENV === 'production') {
          // Loud, because the consequence is silent data loss rather than an
          // error: the app runs correctly right up until the host restarts and
          // every stored photo is gone.
          logger.warn(
            'STORAGE_DRIVER is "local" in production. This host\'s filesystem is ' +
              'ephemeral — stored photos will be lost on the next deploy or restart. ' +
              'Set STORAGE_DRIVER=s3 with R2 credentials.',
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
