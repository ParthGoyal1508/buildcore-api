import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Principle I across the letters boundary, both ways (017 T065, quickstart Pass 10).
 *
 * Phase 5 moved `GeneratedLetter` out of `recruitment` so that a work order could
 * address a vendor without `recruitment` learning about `partners`. That move buys
 * nothing unless the new boundary holds, and it can be broken in two directions:
 *
 * 1. **`src/letters/` reads a business module's tables.** One line — resolving
 *    `subjectId` to a vendor name, so the list could show something friendlier — and the
 *    opacity that justified the whole restructure is gone.
 * 2. **A business module reads `shared.IssuedLetter` directly.** Then the table is a
 *    shared one that four features write to, which is the state the move escaped,
 *    reached through the back door.
 *
 * Neither shows up at runtime. Everything works, on one database, until somebody tries
 * to extract a service and finds the seam was never real.
 *
 * Copied from `src/approvals/spine-boundary.spec.ts`, including its lesson: the forbidden
 * sets are derived from `schema.prisma`, so a model added next year is covered without
 * anybody remembering to come back here.
 *
 * ## This guard has been seen to fail
 *
 * T066. Verified by adding `tx.vendor.findFirst()` to `letters.service.ts` and
 * `tx.issuedLetter.findMany()` to `src/projects/portfolio/projects.service.ts`; each
 * direction failed, naming the exact file and delegate, and passed again on revert.
 */

const REPO_ROOT = join(__dirname, '..', '..');
const SRC = join(REPO_ROOT, 'src');
const LETTERS_DIR = join(SRC, 'letters');
const SCHEMA = join(REPO_ROOT, 'prisma', 'schema.prisma');

interface Model {
  name: string;
  delegate: string;
  schema: string;
}

function models(): Model[] {
  const source = readFileSync(SCHEMA, 'utf8');
  const out: Model[] = [];
  const modelBlock = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  let match: RegExpExecArray | null;
  while ((match = modelBlock.exec(source)) !== null) {
    const [, name, body] = match;
    const schemaAttr = /@@schema\("(\w+)"\)/.exec(body);
    out.push({
      name,
      delegate: name[0].toLowerCase() + name.slice(1),
      schema: schemaAttr ? schemaAttr[1] : 'unknown',
    });
  }
  return out;
}

function tsFilesUnder(dir: string, opts: { includeSpecs?: boolean } = {}) {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...tsFilesUnder(full, opts));
    } else if (
      entry.endsWith('.ts') &&
      (opts.includeSpecs || !entry.endsWith('.spec.ts'))
    ) {
      out.push(full);
    }
  }
  return out;
}

const accesses = (source: string, delegate: string) =>
  new RegExp(`\\.\\s*${delegate}\\s*\\.`).test(source);

/**
 * `recruitment` is exempt from the second direction, and the exemption is the point.
 *
 * Recruitment's offer and appointment letters rode on this table before the move and
 * still do — research §2 kept `employeeId` and `candidateId` precisely so its behaviour
 * would not change. Forbidding it here would fail the restructure's own compatibility
 * promise. Every OTHER module goes through `LettersService`.
 */
const GRANDFATHERED = [join(SRC, 'recruitment')];

describe('Principle I — the letters boundary, in both directions', () => {
  const all = models();

  it('finds the models it is supposed to be guarding', () => {
    // A guard that silently matches nothing is worse than no guard: every assertion
    // below would pass vacuously and nobody would know. 016 learned this from RLS tests
    // that were passing because a superuser bypassed the policy.
    const issued = all.find((m) => m.name === 'IssuedLetter');
    expect(issued).toBeDefined();
    expect(issued!.schema).toBe('shared');
    expect(all.find((m) => m.name === 'GeneratedLetter')).toBeUndefined();
  });

  it('src/letters queries no business module’s tables', () => {
    // Everything outside `shared` and `settings`. `settings` is allowed because the
    // kinds, templates and signatories a letter needs are settings masters reached
    // through exported services — and the delegate names would appear in this file's
    // imports regardless. The business schemas are the ones that matter: `partners`,
    // `projects`, `inventory`, `plant`, `assets`, `labour`, `hr`, `payroll`.
    const businessSchemas = [
      'partners',
      'projects',
      'inventory',
      'plant',
      'assets',
      'labour',
      'hr',
      'payroll',
      'recruitment',
    ];
    const foreign = all.filter((m) => businessSchemas.includes(m.schema));
    expect(foreign.length).toBeGreaterThan(40);

    const offences: string[] = [];
    for (const file of tsFilesUnder(LETTERS_DIR)) {
      const source = readFileSync(file, 'utf8');
      const relative = file.slice(REPO_ROOT.length + 1);
      for (const model of foreign) {
        if (accesses(source, model.delegate)) {
          offences.push(`${relative}: .${model.delegate}.`);
        }
      }
    }

    expect(offences).toEqual([]);
  });

  it('no module outside src/letters queries shared.IssuedLetter', () => {
    const offences: string[] = [];

    for (const file of tsFilesUnder(SRC)) {
      if (file.startsWith(LETTERS_DIR)) continue;
      if (GRANDFATHERED.some((dir) => file.startsWith(dir))) continue;
      const source = readFileSync(file, 'utf8');
      const relative = file.slice(REPO_ROOT.length + 1);

      if (accesses(source, 'issuedLetter')) {
        offences.push(`${relative}: .issuedLetter.`);
      }
      if (
        /(FROM|JOIN|INTO|UPDATE)\s+"?shared"?\.\s*"?IssuedLetter/i.test(source)
      ) {
        offences.push(`${relative}: raw SQL against IssuedLetter`);
      }
    }

    // Modules list their letters through `LettersService.listForSubject`. Nothing else.
    expect(offences).toEqual([]);
  });

  it('never dereferences the subject it addresses', () => {
    // research §2's opacity, as a property of the code rather than an intention. The
    // module stores `(subjectType, subjectId)` and has no way to turn either into a
    // vendor, a project or a purchase — the owning module resolves it.
    const service = readFileSync(
      join(LETTERS_DIR, 'letters.service.ts'),
      'utf8',
    );

    for (const forbidden of [
      'vendorName',
      'projectName',
      'purchaseOrderNumber',
    ]) {
      expect(service).not.toContain(forbidden);
    }
    // And it carries the pair through untouched, which is the positive half: a boundary
    // held by having deleted the feature is not a boundary held.
    expect(service).toContain('subjectType');
    expect(service).toContain('subjectId');
  });

  it('imports no business module', () => {
    const moduleFile = readFileSync(
      join(LETTERS_DIR, 'letters.module.ts'),
      'utf8',
    );
    for (const forbidden of [
      'PartnersModule',
      'ProjectsModule',
      'InventoryModule',
      'PlantModule',
      'HrModule',
      'RecruitmentModule',
    ]) {
      expect(moduleFile).not.toContain(forbidden);
    }
    // The two it does import, so this assertion cannot pass by the module being empty.
    expect(moduleFile).toContain('SettingsModule');
    expect(moduleFile).toContain('ApprovalsModule');
  });
});
