import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Principle I across the spine's boundary, both ways (016 T055, quickstart Pass 10).
 *
 * Two claims, and they fail differently:
 *
 * 1. **No module queries a spine table.** The moment one does, the spine stops being a
 *    module with a boundary and becomes a shared table six features write to directly —
 *    which is the state feature 016 exists to replace, reached by the back door.
 * 2. **The spine queries no module's table.** This is the one that would be easy to break
 *    and tempting to break: the queue would be nicer if it could read the indent, and the
 *    settings screen would be nicer if it could resolve a role name. Both are one line
 *    away and both are the violation.
 *
 * Neither failure shows up at runtime. Everything keeps working, on one database, until
 * somebody tries to extract a service or a schema and discovers the seam was never real.
 * That is why this is a test and not a note.
 *
 * Both forbidden sets are derived from `schema.prisma`, so a model added next year is
 * covered without anybody remembering to come back here. A guard that needs maintaining
 * is a guard that stops working.
 *
 * ## This guard has been seen to fail
 *
 * Checklist CHK008. It was verified by deliberately adding `this.prisma.punchRecord
 * .findFirst()` to `approvals.service.ts` and `tx.approvalInstance.findMany()` to
 * `attendance-exceptions.service.ts`; each direction failed, naming the exact file and
 * delegate, and passed again on revert.
 */

const REPO_ROOT = join(__dirname, '..', '..');
const SRC = join(REPO_ROOT, 'src');
const SPINE_DIR = join(SRC, 'approvals');
const SCHEMA = join(REPO_ROOT, 'prisma', 'schema.prisma');

interface Model {
  name: string;
  delegate: string;
  schema: string;
}

/** Every model in `schema.prisma`, with the database schema it is declared in. */
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

/** `.someDelegate.` — any property access that reaches a Prisma delegate. */
const accesses = (source: string, delegate: string) =>
  new RegExp(`\\.\\s*${delegate}\\s*\\.`).test(source);

describe('Principle I — the approval spine’s boundary, in both directions', () => {
  const all = models();
  const spine = all.filter(
    (m) => /^Approval/.test(m.name) || m.name === 'RoleSlotMapping',
  );

  it('finds the spine models it is supposed to be guarding', () => {
    // A guard that silently matches nothing is worse than no guard: every assertion
    // below would pass vacuously and nobody would know.
    expect(spine.map((m) => m.name).sort()).toEqual([
      'ApprovalChain',
      'ApprovalDecision',
      'ApprovalInstance',
      'ApprovalLevel',
      'RoleSlotMapping',
    ]);
    expect(spine.every((m) => m.schema === 'shared')).toBe(true);
  });

  it('no module outside src/approvals queries a spine table', () => {
    const offences: string[] = [];

    for (const file of tsFilesUnder(SRC)) {
      if (file.startsWith(SPINE_DIR)) continue;
      const source = readFileSync(file, 'utf8');
      const relative = file.slice(REPO_ROOT.length + 1);

      for (const model of spine) {
        if (accesses(source, model.delegate)) {
          offences.push(`${relative}: .${model.delegate}.`);
        }
      }
      if (/(FROM|JOIN|INTO|UPDATE)\s+"?shared"?\.\s*"?Approval/i.test(source)) {
        offences.push(`${relative}: raw SQL against a spine table`);
      }
    }

    // Modules talk to the spine through `ApprovalService`. Nothing else.
    expect(offences).toEqual([]);
  });

  it('the spine queries no other module’s tables', () => {
    // Everything outside the `shared` schema. The spine's own tables are in `shared`, and
    // so is `User` — which it reads to put a name against a decision, the one lookup it
    // genuinely owns. `settings` is forbidden alongside the business schemas: resolving a
    // role *name* would be convenient and is exactly the cross-schema read that makes the
    // boundary imaginary.
    const foreign = all.filter(
      (m) => m.schema !== 'shared' && m.schema !== 'unknown',
    );
    expect(foreign.length).toBeGreaterThan(50);

    const offences: string[] = [];
    for (const file of tsFilesUnder(SPINE_DIR)) {
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

  it('never dereferences the entity it governs', () => {
    // research.md §1's opacity, as a property of the code rather than an intention. The
    // spine stores `(entityType, entityId)` and has no way to turn either into an item —
    // which is why `subject`, `href` and `viewPermission` are supplied by the module at
    // submit time and stored as data.
    const service = readFileSync(
      join(SPINE_DIR, 'approvals.service.ts'),
      'utf8',
    );
    for (const field of ['subject', 'href', 'viewPermission']) {
      expect(service).toContain(`input.${field}`);
    }

    // And the reconciliation sweep — the one place the spine needs an answer only a
    // module has — asks through a registered reconciler rather than reading anything.
    const sweep = readFileSync(
      join(SPINE_DIR, 'reconciliation.service.ts'),
      'utf8',
    );
    expect(sweep).toContain('reconciler.reconcile(');
  });

  it('reaches role holders only through UsersService, never through settings.UserRole', () => {
    // The positive half. Without it, deleting the holder lookup entirely would make the
    // assertions above pass — a boundary held by having removed the feature is not a
    // boundary held.
    const service = readFileSync(
      join(SPINE_DIR, 'approvals.service.ts'),
      'utf8',
    );
    expect(service).toContain('findActiveHoldersOfRole');
    expect(service).not.toContain('userRole');
  });
});
