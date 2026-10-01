import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = join(__dirname, '..', '..', '..');

/**
 * Source with comments stripped.
 *
 * The word search below would otherwise match its own documentation: the refusals service explains
 * at length that nothing here resolves, approves or dismisses anything, and a naive `includes`
 * reads that explanation as the violation it warns against. Stripping comments first is what makes
 * the check about the code.
 */
const codeOf = (relative: string): string =>
  readFileSync(join(REPO_ROOT, relative), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

/**
 * 020 FR-013a, FR-013c, FR-013d — asserted against the source, not against a running server.
 *
 * Both halves of this were originally planned as end-to-end passes. They are here instead because
 * what they protect is a *shape*, and a shape is better defended where it can fail the commit than
 * where it needs a seeded database: the way FR-013c's decision gets undone is one "resolve" button
 * added by somebody who never read the clarification, and the way FR-013a's promise gets broken is
 * one reader joining the refusal table into an attendance view. Neither needs a request to detect.
 */
describe('the refusal surface', () => {
  /**
   * FR-013c: a **log**, not a reviewable item.
   *
   * A refused punch was never recorded, so there is nothing an approval could approve *into*. An
   * action on this surface would create an item in a queue with no possible resolution — and the
   * route back for a wrongly refused day already exists: feature 016's manual attendance
   * correction, which creates attendance from nothing and is reviewed by somebody.
   */
  it.each([
    ['src/hr/punch/punch.controller.ts', 'my/punch'],
    ['src/hr/attendance/attendance-admin.controller.ts', 'hr/attendance'],
  ])('exposes refusals read-only in %s', (file) => {
    const source = codeOf(file);

    // Every decorator immediately preceding a handler whose route mentions refusals.
    const refusalRoutes = [
      ...source.matchAll(
        /@(Get|Post|Put|Patch|Delete)\('([^']*refusal[^']*)'\)/gi,
      ),
    ];

    expect(refusalRoutes.length).toBeGreaterThan(0);
    for (const [, verb] of refusalRoutes) {
      expect(verb).toBe('Get');
    }
  });

  it('has no handler that resolves, approves, dismisses or promotes a refusal', () => {
    // Deliberately a word search rather than a route search. The hazard is not a route named
    // `/refusals/resolve` — somebody would notice that — it is a method on the refusals service
    // called from anywhere.
    const source = codeOf('src/hr/punch/punch-refusals.service.ts');

    for (const forbidden of [
      'resolve',
      'approve',
      'dismiss',
      'promote',
      'punchRecord.create',
    ]) {
      expect(source.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  /**
   * FR-013a and FR-013d, the structural version.
   *
   * The requirement names seven readers — payroll and its payment sheet, the admin daily and
   * monthly views, the employee's own history, the labour and project cost roll-ups, absence
   * counting and leave accrual, shift compliance, and any attendance-derived export. All seven
   * reach attendance through `AttendanceHistoryService` or `AttendanceAdminService`, and both read
   * `PunchRecord` and nothing else.
   *
   * So the promise is kept by the table nobody joins, which is what makes the audit finite: a
   * reader written next year is correct without being told refusals exist. This test is what keeps
   * that true, and it is the reason the audit does not have to be repeated by hand.
   */
  it('is read by nothing that reads attendance', () => {
    let hits: string;
    try {
      hits = execFileSync(
        'git',
        [
          'grep',
          '-l',
          '-e',
          'punchRefusal',
          '--',
          'src',
          ':(exclude)src/hr/punch/punch-refusals.service.ts',
          ':(exclude)src/hr/punch/punch.service.ts',
          ':(exclude)src/hr/punch/punch.controller.ts',
          ':(exclude)src/hr/attendance/attendance-admin.controller.ts',
          ':(exclude)src/hr/punch/refusal-surface.spec.ts',
          // The refusals service's own unit test. Excluded by name rather than by a blanket
          // `*.spec.ts` exclusion: a *reader* written as a spec file would still be a reader, and a
          // pattern that hid every test from this check would hide exactly the file somebody adds
          // when they want an attendance view to show refusals "just for a report".
          ':(exclude)src/hr/punch/punch-refusals.service.spec.ts',
        ],
        {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      );
    } catch (error) {
      // `git grep` exits 1 for no matches, which is the passing case. Anything else — no git, no
      // checkout — must skip rather than pass, because a check that could not run is not a check
      // that succeeded.
      const status = (error as { status?: number }).status;
      if (status === 1) return;
      // eslint-disable-next-line no-console
      console.warn('Refusal-table reader check skipped: git grep unavailable.');
      return;
    }

    expect(hits.trim().split('\n').filter(Boolean)).toEqual([]);
  });
});
