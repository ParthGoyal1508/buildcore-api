import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * Every end-to-end suite releases its database connections when it finishes.
 *
 * ## The defect this exists for
 *
 * On 2026-10-04 `npm run test:e2e` was red: **15 of the 33 suites failing, 158 assertions,
 * and not one of them a product defect.** Postgres refused new connections part-way through
 * the run. `max_connections` is 100 and Prisma sizes its pool from the CPU count, so a
 * handful of undisposed pools is enough.
 *
 * It had two causes and finding only the first would not have fixed it:
 *
 * 1. **Nineteen of the suites never called `app.close()`.** They created a Nest application
 *    in `beforeAll` and left it running.
 * 2. **`app.close()` did not disconnect Prisma anyway.** `nestjs-prisma`'s `PrismaService`
 *    implements `OnModuleInit` and nothing else, so the fourteen suites that *were* closing
 *    their app leaked exactly as much as the nineteen that were not. That is why
 *    `PrismaShutdownService` exists.
 *
 * What makes this worth a guard rather than a one-time fix is the symptom. A suite that
 * leaks connections **passes** — it is the next suite, or the twentieth, that fails, with an
 * error about the database that points nowhere near the file responsible. The failure is
 * displaced from its cause, so it gets diagnosed as "the database is flaky" and the run is
 * retried. This test puts the failure in the file that caused it.
 *
 * Deliberately a source scan and not a runtime check: a runtime check would have to run the
 * suites, which is the thing that was broken.
 *
 * **The first version of this guard did not work, and it passed.** Written to match
 * `app.close()` anywhere in the file, it was tested by commenting the call out in
 * `app.e2e-spec.ts` — and it stayed green, because `// await app.close();` contains
 * `app.close()`. Comments are stripped below for that reason. A guard whose own negative
 * case has not been run is a guard that has not been checked, which is the same mistake in
 * miniature as the one it is here to catch.
 */

/**
 * Source with comments removed, so a call that has been commented out does not satisfy the
 * check that it exists. Crude — it does not know about strings containing `//` — and crude
 * is right here: a false positive names a file for a human to look at, while the false
 * negative it replaces is what let the first version of this file pass.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}
const E2E_DIR = join(process.cwd(), 'test');

interface Suite {
  name: string;
  source: string;
}

const suites: Suite[] = readdirSync(E2E_DIR)
  .filter((f) => f.endsWith('.e2e-spec.ts'))
  .sort()
  .map((name) => ({
    name,
    source: stripComments(readFileSync(join(E2E_DIR, name), 'utf8')),
  }));

describe('end-to-end suites release their connections', () => {
  it('found the suites to check', () => {
    // Vacuity. Every assertion below is `expect(offenders).toEqual([])`, which passes
    // perfectly well against an empty list of files — so the count is the test that the
    // other tests are testing anything. 33 suites on the day this was written.
    expect(suites.length).toBeGreaterThan(25);
  });

  it('closes every Nest application it creates', () => {
    const offenders = suites
      .filter((s) => /let app: INestApplication/.test(s.source))
      .filter((s) => !/app\.close\(\)/.test(s.source))
      .map((s) => s.name);

    // Named rather than counted: the fix is in the file, so the name is the whole of the
    // report. Nineteen names appeared here on 2026-10-04.
    expect(offenders).toEqual([]);
  });

  it('disconnects every PrismaClient it constructs itself', () => {
    // The RLS probes do not build a Nest app at all — they open a client as the
    // application's own role and a second as a `NOSUPERUSER NOBYPASSRLS` role created for
    // the test. Two pools each, and `app.close()` cannot help them.
    const offenders = suites
      .filter((s) => /new PrismaClient\(/.test(s.source))
      .filter((s) => !/\$disconnect\(\)/.test(s.source))
      .map((s) => s.name);

    expect(offenders).toEqual([]);
  });

  it('has at least one suite of each kind, so neither check is idle', () => {
    // Both checks above are filters, and a filter over nothing is silent. These two counts
    // are what make the previous two tests non-vacuous rather than merely passing.
    const withApp = suites.filter((s) =>
      /let app: INestApplication/.test(s.source),
    );
    const withOwnClient = suites.filter((s) =>
      /new PrismaClient\(/.test(s.source),
    );

    expect(withApp.length).toBeGreaterThan(20);
    expect(withOwnClient.length).toBeGreaterThan(3);
  });
});
