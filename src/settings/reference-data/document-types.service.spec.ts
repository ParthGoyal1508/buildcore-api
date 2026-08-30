import { DocumentTypesService } from './document-types.service';
import { computeDocumentTypeFlag } from './document-type-flag';
import { DEFAULT_DOCUMENT_TYPES } from './default-document-types';
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
