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
  selectedCompanyId?: string | null;
}): RlsContext {
  if (caller.permissions.includes(Permission.CROSS_COMPANY_ACCESS)) {
    // 019 FR-010. A cross-company caller who has **chosen** a company is scoped to it, so
    // every list, report and creation reflects the selection without each of them being
    // changed. One who has chosen nothing keeps the bypass, which is what Super Admin needs
    // for the screens that legitimately span companies.
    //
    // The selection narrowing the scope rather than widening it is the whole safety property
    // here: the worst a forged or stale selection can do is show the caller less than they are
    // entitled to. It can never show them more, because narrowing is all it does.
    if (caller.selectedCompanyId) {
      return { isSuperAdmin: false, companyId: caller.selectedCompanyId };
    }
    return { isSuperAdmin: true };
  }
  // A company-scoped caller's own company always wins. A selection must never widen scope,
  // which is the same rule `companyScope()` and `resolveCompanyId()` follow.
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
    // The session's time zone, pinned to UTC for the length of this transaction (025 FR-041).
    //
    // **Found on 2026-10-05 by asking a running server for one day's measurement and being told
    // nothing had happened.** Every `DateTime` column in this schema is `timestamp without time
    // zone`, and Prisma binds a JS `Date` as `timestamptz` — so comparing one against the other
    // makes Postgres convert the stored value *using the session time zone*. The developer
    // database runs `Asia/Kolkata`, so a work date stored as `2026-10-04 00:00:00` was read as
    // 18:30 the previous day, and a period beginning on the 4th excluded it.
    //
    // The effect was not a missing row here and there: **the whole window shifted by a day**. A
    // bill for the 21st to the 20th claimed the 22nd to the 21st, quietly, and the first day's
    // measurement fell out of the claim entirely. Nothing failed; the figures were simply wrong.
    //
    // Pinned here rather than patched at each query because this is not one query's bug — it is
    // every comparison between a bound `Date` and a naive column, in every module. Transaction
    // local (`set_config(..., true)`), so no connection in the pool is left altered.
    //
    // Safe because this codebase computes every date in JavaScript — `zonedDateOnly` does the one
    // genuine time-zone conversion the product needs, against the configured company time zone, and
    // no query reads the clock from the database except one `NOW()` writing an `updatedAt`.
    await tx.$executeRaw`SELECT set_config('TimeZone', 'UTC', true)`;
    return fn(tx);
  });
}
