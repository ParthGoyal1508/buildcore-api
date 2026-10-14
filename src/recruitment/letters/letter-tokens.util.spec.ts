import { extractTokens } from './letter-tokens.util';

describe('letter-tokens.util', () => {
  it('extracts distinct tokens', () => {
    expect(
      extractTokens('Dear {{employeeName}}, your code is {{employeeCode}}.'),
    ).toEqual(['employeeName', 'employeeCode']);
  });
});
