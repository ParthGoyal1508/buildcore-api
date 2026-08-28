import { PrismaService } from 'nestjs-prisma';
import { Prisma, Permission } from '@prisma/client';

export interface RlsContext {
  isSuperAdmin: boolean;
  /** Ignored when `isSuperAdmin` is true. */
  companyId?: string | null;
}

/** Derives the RLS context an authenticated caller's own request should run under —
 * their own company scope, or the cross-company bypass (2026-08-28 design change:
 * this used to be keyed off a hardcoded `role === SUPER_ADMIN` enum comparison;
 * it's now driven by the CROSS_COMPANY_ACCESS permission, so any role — not just a
 * single hardcoded one — can carry that capability). */
export function rlsContextFor(caller: {
  companyId: string | null;
  permissions: Permission[];
}): RlsContext {
  if (caller.permissions.includes(Permission.CROSS_COMPANY_ACCESS)) {
    return { isSuperAdmin: true };
  }
  return { isSuperAdmin: false, companyId: caller.companyId };
}

/**
 * Runs `fn` inside a transaction with the Postgres session-local values that every
 * tenant-scoped table's `tenant_isolation` RLS policy checks (migrations
 * `20260828162304_multi_schema_and_auth_extensions` and
 * `20260828170000_role_permission_model`) — set via `set_config(..., true)`, the SQL
 * equivalent of `SET LOCAL`, so the context can never leak past this one transaction.
 *
 * `{ isSuperAdmin: true }` is used both for a caller who actually holds
 * CROSS_COMPANY_ACCESS AND for a handful of lookups that identify a single row by a
 * value the caller can't forge (a correct password during login, a valid opaque
 * refresh token, the server's own signed JWT claim) rather than by an arbitrary
 * company-scoped filter — see auth.service.ts/jwt.strategy.ts for which specific
 * lookups do this. The session-variable name (`app.is_super_admin`) predates the
 * permission-based redesign and wasn't worth renaming across already-applied
 * migrations — it's internal plumbing, not user-facing.
 */
export function withRlsContext<T>(
  prisma: PrismaService,
  ctx: RlsContext,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const isSuperAdmin = ctx.isSuperAdmin;
  const companyId = isSuperAdmin ? '' : ctx.companyId ?? '';

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.is_super_admin', ${
      isSuperAdmin ? 'true' : 'false'
    }, true)`;
    await tx.$executeRaw`SELECT set_config('app.current_company_id', ${companyId}, true)`;
    return fn(tx);
  });
}
