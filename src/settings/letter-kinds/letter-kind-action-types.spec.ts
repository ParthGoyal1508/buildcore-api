import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

import {
  ACTION_LETTER_LOI,
  ACTION_LETTER_PURCHASE_ORDER,
  ACTION_LETTER_WORK_ORDER,
} from '../../approvals/default-chains';

/**
 * T036 — the seeded kinds and 016's action types are the same strings.
 *
 * Feature 016 declares `letter_work_order`, `letter_loi` and `letter_purchase_order` and
 * seeds a director-final chain for each. 017 seeds three `LetterKind` rows whose
 * `approvalActionType` must name those exact strings, or `assertMayTakeEffect` is called
 * with an action type no chain is configured for — and the letter is then refused with
 * `APPROVAL_CHAIN_NOT_CONFIGURED`, which reads like a setup problem in a system that is
 * set up correctly.
 *
 * The seed lives in SQL, so this reads the SQL. Two files agreeing today is not a
 * guarantee they agree after the next edit, and the failure mode is a commercial letter
 * nobody can issue.
 */
const MIGRATIONS = join(__dirname, '..', '..', '..', 'prisma', 'migrations');

function letterRestructureSql(): string {
  const dir = readdirSync(MIGRATIONS).find((d) =>
    d.endsWith('_letter_restructure'),
  );
  if (!dir) {
    throw new Error(
      'The letter restructure migration is missing. It is what seeds the kinds this ' +
        'test is about — if it was renamed, update this path rather than deleting the test.',
    );
  }
  return readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8');
}

describe('LetterKind approval action types (T036)', () => {
  const sql = letterRestructureSql();

  /** Every seeded row, as `[key, approvalActionType | null]`. */
  const seeded = [
    ...sql.matchAll(
      /\('ltrkind_[^']*',\s*NULL,\s*'([^']+)',\s*'[^']*',\s*(?:true|false),\s*(true|false),\s*(NULL|'[^']+')/g,
    ),
  ].map((m) => ({
    key: m[1],
    requiresApproval: m[2] === 'true',
    actionType: m[3] === 'NULL' ? null : m[3].slice(1, -1),
  }));

  it('parsed the seed at all, so a silent zero-row match cannot pass', () => {
    // Without this, a change to the INSERT's shape would make every assertion below
    // vacuously true — the failure 016's RLS tests taught this codebase to check for.
    expect(seeded.length).toBe(15);
  });

  it.each([
    ['letter_work_order', ACTION_LETTER_WORK_ORDER],
    ['letter_loi', ACTION_LETTER_LOI],
    ['letter_purchase_order', ACTION_LETTER_PURCHASE_ORDER],
  ])('%s is gated on the constant 016 exports', (key, constant) => {
    const row = seeded.find((r) => r.key === key);
    expect(row).toBeDefined();
    expect(row!.requiresApproval).toBe(true);
    expect(row!.actionType).toBe(constant);
  });

  it('gates nothing else, because the other twelve commit no money', () => {
    const gated = seeded.filter((r) => r.requiresApproval).map((r) => r.key);
    expect(gated.sort()).toEqual([
      'letter_loi',
      'letter_purchase_order',
      'letter_work_order',
    ]);
  });

  it('never marks a kind as requiring approval without naming what to gate on', () => {
    // A kind that requires approval but names no action type would be gated on an empty
    // string, which passes — it would look gated and be gated on nothing.
    for (const row of seeded) {
      if (row.requiresApproval) expect(row.actionType).toBeTruthy();
    }
  });

  it('keeps the five migrated keys byte-identical to the dropped enum values', () => {
    // The entire backfill matched on these. Changing one silently orphans every
    // pre-017 letter and template on any installation that has not migrated yet.
    const keys = seeded.map((r) => r.key);
    for (const legacy of [
      'offer',
      'appointment',
      'confirmation',
      'relieving',
      'experience',
    ]) {
      expect(keys).toContain(legacy);
    }
  });
});
