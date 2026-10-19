import { NotFoundException } from '@nestjs/common';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LocalStorageAdapter } from './local-storage.adapter';
import { S3StorageAdapter } from './s3-storage.adapter';

/**
 * A stored file that has gone missing is a 404 for that file, from either adapter (036 Wave 5).
 *
 * Found in the browser walkthrough: every page that shows a company logo answered 500 when the
 * blob behind `logoRef` was absent, because the raw ENOENT reached the error filter.
 */
const KEY = Buffer.alloc(32, 7).toString('hex');

function config(storage: Record<string, unknown>) {
  return { get: () => ({ encryptionKey: KEY, ...storage }) } as never;
}

describe('a missing stored file', () => {
  it('is a NotFoundException from the local adapter', async () => {
    const root = mkdtempSync(join(tmpdir(), 'buildcore-storage-'));
    const adapter = new LocalStorageAdapter(config({ local: { path: root } }));

    await expect(adapter.get('company-logo/x/gone')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('is a NotFoundException from the S3 adapter on NoSuchKey', async () => {
    const adapter = new S3StorageAdapter(
      config({
        s3: {
          endpoint: 'http://localhost:9000',
          bucket: 'b',
          accessKeyId: 'a',
          secretAccessKey: 's',
        },
      }),
    );
    const noSuchKey = Object.assign(new Error('missing'), { name: 'NoSuchKey' });
    (adapter as unknown as { client: { send: jest.Mock } }).client = {
      send: jest.fn().mockRejectedValue(noSuchKey),
    };

    await expect(adapter.get('company-logo/x/gone')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('still surfaces other S3 failures as they are', async () => {
    const adapter = new S3StorageAdapter(
      config({
        s3: {
          endpoint: 'http://localhost:9000',
          bucket: 'b',
          accessKeyId: 'a',
          secretAccessKey: 's',
        },
      }),
    );
    const denied = Object.assign(new Error('denied'), { name: 'AccessDenied' });
    (adapter as unknown as { client: { send: jest.Mock } }).client = {
      send: jest.fn().mockRejectedValue(denied),
    };

    await expect(adapter.get('ref')).rejects.toBe(denied);
  });
});
