import { Injectable, Logger } from '@nestjs/common';
import { RefreshTokenService } from '../auth/refresh-token.service';
import { EmailService } from '../shared/email/email.service';

/**
 * What follows an account being switched off (029 FR-030).
 *
 * Its sessions are revoked rather than left to fail: `JwtStrategy` and `refresh()` already refuse a
 * deactivated account, so this changes no outcome — but a revoked session is one nobody can bring
 * back by reactivating the account, which is the right default for a login whose holder may have
 * left. And the holder is told, because an account that silently stops working reads as a bug.
 */
@Injectable()
export class AccountDeactivationService {
  private readonly logger = new Logger(AccountDeactivationService.name);

  constructor(
    private readonly refreshTokens: RefreshTokenService,
    private readonly email: EmailService,
  ) {}

  async afterDeactivation(account: {
    id: string;
    email: string;
  }): Promise<void> {
    await this.refreshTokens.revokeAllForAccount(account.id);
    try {
      await this.email.sendAccountDeactivatedEmail({ to: account.email });
    } catch (error) {
      // The account is deactivated either way; the notice is a courtesy.
      this.logger.error(
        `Deactivation notice failed for ${account.email}. ${
          (error as Error).message
        }`,
      );
    }
  }
}
