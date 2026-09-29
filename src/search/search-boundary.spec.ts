import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Principle I across search's boundary (021 T027).
 *
 * `src/search/` owning no tables **is** the design. It exists because `Employee` (`hr`),
 * `Vendor` (`partners`), `Equipment` (`plant`) and `Project` (`projects`) live in four
 * schemas and one query cannot span them — so the module holds a registry, and each
 * owning module contributes its own query from inside its own boundary.
 *
 * The realistic way that erodes is not a rewrite. It is one direct query added by
 * somebody who found the fan-out inconvenient — and nothing about it would fail at
 * runtime. Everything keeps working, on one database, until somebody tries to extract a
 * service and discovers the seam was never real. That is why this is a test.
 *
 * The forbidden set is derived from `schema.prisma`, so a model added next year is covered
 * without anybody remembering to come back here. A guard that needs maintaining is a guard
 * that stops working.
 */

const REPO_ROOT = join(__dirname, '..', '..');
const SRC = join(REPO_ROOT, 'src');
const SEARCH_DIR = join(SRC, 'search');
const SCHEMA = join(REPO_ROOT, 'prisma', 'schema.prisma');

/** The schemas search must never reach into directly. */
const FOREIGN_SCHEMAS = ['hr', 'partners', 'plant', 'projects'];

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

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...tsFilesUnder(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}

const accesses = (source: string, delegate: string) =>
  new RegExp(`\\.\\s*${delegate}\\s*\\.`).test(source);

describe('Principle I — src/search/ owns no tables and queries none', () => {
  const foreign = models().filter((m) => FOREIGN_SCHEMAS.includes(m.schema));

  it('finds the models it is supposed to be guarding', () => {
    // A guard that silently matches nothing is worse than no guard: every assertion
    // below would pass vacuously and nobody would know.
    expect(foreign.length).toBeGreaterThan(20);
    for (const name of ['Employee', 'Vendor', 'Equipment', 'Project']) {
      expect(foreign.map((m) => m.name)).toContain(name);
    }
  });

  it('src/search/ never touches a Prisma delegate for those four schemas', () => {
    const offences: string[] = [];

    for (const file of tsFilesUnder(SEARCH_DIR)) {
      const source = readFileSync(file, 'utf8');
      const relative = file.slice(REPO_ROOT.length + 1);

      for (const model of foreign) {
        if (accesses(source, model.delegate)) {
          offences.push(`${relative}: .${model.delegate}.`);
        }
      }
      if (
        new RegExp(
          `(FROM|JOIN|INTO|UPDATE)\\s+"?(${FOREIGN_SCHEMAS.join('|')})"?\\.`,
          'i',
        ).test(source)
      ) {
        offences.push(`${relative}: raw SQL against another module's schema`);
      }
    }

    expect(offences).toEqual([]);
  });

  it('src/search/ does not inject PrismaService at all', () => {
    // Stronger than the delegate check and much harder to work around: with no database
    // handle in the module, there is nothing for a convenient query to be written
    // against. The registry receives results; it does not fetch them.
    const offences: string[] = [];
    for (const file of tsFilesUnder(SEARCH_DIR)) {
      const source = readFileSync(file, 'utf8');
      if (/PrismaService/.test(source)) {
        offences.push(file.slice(REPO_ROOT.length + 1));
      }
    }
    expect(offences).toEqual([]);
  });
});
