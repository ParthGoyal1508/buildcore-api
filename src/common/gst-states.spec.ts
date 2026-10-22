import {
  canonicalStateName,
  cinStateName,
  gstStateCodeFor,
  stateNameForCode,
} from './gst-states';

describe('gst-states', () => {
  it.each([
    ['Rajasthan', '08'],
    ['Delhi', '07'],
    ['Maharashtra', '27'],
    ['Uttar Pradesh', '09'],
    ['Gujarat', '24'],
    ['Haryana', '06'],
    ['Bihar', '10'],
    ['Madhya Pradesh', '23'],
  ])('%s is GST state %s', (name, code) => {
    expect(gstStateCodeFor(name)).toBe(code);
    expect(stateNameForCode(code)).toBe(name);
  });

  it('matches the client sheet’s upper-case and stray spacing', () => {
    expect(gstStateCodeFor('RAJASTHAN')).toBe('08');
    expect(canonicalStateName('  uttar   pradesh ')).toBe('Uttar Pradesh');
  });

  it('is null for an unknown or empty state', () => {
    expect(gstStateCodeFor('Atlantis')).toBeNull();
    expect(gstStateCodeFor(null)).toBeNull();
    expect(stateNameForCode('99')).toBeNull();
  });

  it('reads the registered state out of a CIN', () => {
    expect(cinStateName('U70109RJ2022PTC081146')).toBe('Rajasthan');
    expect(cinStateName('U45200MH2010PTC123456')).toBe('Maharashtra');
    expect(cinStateName('')).toBeNull();
    expect(cinStateName(null)).toBeNull();
  });
});
