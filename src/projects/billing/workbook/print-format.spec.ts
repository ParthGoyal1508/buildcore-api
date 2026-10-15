import { indianFigure, printDate, taxBasisLine } from './print-format';

describe('bill document print formatting (2026-10-15)', () => {
  it('groups figures the Indian way and leaves anything else alone', () => {
    expect(indianFigure('311581')).toBe('3,11,581');
    expect(indianFigure('1234567.50')).toBe('12,34,567.50');
    expect(indianFigure('-125000.00')).toBe('-1,25,000.00');
    expect(indianFigure('999')).toBe('999');
    expect(indianFigure('2690.000')).toBe('2,690.000');
    expect(indianFigure('RA-01')).toBe('RA-01');
    expect(indianFigure('no record')).toBe('no record');
    expect(indianFigure('')).toBe('');
  });

  it('prints dates day first', () => {
    expect(printDate('2026-09-29')).toBe('29-09-2026');
    expect(printDate('September 2026')).toBe('September 2026');
  });

  it('says the tax basis in words, not enum values', () => {
    expect(
      taxBasisLine({
        taxBasis: 'intra_state',
        taxBasisSource: 'from_project_flag',
      }),
    ).toBe(
      'Tax basis: Intra-state supply — CGST + SGST (as set on the project)',
    );
  });
});
