import { readFileSync } from 'fs';
import { join } from 'path';

import { DocumentTypesService } from './document-types.service';
import { computeDocumentTypeFlag } from './document-type-flag';
import { DEFAULT_DOCUMENT_TYPES } from './default-document-types';
import { scopeForCode } from '../document-kinds';
import { createPrismaMock } from '../testing/prisma-mock';

describe('computeDocumentTypeFlag', () => {
  // The six cases in spec User Story 5's acceptance scenario, in the precedence
  // order research.md §7 fixes.
  it.each([
    [true, false, true, 'MandatoryNumber'],
    [true, false, false, 'Mandatory'],
    [false, true, true, 'ExpiryNumber'],
    [false, true, false, 'Expiry'],
    [false, false, true, 'Number'],
    [false, false, false, 'Optional'],
  ])(
    'mandatory=%s expiry=%s number=%s -> %s',
    (isMandatory, hasExpiry, needsNumber, expected) => {
      expect(
        computeDocumentTypeFlag(
          isMandatory as boolean,
          hasExpiry as boolean,
          needsNumber as boolean,
        ),
      ).toBe(expected);
    },
  );

  it('lets mandatory outrank expiry when both are set', () => {
    expect(computeDocumentTypeFlag(true, true, false)).toBe('Mandatory');
    expect(computeDocumentTypeFlag(true, true, true)).toBe('MandatoryNumber');
  });
});

describe('DEFAULT_DOCUMENT_TYPES', () => {
  it('matches the PRD table: 17 entries with unique codes and sort orders', () => {
    expect(DEFAULT_DOCUMENT_TYPES).toHaveLength(17);
    const codes = DEFAULT_DOCUMENT_TYPES.map((d) => d.code);
    expect(new Set(codes).size).toBe(17);
    const sortOrders = DEFAULT_DOCUMENT_TYPES.map((d) => d.sortOrder);
    expect([...sortOrders].sort((a, b) => a - b)).toEqual(sortOrders);
  });

  it('carries the PRD flags for the five non-Optional defaults', () => {
    const flagOf = (code: string) => {
      const d = DEFAULT_DOCUMENT_TYPES.find((x) => x.code === code)!;
      return computeDocumentTypeFlag(d.isMandatory, d.hasExpiry, d.needsNumber);
    };
    expect(flagOf('AADHAAR')).toBe('MandatoryNumber');
    expect(flagOf('PAN')).toBe('Number');
    expect(flagOf('BANK_PROOF')).toBe('Mandatory');
    expect(flagOf('PHOTO')).toBe('Mandatory');
    expect(flagOf('DRIVING_LICENCE')).toBe('ExpiryNumber');
    expect(flagOf('MEDICAL_FITNESS')).toBe('Expiry');
  });

  /**
   * 017 FR-024. The restriction reaches an existing company through a one-time
   * `UPDATE` in migration `20260915162449_company_documents` and a newly created one
   * through this array, so the two lists have to name the same codes. Asserting the
   * defaults alone would still pass if the migration were later widened, and a
   * company's Aadhaar type would be restricted or not depending only on the date the
   * company was created.
   */
  it('restricts Aadhaar and nothing else, in step with the migration', () => {
    const restricted = DEFAULT_DOCUMENT_TYPES.filter((d) => d.isRestricted).map(
      (d) => d.code,
    );
    expect(restricted).toEqual(['AADHAAR']);

    const sql = readFileSync(
      join(
        __dirname,
        '../../../prisma/migrations/20260915162449_company_documents/migration.sql',
      ),
      'utf8',
    );
    const clause =
      /SET "isRestricted" = true\s+WHERE upper\("code"\) IN \(([^)]*)\)/i.exec(
        sql,
      );
    expect(clause).not.toBeNull();
    const migrationCodes = clause![1]
      .split(',')
      .map((c) => c.trim().replace(/'/g, ''));

    // The migration matches spelling variants an operator may have used; every
    // *default* code it names must be one this array restricts, and vice versa.
    expect(migrationCodes).toContain('AADHAAR');
    for (const code of restricted) {
      expect(migrationCodes).toContain(code);
    }
    const defaultCodes = new Set(DEFAULT_DOCUMENT_TYPES.map((d) => d.code));
    for (const code of migrationCodes.filter((c) => defaultCodes.has(c))) {
      expect(restricted).toContain(code);
    }
  });
});

/**
 * The same class of bug as the Aadhaar one above, and found the same way — by running
 * the seed and reading the result rather than by reasoning about it.
 *
 * A row's scope reaches it from two places: the migration backfill for rows that already
 * existed, and the creating code for everything after. Miss the second and every company
 * created from now on gets its seventeen employee defaults listed in Company Documents
 * beside the GST certificate, with no error anywhere.
 */
describe('DocumentTypesService.seedDefaultsForCompany', () => {
  it('sets a scope on every default rather than leaving the column default', async () => {
    const createMany = jest.fn().mockResolvedValue({ count: 0 });
    const prisma = createPrismaMock({ documentType: { createMany } });
    const service = new DocumentTypesService(
      prisma as never,
      { record: jest.fn() } as never,
    );

    await service.seedDefaultsForCompany('co-1', prisma.tx as never);

    const rows = createMany.mock.calls[0][0].data as {
      code: string;
      scope: string;
    }[];
    expect(rows).toHaveLength(DEFAULT_DOCUMENT_TYPES.length);
    for (const row of rows) {
      expect(row.scope).toBeDefined();
      expect(row.scope).toBe(
        scopeForCode(
          row.code,
          DEFAULT_DOCUMENT_TYPES.map((d) => d.code),
        ),
      );
    }

    // The two that are genuinely both, spelled out: Aadhaar and PAN are required of the
    // company AND held on an employee's file, and resolving either to one side would
    // remove it from the other screen entirely.
    const scopeOf = (code: string) => rows.find((r) => r.code === code)!.scope;
    expect(scopeOf('AADHAAR')).toBe('both');
    expect(scopeOf('PAN')).toBe('both');
    expect(scopeOf('MARKSHEET_10')).toBe('employee');
  });
});

describe('DocumentTypesService.hasMissingMandatoryDocs', () => {
  const mandatoryRows = [
    { id: 'dt-aadhaar', code: 'AADHAAR' },
    { id: 'dt-photo', code: 'PHOTO' },
  ];

  const serviceWith = (rows: unknown[]) => {
    const prisma = createPrismaMock({
      documentType: { findMany: jest.fn().mockResolvedValue(rows) },
    });
    return new DocumentTypesService(
      prisma as never,
      { record: jest.fn() } as never,
    );
  };

  it('returns nothing missing when the employee holds every mandatory type', async () => {
    const service = serviceWith(mandatoryRows);
    const result = await service.hasMissingMandatoryDocs('company-1', [
      'dt-aadhaar',
      'dt-photo',
      'dt-extra',
    ]);
    expect(result.missing).toEqual([]);
  });

  it('returns exactly the mandatory type the employee is missing', async () => {
    const service = serviceWith(mandatoryRows);
    const result = await service.hasMissingMandatoryDocs('company-1', [
      'dt-aadhaar',
    ]);
    expect(result.missing.map((d) => d.id)).toEqual(['dt-photo']);
  });
});
