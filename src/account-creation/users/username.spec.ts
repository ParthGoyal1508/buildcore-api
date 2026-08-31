import { baseUsernameFromEmail } from './username';

describe('baseUsernameFromEmail', () => {
  it('uses the email local part, lowercased', () => {
    expect(baseUsernameFromEmail('Parth.Goyal@example.com')).toBe(
      'parth.goyal',
    );
  });

  it('strips characters outside the allowed set', () => {
    expect(baseUsernameFromEmail("o'brien+tag@example.com")).toBe('obrientag');
  });

  it('collapses runs of punctuation', () => {
    expect(baseUsernameFromEmail('a..b__c@example.com')).toBe('a.b.c');
  });

  it('never leads or trails with punctuation', () => {
    // ".._bob_.." is a legal local part but an ugly username.
    expect(baseUsernameFromEmail('.._bob_..@example.com')).toBe('bob');
  });

  it('caps length at 30 characters', () => {
    const long = 'a'.repeat(60);
    expect(baseUsernameFromEmail(`${long}@example.com`)).toHaveLength(30);
  });

  it('produces something usable when the local part strips to nothing', () => {
    // An empty username would be unique exactly once and then collide forever.
    const result = baseUsernameFromEmail('!!!@example.com');
    expect(result.length).toBeGreaterThanOrEqual(3);
    expect(result).toBe('user');
  });

  it('pads a very short local part rather than returning one character', () => {
    expect(baseUsernameFromEmail('a@example.com')).toBe('usera');
  });
});
