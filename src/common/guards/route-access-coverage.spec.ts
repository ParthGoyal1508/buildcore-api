import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Every controller declares how it is authorised (019 FR-005, Phase 3).
 *
 * ## What FR-005's hole actually was
 *
 * The requirement says the system must "refuse direct access to records outside the role's
 * granted areas, not only hide their navigation", and the plan described a hole of six
 * unguarded routes. **Reading every controller, there was no hole.** All 101 are authorised;
 * the ten that carry no `PermissionsGuard` each authorise somewhere else and say so:
 *
 * - `app` — the health check, called by load balancers without a token.
 * - `letters` — per *kind*, in the service: a work order and a relieving letter are not the
 *   same authority, and the kind is knowable only after it is loaded.
 * - `search` — per *register*, in the registry: a route-level guard would have to name one
 *   register's permission and be wrong for the other three.
 * - `users` and the five `/my/*` controllers — by record ownership, resolved from the
 *   caller's own user id.
 * - `account-creation/invites` — by the invite token itself, which is the credential; there
 *   is no account to authenticate with yet, and both routes are rate-limited because of it.
 *
 * So what was wrong was not the access, it was that **being correct and being forgotten
 * looked identical**. A new controller could join that list by saying nothing, and nothing
 * would notice. This test is what makes that impossible: every controller must fall into one
 * named category, and a new one falls into none until somebody says which.
 *
 * That is the durable half of FR-005. The `PermissionsGuard` change is the other half, and it
 * only binds where the guard is declared — which is why a grep is needed as well.
 */

const SRC = join(__dirname, '..', '..');

/**
 * Controllers authorised by something other than `@RequirePermissions`, each with the reason.
 *
 * Adding a path here is a deliberate act that needs a reason beside it. That is the point: the
 * cost of joining this list should be writing down why.
 */
const AUTHORISED_ELSEWHERE: Record<string, string> = {
  'app.controller.ts':
    'Health check — @PublicRoute(), no authentication by design.',
  'letters/letters.controller.ts':
    'Per letter kind, in LettersService (LETTER_KIND_FORBIDDEN). A class-level guard would be too broad or wrong.',
  'search/search.controller.ts':
    'Per register, in SearchSourcesRegistry. A route-level guard would name one register and be wrong for three.',
  'users/users.controller.ts':
    'Self-service: the caller’s own profile and password. @SelfService().',
  'hr/punch/punch.controller.ts':
    'Self-service: the employee’s own punches. @SelfService().',
  'hr/leave/leave.controller.ts':
    'Self-service: the employee’s own leave. @SelfService().',
  'hr/reimbursements/reimbursement.controller.ts':
    'Self-service: the employee’s own claims. @SelfService().',
  'hr/biometrics/face-enrolment.controller.ts':
    'Self-service: the employee’s own face enrolment. @SelfService().',
  'payroll/salary/salary.controller.ts':
    'Self-service: the employee’s own payslips. @SelfService().',
  'account-creation/invites/invites.controller.ts':
    'The invite token is the credential — there is no account yet. Rate-limited for exactly that reason.',
};

function controllersUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...controllersUnder(full));
    else if (entry.endsWith('.controller.ts')) out.push(full);
  }
  return out;
}

describe('FR-005 — every controller declares how it is authorised', () => {
  const controllers = controllersUnder(SRC).map((file) => ({
    path: file.slice(SRC.length + 1),
    text: readFileSync(file, 'utf8'),
  }));

  it('finds the controllers it is supposed to be checking', () => {
    // A guard that matched nothing would pass every assertion below vacuously.
    expect(controllers.length).toBeGreaterThan(90);
  });

  it('no controller is authorised by nothing at all', () => {
    const undeclared = controllers
      .filter(
        (c) =>
          !/RequirePermissions/.test(c.text) &&
          !/@SelfService\(\)/.test(c.text) &&
          !/@PublicRoute\(\)/.test(c.text) &&
          !(c.path in AUTHORISED_ELSEWHERE),
      )
      .map((c) => c.path);

    // If this fails, a controller has been added that says nothing about who may reach it.
    // Give it `@RequirePermissions(...)`, or `@SelfService()` if ownership is the rule, or add
    // it to AUTHORISED_ELSEWHERE **with the reason** — never just to make the test pass.
    expect(undeclared).toEqual([]);
  });

  it('every entry in the exemption list still exists', () => {
    // A stale exemption is how a list like this rots into permission to skip the check.
    const paths = new Set(controllers.map((c) => c.path));
    const missing = Object.keys(AUTHORISED_ELSEWHERE).filter(
      (p) => !paths.has(p),
    );
    expect(missing).toEqual([]);
  });

  it('every exemption carries a reason', () => {
    const empty = Object.entries(AUTHORISED_ELSEWHERE)
      .filter(([, reason]) => reason.trim().length < 20)
      .map(([path]) => path);
    expect(empty).toEqual([]);
  });

  it('the self-service controllers actually say so', () => {
    // The marker is what lets the guard tell a deliberate ownership route from an oversight,
    // so its absence on one of these would put the category back to being invisible.
    for (const path of [
      'hr/punch/punch.controller.ts',
      'hr/leave/leave.controller.ts',
      'hr/reimbursements/reimbursement.controller.ts',
      'hr/biometrics/face-enrolment.controller.ts',
      'payroll/salary/salary.controller.ts',
      'users/users.controller.ts',
    ]) {
      const controller = controllers.find((c) => c.path === path);
      expect(controller).toBeDefined();
      expect(controller?.text).toMatch(/@SelfService\(\)/);
    }
  });
});
