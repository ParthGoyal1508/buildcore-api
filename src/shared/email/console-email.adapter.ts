import { Injectable, Logger } from '@nestjs/common';
import { EmailService } from './email.service';
import { renderAccountLockedEmail, renderInviteEmail } from './email-templates';

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

  describe(): string {
    return 'console (messages are logged, not sent)';
  }
}
