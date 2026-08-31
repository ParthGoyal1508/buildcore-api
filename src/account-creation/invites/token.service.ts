import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { INVITE_TOKEN_BYTES } from '../constants/account-creation.constants';

export interface GeneratedToken {
  /** Goes into the emailed link. Never stored, never logged. */
  raw: string;
  /** What the database keeps. */
  hash: string;
}

/**
 * Invite-token generation, mirroring how 001 already handles refresh tokens
 * (research.md §2): a long random value whose SHA-256 hash is all that is persisted.
 *
 * The consequence worth stating: a stolen database backup contains no usable invite
 * links, because hashes cannot be reversed into the value the link carries.
 */
@Injectable()
export class TokenService {
  generate(): GeneratedToken {
    const raw = randomBytes(INVITE_TOKEN_BYTES).toString('hex');
    return { raw, hash: this.hash(raw) };
  }

  /**
   * Hashes an incoming token for lookup.
   *
   * Plain SHA-256 rather than a slow password hash, deliberately: the input is 32
   * bytes of CSPRNG output, not a human-chosen secret, so there is no dictionary to
   * defend against and nothing for key stretching to buy. It also keeps validation a
   * single indexed lookup instead of a scan comparing every stored row.
   */
  hash(rawToken: string): string {
    return createHash('sha256').update(rawToken).digest('hex');
  }
}
