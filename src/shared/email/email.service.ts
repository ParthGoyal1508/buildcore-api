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

  /**
   * Sends one employee their payslip for one period (021 FR-005) — `bugs.md` item 8.
   *
   * The PDF is passed in rendered rather than fetched here, for the reason the invite's URL is: the
   * caller already holds the authoritative `SalarySlipView` and this transport has no business
   * reading payroll. It also means a slip and its on-screen figures cannot diverge, since both come
   * from the one object.
   *
   * Throws `EmailDeliveryError` on rejection, which the caller records per employee rather than
   * letting it abandon the run — one bad address must not stop the other 499.
   */
  abstract sendPayslipEmail(input: {
    to: string;
    employeeName: string;
    /** "February 2026", already worded — this transport does not format dates. */
    periodLabel: string;
    companyName: string;
    pdf: Buffer;
    filename: string;
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
