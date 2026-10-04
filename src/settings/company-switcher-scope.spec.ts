import { readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

import { isInScope } from './company-scope';

/**
 * No reader decides company scope by comparing against `caller.companyId`.
 *
 * ## The defect this exists for
 *
 * Feature 019 made company selection real: a cross-company caller who has selected a company
 * arrives with `isSuperAdmin` false and the **selected** company on the request context. An
 * account's own `companyId` is therefore no longer the company they are working in, and
 * `companyScope()` says so in a comment written when that was first got wrong.
 *
 * Eight settings-master readers got it wrong again anyway, each independently:
 *
 *     if (!ctx.isSuperAdmin && row.companyId !== caller.companyId) return null;
 *
 * Equipment categories, equipment document types, vendor categories, skill categories, items,
 * asset categories, asset document types and condition grades. With the second company
 * selected, every one of them reported a real row as absent.
 *
 * **The symptom was a false sentence rather than a missing row**, which is why this is worth a
 * guard. These readers feed validators, so `POST /plant/equipment` refused a category that
 * plainly existed with "Equipment category … does not exist in this company" — sending the
 * reader to inspect the category, the company, and the request, none of which were wrong.
 * Found on 2026-10-04 by the plant e2e suite, and only after that suite was itself corrected
 * to use the company the API actually resolves. A defect found by a test that had to be fixed
 * first was a defect nothing was going to find.
 */
const ALLOWED = new Map<string, string>([
  [
    'src/auth/auth.service.ts',
    'Resetting another account’s password is gated on CROSS_COMPANY_ACCESS or the target ' +
      'being in the caller’s OWN company. A selected company must not confer power over that ' +
      'company’s accounts, and a caller with no switcher has ctx.companyId equal to ' +
      'caller.companyId, so the two readings coincide where it matters.',
  ],
]);

function sourceFiles(): string[] {
  // `git ls-files` rather than a directory walk: it is the list of files that are actually
  // part of the repository, so a stray copy in a scratch directory cannot fail the build.
  return execSync('git ls-files "src/**/*.ts"', {
    cwd: process.cwd(),
    encoding: 'utf8',
  })
    .split('\n')
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'));
}

describe('company scope is read from the request context, not the account', () => {
  const files = sourceFiles();

  it('found the source files to scan', () => {
    // Vacuity: the assertion below is `toEqual([])`, which an empty file list satisfies.
    expect(files.length).toBeGreaterThan(200);
  });

  it('never compares a row’s company against caller.companyId', () => {
    const offenders = files
      .filter((file) => {
        const source = readFileSync(join(process.cwd(), file), 'utf8')
          // Comments are stripped, so the explanations written *about* this mistake do not
          // count as the mistake. The e2e teardown guard needed the same thing, for the same
          // reason: its first version passed because a commented-out call still matched.
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|[^:])\/\/.*$/gm, '$1');
        return /\w+\.companyId\s*!==\s*caller\.companyId/.test(source);
      })
      .filter((file) => !ALLOWED.has(file));

    // Named, with the fix in the message: the replacement is one function call.
    expect(offenders).toEqual([]);
  });

  it('every allowance still has a file and a reason', () => {
    // An allowlist whose entries have gone stale silently re-opens the hole it documents.
    for (const [file, reason] of ALLOWED) {
      expect(files).toContain(file);
      expect(reason.length).toBeGreaterThan(40);
    }
  });
});

describe('isInScope', () => {
  const ctxFor = (over: Record<string, unknown>) =>
    ({
      id: 'u1',
      companyId: 'own-company',
      permissions: [],
      roleIds: [],
      ...over,
    } as never);

  it('admits any row for a caller who has selected nothing', () => {
    // A genuinely cross-company caller sees every company; that is what the switcher's
    // "all companies" state means.
    const caller = ctxFor({ permissions: ['CROSS_COMPANY_ACCESS'] });
    expect(isInScope(caller, { companyId: 'other-company' })).toBe(true);
  });

  it('uses the SELECTED company, not the account’s own', () => {
    // The whole point. This caller's account belongs to `own-company` and they are working
    // in `selected-company`; a row from their own company is out of scope while they are.
    const caller = ctxFor({
      permissions: ['CROSS_COMPANY_ACCESS'],
      selectedCompanyId: 'selected-company',
    });
    expect(isInScope(caller, { companyId: 'selected-company' })).toBe(true);
    expect(isInScope(caller, { companyId: 'own-company' })).toBe(false);
  });

  it('pins a single-company caller to their own company', () => {
    const caller = ctxFor({});
    expect(isInScope(caller, { companyId: 'own-company' })).toBe(true);
    expect(isInScope(caller, { companyId: 'other-company' })).toBe(false);
  });
});
