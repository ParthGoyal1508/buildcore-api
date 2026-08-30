import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * Envelope encryption for stored blobs.
 *
 * Applied by both adapters, including the S3 one: encrypting client-side means the
 * storage provider holds ciphertext it cannot read, so a misconfigured bucket
 * policy or a provider-side compromise exposes no biometric data. Provider-side
 * encryption alone would not give that, because the provider holds those keys.
 *
 * AES-256-GCM rather than CBC because GCM authenticates as well as encrypts: a
 * tampered blob fails to decrypt instead of yielding plausible-looking garbage that
 * a face matcher would then compare against.
 */

const ALGORITHM = 'aes-256-gcm';
/** 96 bits — the IV length GCM is specified and optimised for. */
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32;

/**
 * Parses the configured hex key, failing loudly if it is unusable.
 *
 * Deliberately fatal rather than falling back to a generated or default key. A
 * silent fallback would let the application start and cheerfully write blobs that
 * nothing can ever decrypt again — a data-loss bug that only surfaces the first
 * time someone tries to read a photo back, long after the cause is gone.
 */
export function parseEncryptionKey(hexKey: string | undefined): Buffer {
  if (!hexKey) {
    throw new Error(
      'STORAGE_ENCRYPTION_KEY is not set. Blob storage cannot start without it — ' +
        "generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hexKey.trim())) {
    throw new Error(
      `STORAGE_ENCRYPTION_KEY must be ${KEY_BYTES} bytes hex-encoded (64 hex characters); got ${
        hexKey.trim().length
      } characters.`,
    );
  }
  return Buffer.from(hexKey.trim(), 'hex');
}

/**
 * Encrypts to a self-describing envelope: `iv || authTag || ciphertext`.
 *
 * The IV and tag travel with the ciphertext rather than in separate columns so a
 * blob is decryptable from the stored bytes alone — no second lookup that could go
 * missing, and no ordering dependency between two writes.
 */
export function encryptBlob(plaintext: Buffer, key: Buffer): Buffer {
  // A fresh random IV per blob. Reusing an IV under the same key is the one thing
  // that breaks GCM catastrophically, so it is never derived from anything.
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

/** Reverses `encryptBlob`. Throws if the envelope is truncated or tampered with. */
export function decryptBlob(envelope: Buffer, key: Buffer): Buffer {
  if (envelope.length < IV_BYTES + AUTH_TAG_BYTES) {
    throw new Error(
      'Stored blob is truncated or not a valid encrypted envelope.',
    );
  }
  const iv = envelope.subarray(0, IV_BYTES);
  const authTag = envelope.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
  const ciphertext = envelope.subarray(IV_BYTES + AUTH_TAG_BYTES);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  // `final()` is what verifies the tag; it throws on any mismatch.
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
