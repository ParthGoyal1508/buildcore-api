import { AccessLevel } from '@prisma/client';

/**
 * Which access level an HTTP method requires (019 FR-001, plan D2).
 *
 * One exported constant rather than a condition inside the guard (Principle III), and the
 * single most consequential decision in feature 019.
 *
 * The alternative was annotating each of the 419 routes with its own level. That was
 * rejected because its failure mode is silent: a route somebody forgets keeps admitting
 * writes from a read-only role, and it is precisely the endpoint nobody checked. Deriving
 * from the verb inverts that — a route is covered because it exists, not because it was
 * remembered — and `@RequireLevel(...)` handles the cases where the verb lies.
 */
export const LEVEL_BY_METHOD: Readonly<Record<string, AccessLevel>> = {
  GET: AccessLevel.read,
  HEAD: AccessLevel.read,
  OPTIONS: AccessLevel.read,
  POST: AccessLevel.write,
  PUT: AccessLevel.write,
  PATCH: AccessLevel.write,
  DELETE: AccessLevel.write,
};

/**
 * Falls back to `write` for an unrecognised method, deliberately.
 *
 * An unknown verb defaulting to `read` would be a way past every level check the moment
 * anybody wired up a custom method; defaulting to `write` refuses instead, and a refusal
 * is a bug report rather than a hole.
 */
export function levelForMethod(method: string): AccessLevel {
  return LEVEL_BY_METHOD[method.toUpperCase()] ?? AccessLevel.write;
}
