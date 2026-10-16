import { Injectable, Logger } from '@nestjs/common';
import { EmailService } from './email.service';
import {
  renderAccountDeactivatedEmail,
  renderAccountLockedEmail,
  renderAccountReadyEmail,
  renderAdminPasswordResetEmail,
  renderInviteEmail,
  renderPasswordChangedEmail,
  renderPasswordResetEmail,
  renderPayslipEmail,
} from './email-templates';

/**
 * Writes email to the application log instead of sending it — the dev/test adapter.
 *
 * This exists so the invite flow is exercisable without an API key or a verified
 * sending domain. Domain verification needs DNS changes and propagation time, and
 * without this adapter none of account creation could be run or tested until that
 * was finished — a prerequisite unrelated to any of the logic under test.
 *
 * The set-password URL is logged in full and deliberately: it is the only way to
 * reach the next step locally. That is also precisely why this adapter must never
 * run in production, where the same line would put a live credential-setting link
 * into the log stream — `EmailModule` refuses to select it there.
 */
@Injectable()
export class ConsoleEmailAdapter extends EmailService {
  private readonly logger = new Logger('EmailService');

  async sendInviteEmail(input: {
    to: string;
    setPasswordUrl: string;
    isResend: boolean;
    expiresAt: Date;
  }): Promise<void> {
    const { subject } = renderInviteEmail(input);
    this.logger.log(
      [
        '',
        '──────── invite email (not sent — console adapter) ────────',
        `  to:      ${input.to}`,
        `  subject: ${subject}`,
        `  resend:  ${input.isResend}`,
        `  expires: ${input.expiresAt.toISOString()}`,
        `  link:    ${input.setPasswordUrl}`,
        '───────────────────────────────────────────────────────────',
      ].join('\n'),
    );
  }

  async sendAccountLockedEmail(input: {
    to: string;
    unlockAt: Date;
  }): Promise<void> {
    const { subject } = renderAccountLockedEmail(input);
    this.logger.log(
      `[console adapter] ${subject} → ${
        input.to
      } (unlocks ${input.unlockAt.toISOString()})`,
    );
  }

  async sendPasswordResetEmail(input: {
    to: string;
    resetUrl: string;
    expiresAt: Date;
    requestedByAdmin: boolean;
  }): Promise<void> {
    const { subject } = renderPasswordResetEmail(input);
    // The link in full, as the invite's is, and for the same reason: it is the only way to
    // reach the next step locally — and why this adapter is refused in production.
    this.logger.log(
      [
        '',
        '──────── password reset email (not sent — console adapter) ────────',
        `  to:      ${input.to}`,
        `  subject: ${subject}`,
        `  by admin: ${input.requestedByAdmin}`,
        `  expires: ${input.expiresAt.toISOString()}`,
        `  link:    ${input.resetUrl}`,
        '────────────────────────────────────────────────────────────────────',
      ].join('\n'),
    );
  }

  async sendPasswordChangedEmail(input: {
    to: string;
    changedAt: Date;
    via: 'self' | 'reset_link';
  }): Promise<void> {
    const { subject } = renderPasswordChangedEmail(input);
    this.logger.log(`[console adapter] ${subject} → ${input.to}`);
  }

  async sendAdminPasswordResetEmail(input: { to: string }): Promise<void> {
    const { subject } = renderAdminPasswordResetEmail();
    this.logger.log(`[console adapter] ${subject} → ${input.to}`);
  }

  async sendAccountDeactivatedEmail(input: { to: string }): Promise<void> {
    const { subject } = renderAccountDeactivatedEmail();
    this.logger.log(`[console adapter] ${subject} → ${input.to}`);
  }

  async sendAccountReadyEmail(input: {
    to: string;
    loginUrl: string;
    username: string | null;
  }): Promise<void> {
    const { subject } = renderAccountReadyEmail(input);
    this.logger.log(
      `[console adapter] ${subject} → ${input.to} (sign in at ${input.loginUrl})`,
    );
  }

  async sendPayslipEmail(input: {
    to: string;
    employeeName: string;
    periodLabel: string;
    companyName: string;
    pdf: Buffer;
    filename: string;
  }): Promise<void> {
    const { subject } = renderPayslipEmail(input);
    // The attachment's *size* and not its contents: a payslip is regulated data and this adapter
    // writes to the application log. The size is the one fact worth having — a zero-byte PDF is the
    // failure a local run is most likely to produce and least likely to notice.
    this.logger.log(
      `[console adapter] ${subject} → ${input.to} (${input.filename}, ${input.pdf.length} bytes)`,
    );
  }

  describe(): string {
    return 'console (messages are logged, not sent)';
  }
}
