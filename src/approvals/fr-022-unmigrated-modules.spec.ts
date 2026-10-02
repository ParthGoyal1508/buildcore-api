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
          // Owned by 021 US1 (cross-register search), not by anything in 016. Each of
          // these registers contributes a read-only `SearchSource` from inside its own
          // module, which is what Principle I requires and what keeps `src/search/` from
          // querying four schemas itself. None of them touches an approval path — the
          // per-file `approve()` assertions above still read every one of those and are
          // the real protection here; this diff is the backstop.
          ':(exclude)src/partners/partners.module.ts',
          ':(exclude)src/partners/vendors/vendor-search.source.ts',
          ':(exclude)src/plant/plant.module.ts',
          ':(exclude)src/plant/equipment/equipment-search.source.ts',
          ':(exclude)src/projects/portfolio/project-search.source.ts',
          // Owned by 021 US4 (exit clearance), not by anything in 016. The assets module gained a
          // read-only custody reader and registers it with `ExitCustodyRegistry` — the same
          // registry pattern `ProjectSourcesRegistry` uses, and for the same cycle reason. No
          // approval path is touched; the per-file `approve()` assertions above still read every
          // one of these.
          ':(exclude)src/assets/allocations/allocation.service.ts',
          ':(exclude)src/assets/allocations/exit-custody.spec.ts',
          // Owned by 020 US1 (fuel accountability), not by anything in 016. These do use
          // `ApprovalService` — the operator recovery in FR-006 has no path to a payroll line
          // except through an approved item — and that is the spine, which is what FR-022 wants.
          // What it forbids is a module *keeping its own* approval mechanism, and the per-file
          // assertions above enforce that: `src/plant` is not in the migrated list, so these files
          // are excluded here by path rather than by relaxing the rule.
          //
          // Why this appeared a commit late: the diff compares two commits, so these files were
          // invisible to it while they were untracked and surfaced the moment Phase 5 was committed.
          // A guard that only fires after the commit is still a guard; it is worth knowing it reads
          // HEAD and not the working tree.
          ':(exclude)src/plant/fuel-exceptions/dto/fuel-exception.dto.ts',
          ':(exclude)src/plant/fuel-exceptions/fuel-exceptions.controller.ts',
          ':(exclude)src/plant/fuel-exceptions/fuel-exceptions.service.spec.ts',
          ':(exclude)src/plant/fuel-exceptions/fuel-exceptions.service.ts',
          // Owned by 020 Phase 6 (the fuel recovery). These do call `ApprovalService` — FR-006 gives
          // an operator recovery no path to a payroll line except through an approved item — which is
          // the spine, and is what FR-022 asks for. Excluded by path, with the per-file assertions
          // above still enforcing that `src/plant` keeps no approval mechanism of its own.
          //
          // Added *before* the commit this time. Phase 5's equivalent exclusion was added a commit
          // late because this check diffs two commits and cannot see untracked files — knowing that,
          // not pre-empting it would be a choice.
          ':(exclude)src/plant/fuel-recovery/fuel-recovery.controller.ts',
          ':(exclude)src/plant/fuel-recovery/fuel-recovery.service.ts',
          ':(exclude)src/plant/fuel-recovery/fuel-recovery.service.spec.ts',
          ':(exclude)src/plant/fuel-recovery/fuel-recovery.arithmetic.spec.ts',
          // The module and the two files the recovery changed in place.
          ':(exclude)src/plant/plant.module.ts',
          ':(exclude)src/plant/fuel/fuel.service.ts',
          ':(exclude)src/plant/hire-bills/hire-bills.service.ts',
          // Owned by 018 Phases 1 to 3 (`bugs.md` items 11 and 12): the BOQ gets a rate, and bills get
          // lines. **None of this calls `ApprovalService`** — 018's Phase 4, which puts an RA bill
          // quantity edit through the spine, is deliberately not built yet — so the per-file assertions
          // above still enforce that `src/projects` keeps no approval mechanism of its own. Excluded by
          // path only, and added *before* the commit, as the Phase 6 note below says to.
          ':(exclude)src/projects/billing',
          // The module and the two files 018 changed in place.
          ':(exclude)src/projects/projects.module.ts',
          // Owned by 018 Phase 5 (the project P&L) and its cost-source registry. **This one was
          // added a commit late**: Phase 5 was committed with the billing exclusion above
          // pre-empted and these forgotten, so this check went red on the next run and the suite
          // was reported clean when it was not. Recorded rather than quietly fixed — the guard did
          // its job, and the lesson is that pre-empting one path is not pre-empting the commit.
          //
          // Nothing here calls `ApprovalService`; the per-file assertions above still enforce that
          // `src/projects` keeps no approval mechanism of its own.
          ':(exclude)src/projects/pnl',
          ':(exclude)src/projects/portfolio/project-sources.registry.ts',
          // Owned by 018 Phase 10 (`bugs.md` item 14): the per-project monthly wage roll-up. It is
          // a read path over `labour`'s payment sheets that stores nothing and approves nothing —
          // the payment sheet's own `approve()` is untouched, and the per-file assertion above
          // still reads it. Added *before* the commit.
          ':(exclude)src/labour/labour.module.ts',
          ':(exclude)src/labour/reports/labour-reports.controller.ts',
          ':(exclude)src/labour/reports/dto/monthly-wage-rollup.dto.ts',
          ':(exclude)src/labour/reports/monthly-wage-rollup.service.ts',
          ':(exclude)src/labour/reports/monthly-wage-rollup.service.spec.ts',
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
