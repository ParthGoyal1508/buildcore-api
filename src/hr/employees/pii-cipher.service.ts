import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  decryptBlob,
  encryptBlob,
  parseEncryptionKey,
} from '../../common/storage/blob-cipher';
import type { StorageConfig } from '../../common/configs/config.interface';

/**
 * Field-level encryption for the four regulated-PII columns the constitution names
 * (Aadhaar, PAN, bank account number, UAN) — Principle IV.
 *
 * Deliberately reuses `blob-cipher`'s AES-256-GCM primitives and the same
 * `STORAGE_ENCRYPTION_KEY` rather than introducing a second cipher, a second key,
 * or a second key-rotation story. The only difference is the envelope's transport
 * form: blobs are stored as raw `Buffer`s by the storage adapters, whereas these
 * live in `text` columns, so the envelope is base64-encoded on the way in and
 * decoded on the way out.
 *
 * GCM matters here for the same reason it does for blobs: a tampered ciphertext
 * fails loudly instead of decrypting to plausible-looking garbage that would then be
 * rendered to a user as though it were someone's real Aadhaar number.
 */
@Injectable()
export class PiiCipherService {
  private readonly key: Buffer;

  constructor(configService: ConfigService) {
    const storage = configService.get<StorageConfig>('storage');
    // Fatal-on-missing is inherited from parseEncryptionKey: an app that starts
    // without a key would write PII nothing can ever read back.
    this.key = parseEncryptionKey(storage?.encryptionKey);
  }

  /**
   * Encrypts a PII value for storage. Returns null for null/empty input so an
   * absent value stays absent rather than becoming an encrypted empty string —
   * which would be indistinguishable from a real value at the column level.
   */
  encrypt(plaintext: string | null | undefined): string | null {
    if (plaintext === null || plaintext === undefined) return null;
    const trimmed = plaintext.trim();
    if (trimmed === '') return null;
    return encryptBlob(Buffer.from(trimmed, 'utf8'), this.key).toString(
      'base64',
    );
  }

  /**
   * Decrypts a stored PII value. Only the audited reveal path should call this —
   * every other read path must use `mask()` instead.
   */
  decrypt(envelope: string | null | undefined): string | null {
    if (!envelope) return null;
    return decryptBlob(Buffer.from(envelope, 'base64'), this.key).toString(
      'utf8',
    );
  }

  /**
   * The default read shape: last four characters only, e.g. `XXXXXXXX1234`.
   *
   * Masks from the *decrypted* value, because the ciphertext's last four
   * characters are meaningless. Callers therefore still decrypt — the protection
   * this gives is that the plaintext never leaves the service, not that it is never
   * produced. Returns null when there is nothing stored, so "no Aadhaar on file"
   * and "an Aadhaar the caller may not see" stay distinguishable.
   */
  mask(envelope: string | null | undefined): string | null {
    const plain = this.decrypt(envelope);
    if (plain === null) return null;
    return PiiCipherService.maskValue(plain);
  }

  /** Pure masking of an already-plaintext value; shared with the interceptor. */
  static maskValue(plain: string): string {
    const visible = 4;
    if (plain.length <= visible) return 'X'.repeat(plain.length);
    return 'X'.repeat(plain.length - visible) + plain.slice(-visible);
  }
}
