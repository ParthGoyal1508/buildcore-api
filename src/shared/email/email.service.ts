/**
 * The transactional-email contract every adapter implements.
 *
 * An abstract class rather than a TypeScript interface for the same reason
 * `StorageService` is one: Nest resolves providers by runtime token, and an
 * interface is erased at compile time.
 *
 * This is the application's ONE email transport. Feature 001's account-lockout
 * notification was previously a separate stub in `src/auth/mail.service.ts`; folding
 * it in here means there is a single place where delivery is configured, retried, or
 * swapped — rather than each feature growing its own sender and its own idea of what
 * a failed send means.
 */
export abstract class EmailService {
  /**
   * Sends an invite carrying a set-password link.
   *
   * `setPasswordUrl` is passed in fully built rather than assembled here: the raw
   * token must never be logged or stored (research.md §2), so the one place that
   * handles it should be the caller that just generated it.
   */
  abstract sendInviteEmail(input: {
    to: string;
    setPasswordUrl: string;
    /** A resend reads differently from a first invite — the recipient may have
     * already tried the earlier link and found it dead. */
    isResend: boolean;
    expiresAt: Date;
  }): Promise<void>;

  /** Feature 001 FR-015: tells someone their account locked after repeated failures. */
  abstract sendAccountLockedEmail(input: {
    to: string;
    unlockAt: Date;
  }): Promise<void>;
}

/**
 * Raised when a provider rejects a send.
 *
 * Distinguished from a programming error so callers can apply the spec's rule:
 * creating a user succeeds and reports `emailDispatchFailed: true` rather than
 * rolling back. A created account with an undelivered invite is recoverable — the
 * admin resends. A rolled-back account whose email happened to go out is not.
 */
export class EmailDeliveryError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'EmailDeliveryError';
  }
}
