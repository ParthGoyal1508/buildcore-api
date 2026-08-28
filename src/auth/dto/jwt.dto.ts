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
   * Issued at
   */
  iat: number;
  /**
   * Expiration time
   */
  exp: number;
}
