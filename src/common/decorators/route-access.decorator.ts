import { SetMetadata } from '@nestjs/common';

export const SELF_SERVICE_KEY = 'selfService';
export const PUBLIC_KEY = 'publicRoute';

/**
 * Declares a route authorised by **record ownership** rather than by a permission
 * (019 FR-005, plan D4).
 *
 * The `/my/*` surfaces are the real case: an employee reads their own punches, their own
 * leave, their own payslip. A permission would be the wrong tool — every employee would need
 * it, so it would grant nothing — and the authorisation that matters is "this row is yours",
 * enforced in the service by resolving the employee from the caller's own user id.
 *
 * Before this existed, such a route was declared by **saying nothing**, and the guard could
 * not tell it from a route somebody forgot to protect. That is the hole FR-005 describes: not
 * the twenty-two `/my/*` routes, which are correct, but that their correctness was
 * indistinguishable from an oversight. With this marker the guard can refuse a route that
 * declares neither — so a new controller fails closed instead of open.
 */
export const SelfService = () => SetMetadata(SELF_SERVICE_KEY, true);

/**
 * Declares a route that needs no authentication at all.
 *
 * Exactly one route qualifies today: the health check. Kept as an explicit marker rather than
 * an exemption list inside the guard, so the decision is visible where the route is.
 */
export const PublicRoute = () => SetMetadata(PUBLIC_KEY, true);
