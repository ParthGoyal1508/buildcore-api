import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Principle I, enforced rather than trusted (016 T041).
 *
 * `hr` may not read or write `payroll`'s tables. Feature 016 makes that easy to break:
 * the attendance write path now needs to know whether a period is under payroll review,
 * and the obvious way to find out — reading `payroll.PayrollRun` — is exactly the
 * cross-schema query the constitution forbids. The correct route is
 * `PayrollScheduleService.isPeriodUnderReview`, an exported service method
 * (research.md §5).
 *
 * This test derives the forbidden set from `schema.prisma` rather than hardcoding it, so
 * a payroll model added next year is covered without anybody remembering to come back
 * here. A guard that needs maintaining is a guard that stops working.
 */

const REPO_ROOT = join(__dirname, '..', '..');
const HR_DIR = join(REPO_ROOT, 'src', 'hr');
const SCHEMA = join(REPO_ROOT, 'prisma', 'schema.prisma');

/** Every model declared with `@@schema("payroll")`, as Prisma delegate names. */
function payrollDelegates(): string[] {
  const schema = readFileSync(SCHEMA, 'utf8');
  const names: string[] = [];

  const modelBlock = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  let match: RegExpExecArray | null;
  while ((match = modelBlock.exec(schema)) !== null) {
    const [, name, body] = match;
    if (body.includes('@@schema("payroll")')) {
      names.push(name[0].toLowerCase() + name.slice(1));
    }
  }
  return names;
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

describe('Principle I — hr may not touch payroll tables', () => {
  const delegates = payrollDelegates();

  it('finds the payroll models it is supposed to be guarding', () => {
    // If this ever finds nothing, every assertion below would pass vacuously — which is
    // the failure mode that makes a guard worse than no guard.
    expect(delegates.length).toBeGreaterThan(0);
    expect(delegates).toContain('payrollRun');
    expect(delegates).toContain('payrollLineItem');
  });

  it('has no Prisma delegate access to a payroll model anywhere under src/hr', () => {
    const offences: string[] = [];

    for (const file of tsFilesUnder(HR_DIR)) {
      const source = readFileSync(file, 'utf8');
      const relative = file.slice(REPO_ROOT.length + 1);

      for (const delegate of delegates) {
        // `tx.payrollRun.` / `prisma.payrollRun.` / `this.prisma.payrollRun.` — any
        // property access that reaches a payroll delegate.
        const access = new RegExp(`\\.\\s*${delegate}\\s*\\.`, 'g');
        if (access.test(source)) {
          offences.push(`${relative}: .${delegate}.`);
        }
      }

      // Raw SQL naming the schema is the other way round the type system.
      if (/"payroll"\s*\./.test(source) || /\bpayroll\.\w+/.test(source)) {
        // `payroll.runs.payroll-schedule.service` appears in import paths, which are
        // not queries. Only flag it where it reads like SQL.
        const sqlish = /(FROM|JOIN|INTO|UPDATE)\s+"?payroll"?\./i.test(source);
        if (sqlish) offences.push(`${relative}: raw SQL against payroll`);
      }
    }

    expect(offences).toEqual([]);
  });

  it('reaches payroll only through its exported service', () => {
    // The positive half: the attendance lock exists and goes through the service. Without
    // this, deleting the lock entirely would make the test above pass.
    const admin = readFileSync(
      join(HR_DIR, 'attendance', 'attendance-admin.service.ts'),
      'utf8',
    );
    expect(admin).toContain('PayrollScheduleService');
    expect(admin).toContain('isPeriodUnderReview');
  });
});
