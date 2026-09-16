import { BadRequestException } from '@nestjs/common';

import {
  assertNoRestrictedTypes,
  extractTokens,
  renderTemplate,
} from './template-resolver';

const TYPES = [
  { code: 'AADHAAR', isRestricted: true },
  { code: 'PAN', isRestricted: false },
  { code: 'GST', isRestricted: false },
];

describe('template resolver — restricted types (T039, T044, FR-024)', () => {
  it('refuses a body that references a restricted type', () => {
    const attempt = () =>
      assertNoRestrictedTypes(
        'Employee {{employeeName}} holds Aadhaar {{document.AADHAAR}}.',
        TYPES,
      );

    expect(attempt).toThrow(BadRequestException);
    try {
      attempt();
    } catch (e) {
      expect((e as { response: { code: string } }).response.code).toBe(
        'DOCUMENT_TYPE_RESTRICTED',
      );
    }
  });

  it('refuses the bare form too, not just the prefixed one', () => {
    // A template author who writes `{{AADHAAR}}` did not intend a different rule. Belt
    // and braces on purpose: the cost of missing one here is legal, not functional.
    expect(() => assertNoRestrictedTypes('Number: {{AADHAAR}}', TYPES)).toThrow(
      BadRequestException,
    );
    expect(() => assertNoRestrictedTypes('Number: {{aadhaar}}', TYPES)).toThrow(
      BadRequestException,
    );
    expect(() =>
      assertNoRestrictedTypes('Number: {{document_AADHAAR}}', TYPES),
    ).toThrow(BadRequestException);
  });

  it('allows unrestricted types through untouched', () => {
    expect(() =>
      assertNoRestrictedTypes('PAN {{document.PAN}} and GST {{GST}}', TYPES),
    ).not.toThrow();
  });

  it('holds for a letter kind invented after this code shipped (T044)', () => {
    // THE assertion this file exists for. The rule lives in the resolver, not in a list
    // of kinds — so a kind an administrator defines tomorrow (FR-011) is refused
    // identically. A per-kind allowlist would have been written against the kinds that
    // existed at build time and would silently permit every kind added after.
    const bodyForBrandNewKind =
      'This site pass is issued to {{workerName}}, Aadhaar {{document.AADHAAR}}.';

    expect(() => assertNoRestrictedTypes(bodyForBrandNewKind, TYPES)).toThrow(
      BadRequestException,
    );
  });

  it('refuses a type that BECAME restricted after the template was written', () => {
    const body = 'Reference: {{document.PAN}}';
    // Same template, same tokens — the only thing that changed is the flag.
    expect(() => assertNoRestrictedTypes(body, TYPES)).not.toThrow();
    expect(() =>
      assertNoRestrictedTypes(body, [{ code: 'PAN', isRestricted: true }]),
    ).toThrow(BadRequestException);
  });

  it('does nothing when the company has no restricted types at all', () => {
    expect(() =>
      assertNoRestrictedTypes('{{document.AADHAAR}}', [
        { code: 'PAN', isRestricted: false },
      ]),
    ).not.toThrow();
  });
});

describe('template resolver — substitution', () => {
  it('extracts each token once, in first-seen order', () => {
    expect(extractTokens('{{a}} {{ b }} {{a}} {{document.PAN}}')).toEqual([
      'a',
      'b',
      'document.PAN',
    ]);
  });

  it('renders an unresolved token as empty rather than leaving the braces', () => {
    // A letter that goes out with a literal `{{employeeName}}` in it has already
    // embarrassed somebody; a blank is visible in the preview the composer requires.
    expect(
      renderTemplate('Dear {{name}}, {{missing}}.', { name: 'Anil' }),
    ).toBe('Dear Anil, .');
  });
});
