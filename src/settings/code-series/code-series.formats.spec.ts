import { CodeSeriesType } from '@prisma/client';

import { CODE_SERIES_FORMATS, formatCode } from './code-series.formats';

/** The format of a series, applied to its first few allocations. */
const firstFew = (type: CodeSeriesType, count = 3) => {
  const format = CODE_SERIES_FORMATS[type];
  if (!format) throw new Error(`${type} has no declared format`);
  return Array.from({ length: count }, (_, i) => formatCode(format, i + 1));
};

/**
 * The three series the business quotes outside the system (2026-10-11).
 *
 * Asserted as the literal strings a person reads off a work order, not as "a string
 * containing 150" — the figures either match what was specified or they do not, and a
 * `toContain` would pass for `1500001`, `0001500001` and `150` alike.
 */
describe('code series business formats', () => {
  it('numbers projects from 1000 in steps of ten', () => {
    expect(firstFew(CodeSeriesType.PROJECTS)).toEqual(['1010', '1020', '1030']);
  });

  it('numbers vendors 2022001 upward, the 2022 fixed', () => {
    expect(firstFew(CodeSeriesType.VENDORS)).toEqual([
      '2022001',
      '2022002',
      '2022003',
    ]);
  });

  it('numbers work orders 1500001 upward, the 150 fixed', () => {
    expect(firstFew(CodeSeriesType.WORK_ORDER)).toEqual([
      '1500001',
      '1500002',
      '1500003',
    ]);
  });

  it('keeps the padding past the first nine', () => {
    // 2022010, not 20220010 — the width is on the sequence, not on the whole code.
    const vendors = CODE_SERIES_FORMATS[CodeSeriesType.VENDORS]!;
    expect(formatCode(vendors, 10)).toBe('2022010');
    expect(formatCode(vendors, 999)).toBe('2022999');
  });

  it('lets a sequence outgrow its width rather than truncating it', () => {
    // The thousandth vendor is 20221000. Ugly, and the alternative — wrapping back to
    // 2022000 — issues a code the company already used.
    const vendors = CODE_SERIES_FORMATS[CodeSeriesType.VENDORS]!;
    expect(formatCode(vendors, 1000)).toBe('20221000');
  });

  it('leaves the internal series on the short-code format', () => {
    // Items, indents, GRNs, requisitions, assets and equipment are quoted by nobody
    // outside the system and keep `{shortCode}-{infix}-{0001}`.
    expect(CODE_SERIES_FORMATS[CodeSeriesType.ITEMS]).toBeUndefined();
    expect(CODE_SERIES_FORMATS[CodeSeriesType.GRN]).toBeUndefined();
  });
});
