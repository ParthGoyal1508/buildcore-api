import { formatChainage, parseChainage } from './chainage';

/**
 * Chainage, both ways (028, reported 2026-10-07).
 *
 * The assertion that matters is the **padding**. `6+820` and `6+082` are 738 metres apart, and a
 * formatter that dropped the leading zero would print the first where the second belongs — on a
 * measurement sheet a client signs, against a quantity measured somewhere else entirely. Nothing
 * downstream would disagree with it.
 */

describe('printing a chainage', () => {
  it.each([
    ['21.300', '21+300'],
    ['38.350', '38+350'],
    ['20.000', '20+000'],
    ['0.400', '0+400'],
    ['6.600', '6+600'],
    ['7.750', '7+750'],
  ])('renders %s as %s, which is how the client writes it', (stored, shown) => {
    expect(formatChainage(stored)).toBe(shown);
  });

  it('pads the metres to three digits', () => {
    // 6 km 82 m, not 6 km 820 m. The whole point.
    expect(formatChainage('6.082')).toBe('6+082');
    expect(formatChainage('6.008')).toBe('6+008');
    expect(formatChainage('6.820')).toBe('6+820');
  });

  it('keeps the zero kilometre', () => {
    // `+400` is not a chainage anybody writes.
    expect(formatChainage('0.4')).toBe('0+400');
  });

  it('rounds to the stored precision rather than truncating', () => {
    // 21.2999999 is 21+300. Truncating prints 21+299, a metre out, silently.
    expect(formatChainage('21.2999999')).toBe('21+300');
  });

  it('says nothing where no chainage was recorded', () => {
    expect(formatChainage(null)).toBeNull();
    expect(formatChainage(undefined)).toBeNull();
    expect(formatChainage('not a number')).toBeNull();
  });

  it('takes a Prisma Decimal as well as a string', () => {
    expect(formatChainage({ toFixed: () => '21.300' })).toBe('21+300');
  });
});

describe('reading a chainage somebody typed', () => {
  it.each([
    ['21+300', '21.3'],
    ['0+400', '0.4'],
    ['6+820', '6.82'],
    ['6+082', '6.082'],
  ])('reads %s as %s kilometres', (typed, stored) => {
    expect(parseChainage(typed)).toBe(stored);
  });

  it('accepts a plain decimal unchanged, because both get typed', () => {
    // Off the client's sheet it is `21+300`; off a survey it is `21.3`. A form that refused either
    // would be refusing the notation one of its own documents is printed in.
    expect(parseChainage('21.3')).toBe('21.3');
    expect(parseChainage('21')).toBe('21');
  });

  it('pads a partial metre entry to the right', () => {
    // `6+82` means 6 km 820 m: the metres are a position within the kilometre, not a count.
    expect(parseChainage('6+82')).toBe('6.82');
    expect(parseChainage('6+8')).toBe('6.8');
  });

  it('refuses what it cannot read rather than storing a guess', () => {
    expect(parseChainage('')).toBeNull();
    expect(parseChainage('21+3000')).toBeNull();
    expect(parseChainage('km 21')).toBeNull();
    expect(parseChainage('21++300')).toBeNull();
  });

  it('round-trips', () => {
    for (const typed of ['21+300', '0+400', '6+082', '38+350']) {
      expect(formatChainage(parseChainage(typed) as string)).toBe(typed);
    }
  });
});
