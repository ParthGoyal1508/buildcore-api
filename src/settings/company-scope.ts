import { NotFoundException } from '@nestjs/common';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { rlsContextFor } from '../common/prisma/rls-context';

/**
 * Application-layer company scoping for the per-company settings resources.
 *
 * RLS is the database-level guarantee, but it is not the only one worth having: a
 * policy is silently inert whenever the connecting Postgres role is a superuser or
 * holds BYPASSRLS, and a query with no `companyId` predicate then returns every
 * company's rows. These helpers put the same predicate in the query itself, so
 * isolation survives that misconfiguration — the belt to RLS's braces, and the same
 * thing `UsersService.findAllForCompany()` already does.
 */

/**
 * A sentinel that matches no row. Every company id is a cuid, so the empty string
 * can never collide with a real one. Used for a caller with no company assigned:
 * they own no company-scoped data, so their lists come back empty. `null` would be
 * wrong here — these tables' `companyId` columns are NOT NULL, and Prisma rejects a
 * null equality filter against them at runtime.
 */
const NO_COMPANY = '';

/** A `where` fragment restricting a list query to one company — the caller's own, or
 * the one a cross-company caller asked for. */
export function companyScope(
  caller: AuthenticatedUser,
  requested?: string,
): { companyId?: string } {
  const ctx = rlsContextFor(caller);
  if (ctx.isSuperAdmin) {
    // A cross-company caller may narrow to one company (the Settings UI's company
    // selector), and sees every company when they don't.
    return requested ? { companyId: requested } : {};
  }
  // Everyone else is pinned to their own company and `requested` is ignored
  // outright — a query parameter must never widen a caller's scope.
  return { companyId: caller.companyId ?? NO_COMPANY };
}

/**
 * Guards a by-id operation against reaching into another company's row.
 *
 * Reports "not found" rather than "forbidden" deliberately — a caller who may not
 * touch a row should not be able to confirm it exists.
 */
export function assertInScope(
  caller: AuthenticatedUser,
  row: { companyId: string },
  label: string,
): void {
  const ctx = rlsContextFor(caller);
  if (ctx.isSuperAdmin) {
    return;
  }
  if (row.companyId !== caller.companyId) {
    throw new NotFoundException(`${label} not found`);
  }
}
