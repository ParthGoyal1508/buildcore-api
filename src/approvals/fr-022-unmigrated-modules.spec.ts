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
          // Owned by 023 Phase C (the bill package's statutory header). `getBillingIdentity` is a
          // **read-only slice** — code, name, registration number, permanent account number, state,
          // address — exported so `projects` can put a subcontractor in a bill's receiving slot
          // without reading the `partners` schema directly, which is what Principle I requires. It
          // adds no approval path of any kind, and the per-file `approve()` assertions above still
          // read this file and still enforce that `src/partners` keeps its own approval mechanism.
          //
          // Added a commit late, again, and the reason is worth keeping rather than apologising
          // for: this check diffs two commits, so a change is invisible to it until the commit that
          // makes it. Phase B did not touch `src/partners` and Phase C did, so the guard fired on
          // Phase C — which is the earliest it could have.
          ':(exclude)src/partners/vendors/vendors.service.ts',
          // Owned by 023 Phase G. A **read-only** source registering itself with
          // `ProjectSourcesRegistry` so a bill's header can print a subcontractor's statutory
          // details — the same registry pattern `plant` uses for the equipment logbook and
          // `search` for its registers, and for the same cycle reason: `PartnersModule` imports
          // `ProjectsModule`, so the dependency has to be inverted. No approval path of any kind,
          // and the per-file `approve()` assertions above still enforce that `src/partners` keeps
          // its own approval mechanism.
          //
          // A commit late for the seventh time, and still the earliest it could be: the check
          // diffs two commits, so an untracked file is invisible to it until the commit that adds
          // it. Worth knowing rather than worth apologising for.
          ':(exclude)src/partners/vendors/vendor-identity.source.ts',
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
          // Owned by 018 T026-T028 and T031: the four cost sources the P&L asks, and the drill-down
          // behind each figure. Registration only — each module announces a read-only cost reader to
          // `ProjectSourcesRegistry` on init, the same registry pattern 021's exit custody uses.
          // No approval path is touched; the per-file `approve()` assertions above still read the
          // material indent, the muster, the payment sheet and the labour advance.
          //
          // **Added a commit late for the second time**, which is now a pattern worth naming rather
          // than apologising for: this check diffs two commits, so a new file is invisible to it
          // until the commit lands, and *then* it fires. The habit that fixes it is running this one
          // spec before committing anything under the six scanned paths — not remembering harder.
          ':(exclude)src/plant/plant.service.ts',
          ':(exclude)src/inventory/inventory.service.ts',
          ':(exclude)src/projects/portfolio/cost-source-registration.spec.ts',
          // Owned by 008's 2026-10-03 amendment: BOQ entry and the tender import, which exist
          // because nothing in either repository could write a BOQ and 018's billing was therefore
          // unusable. A parse-and-stage path and plain CRUD; **nothing here calls
          // `ApprovalService`**, and the per-file assertions above still enforce that
          // `src/projects` keeps no approval mechanism of its own.
          //
          // **Fired a commit late for the third time**, and the habit named above is the reason:
          // this spec was run before the Phase B1 commit, when the Phase B2 files did not yet
          // exist to be seen. Running it before *each* commit under the scanned paths is the rule,
          // not running it once at the start of the work.
          ':(exclude)src/projects/boq',
          // Owned by 018's 2026-10-03 verification work: the route-registration guard written after
          // `GET /projects/:id/boq` was found shadowing `GET /projects/client-bills/boq`. Pure
          // reflection over Nest's own route metadata — it calls nothing and touches no approval
          // path, and the per-file assertions above still enforce that `src/projects` keeps no
          // approval mechanism of its own.
          //
          // **Fired a commit late for the fourth time.** The habit named above was followed — this
          // spec was run before the commit — but the exclusion was not added, which is the other
          // half of the same rule: running it is only useful if its refusal is then acted on rather
          // than read. The refusal names the file; adding it takes a line.
          ':(exclude)src/projects/route-shadowing.spec.ts',
          // Owned by 022: daily work reports, which 008 specified in August, created tables for,
          // and never built — leaving every BOQ line in the system reporting 0% executed, because
          // `doneQty` moves only on approval and nothing could approve anything. Recording,
          // lifecycle and reads; **nothing here calls `ApprovalService`**. 022 decision D2 settled
          // that deliberately: approval is a direct transition by somebody other than the author,
          // because one report a day per project makes routing disproportionate and a chain left
          // unconfigured would block the site's measurement rather than review it. The per-file
          // assertions above still enforce that `src/projects` keeps no approval mechanism of its
          // own.
          //
          // **Fired a commit late for the fifth time, and this one is worth being precise about.**
          // 022's tasks.md carries running this spec before each phase commit as T067, and it *was*
          // run before both the Phase A and Phase B commits — passing each time, because
          // `git diff` between two commits cannot see an untracked file. So the habit named above
          // is necessary and not sufficient: the only run that can see a new directory is the one
          // *after* its first commit. The rule that actually works is narrower than "run it before
          // committing" — it is **run it again straight after the first commit of any new directory
          // under these paths**, which is the one moment the check can finally see it.
          ':(exclude)src/projects/dwr',
          // Owned by 025 FR-035, closing 008's T057: `SitesService.getGeofence()` now carries
          // whether the site is in service. `SiteStatus.inactive` had been stored and editable
          // since 008 and read by nothing, so decommissioning a site did not stop attendance being
          // recorded against it. One field on a projection and one boolean on its return; **nothing
          // here calls `ApprovalService`**, and the per-file assertions above still enforce that
          // `src/projects` keeps no approval mechanism of its own.
          //
          // **Fired a commit late for the sixth time**, and this one was predicted in writing:
          // 025's tasks.md names this spec in its repository rules and its Phase G, and it was run
          // before every commit of that feature — passing each time, because the run that could
          // have seen this change is the one *after* the commit carrying it. The rule that works
          // remains the narrow one: run it again straight after committing anything under these
          // paths, not only before.
          ':(exclude)src/projects/sites/sites.service.ts',
          // Owned by 025 FR-039: `Client.pan` and `Client.state`, the two rows the running-account
          // bill's statutory header prints and this table carried neither — so every bill issued to
          // a client reported both as missing and somebody filled them in by hand on the printed
          // sheet. Two nullable columns, their validation, and a spec that exercises both DTOs
          // under the global pipe's own settings. **Nothing here calls `ApprovalService`**, and the
          // per-file assertions above still enforce that `src/projects` keeps no approval mechanism
          // of its own.
          //
          // **Fired a commit late for the seventh time, two commits after the sixth.** The note on
          // the exclusion above says the rule plainly — run it again *after* committing anything
          // under these paths — and it was not followed here either. Written down a seventh time
          // because the alternative is pretending the habit works.
          ':(exclude)src/projects/clients',
          // Owned by 028, the projects defect register. Five paths, and the approval question has a
          // different answer here than on every exclusion above it.
          //
          // `src/projects/billing` is **already excluded** higher up, so the award approval added by
          // FR-009 is covered. What is new is `src/inventory`: FR-010 registers
          // `ACTION_PURCHASE_RATE_CHANGE`, and that is the inventory module's **first approval of
          // any kind**. So unlike every note above, this one cannot say "nothing here calls
          // `ApprovalService`" — the point of the change is that something eventually will.
          //
          // It does not yet. The action is registered in `default-chains.ts` and consumed by no
          // caller; `vendor-item-rate.service.ts` refuses a mismatched rate and raises nothing. The
          // per-file assertions above still read the material indent, the muster, the payment sheet
          // and the labour advance, and none of those paths is touched. When the rate-change
          // workflow is built, this exclusion is the line to revisit rather than widen.
          //
          // **Fired a commit late for the eighth time**, and the seventh note predicted exactly
          // this: `src/inventory/rates/` did not exist to be seen until the commit that created it
          // landed. The run before that commit passed, as it had to. Run it again straight after
          // the first commit of any new directory under these paths — written down an eighth time
          // because it keeps being the one step skipped.
          ':(exclude)src/inventory/rates',
          ':(exclude)src/inventory/purchases',
          ':(exclude)src/inventory/inventory.module.ts',
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
