/**
 * Caps the database connection pool for the end-to-end run.
 *
 * ## Why this exists
 *
 * On 2026-10-04 the suites were repaired so they release their connections, and the run went
 * green. It then went **intermittently** red — suites timing out after 120 and 318 seconds, with
 * no error, just tests waiting. The database was not at fault and neither was the product:
 *
 *     SELECT application_name, count(*), max(now() - backend_start) FROM pg_stat_activity;
 *     prisma | 37 | 3 days 14:58:26
 *
 * **Thirty-seven connections, the oldest three days old.** Two sources. A running `nest start`
 * holds a pool of its own — Prisma sizes it from the CPU count, so roughly twenty on this machine
 * — and `jest --forceExit` strands whatever is open at the moment it kills the process, every run,
 * for days. With `max_connections` at 100, a run starting from forty is one unlucky suite away
 * from waiting for a slot rather than getting one. Waiting looks exactly like a slow test.
 *
 * So the suites releasing their connections was necessary and not sufficient: it fixed what the
 * run leaks and did nothing about what the run must *share*. This caps what the run asks for.
 *
 * Five connections, with the suites running serially (`maxWorkers: 1`), is ample — the only
 * concurrency in the whole run is a handful of deliberately simultaneous requests in the inventory
 * and assets suites, and those need two, not twenty. The cap is what makes the run's footprint a
 * number somebody can reason about instead of a function of the machine it runs on.
 *
 * Applied by rewriting `DATABASE_URL` before any module reads it, which is why this is a
 * `setupFiles` entry rather than anything cleverer: Prisma reads the URL when the client is
 * constructed, and the client is constructed when the first suite imports `AppModule`.
 */
const TEST_CONNECTION_LIMIT = 5;

/** Seconds Prisma waits for a free connection before giving up — and saying so. */
const TEST_POOL_TIMEOUT_SECONDS = 20;

const url = process.env.DATABASE_URL;

if (url) {
  try {
    const parsed = new URL(url);
    // Only when unset. An operator who has pinned these deliberately — against a pooler, say —
    // should not have them overwritten by a test helper.
    if (!parsed.searchParams.has('connection_limit')) {
      parsed.searchParams.set(
        'connection_limit',
        String(TEST_CONNECTION_LIMIT),
      );
    }
    if (!parsed.searchParams.has('pool_timeout')) {
      parsed.searchParams.set(
        'pool_timeout',
        String(TEST_POOL_TIMEOUT_SECONDS),
      );
    }
    process.env.DATABASE_URL = parsed.toString();
  } catch {
    // An unparseable URL is left exactly as it was. Failing here would turn a configuration
    // problem into a test-harness problem, and the suites report the real one far more clearly
    // when they try to connect.
  }
}
