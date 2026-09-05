import { AuthenticatedUser } from '../auth/authenticated-user';
import { rlsContextFor, type RlsContext } from '../common/prisma/rls-context';
import type { Caller } from '../hr/biometrics/face-enrolment.service';

/**
 * The per-request context every widget / notification / report provider is handed.
 *
 * It carries the three shapes the exported services this feature reads through
 * expect — the raw {@link AuthenticatedUser} (plant, reimbursements), the `hr`-style
 * {@link Caller}, and a bare {@link RlsContext} (employees, sites) — so a provider
 * never rebuilds them and never reaches for Prisma itself (Principle I).
 *
 * `cache` memoises the handful of reads several KPI cards share (the day's
 * attendance, the approved-leave list) so eight providers resolving in parallel do
 * not each re-run the same query — see {@link once}.
 */
export interface DashboardContext {
  user: AuthenticatedUser;
  caller: Caller;
  rls: RlsContext;
  /** The caller's own company. Null only for a company-less Super Admin, which the
   * controllers reject before a provider ever runs. */
  companyId: string;
  ipAddress: string;
  /** Set on the Site Dashboard path; undefined on the company dashboard. */
  siteId?: string;
  cache: Map<string, Promise<unknown>>;
}

/** Builds a {@link DashboardContext} from an authenticated request. */
export function buildDashboardContext(
  user: AuthenticatedUser,
  ipAddress: string,
  siteId?: string,
): DashboardContext {
  return {
    user,
    caller: {
      userId: user.id,
      companyId: user.companyId,
      ipAddress,
      rls: rlsContextFor(user),
    },
    rls: rlsContextFor(user),
    companyId: user.companyId ?? '',
    ipAddress,
    siteId,
    cache: new Map(),
  };
}

/**
 * Runs `fn` once per request per key, sharing its promise across every provider that
 * asks for the same read. Keeps the Total/Present/Absent/On-Leave cards from each
 * re-querying the day's attendance (spec SC-001 — parallel, not repeated, work).
 */
export function once<T>(
  ctx: DashboardContext,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const existing = ctx.cache.get(key);
  if (existing) return existing as Promise<T>;
  const created = fn();
  ctx.cache.set(key, created);
  return created;
}
