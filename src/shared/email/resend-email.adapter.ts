import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import type { EmailConfig } from '../../common/configs/config.interface';
import { EmailDeliveryError, EmailService } from './email.service';
import {
  RenderedEmail,
  renderAccountLockedEmail,
  renderInviteEmail,
} from './email-templates';

/**
 * Real delivery through Resend — the production adapter (constitution v1.3.0,
 * research.md §5; master PRD §7.1 names Resend specifically).
 */
@Injectable()
export class ResendEmailAdapter extends EmailService {
  private readonly logger = new Logger('EmailService');
  private readonly client: Resend;
  private readonly from: string;

  constructor(configService: ConfigService) {
    super();
    const config = configService.get<EmailConfig>('email');

    const missing = (
      [
        ['RESEND_API_KEY', config.apiKey],
        ['EMAIL_FROM_ADDRESS', config.fromAddress],
        ['APP_BASE_URL', config.appBaseUrl],
      ] as const
    )
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missing.length > 0) {
      // Fails at construction, so a misconfiguration surfaces when the process
      // starts rather than when an admin invites someone and the invite silently
      // never arrives.
      throw new Error(
        `EMAIL_DRIVER=resend requires: ${missing.join(
          ', ',
        )}. Set them, or use EMAIL_DRIVER=console outside production.`,
      );
    }

    this.client = new Resend(config.apiKey);
    this.from = config.fromAddress;
  }

  private async send(to: string, message: RenderedEmail): Promise<void> {
    // Resend's SDK reports failures in the response body rather than by throwing,
    // so a caller that only wrapped this in try/catch would treat every rejected
    // send as a success.
    const { error } = await this.client.emails.send({
      from: this.from,
      to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    if (error) {
      // The recipient is logged; the message body is not, since an invite body
      // contains a live credential-setting link.
      this.logger.error(`Resend rejected a message to ${to}: ${error.message}`);
      throw new EmailDeliveryError(error.message, error);
    }
  }

  async sendInviteEmail(input: {
    to: string;
    setPasswordUrl: string;
    isResend: boolean;
    expiresAt: Date;
  }): Promise<void> {
    await this.send(input.to, renderInviteEmail(input));
  }

  async sendAccountLockedEmail(input: {
    to: string;
    unlockAt: Date;
  }): Promise<void> {
    await this.send(input.to, renderAccountLockedEmail(input));
  }

  describe(): string {
    return `Resend (from ${this.from})`;
  }
}
