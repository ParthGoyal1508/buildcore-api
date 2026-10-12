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
  /**
   * The company every provider computes for — **the selected one**, not the caller's own.
   *
   * These are different for a cross-company caller using the company switcher, and
   * taking the wrong one was a live defect: `rlsContextFor` honours
   * `selectedCompanyId` and every module screen scopes through it, while this field was
   * `user.companyId`. So after switching company, the Plant Register listed the newly
   * selected company's two machines while the Total Machinery card said 3 and Contract
   * Value showed the other company's ₹37.11 crore — one director's dashboard reporting
   * another company's figures, with nothing on screen to say so.
   *
   * Falls back to the caller's own company, then to empty, so a cross-company caller who
   * has selected nothing behaves exactly as before. Empty only for a company-less Super
   * Admin, which the controllers reject before a provider ever runs.
   */
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
  const rls = rlsContextFor(user);
  return {
    user,
    caller: {
      userId: user.id,
      // The caller's **own** company, deliberately, matching `callerFrom` — the services
      // that take a `Caller` scope through `caller.rls` and read this only where "the
      // company this person belongs to" is what they mean.
      companyId: user.companyId,
      roleIds: user.roleIds ?? [],
      ipAddress,
      rls,
    },
    rls,
    companyId: rls.companyId ?? user.companyId ?? '',
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
