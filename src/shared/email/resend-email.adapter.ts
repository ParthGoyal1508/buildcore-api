import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { Resend } from 'resend';
import type {
  EmailConfig,
  SettingsConfig,
} from '../../common/configs/config.interface';
import { CompaniesService } from '../../settings/companies/companies.service';
import { EmailDeliveryError, EmailService } from './email.service';
import {
  EmailBrand,
  LOGO_CONTENT_ID,
  RenderOptions,
  RenderedEmail,
  renderAccountDeactivatedEmail,
  renderAccountLockedEmail,
  renderAccountReadyEmail,
  renderAdminPasswordResetEmail,
  renderEmailLayout,
  renderInviteEmail,
  renderPasswordChangedEmail,
  renderPasswordResetEmail,
  renderPayslipEmail,
} from './email-templates';

/** How long a company's name and logo are reused before being read again. */
const BRAND_CACHE_MS = 10 * 60 * 1000;

interface Attachment {
  filename: string;
  content: Buffer;
  contentId?: string;
}

interface ResolvedBrand {
  brand: EmailBrand;
  logo: Attachment | null;
}

/** JPEG and PNG are what the company form accepts; the extension is how Resend types the part. */
const logoFilename = (bytes: Buffer): string =>
  bytes.subarray(0, 4).toString('hex') === '89504e47' ? 'logo.png' : 'logo.jpg';

/**
 * Real delivery through Resend — the production adapter (constitution v1.3.0,
 * research.md §5; master PRD §7.1 names Resend specifically).
 */
@Injectable()
export class ResendEmailAdapter extends EmailService {
  private readonly logger = new Logger('EmailService');
  private readonly client: Resend;
  private readonly from: string;
  private readonly renderOptions: RenderOptions;
  private readonly brands = new Map<
    string,
    { at: number; value: Promise<ResolvedBrand> }
  >();

  constructor(
    configService: ConfigService,
    // Resolved per send rather than injected: `settings` reaches the email transport through its
    // users module, so importing it here would close a loop at boot.
    private readonly moduleRef: ModuleRef,
  ) {
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
    this.renderOptions = {
      timeZone: configService.get<SettingsConfig>('settings').timezone,
    };
  }

  /**
   * The recipient's company name and logo, through `settings`' exported read (Principle I).
   *
   * Cached briefly, because a payroll run sends one per employee for the same company. A logo that
   * cannot be read sends the email with the name in its place: an invite is never held back for
   * want of a picture.
   */
  private brandFor(
    companyId: string | null | undefined,
  ): Promise<ResolvedBrand> {
    if (!companyId) {
      return Promise.resolve({
        brand: { companyName: null, hasLogo: false },
        logo: null,
      });
    }
    const cached = this.brands.get(companyId);
    if (cached && Date.now() - cached.at < BRAND_CACHE_MS) return cached.value;

    const value = this.moduleRef
      .get(CompaniesService, { strict: false })
      .getDocumentIdentity(companyId)
      .then(
        ({ name, logo }): ResolvedBrand => ({
          brand: { companyName: name || null, hasLogo: logo !== null },
          logo: logo
            ? {
                filename: logoFilename(logo),
                content: logo,
                contentId: LOGO_CONTENT_ID,
              }
            : null,
        }),
      )
      .catch((error: Error): ResolvedBrand => {
        this.brands.delete(companyId);
        this.logger.warn(
          `Company ${companyId} could not be read for email branding; sending unbranded. ${error.message}`,
        );
        return { brand: { companyName: null, hasLogo: false }, logo: null };
      });
    this.brands.set(companyId, { at: Date.now(), value });
    return value;
  }

  private async send(
    to: string,
    companyId: string | null | undefined,
    message: RenderedEmail,
    attachments: Attachment[] = [],
  ): Promise<void> {
    const { brand, logo } = await this.brandFor(companyId);
    const parts = logo ? [logo, ...attachments] : attachments;
    // Resend's SDK reports failures in the response body rather than by throwing,
    // so a caller that only wrapped this in try/catch would treat every rejected
    // send as a success.
    const { error } = await this.client.emails.send({
      from: this.from,
      to,
      subject: message.subject,
      text: message.text,
      html: renderEmailLayout(message.html, brand),
      ...(parts.length > 0 ? { attachments: parts } : {}),
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
    companyId?: string | null;
    setPasswordUrl: string;
    isResend: boolean;
    expiresAt: Date;
  }): Promise<void> {
    await this.send(
      input.to,
      input.companyId,
      renderInviteEmail(input, this.renderOptions),
    );
  }

  async sendAccountLockedEmail(input: {
    to: string;
    companyId?: string | null;
    unlockAt: Date;
  }): Promise<void> {
    await this.send(
      input.to,
      input.companyId,
      renderAccountLockedEmail(input, this.renderOptions),
    );
  }

  async sendPasswordResetEmail(input: {
    to: string;
    companyId?: string | null;
    resetUrl: string;
    expiresAt: Date;
    requestedByAdmin: boolean;
  }): Promise<void> {
    await this.send(
      input.to,
      input.companyId,
      renderPasswordResetEmail(input, this.renderOptions),
    );
  }

  async sendPasswordChangedEmail(input: {
    to: string;
    companyId?: string | null;
    changedAt: Date;
    via: 'self' | 'reset_link';
  }): Promise<void> {
    await this.send(
      input.to,
      input.companyId,
      renderPasswordChangedEmail(input, this.renderOptions),
    );
  }

  async sendAdminPasswordResetEmail(input: {
    to: string;
    companyId?: string | null;
  }): Promise<void> {
    await this.send(input.to, input.companyId, renderAdminPasswordResetEmail());
  }

  async sendAccountDeactivatedEmail(input: {
    to: string;
    companyId?: string | null;
  }): Promise<void> {
    await this.send(input.to, input.companyId, renderAccountDeactivatedEmail());
  }

  async sendAccountReadyEmail(input: {
    to: string;
    companyId?: string | null;
    loginUrl: string;
    username: string | null;
  }): Promise<void> {
    await this.send(input.to, input.companyId, renderAccountReadyEmail(input));
  }

  async sendPayslipEmail(input: {
    to: string;
    companyId?: string | null;
    employeeName: string;
    periodLabel: string;
    companyName: string;
    pdf: Buffer;
    filename: string;
  }): Promise<void> {
    await this.send(input.to, input.companyId, renderPayslipEmail(input), [
      { filename: input.filename, content: input.pdf },
    ]);
  }

  describe(): string {
    return `Resend (from ${this.from})`;
  }
}
