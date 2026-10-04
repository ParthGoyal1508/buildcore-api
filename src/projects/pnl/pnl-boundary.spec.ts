import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * The P&L reads other modules through the registry, never by querying their tables (018 T049).
 *
 * Copied from `src/letters/letters-boundary.spec.ts`, and **both directions**, because a boundary
 * enforced one way is a boundary that leaks the other:
 *
 *   1. the P&L must not query `labour`, `inventory` or `plant` tables;
 *   2. no business module may query the billing tables.
 *
 * The second matters as much as the first. The moment `labour` reads `ClientBill` to work out what was
 * billed, two modules compute revenue and the figures diverge — which is the defect `bill-totals.ts`
 * exists to prevent, arriving by a different route.
 */

const REPO = join(__dirname, '..', '..', '..');
const PNL_DIR = 'src/projects/pnl';
const BILLING_DIR = 'src/projects/billing';

/** Prisma delegates belonging to other modules' schemas. */
const FOREIGN_DELEGATES = [
  'labourPaymentSheet',
  'paymentSheetLine',
  'labourWorker',
  'musterRoll',
  'stockLedger',
  'materialIssue',
  'purchaseBill',
  'equipment',
  'fuelEntry',
  'logbookEntry',
  'hireBill',
];

/** The billing tables, which only `src/projects` may touch. */
const BILLING_DELEGATES = [
  'clientBill',
  'clientBillLine',
  'workOrderBOQItem',
  'rABillLine',
];

/**
 * A directory walk, not `git ls-files`.
 *
 * `git ls-files` omits files that are new and unstaged — which on the commit that adds this test is
 * every file it is meant to be checking. A guard that passes because it found nothing is worse than no
 * guard, so this reads the filesystem the way `letters-boundary.spec.ts` does.
 */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(REPO, dir))) {
    const relative = `${dir}/${entry}`;
    if (statSync(join(REPO, relative)).isDirectory()) {
      out.push(...filesUnder(relative));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) {
      out.push(relative);
    }
  }
  return out;
}

function allSourceFiles(): string[] {
  return filesUnder('src');
}

/** `tx.foo.` or `prisma.foo.` — a delegate being used, not merely a word appearing. */
function uses(source: string, delegate: string): boolean {
  return new RegExp(`\\.${delegate}\\s*\\.`).test(source);
}

describe('the P&L does not reach into other modules’ tables', () => {
  it('finds the files it is supposed to be checking', () => {
    // A listing that matched nothing would pass every assertion below vacuously.
    expect(filesUnder(PNL_DIR).length).toBeGreaterThan(0);
  });

  it('queries no labour, inventory or plant table', () => {
    const offences: string[] = [];
    for (const file of filesUnder(PNL_DIR)) {
      const source = readFileSync(join(REPO, file), 'utf8');
      for (const delegate of FOREIGN_DELEGATES) {
        if (uses(source, delegate)) offences.push(`${file}: .${delegate}.`);
      }
    }
    // Costs come through `ProjectSourcesRegistry`. A join here would be faster to write and would make
    // the module boundary imaginary — see Principle I.
    expect(offences).toEqual([]);
  });

  it('queries no raw SQL against another module’s schema', () => {
    const offences: string[] = [];
    for (const file of filesUnder(PNL_DIR)) {
      const source = readFileSync(join(REPO, file), 'utf8');
      if (
        /(FROM|JOIN|INTO|UPDATE)\s+"?(labour|inventory|plant|hr)"?\./i.test(
          source,
        )
      ) {
        offences.push(`${file}: raw SQL across a schema boundary`);
      }
    }
    expect(offences).toEqual([]);
  });
});

describe('no module outside src/projects queries the billing tables', () => {
  it('finds the files it is supposed to be checking', () => {
    expect(allSourceFiles().length).toBeGreaterThan(50);
  });

  it('keeps the billing tables inside src/projects', () => {
    const offences: string[] = [];
    for (const file of allSourceFiles()) {
      if (file.startsWith('src/projects/')) continue;
      const source = readFileSync(join(REPO, file), 'utf8');
      for (const delegate of BILLING_DELEGATES) {
        if (uses(source, delegate)) offences.push(`${file}: .${delegate}.`);
      }
    }
    // The moment `labour` reads `ClientBill` to work out what was billed, two modules compute revenue
    // and the figures diverge — the defect `bill-totals.ts` exists to prevent, arriving another way.
    expect(offences).toEqual([]);
  });
});

describe('the billing services keep to their own schema', () => {
  it('query no other module’s tables either', () => {
    // The same rule applied to `src/projects/billing`: the bills are priced from the BOQ, which is in
    // `projects`, and nothing else.
    const offences: string[] = [];
    for (const file of filesUnder(BILLING_DIR)) {
      const source = readFileSync(join(REPO, file), 'utf8');
      for (const delegate of FOREIGN_DELEGATES) {
        if (uses(source, delegate)) offences.push(`${file}: .${delegate}.`);
      }
    }
    expect(offences).toEqual([]);
  });
});
