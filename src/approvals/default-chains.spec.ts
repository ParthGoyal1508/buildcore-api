import * as chains from './default-chains';

/**
 * Every action type the spine knows about has a default chain, or is named here as deliberately
 * without one.
 *
 * ## The defect this exists for
 *
 * On 2026-10-03 a freshly seeded demo company **refused every subcontractor bill sent for
 * certification** with `APPROVAL_CHAIN_NOT_CONFIGURED`. The cause was two lists: `ChainsService`
 * carried the canonical set of chains a company gets on creation, and `prisma/seed-demo.ts` carried
 * a hand-copied subset that had drifted three chains behind — `attendance_correction`,
 * `operator_fuel_recovery` and `ra_bill`.
 *
 * The two lists are now one, which removes that particular drift. What this spec catches is the
 * *next* one: an `ACTION_*` constant added for a new module and never added to
 * `DEFAULT_COMPANY_CHAINS`. The symptom would be identical and just as quiet — the first submission
 * of that kind, in any company created after the change, refused as a configuration fault. A
 * company old enough to have been reached by a backfill migration would keep working, so whether it
 * is broken depends on when the company was created, which is the hardest kind of gap to notice.
 */

/**
 * Action types with no default chain, each with the reason.
 *
 * Adding a name here is a deliberate statement that a company should start **without** this gate.
 * Nothing should land here to make the test pass.
 */
const DELIBERATELY_UNCHAINED: Record<string, string> = {
  // The pre-016 attendance exception, kept only so historical instances still resolve their chain.
  // A new company must never be given one: its submissions go to `attendance_exception`.
  ACTION_ATTENDANCE_EXCEPTION_LEGACY:
    'a retired action type, retained only so instances raised before 016 still resolve',
};

describe('DEFAULT_COMPANY_CHAINS', () => {
  /** Every exported `ACTION_*` constant, by its export name. */
  const actionExports = Object.entries(chains).filter(
    ([name, value]) => name.startsWith('ACTION_') && typeof value === 'string',
  ) as [string, string][];

  const chained = new Set(
    chains.DEFAULT_COMPANY_CHAINS.map(([actionType]) => actionType),
  );

  it('reads the module at all — a silent zero would make the sweep below vacuous', () => {
    // The case that separates "everything is chained" from "nothing was found", which look
    // identical from outside. Both `boq-workbook.reader.spec.ts` and `route-shadowing.spec.ts`
    // shipped this shape of mistake the same day.
    expect(actionExports.length).toBeGreaterThan(8);
    expect(chains.DEFAULT_COMPANY_CHAINS.length).toBeGreaterThan(8);
    expect(chained).toContain('ra_bill');
  });

  it('gives every action type a default chain, or names it as deliberately without one', () => {
    const missing = actionExports
      .filter(
        ([name, actionType]) =>
          !chained.has(actionType) && !(name in DELIBERATELY_UNCHAINED),
      )
      .map(([name, actionType]) => `${name} ("${actionType}")`);

    // Named, not counted. "One action type has no chain" leaves somebody diffing two lists; the
    // name is the whole of the fix.
    expect(missing).toEqual([]);
  });

  it('defines at least one level for each chain, with a final authority', () => {
    for (const [actionType, levels] of chains.DEFAULT_COMPANY_CHAINS) {
      expect(levels.length).toBeGreaterThan(0);
      // A chain with no final authority can never complete, and the symptom is not an error — it
      // is an item that sits in a queue indefinitely while reading as submitted.
      expect(levels.some((level) => level.isFinalAuthority === true)).toBe(
        true,
      );
      // Positions are what the spine walks. A gap or a duplicate parks an item at a level the
      // chain does not define, which `decide` reports as a chain an administrator must repair.
      expect(levels.map((level) => level.position).sort()).toEqual(
        levels.map((_, index) => index + 1),
      );
      expect(actionType).toMatch(/^[a-z_]+$/);
    }
  });

  it('lists each action type exactly once', () => {
    // Two entries for one action type would mean the second never runs — the seeder skips an
    // action it has already created — so the levels somebody intended could be silently ignored.
    const seen = chains.DEFAULT_COMPANY_CHAINS.map(
      ([actionType]) => actionType,
    );
    expect(new Set(seen).size).toBe(seen.length);
  });
});
