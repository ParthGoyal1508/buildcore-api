import { advanceTermsProblem } from './labour-advance.service';

describe('advanceTermsProblem (036 O12)', () => {
  it('refuses fractional, zero or too many instalments', () => {
    expect(advanceTermsProblem(1000, 2.5)).toMatch(/whole number/);
    expect(advanceTermsProblem(1000, 0)).toMatch(/whole number/);
    expect(advanceTermsProblem(1000, 105)).toMatch(/whole number/);
  });
  it('refuses a zero, negative or oversized amount', () => {
    expect(advanceTermsProblem(0, 1)).toMatch(/more than 0/);
    expect(advanceTermsProblem(-5, 1)).toMatch(/more than 0/);
    expect(advanceTermsProblem(1_000_001, 1)).toMatch(/at most/);
  });
  it('accepts sensible terms', () => {
    expect(advanceTermsProblem(3000, 3)).toBeNull();
  });
});
