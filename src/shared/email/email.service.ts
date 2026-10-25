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
 *
 * Every message takes the recipient's `companyId` (2026-10-24): the email carries that company's
 * logo, so a Parth Realcon employee and a Tirupati Enterprises employee each see their own. Null
 * — an account with no home company — falls back to the group name.
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
    companyId?: string | null;
    setPasswordUrl: string;
    /** A resend reads differently from a first invite — the recipient may have
     * already tried the earlier link and found it dead. */
    isResend: boolean;
    expiresAt: Date;
  }): Promise<void>;

  /** Feature 001 FR-015: tells someone their account locked after repeated failures. */
  abstract sendAccountLockedEmail(input: {
    to: string;
    companyId?: string | null;
    unlockAt: Date;
  }): Promise<void>;

  /**
   * A single-use link to choose a new password (029 FR-010, FR-015). Built by the caller for
   * the reason `setPasswordUrl` is: the raw token stays with the code that generated it.
   */
  abstract sendPasswordResetEmail(input: {
    to: string;
    companyId?: string | null;
    resetUrl: string;
    expiresAt: Date;
    requestedByAdmin: boolean;
  }): Promise<void>;

  /** After-the-fact notice that the password changed (029 FR-007, FR-013). */
  abstract sendPasswordChangedEmail(input: {
    to: string;
    companyId?: string | null;
    changedAt: Date;
    via: 'self' | 'reset_link';
  }): Promise<void>;

  /** An admin set a temporary password; the value is never in the mail (029 FR-015). */
  abstract sendAdminPasswordResetEmail(input: {
    to: string;
    companyId?: string | null;
  }): Promise<void>;

  /** The account was deactivated (029 FR-030). */
  abstract sendAccountDeactivatedEmail(input: {
    to: string;
    companyId?: string | null;
  }): Promise<void>;

  /** An admin created the account with a password they chose (029 FR-031). */
  abstract sendAccountReadyEmail(input: {
    to: string;
    companyId?: string | null;
    loginUrl: string;
    username: string | null;
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
    companyId?: string | null;
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
