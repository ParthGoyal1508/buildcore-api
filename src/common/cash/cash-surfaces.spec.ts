import { readFileSync } from 'fs';
import { join } from 'path';

import {
  CASH_ENUM_VALUES,
  CASH_MODE_ENUMS,
  UNCONDITIONAL_CASH_FIELDS,
  isCashMode,
} from './cash-surfaces';
import { hideCash } from './cash-visibility.interceptor';

/**
 * The cash surface list, and the guard that keeps it honest (019 FR-014, FR-015, T060).
 *
 * A closed list is a liability: a module added later holds cash, nobody updates the constant,
 * and a figure appears on a screen somebody was told would hide it. So the first test parses
 * `schema.prisma` and fails when an enum grows a `cash` value the constant does not name —
 * turning the list going stale into a failing test rather than a promise quietly broken.
 */

const SCHEMA = join(__dirname, '..', '..', '..', 'prisma', 'schema.prisma');

/** Every enum in the schema that has a value meaning "cash", with its name. */
function enumsWithCashValue(): string[] {
  const source = readFileSync(SCHEMA, 'utf8');
  const out: string[] = [];
  const block = /^enum\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  let match: RegExpExecArray | null;
  while ((match = block.exec(source)) !== null) {
    const [, name, body] = match;
    const values = body
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^\w+$/.test(line));
    if (values.some((v) => CASH_ENUM_VALUES.includes(v))) out.push(name);
  }
  return out;
}

describe('the cash surface list is complete', () => {
  it('finds the enums it is supposed to be checking', () => {
    // A guard that matched nothing would pass the assertion below vacuously.
    expect(enumsWithCashValue().length).toBeGreaterThan(0);
  });

  it('names every enum in the schema that has a cash value', () => {
    const found = enumsWithCashValue().sort();
    const declared = [...CASH_MODE_ENUMS].sort();

    // If this fails, a new enum carries a `cash` value and the interceptor does not know about
    // it. Add it to CASH_MODE_ENUMS — and check whether its rows' amount field is in
    // CASH_AMOUNT_FIELDS too, because naming the enum alone hides nothing.
    expect(found).toEqual(declared);
  });

  it('still excludes the company’s configured denominations', () => {
    // `Company.labourCashDenominations` looks like cash and is not: it is configuration, and
    // hiding it would break the payment sheet builder while concealing nothing anybody wanted
    // concealed. Asserted so a future tidy-up does not "complete" the list by adding it.
    expect(UNCONDITIONAL_CASH_FIELDS).not.toContain('labourCashDenominations');
  });
});

describe('isCashMode', () => {
  it('recognises a cash mode and nothing else', () => {
    expect(isCashMode('cash')).toBe(true);
    expect(isCashMode('bank')).toBe(false);
    expect(isCashMode('bank_transfer')).toBe(false);
    expect(isCashMode(undefined)).toBe(false);
    expect(isCashMode(null)).toBe(false);
  });
});

describe('hideCash', () => {
  it('hides a cash payment’s amount and marks it', () => {
    expect(hideCash({ id: 'p1', paymentMode: 'cash', amount: 5000 })).toEqual({
      id: 'p1',
      paymentMode: 'cash',
      amount: null,
      amountHidden: true,
    });
  });

  it('nulls rather than zeroes', () => {
    // A zero is a figure. Neither a reader nor a spreadsheet summing a column can tell a hidden
    // amount from a real zero, and an export would silently understate its total by the value of
    // every cash payment in it.
    const hidden = hideCash({ paymentMode: 'cash', amount: 5000 }) as Record<
      string,
      unknown
    >;
    expect(hidden.amount).toBeNull();
    expect(hidden.amount).not.toBe(0);
  });

  it('leaves a non-cash payment entirely alone', () => {
    const row = { id: 'p2', paymentMode: 'bank_transfer', amount: 9000 };
    expect(hideCash(row)).toEqual(row);
  });

  it('hides a denomination breakup whatever the mode says', () => {
    // Cash by construction: a note-count breakup exists only for cash.
    const hidden = hideCash({
      id: 's1',
      denominationBreakup: { 500: 4 },
    }) as Record<string, unknown>;
    expect(hidden.denominationBreakup).toBeNull();
    expect(hidden.amountHidden).toBe(true);
  });

  it('applies the parent row’s mode to its lines', () => {
    // Hiding a sheet's total while leaving its lines visible would hide nothing at all.
    const hidden = hideCash({
      paymentMode: 'cash',
      netTotal: 10000,
      lines: [{ workerId: 'w1', amount: 500 }],
    }) as Record<string, unknown>;
    expect(hidden.netTotal).toBeNull();
    expect((hidden.lines as Record<string, unknown>[])[0].amount).toBeNull();
  });

  it('walks arrays', () => {
    const hidden = hideCash([
      { paymentMode: 'cash', amount: 1 },
      { paymentMode: 'bank', amount: 2 },
    ]) as Record<string, unknown>[];
    expect(hidden[0].amount).toBeNull();
    expect(hidden[1].amount).toBe(2);
  });

  it('does not touch a Date, and so does not corrupt timestamps', () => {
    // The bug this guards against is far worse than the one the feature prevents: walking into
    // a Date and rebuilding it as a plain object would break every timestamp in a response.
    const when = new Date('2026-09-30T00:00:00.000Z');
    const hidden = hideCash({
      paymentMode: 'cash',
      amount: 100,
      createdAt: when,
    }) as Record<string, unknown>;
    expect(hidden.createdAt).toBe(when);
    expect(hidden.createdAt instanceof Date).toBe(true);
  });

  it('leaves a null amount as null without claiming it was hidden', () => {
    // A row that never had an amount must not report `amountHidden`, or every absent figure
    // would look deliberately concealed.
    const hidden = hideCash({ paymentMode: 'cash', amount: null }) as Record<
      string,
      unknown
    >;
    expect(hidden.amount).toBeNull();
    expect(hidden.amountHidden).toBeUndefined();
  });

  it('marks nothing on a response with no cash in it', () => {
    const row = { id: 'x', name: 'A project', contractValue: 100 };
    expect(hideCash(row)).toEqual(row);
  });
});

/**
 * FR-017d, task T079 — added 2026-10-02.
 *
 * The one change hiding itself needed. Hiding a note count from the cashier who has to count the
 * notes against it conceals nothing from anybody it was meant to conceal from, while making the
 * screen's only purpose unreachable.
 */
describe('the denomination breakup and who may see it', () => {
  const SHEET = {
    id: 's1',
    paymentMode: 'cash',
    netTotal: 10000,
    denominationBreakup: { 500: 20 },
  };

  it('shows the breakup to a caller who may enter cash', () => {
    const shown = hideCash(SHEET, false, true) as Record<string, unknown>;
    expect(shown.denominationBreakup).toEqual({ 500: 20 });
  });

  it('still hides the amounts from that same caller', () => {
    // A cashier needs the breakup to pay out. They need no view of what every other cash payment
    // in the company came to, so the two are separate decisions and only one of them moved.
    const shown = hideCash(SHEET, false, true) as Record<string, unknown>;
    expect(shown.netTotal).toBeNull();
  });

  it('hides the breakup from everyone else', () => {
    const hidden = hideCash(SHEET, false, false) as Record<string, unknown>;
    expect(hidden.denominationBreakup).toBeNull();
  });

  it('hides it as null, never as a zeroed count', () => {
    // A denomination count of zero reads as a real count of no notes — a different and false
    // statement, and one a cashier would act on.
    const hidden = hideCash(SHEET, false, false) as Record<string, unknown>;
    expect(hidden.denominationBreakup).toBeNull();
    expect(hidden.denominationBreakup).not.toEqual({});
    expect(hidden.denominationBreakup).not.toEqual({ 500: 0 });
  });

  it('defaults to hiding when nobody said otherwise', () => {
    // The argument is optional, so every existing caller of `hideCash` keeps the old behaviour.
    // It must default to hiding: a default of "show" would silently publish the breakup on every
    // surface that has not been updated.
    const hidden = hideCash(SHEET) as Record<string, unknown>;
    expect(hidden.denominationBreakup).toBeNull();
  });
});
