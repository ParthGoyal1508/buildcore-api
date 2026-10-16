import { Permission } from '@prisma/client';

export interface JwtDto {
  userId: string;
  /** Union of every role this account holds, as of token issuance — re-verified
   * fresh from the DB on every request regardless (FR-009, jwt.strategy.ts). */
  permissions: Permission[];
  companyId: string | null;
  mustChangePassword: boolean;
  name: string;
  /**
   * The refresh-token family this access token was minted for — "which signed-in device"
   * (029 FR-006). Lets a password change sign out every *other* device and keep this one.
   * Optional: tokens issued before 029 have none, and are treated as belonging to no
   * session in particular.
   */
  sid?: string;
  /**
   * Issued at
   */
  iat: number;
  /**
   * Expiration time
   */
  exp: number;
}
