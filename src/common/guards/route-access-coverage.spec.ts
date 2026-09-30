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

/** The three ways a route may declare how it is authorised (019 FR-005). */
const DECLARATION = /@(RequirePermissions|SelfService|PublicRoute)\b/;

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

/**
 * Route handlers in a controller, with whatever declaration applies to each.
 *
 * ## Why this exists, and why the file-level check below was not enough
 *
 * The first version of this test asked whether a controller file mentioned
 * `@RequirePermissions` *anywhere*. Every controller passed — and five handlers on
 * `approvals.controller.ts` were still undeclared, because the file said
 * `@RequirePermissions` on its chain-configuration routes and nothing at all on the queue,
 * decide, resubmit and history routes. Once the guard began refusing the undeclared, those
 * five returned 403 to every caller, and this test went on passing.
 *
 * The lesson is narrow and worth keeping: the guard resolves the decorator **per handler**
 * (`getAllAndOverride` over `[handler, class]`), so a test that resolves it per *file* is
 * not checking the thing the guard checks.
 */
interface Handler {
  method: string;
  line: number;
  /** A declaration applies to it — its own, or the controller class's. */
  declared: boolean;
  /** `PermissionsGuard` is mounted on it — so an absent declaration refuses. */
  guarded: boolean;
}

const USE_PERMISSIONS_GUARD = /@UseGuards\([^)]*PermissionsGuard/s;

/**
 * The decorators attached to the `@Controller` class itself.
 *
 * Finding this by the *first* `export class` in the file is wrong, and was: a controller
 * that declares a query DTO above itself — `permission-refusals` does — would have its
 * class decorators read from above the DTO, where there are none. So the anchor is the
 * `@Controller(...)` line, and the block is the contiguous decorator run around it.
 */
function classBlockOf(lines: string[]): string {
  const anchor = lines.findIndex((line) => /^@Controller\(/.test(line));
  if (anchor < 0) return '';
  let start = anchor;
  while (start > 0) {
    const previous = lines[start - 1];
    // A decorator run ends at the doc comment above it, a blank line, or the imports.
    if (
      previous.trim() === '' ||
      /^\s*\*\//.test(previous) ||
      /^import /.test(previous) ||
      /^}/.test(previous)
    ) {
      break;
    }
    start--;
  }
  let end = anchor;
  while (end < lines.length - 1 && !/^export class /.test(lines[end])) end++;
  return lines.slice(start, end + 1).join('\n');
}

/**
 * Route handlers in a controller, with whatever declaration and guard applies to each.
 *
 * ## Why this exists, and why the file-level check was not enough
 *
 * The first version of this test asked whether a controller file mentioned
 * `@RequirePermissions` *anywhere*. Every controller passed — and five handlers on
 * `approvals.controller.ts` were still undeclared, because the file said
 * `@RequirePermissions` on its chain-configuration routes and nothing at all on the queue,
 * decide, resubmit and history routes. Once the guard began refusing the undeclared, those
 * five returned 403 to every caller, and this test went on passing.
 *
 * The lesson is narrow and worth keeping: the guard resolves both the declaration and its own
 * mounting **per handler** (`getAllAndOverride` over `[handler, class]`), so a test that
 * resolves either per *file* is not checking the thing the guard checks. `auth` is the case
 * that proves the guard half matters — it mounts `PermissionsGuard` on one method, and
 * `login` must stay reachable by callers who hold nothing at all.
 */
function handlersOf(text: string): Handler[] {
  const lines = text.split('\n');
  const classBlock = classBlockOf(lines);
  const classDeclared = DECLARATION.test(classBlock);
  const classGuarded = USE_PERMISSIONS_GUARD.test(classBlock);

  const handlers: Handler[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s+@(Get|Post|Patch|Put|Delete)\(/.test(lines[i])) continue;
    // A handler's own decorators may sit above the route decorator as well as below it, so
    // both directions are scanned, bounded by the blank line that separates handlers.
    let start = i;
    while (start > 0 && lines[start - 1].trim() !== '') start--;
    let end = i;
    while (
      end < lines.length - 1 &&
      !/^\s+(async )?[a-zA-Z_][\w]*\s*\(/.test(lines[end + 1])
    ) {
      end++;
    }
    const block = lines.slice(start, end + 2).join('\n');
    handlers.push({
      method: lines[i].trim(),
      line: i + 1,
      declared: classDeclared || DECLARATION.test(block),
      guarded: classGuarded || USE_PERMISSIONS_GUARD.test(block),
    });
  }
  return handlers;
}

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

  it('no *handler* behind the guard is authorised by nothing at all', () => {
    // The check the file-level one above could not make. Scoped to controllers that actually
    // mount `PermissionsGuard`, because only there does an absent declaration refuse.
    const undeclared: string[] = [];
    for (const controller of controllers) {
      if (controller.path in AUTHORISED_ELSEWHERE) continue;
      for (const handler of handlersOf(controller.text)) {
        if (handler.declared || !handler.guarded) continue;
        undeclared.push(`${controller.path}:${handler.line} ${handler.method}`);
      }
    }

    // If this fails, that route returns 403 `ROUTE_ACCESS_UNDECLARED` to every caller —
    // including the ones who should reach it. Give it `@RequirePermissions(...)`, or
    // `@SelfService()` where the service resolves authority per record.
    expect(undeclared).toEqual([]);
  });

  it('finds the handlers it is supposed to be checking', () => {
    // Paired with the assertion above: a `handlersOf` that silently matched nothing — a
    // changed decorator style, a formatting change — would make it pass vacuously, which is
    // the exact failure this whole file exists to prevent from recurring.
    const handlers = controllers.flatMap((c) => handlersOf(c.text));
    const guarded = handlers.filter((h) => h.guarded);
    expect(handlers.length).toBeGreaterThan(350);
    expect(guarded.length).toBeGreaterThan(350);
    // And that the guard half discriminates at all — `auth`'s login and the invite routes
    // are the unguarded ones, so a `guarded` that were always true would hide them.
    expect(handlers.length - guarded.length).toBeGreaterThan(0);
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
