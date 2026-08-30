import { randomBytes } from 'crypto';
import { decryptBlob, encryptBlob, parseEncryptionKey } from './blob-cipher';

const KEY = randomBytes(32);

describe('parseEncryptionKey', () => {
  it('accepts a 64-character hex key', () => {
    expect(parseEncryptionKey(KEY.toString('hex'))).toEqual(KEY);
  });

  it('tolerates surrounding whitespace from an env file', () => {
    expect(parseEncryptionKey(` ${KEY.toString('hex')} `)).toEqual(KEY);
  });

  it('refuses to start without a key rather than inventing one', () => {
    // A generated fallback would let the app write blobs nothing can ever decrypt.
    expect(() => parseEncryptionKey(undefined)).toThrow(/not set/);
  });

  it('rejects a key of the wrong length', () => {
    expect(() => parseEncryptionKey('abcd')).toThrow(/64 hex characters/);
  });

  it('rejects a non-hex key', () => {
    expect(() => parseEncryptionKey('z'.repeat(64))).toThrow(
      /64 hex characters/,
    );
  });
});

describe('blob encryption', () => {
  const plaintext = Buffer.from('a face photo’s bytes', 'utf8');

  it('round-trips', () => {
    expect(decryptBlob(encryptBlob(plaintext, KEY), KEY)).toEqual(plaintext);
  });

  it('round-trips an empty buffer', () => {
    expect(decryptBlob(encryptBlob(Buffer.alloc(0), KEY), KEY)).toEqual(
      Buffer.alloc(0),
    );
  });

  it('produces different ciphertext each time for the same input', () => {
    // A fresh random IV per blob. Reused IVs are what break GCM catastrophically.
    const a = encryptBlob(plaintext, KEY);
    const b = encryptBlob(plaintext, KEY);
    expect(a.equals(b)).toBe(false);
  });

  it('does not leave the plaintext recoverable in the envelope', () => {
    const envelope = encryptBlob(plaintext, KEY);
    expect(envelope.includes(plaintext)).toBe(false);
  });

  it('fails to decrypt with the wrong key', () => {
    expect(() =>
      decryptBlob(encryptBlob(plaintext, KEY), randomBytes(32)),
    ).toThrow();
  });

  it('detects tampering rather than returning garbage', () => {
    // The whole reason for GCM over CBC: a modified blob must fail loudly, not
    // yield plausible bytes that a face matcher would then compare against.
    const envelope = encryptBlob(plaintext, KEY);
    envelope[envelope.length - 1] ^= 0xff;
    expect(() => decryptBlob(envelope, KEY)).toThrow();
  });

  it('rejects a truncated envelope', () => {
    expect(() => decryptBlob(Buffer.alloc(4), KEY)).toThrow(/truncated/);
  });
});
