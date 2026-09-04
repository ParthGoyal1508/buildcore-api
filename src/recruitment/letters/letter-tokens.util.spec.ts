import { LetterType } from '@prisma/client';

import {
  extractTokens,
  renderTemplate,
  unknownTokens,
} from './letter-tokens.util';

describe('letter-tokens.util', () => {
  it('extracts distinct tokens', () => {
    expect(
      extractTokens('Dear {{employeeName}}, your code is {{employeeCode}}.'),
    ).toEqual(['employeeName', 'employeeCode']);
  });

  it('flags tokens outside a letter type set', () => {
    expect(
      unknownTokens('{{employeeName}} {{salary}}', LetterType.appointment),
    ).toEqual(['salary']);
    expect(
      unknownTokens('{{candidateName}} {{offeredCtc}}', LetterType.offer),
    ).toEqual([]);
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
