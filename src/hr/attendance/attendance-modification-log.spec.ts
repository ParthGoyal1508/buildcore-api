import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * `AttendanceModification` is append-only (016 FR-012b, T080).
 *
 * The requirement holds **by construction** — no route updates or deletes one — and this
 * test is what keeps it holding. It is a grep rather than a behavioural test because there
 * is no behaviour to exercise: what must be true is that a capability does not exist, and
 * the only way that becomes false is somebody adding it.
 *
 * ## The one honest caveat
 *
 * `Employee.onDelete: Cascade` means hard-deleting an employee deletes their modification
 * history. That is recorded beside the model in `schema.prisma` rather than fixed: breaking
 * the cascade would strand rows against an employee who no longer exists, which is worse.
 * Soft-delete is this product's norm and no live path hard-deletes an employee. This test
 * does not guard the cascade, because the cascade is deliberate.
 */

const SRC = join(__dirname, '..', '..');

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts'))
      out.push(full);
  }
  return out;
}

describe('FR-012b — the modification log is append-only', () => {
  const sources = tsFilesUnder(SRC).map((file) => ({
    file: file.slice(SRC.length + 1),
    text: readFileSync(file, 'utf8'),
  }));

  it('reads the source tree it is supposed to be guarding', () => {
    // A guard that silently matched nothing would pass vacuously.
    expect(sources.length).toBeGreaterThan(100);
    expect(
      sources.some((s) => /attendanceModification\.create/.test(s.text)),
    ).toBe(true);
  });

  it('no code updates a modification row', () => {
    const offences = sources
      .filter((s) => /attendanceModification\s*\.\s*update/.test(s.text))
      .map((s) => s.file);
    expect(offences).toEqual([]);
  });

  it('no code deletes a modification row', () => {
    const offences = sources
      .filter((s) => /attendanceModification\s*\.\s*delete/.test(s.text))
      .map((s) => s.file);
    expect(offences).toEqual([]);
  });

  it('no code upserts one either', () => {
    // An upsert is an update wearing a create's clothes, and it is the form somebody
    // reaches for when "the row already exists" looks like the problem to solve.
    const offences = sources
      .filter((s) => /attendanceModification\s*\.\s*upsert/.test(s.text))
      .map((s) => s.file);
    expect(offences).toEqual([]);
  });

  it('no raw SQL writes to the table', () => {
    const offences = sources
      .filter((s) =>
        /(UPDATE|DELETE\s+FROM)\s+"?hr"?\.\s*"?AttendanceModification/i.test(
          s.text,
        ),
      )
      .map((s) => s.file);
    expect(offences).toEqual([]);
  });
});
