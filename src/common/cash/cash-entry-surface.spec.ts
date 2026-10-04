import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

import { CASH_ENUM_VALUES, CASH_MODE_FIELDS } from './cash-surfaces';

/**
 * What keeps the cash-entry gate complete (019 FR-017a, task T077).
 *
 * `CashEntryInterceptor` finds cash in a request body rather than on a list of routes, and that
 * is only sufficient while **every** cash record originates in a request. The moment a service
 * writes a cash mode it decided for itself, the body holds nothing to find and the write is
 * unguarded — silently, because passing is what passing looks like.
 *
 * So two things are asserted here, and neither is about any particular route:
 *
 *   1. the interceptor is registered globally, because a per-controller one would be absent on
 *      whichever module nobody remembered;
 *   2. no source file writes a cash mode value, so the body check cannot be bypassed.
 *
 * Breaking (2) is legitimate — a sheet whose mode comes from its own type, an import that
 * defaults to cash. It just has to say so with `@RequiresCashEntry()`, and this test is what
 * makes saying so unavoidable. T074 was a one-time audit; this is what keeps it true.
 */

const SRC = join(__dirname, '..', '..');
const REPO = join(SRC, '..');

describe('the cash-entry gate cannot be bypassed', () => {
  it('registers the interceptor globally', () => {
    const appModule = readFileSync(join(SRC, 'app.module.ts'), 'utf8');
    // Per-controller registration is the failure this asserts against: "every write that
    // records cash" is the requirement, and the gate would be missing wherever somebody forgot.
    expect(appModule).toContain('useClass: CashEntryInterceptor');
    expect(appModule).toContain('APP_INTERCEPTOR');
  });

  it('inspects the request body on a write and leaves reads alone', () => {
    const source = readFileSync(
      join(__dirname, 'cash-entry.interceptor.ts'),
      'utf8',
    );
    // Both halves, because dropping either silently changes who is refused: without the level
    // check a read-only clerk loses a list they are entitled to, and without the body check the
    // gate becomes a general payments permission.
    expect(source).toContain('AccessLevel.read');
    expect(source).toContain('findCashInRequest');
  });

  it('finds no service that writes a cash mode of its own accord', () => {
    const matches = grepSource();
    const offenders = matches.filter((line) => !isAllowed(line));

    // If this fails: a write now sets a cash payment mode the caller never sent, so
    // `CashEntryInterceptor` sees nothing cash-looking in the body and admits it. Declare the
    // route with `@RequiresCashEntry()` and add it to ALLOWED below with the reason.
    expect(offenders).toEqual([]);
  });

  it('finds the lines it is supposed to be checking', () => {
    // A grep that matched nothing would pass the assertion above vacuously — the failure mode
    // of every test that searches a codebase for a pattern.
    expect(grepSource().length).toBeGreaterThan(0);
  });
});

/**
 * Every line in `src/` that mentions a cash mode value, from git rather than a directory walk —
 * an untracked scratch file is not part of the product and should not be able to fail this.
 */
function grepSource(): string[] {
  const patterns = CASH_MODE_FIELDS.flatMap((field) =>
    CASH_ENUM_VALUES.flatMap((value) => [
      `${field}: '${value}'`,
      `${field}: "${value}"`,
      `Mode.${value}`,
    ]),
  );
  const out: string[] = [];
  for (const pattern of patterns) {
    try {
      const result = execFileSync(
        'git',
        ['grep', '-n', '-F', pattern, '--', 'src/'],
        { cwd: REPO, encoding: 'utf8' },
      );
      out.push(...result.split('\n').filter(Boolean));
    } catch {
      // `git grep` exits 1 when a pattern matches nothing. Not an error here.
    }
  }
  return [...new Set(out)];
}

/**
 * The lines that may mention a cash mode.
 *
 * Narrow on purpose: a *comparison* reads a mode the caller sent and is exactly what the
 * interceptor is there to have already checked; prose and the constants themselves are not
 * writes at all. Anything else is a service deciding a payment is cash, which the body check
 * cannot see.
 */
function isAllowed(line: string): boolean {
  const [file, , ...rest] = line.split(':');
  const code = rest.join(':');

  // Documentation and the constants, where naming the value is the point.
  if (file.startsWith('src/common/cash/')) return true;
  if (file.startsWith('src/common/decorators/cash-entry.decorator.ts')) {
    return true;
  }
  if (file === 'src/metadata.ts') return true;
  const trimmed = code.trim();
  if (trimmed.startsWith('*') || trimmed.startsWith('//')) return true;

  // A comparison, not a write. `dto.paymentMode === LabourPaymentMode.cash` is the service
  // reading what the caller sent — which the interceptor has already gated.
  if (/[=!]==?\s*\w*Mode\.\w+|\w*Mode\.\w+\s*[=!]==/.test(code)) return true;

  return false;
}
