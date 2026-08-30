import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { StorageConfig } from '../configs/config.interface';
import { decryptBlob, encryptBlob, parseEncryptionKey } from './blob-cipher';
import { StorageService, newStorageRef } from './storage.service';

/**
 * S3-compatible object storage — the production adapter.
 *
 * Targets Cloudflare R2, and works unchanged against Supabase Storage or Backblaze
 * B2, because all three speak the S3 API. That portability is the reason the
 * constitution pre-approved the S3 client rather than a provider-specific SDK: it
 * keeps a provider change to four environment variables.
 *
 * Blobs are encrypted before they leave the process (see `blob-cipher.ts`), so the
 * provider stores ciphertext it holds no key for.
 */
@Injectable()
export class S3StorageAdapter extends StorageService {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly key: Buffer;
  private readonly endpoint: string;

  constructor(configService: ConfigService) {
    super();
    const config = configService.get<StorageConfig>('storage');
    this.key = parseEncryptionKey(config.encryptionKey);

    const missing = (
      [
        ['STORAGE_S3_ENDPOINT', config.s3.endpoint],
        ['STORAGE_S3_BUCKET', config.s3.bucket],
        ['STORAGE_S3_ACCESS_KEY_ID', config.s3.accessKeyId],
        ['STORAGE_S3_SECRET_ACCESS_KEY', config.s3.secretAccessKey],
      ] as const
    )
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missing.length > 0) {
      // Fail at construction, which means at application startup, rather than on
      // the first photo upload. A storage misconfiguration that only surfaces when
      // a worker tries to punch in is one discovered by the worker.
      throw new Error(
        `STORAGE_DRIVER=s3 requires: ${missing.join(
          ', ',
        )}. Set them or use STORAGE_DRIVER=local for development.`,
      );
    }

    this.bucket = config.s3.bucket;
    this.endpoint = config.s3.endpoint;
    this.client = new S3Client({
      endpoint: config.s3.endpoint,
      region: config.s3.region,
      // R2 and most S3-compatible providers require path-style addressing; real
      // AWS S3 prefers virtual-host style, hence the config switch.
      forcePathStyle: config.s3.forcePathStyle,
      credentials: {
        accessKeyId: config.s3.accessKeyId,
        secretAccessKey: config.s3.secretAccessKey,
      },
    });
  }

  async put(
    namespace: string,
    data: Buffer,
    contentType: string,
  ): Promise<string> {
    const ref = newStorageRef(namespace);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: ref,
        Body: encryptBlob(data, this.key),
        // The declared type describes the plaintext, for whoever eventually reads
        // it back; the stored bytes are ciphertext either way.
        ContentType: contentType,
      }),
    );
    return ref;
  }

  async get(ref: string): Promise<Buffer> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: ref }),
    );
    const bytes = await response.Body.transformToByteArray();
    return decryptBlob(Buffer.from(bytes), this.key);
  }

  async delete(ref: string): Promise<void> {
    // S3 delete is already idempotent — deleting a missing key succeeds — which
    // matches the contract StorageService documents.
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: ref }),
    );
  }

  describe(): string {
    return `S3-compatible bucket "${this.bucket}" at ${this.endpoint}`;
  }
}
