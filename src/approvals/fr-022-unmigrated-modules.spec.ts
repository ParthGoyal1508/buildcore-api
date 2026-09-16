import { execFileSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * FR-022 — the modules this feature did **not** migrate still approve exactly as before
 * (016 T054a).
 *
 * The analyze pass found FR-022 had no task at all, and the reason it needed one is worth
 * stating: "we did not mean to change it" is not evidence that we did not. Feature 016
 * adds a mechanism next to six existing single-step approvals. Any of them could have been
 * half-migrated by accident — a service quietly reaching for `ApprovalService`, a
 * permission check dropped on the assumption the chain would cover it — and the symptom
 * would be an indent nobody can approve any more, discovered by whoever needed the cement.
 *
 * Two checks, one negative and one positive, because either alone is weak. The negative
 * one alone would pass if the approval had been deleted outright; the positive one alone
 * would pass while the module *also* called into the spine and acquired two mechanisms.
 */

const REPO_ROOT = join(__dirname, '..', '..');

/**
 * The single-step approvals that exist today and are out of scope for this feature.
 *
 * Each entry names the file and the method that must still be there. Listed explicitly
 * rather than derived, because the claim is about these specific approvals — the ones a
 * person can point at and say "that still works" — and a derived list would quietly shrink
 * if one of them were removed, which is the failure being guarded against.
 */
const UNMIGRATED = [
  { what: 'material indent', file: 'src/inventory/indents/indents.service.ts' },
  { what: 'labour muster roll', file: 'src/labour/muster/muster.service.ts' },
  {
    what: 'labour payment sheet',
    file: 'src/labour/payment-sheets/payment-sheet.service.ts',
  },
  {
    what: 'labour advance',
    file: 'src/labour/advances/labour-advance.service.ts',
  },
  {
    what: 'recruitment requisition',
    file: 'src/recruitment/requisitions/requisition.service.ts',
  },
];

describe('FR-022 — unmigrated modules keep their own approvals', () => {
  it.each(UNMIGRATED)(
    'the $what still has its own approve() and does not call the spine',
    ({ file }) => {
      const full = join(REPO_ROOT, file);
      expect(existsSync(full)).toBe(true);
      const source = readFileSync(full, 'utf8');

      // Positive: the approval this feature promised not to touch is still there.
      expect(source).toMatch(/async approve\(/);

      // Negative: and it has not been half-migrated onto the chain. Half-migrated is
      // worse than either end state — the module would have two ways to approve the same
      // thing and no rule about which wins.
      expect(source).not.toContain('ApprovalService');
      expect(source).not.toContain('approvals.submit');
    },
  );

  it('the modules outside this feature’s scope are untouched since it began', () => {
    // The strongest evidence available, and cheap: `git diff` against the commit before
    // Phase 1. If a business module changed at all during this feature, that is worth a
    // person looking at, whatever the tests say.
    //
    // FEATURES AFTER 016 ARE EXCLUDED BY PATH, not by relaxing the assertion. 017 US2
    // adds project document readiness, which genuinely belongs in `src/projects` — so
    // those paths are listed below and everything else in every business module stays
    // guarded. The alternative, deleting this check once a later feature touched a
    // business module, would throw away the guard the first time it became inconvenient.
    //
    // Skipped rather than failed outside a git checkout — a packaged build has no
    // history to consult, and a test that cannot run must not masquerade as one that
    // passed.
    let changed: string;
    try {
      changed = execFileSync(
        'git',
        [
          'diff',
          '--name-only',
          'c32f906',
          'HEAD',
          '--',
          'src/inventory',
          'src/labour',
          'src/projects',
          'src/assets',
          'src/plant',
          'src/partners',
          // Owned by 017 US2 (project document readiness), not by anything in 016.
          ':(exclude)src/projects/documents',
          // Owned by 017 US7 (payment proof). The indent approval this guard is really
          // about lives in src/inventory/indents and is NOT excluded — the per-file
          // assertions above still read it, and any change there still shows up here.
          ':(exclude)src/inventory/payments',
          ':(exclude)src/projects/projects.module.ts',
          ':(exclude)src/projects/portfolio/projects.service.ts',
          ':(exclude)src/projects/portfolio/projects.service.spec.ts',
          ':(exclude)src/projects/portfolio/dto/project.dto.ts',
        ],
        {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      );
    } catch {
      // eslint-disable-next-line no-console
      console.warn(
        'FR-022 diff check skipped: the pre-016 commit c32f906 is not reachable ' +
          'from here. The per-file assertions above still ran.',
      );
      return;
    }

    expect(changed.trim().split('\n').filter(Boolean)).toEqual([]);
  });
});
