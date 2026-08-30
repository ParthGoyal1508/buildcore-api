import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'fs';
import { dirname, join, resolve, sep } from 'path';
import type { StorageConfig } from '../configs/config.interface';
import { decryptBlob, encryptBlob, parseEncryptionKey } from './blob-cipher';
import { StorageService, newStorageRef } from './storage.service';

/**
 * Encrypted-filesystem blob storage, for development and tests.
 *
 * NOT viable in production: the deployed host's filesystem is ephemeral and cannot
 * take a persistent disk, so blobs written here vanish on the next deploy or idle
 * spin-down (constitution v1.4.0). `StorageModule` logs a warning if this adapter
 * is ever selected outside development, because the failure is otherwise silent —
 * everything works until the first restart.
 */
@Injectable()
export class LocalStorageAdapter extends StorageService {
  private readonly logger = new Logger(LocalStorageAdapter.name);
  private readonly root: string;
  private readonly key: Buffer;

  constructor(configService: ConfigService) {
    super();
    const config = configService.get<StorageConfig>('storage');
    this.root = resolve(process.cwd(), config.local.path);
    this.key = parseEncryptionKey(config.encryptionKey);
  }

  /**
   * Maps a reference to a path, refusing anything that escapes the root.
   *
   * References are generated internally, so a traversal sequence should be
   * impossible — but this is the one place where a bad reference turns into a
   * filesystem write at an attacker-chosen path, and "should be impossible" is not
   * the standard to apply at that boundary.
   */
  private pathFor(ref: string): string {
    const target = resolve(this.root, ref);
    if (target !== this.root && !target.startsWith(this.root + sep)) {
      throw new Error(
        `Refusing to resolve storage reference outside root: ${ref}`,
      );
    }
    return target;
  }

  async put(
    namespace: string,
    data: Buffer,
    _contentType: string,
  ): Promise<string> {
    const ref = newStorageRef(namespace);
    const target = this.pathFor(ref);
    await fs.mkdir(dirname(target), { recursive: true });

    // Write to a temporary name and rename into place. Rename is atomic within a
    // filesystem, so a crash mid-write leaves either no blob or a complete one —
    // never a half-written file that decryption would later fail on.
    const temp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(temp, encryptBlob(data, this.key), { mode: 0o600 });
    await fs.rename(temp, target);
    return ref;
  }

  async get(ref: string): Promise<Buffer> {
    const envelope = await fs.readFile(this.pathFor(ref));
    return decryptBlob(envelope, this.key);
  }

  async delete(ref: string): Promise<void> {
    try {
      await fs.unlink(this.pathFor(ref));
    } catch (error) {
      // Already gone is the desired end state, not a failure — see StorageService.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  /** Where blobs are being written — surfaced at startup so a developer wondering
   * where the photos went does not have to read the config to find out. */
  describe(): string {
    return `local filesystem at ${join(this.root)}`;
  }
}
