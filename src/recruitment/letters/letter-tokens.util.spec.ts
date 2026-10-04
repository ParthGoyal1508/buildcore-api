import { extractTokens, renderTemplate } from './letter-tokens.util';

describe('letter-tokens.util', () => {
  it('extracts distinct tokens', () => {
    expect(
      extractTokens('Dear {{employeeName}}, your code is {{employeeCode}}.'),
    ).toEqual(['employeeName', 'employeeCode']);
  });

  it('substitutes known tokens and empties unresolved ones', () => {
    expect(
      renderTemplate('Hi {{employeeName}} ({{employeeCode}})', {
        employeeName: 'Asha',
      }),
    ).toBe('Hi Asha ()');
  });

  it('tolerates whitespace inside the braces', () => {
    expect(renderTemplate('{{ companyName }}', { companyName: 'Acme' })).toBe(
      'Acme',
    );
  });
});
