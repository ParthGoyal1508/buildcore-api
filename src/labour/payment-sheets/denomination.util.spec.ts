import { computeDenominationBreakup } from './denomination.util';

const INR = [500, 200, 100, 50, 20, 10, 5, 1];

describe('denomination.util', () => {
  it('produces a minimal-note-count breakup for an exact net', () => {
    const result = computeDenominationBreakup(
      [{ workerId: 'w1', netPayable: 860 }],
      INR,
    );
    // 860 = 500 + 200 + 100 + 50 + 10 = 5 notes.
    expect(result.notes).toEqual({ 500: 1, 200: 1, 100: 1, 50: 1, 10: 1 });
    expect(result.totalNotes).toBe(5);
    expect(result.expressibleTotal).toBe(860);
    expect(result.residuals).toHaveLength(0);
  });

  it('aggregates note counts across workers', () => {
    const result = computeDenominationBreakup(
      [
        { workerId: 'w1', netPayable: 500 },
        { workerId: 'w2', netPayable: 500 },
      ],
      INR,
    );
    expect(result.notes[500]).toBe(2);
    expect(result.totalNotes).toBe(2);
  });

  it('reports a per-worker residual when the net is not expressible', () => {
    // Smallest denomination is 5, so 862 leaves a residual of 2.
    const result = computeDenominationBreakup(
      [{ workerId: 'w1', netPayable: 862 }],
      [500, 200, 100, 50, 20, 10, 5],
    );
    expect(result.expressibleTotal).toBe(860);
    expect(result.residuals).toEqual([{ workerId: 'w1', residual: 2 }]);
  });

  it('carries a paise residual forward rather than rounding it away', () => {
    const result = computeDenominationBreakup(
      [{ workerId: 'w1', netPayable: 100.5 }],
      INR,
    );
    expect(result.notes[100]).toBe(1);
    expect(result.residuals).toEqual([{ workerId: 'w1', residual: 0.5 }]);
  });
});
