/**
 * Stops the end-to-end run before it can touch the shared `buildcore` database.
 *
 * The suites create and delete their own fixtures, and README-e2e.md explains why they belong on
 * `buildcore_scratch`: a teardown that reached too far once took real data with it, and on
 * 2026-10-06 a whole session's runs went to `buildcore` without a word, because `.env` holds a
 * template that resolves to it. The README told people what to do; nothing enforced it (036).
 *
 * This runs first, before any module reads the URL, and refuses three cases: no `DATABASE_URL` in
 * the environment (dotenv would then fill in `.env`'s template, which is `buildcore`), an
 * unexpanded template, and a resolved URL naming `buildcore` itself.
 */
const SHARED_DATABASE = 'buildcore';

function refuse(reason: string): never {
  throw new Error(
    `e2e refused to start: ${reason}\n` +
      'Pass a resolved URL for a scratch database, e.g.\n' +
      '  DATABASE_URL="postgresql://USER:PASS@localhost:5432/buildcore_scratch?schema=public" npm run test:e2e\n' +
      'See test/README-e2e.md.',
  );
}

const url = process.env.DATABASE_URL;

if (!url) {
  refuse(
    `DATABASE_URL is not set, so .env's template would resolve to "${SHARED_DATABASE}".`,
  );
}
if (url.includes('${')) {
  refuse(
    'DATABASE_URL is an unexpanded template; its database cannot be checked.',
  );
}

let database: string;
try {
  database = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
} catch {
  refuse('DATABASE_URL could not be parsed.');
}
if (database === SHARED_DATABASE) {
  refuse(`DATABASE_URL points at the shared "${SHARED_DATABASE}" database.`);
}

// A module, not a script: setup files otherwise share one global scope with bound-connection-pool.ts.
export {};
