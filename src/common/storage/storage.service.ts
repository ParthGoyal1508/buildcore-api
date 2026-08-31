import { randomUUID } from 'crypto';

/**
 * The contract every blob adapter implements.
 *
 * Modules depend on this abstract class, never on a concrete adapter or on the AWS
 * SDK directly (constitution v1.4.0). That indirection is what lets the same code
 * run against encrypted local files in development and object storage in
 * production, and it is why swapping Cloudflare R2 for another S3-compatible
 * provider is a config change rather than a code change.
 *
 * An abstract class rather than a TypeScript `interface` because Nest resolves
 * providers by runtime token: an interface is erased at compile time and cannot be
 * injected without a separate string token to keep in sync.
 */
export abstract class StorageService {
  /**
   * Stores a blob and returns an opaque reference to it.
   *
   * The reference is what callers persist in Postgres. It carries no information a
   * caller should act on — treating it as a URL or a filesystem path is exactly the
   * coupling this abstraction exists to prevent.
   */
  abstract put(
    namespace: string,
    data: Buffer,
    contentType: string,
  ): Promise<string>;

  /** Retrieves and decrypts a blob. Throws if the reference is unknown. */
  abstract get(ref: string): Promise<Buffer>;

  /**
   * Permanently removes a blob. Idempotent: deleting an already-deleted reference
   * succeeds rather than throwing, because both consent withdrawal (FR-004) and
   * retention cleanup can legitimately race each other over the same photo, and
   * neither should fail because the other got there first.
   */
  abstract delete(ref: string): Promise<void>;

  /** Best-effort bulk delete. Never throws for a missing reference. */
  async deleteMany(refs: string[]): Promise<void> {
    await Promise.all(refs.map((ref) => this.delete(ref)));
  }
}

/**
 * Builds an opaque storage reference.
 *
 * A random UUID, not anything derived from the subject: a reference built from an
 * employee id would leak who a blob belongs to to anyone who could enumerate the
 * bucket, and biometric data is precisely what Principle IV says must not be
 * casually attributable.
 */
export function newStorageRef(namespace: string): string {
  return `${namespace}/${randomUUID()}`;
}
