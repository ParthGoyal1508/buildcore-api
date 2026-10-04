import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';

/**
 * Every `seedDefaultsForCompany` in `settings` is actually called when a company is created.
 *
 * ## The third defect of one class in two days
 *
 * All three share a symptom: **whether a company works depends on when it was created.** A
 * backfill migration reached the companies that already existed, the creation path did not reach
 * the new ones, and nothing failed loudly in between.
 *
 *   * **2026-10-03** — `prisma/seed-demo.ts` carried a hand-copied list of approval chains that had
 *     drifted three behind `ChainsService`, so every freshly seeded company refused a subcontractor
 *     bill sent for certification. Guarded now by `default-chains.spec.ts`.
 *   * **2026-10-04** — the chains' *slots* were mapped for nobody, so neither company could approve
 *     a payroll run. Guarded now by the same file's slot tests.
 *   * **2026-10-04** — the two machinery masters had a `seedDefaultsForCompany` each, both correct,
 *     and **nothing called either of them** outside the demo seed. Measured:
 *     `SELECT count(*) FROM settings."EquipmentCategory"` returned zero rows for both companies, so
 *     the first person to register a machine in either was refused until they hand-created a
 *     category.
 *
 * This file is the one that catches the fourth. A method named `seedDefaultsForCompany` is a
 * promise that a new company gets those rows; this asserts the promise is kept.
 *
 * Deliberately a source scan. The alternative — creating a company and counting rows per master —
 * would be a better test and a far slower one, and it would need every master to be nameable from
 * the outside. This needs only the thing that is actually easy to get wrong: wiring the call up.
 */
const ROOT = process.cwd();

/**
 * Services whose defaults are deliberately not seeded at creation, each with the reason.
 *
 * Empty today, and that is the honest state rather than a stub: every `seedDefaultsForCompany`
 * that exists is called. The map is here so that exempting one later costs a written reason, which
 * is the whole mechanism — the machinery masters were not exempted by anybody, they were simply
 * never wired up.
 */
const NOT_AT_CREATION = new Map<string, string>();

function filesWithSeeder(): string[] {
  // `src/approvals` as well as `src/settings`: `ChainsService.seedDefaultsForCompany` is the same
  // promise made by a service outside this module, and it is called from the same place. Scanning
  // only `settings` would have left the count one short and the mismatch unexplained.
  // Directory pathspecs, not globs. `git ls-files "src/settings/**/*.ts"` silently misses every
  // file sitting *directly* in `src/settings/` — `**/` requires a directory level — which is how
  // the first version of this test found eight seeders and nine calls and could not say why. The
  // ninth is `ChainsService`, in `src/approvals/chains.service.ts`.
  const listed = execSync('git ls-files src/settings src/approvals', {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'));

  return listed.filter((file) => {
    const source = readFileSync(join(ROOT, file), 'utf8');
    // The declaration, not a call to one: `async seedDefaultsForCompany(`.
    return /\basync seedDefaultsForCompany\s*\(/.test(source);
  });
}

/** The class name a file declares, which is what `CompaniesService` injects. */
function exportedClassOf(file: string): string | null {
  const source = readFileSync(join(ROOT, file), 'utf8');
  return /export class (\w+)/.exec(source)?.[1] ?? null;
}

describe('a new company gets every master that has defaults', () => {
  const files = filesWithSeeder();
  const creation = readFileSync(
    join(ROOT, 'src/settings/companies/companies.service.ts'),
    'utf8',
  );

  it('found the seeders to check', () => {
    // Vacuity, and the number matters: nine on the day this was written — eight masters plus the
    // approval chains — two of which had just been added to the creation path. An empty list
    // satisfies every assertion below.
    expect(files.length).toBeGreaterThanOrEqual(8);
  });

  it('calls each one from CompaniesService.create', () => {
    const missing = files
      .filter((file) => !NOT_AT_CREATION.has(file))
      .filter((file) => {
        const className = exportedClassOf(file);
        if (!className) return false;
        // Injected by type, so the class name appears in the constructor; and called, so the
        // property appears with the method. Both, because a dependency that is injected and never
        // used is exactly the state this is here to catch.
        const injected = creation.includes(className);
        const called = new RegExp(
          `this\\.\\w+\\.seedDefaultsForCompany\\(`,
        ).test(creation);
        return !injected || !called;
      })
      .map((file) => `${file} (${exportedClassOf(file)})`);

    // Named, not counted: the fix is one line in one file, and the name is the whole of it.
    expect(missing).toEqual([]);
  });

  it('calls as many seeders as there are services with one', () => {
    // The assertion the test above cannot make. `injected` only checks the class name appears
    // somewhere in the file — a service imported for another reason would satisfy it. Counting the
    // calls catches the case where a service is injected and its seeder never invoked, which is
    // half of what went wrong with the machinery masters: they were not injected at all, but
    // injecting them and forgetting the call would have looked identical from the outside.
    const calls = (creation.match(/this\.\w+\.seedDefaultsForCompany\(/g) ?? [])
      .length;
    const expected = files.filter((f) => !NOT_AT_CREATION.has(f)).length;

    expect(calls).toBe(expected);
  });

  it('keeps every exemption pointing at a real file, with a reason', () => {
    // An exemption whose file has moved silently re-opens the hole it documents.
    for (const [file, reason] of NOT_AT_CREATION) {
      expect(files).toContain(file);
      expect(reason.length).toBeGreaterThan(40);
    }
  });
});
