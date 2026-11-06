import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * 058: every My Workspace controller reads the caller's own records in their home company.
 *
 * A `my/…` controller that forgot `@OwnRecords()` would work for everyone today and fail only for
 * an all-companies user who had switched company — "No employee record is linked to this account"
 * on their own punch screen, found by the first person to try. So the rule is checked over the
 * source rather than left to memory.
 *
 * The exceptions follow the company the person is working in on purpose: which payment modes the
 * screen may offer is the working company's setting.
 */
const FOLLOW_WORKING_COMPANY = new Set(['my/cash-policy']);

const SRC = join(process.cwd(), 'src');

function controllerFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return controllerFiles(path);
    return name.endsWith('.controller.ts') ? [path] : [];
  });
}

interface MyController {
  file: string;
  path: string;
  marked: boolean;
}

const myControllers: MyController[] = controllerFiles(SRC).flatMap((file) => {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(/@Controller\('(my(?:\/[^']*)?)'\)/g)].map(
    (match) => {
      // The decorators stacked on this class: everything since the previous statement or comment.
      const before = source.slice(0, match.index);
      const start = Math.max(
        before.lastIndexOf(';\n'),
        before.lastIndexOf('*/'),
        before.lastIndexOf('}\n'),
      );
      return {
        file: relative(SRC, file),
        path: match[1],
        marked: before.slice(start).includes('@OwnRecords()'),
      };
    },
  );
});

describe('My Workspace controllers read in the home company (058)', () => {
  it('found the my/ controllers', () => {
    // Vacuity: an empty list passes every check below.
    expect(myControllers.length).toBeGreaterThanOrEqual(10);
  });

  it('marks every one with @OwnRecords(), apart from the named exceptions', () => {
    const unmarked = myControllers
      .filter((c) => !c.marked && !FOLLOW_WORKING_COMPANY.has(c.path))
      .map((c) => `${c.path} (${c.file})`);
    expect(unmarked).toEqual([]);
  });

  it('leaves the exceptions on the working company', () => {
    const marked = myControllers
      .filter((c) => c.marked && FOLLOW_WORKING_COMPANY.has(c.path))
      .map((c) => c.path);
    expect(marked).toEqual([]);
  });
});
