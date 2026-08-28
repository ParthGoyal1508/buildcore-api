import { Injectable, Logger } from '@nestjs/common';

/**
 * Minimal mail-sending abstraction (spec FR-015 needs a lockout notification email).
 * No email provider is wired/approved yet, so this logs instead of sending — swap the
 * body of these methods for a real provider (e.g. Resend, per 010-account-creation-
 * backend's research) without touching any caller.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  async sendAccountLockedEmail(to: string, unlockAt: Date): Promise<void> {
    this.logger.log(
      `[stub] account-locked email → ${to}: locked until ${unlockAt.toISOString()}`,
    );
  }
}
