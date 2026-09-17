import { readFileSync } from 'fs';
import { join } from 'path';

import { DEFAULT_DOCUMENT_TYPES } from './reference-data/default-document-types';
import {
  REQUIRED_COMPANY_DOCUMENT_CODES,
  REQUIRED_PROJECT_DOCUMENT_CODES,
  scopeForCode,
  type DocumentTypeScopeValue,
} from './document-kinds';

/**
 * The backfill in `20260916120000_document_type_scope` and `scopeForCode()` have to name
 * the same codes (017 amendment, 2026-09-16).
 *
 * Existing rows get their scope from the migration; rows created afterwards get it from
 * the function. Two hand-maintained lists disagree the first time somebody adds a kind,
 * and the symptom is not an error — it is a document type quietly absent from one of the
 * two screens, which nobody notices until they go looking for it.
 */
const SQL = readFileSync(
  join(
    __dirname,
    '../../prisma/migrations/20260916120000_document_type_scope/migration.sql',
  ),
  'utf8',
);

const EMPLOYEE_CODES = DEFAULT_DOCUMENT_TYPES.map((d) => d.code);

/** The codes one `UPDATE … SET "scope" = '<value>'` statement names. */
function codesFor(scope: DocumentTypeScopeValue): string[] {
  const match = new RegExp(
    `SET "scope" = '${scope}'\\s+WHERE upper\\("code"\\) IN \\(([^)]*)\\)`,
    'i',
  ).exec(SQL);
  if (!match) throw new Error(`No backfill statement for scope "${scope}"`);
  return match[1].split(',').map((c) => c.trim().replace(/'/g, ''));
}

describe('DocumentType scope backfill', () => {
  // Asserted first and by count, so a regex that silently stopped matching cannot make
  // every test below pass over three empty lists.
  it('names every declared code exactly once, across the three statements', () => {
    const all = [
      ...codesFor('employee'),
      ...codesFor('company'),
      ...codesFor('both'),
    ];
    expect(all).toHaveLength(29);
    expect(new Set(all).size).toBe(29);

    const declared = new Set([
      ...EMPLOYEE_CODES,
      ...REQUIRED_COMPANY_DOCUMENT_CODES,
      ...REQUIRED_PROJECT_DOCUMENT_CODES,
    ]);
    expect(new Set(all)).toEqual(declared);
  });

  it.each(['employee', 'company', 'both'] as DocumentTypeScopeValue[])(
    'agrees with scopeForCode() on every code it assigns %s',
    (scope) => {
      const codes = codesFor(scope);
      expect(codes.length).toBeGreaterThan(0);
      for (const code of codes) {
        expect(scopeForCode(code, EMPLOYEE_CODES)).toBe(scope);
      }
    },
  );

  it('puts the two kinds that are genuinely both in `both`', () => {
    // Aadhaar is required of the company (FR-002) and is an employee document. If this
    // ever resolved to one scope, it would vanish from the other screen — and for
    // Aadhaar specifically that screen is the one carrying FR-024's handling.
    expect(codesFor('both').sort()).toEqual(['AADHAAR', 'PAN']);
    expect(scopeForCode('AADHAAR', EMPLOYEE_CODES)).toBe('both');
    expect(scopeForCode('PAN', EMPLOYEE_CODES)).toBe('both');
  });

  it('leaves a kind this product never declared as `both`', () => {
    // The column default, and the only value that cannot hide an operator's own kind
    // from a screen that was already showing it.
    expect(scopeForCode('MSME_UDYAM', EMPLOYEE_CODES)).toBe('both');
    expect(codesFor('company')).not.toContain('MSME_UDYAM');
  });
});
