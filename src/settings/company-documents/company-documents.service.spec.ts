import { BadRequestException } from '@nestjs/common';

import { DOCUMENT_KIND_NOT_REQUIRED } from './company-document-error-codes';
import { CompanyDocumentsService } from './company-documents.service';
import { DocumentTypesService } from '../reference-data/document-types.service';
import { REQUIRED_COMPANY_DOCUMENT_KINDS } from '../document-kinds';

const COMPANY = 'co-1';

/**
 * Unit tests for the company-document store (017 T016, T017).
 *
 * The harness counts Prisma calls rather than only inspecting results, because the
 * requirement these protect is a **query count**. 016 learned this the expensive way: a
 * result-only assertion passes an N+1 happily, and the N+1 is invisible until a company
 * has enough rows for it to matter — by which time it is in production.
 */
function harness(
  opts: {
    types?: {
      id: string;
      code: string;
      name: string;
      hasExpiry: boolean;
      isRestricted: boolean;
      isActive?: boolean;
      companyDocuments: {
        id: string;
        documentTypeId: string;
        documentNumber: string | null;
        expiresAt: Date | null;
        uploadedAt: Date;
        isCurrent: boolean;
      }[];
    }[];
    currentDoc?: { id: string } | null;
    /** Explicit override for `documentType.findFirst`, so `null` can mean "none". */
    existingType?: { id: string; code: string; name: string } | null;
  } = {},
) {
  const calls: string[] = [];

  const tx = {
    documentType: {
      findMany: jest.fn(async () => {
        calls.push('documentType.findMany');
        return opts.types ?? [];
      }),
      findFirst: jest.fn(async () => {
        calls.push('documentType.findFirst');
        return opts.existingType !== undefined
          ? opts.existingType
          : opts.types?.[0] ?? null;
      }),
      create: jest.fn(async (args: { data: Record<string, unknown> }) => {
        calls.push('documentType.create');
        return { id: 'dt-new', ...args.data };
      }),
    },
    companyDocument: {
      findFirst: jest.fn(async () => {
        calls.push('companyDocument.findFirst');
        return opts.currentDoc ?? null;
      }),
      findMany: jest.fn(async () => {
        calls.push('companyDocument.findMany');
        return [];
      }),
      update: jest.fn(async (args: { data: unknown }) => {
        calls.push('companyDocument.update');
        return { id: 'old-1', ...(args.data as object) };
      }),
      create: jest.fn(async (args: { data: Record<string, unknown> }) => {
        calls.push('companyDocument.create');
        return {
          id: 'new-1',
          documentTypeId: args.data.documentTypeId,
          documentNumber: args.data.documentNumber ?? null,
          expiresAt: args.data.expiresAt ?? null,
          uploadedAt: new Date(),
          isCurrent: true,
          supersedesId: args.data.supersedesId ?? null,
        };
      }),
      deleteMany: jest.fn(async () => {
        calls.push('companyDocument.deleteMany');
        return { count: 0 };
      }),
    },
    $executeRaw: jest.fn(),
  };

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const prisma: any = {
    $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) =>
      fn(tx),
    ),
  };
  const storage: any = {
    put: jest.fn(async () => 'company-documents/co-1/ref-1'),
    get: jest.fn(async () => Buffer.from('bytes')),
    delete: jest.fn(),
    deleteMany: jest.fn(),
  };
  const audit: any = { record: jest.fn().mockResolvedValue(undefined) };
  /* eslint-enable @typescript-eslint/no-explicit-any */

  /**
   * A real `DocumentTypesService` on the same mock, not a stub.
   *
   * `defineRequiredKind` resolves the code here and delegates the creation there, and
   * the interesting claims — that the row's fields come from configuration and that a
   * second call creates nothing — are about what the delegate does. Stubbing it would
   * leave those tests asserting that a mock was called with arguments, which is a
   * different and much weaker statement.
   */
  const documentTypes = new DocumentTypesService(prisma, audit);

  const service = new CompanyDocumentsService(
    prisma,
    storage,
    audit,
    documentTypes,
  );
  return { service, calls, tx, storage, audit, documentTypes };
}

const ctx = { isSuperAdmin: false, companyId: COMPANY };
const actor = { userId: 'user-1', ipAddress: '127.0.0.1' };

/** A document type holding one current document, in the shape the harness mock returns. */
function typeWithDoc(
  id: string,
  code: string,
  name: string,
): {
  id: string;
  code: string;
  name: string;
  hasExpiry: boolean;
  isRestricted: boolean;
  isActive: boolean;
  companyDocuments: {
    id: string;
    documentTypeId: string;
    documentNumber: string | null;
    expiresAt: Date | null;
    uploadedAt: Date;
    isCurrent: boolean;
  }[];
} {
  return {
    id,
    code,
    name,
    hasExpiry: false,
    isRestricted: false,
    isActive: true,
    companyDocuments: [
      {
        id: `doc-${id}`,
        documentTypeId: id,
        documentNumber: null,
        expiresAt: null,
        uploadedAt: new Date('2026-01-01'),
        isCurrent: true,
      },
    ],
  };
}
const requiredType = typeWithDoc;
const supplementaryType = typeWithDoc;

/** Runs `completenessFor` over a given type master and hands back both halves. */
async function withTypes(types: ReturnType<typeof typeWithDoc>[]) {
  const { service, calls } = harness({ types });
  const result = await service.completenessFor(ctx, COMPANY);
  return { service, calls, result };
}

describe('CompanyDocumentsService', () => {
  describe('completenessFor (FR-003, T012, T016)', () => {
    it('answers every required kind in ONE query, not one per kind', async () => {
      const { service, calls } = harness({
        types: [
          {
            id: 'dt-gst',
            code: 'GST',
            name: 'GST registration certificate',
            hasExpiry: false,
            isRestricted: false,
            companyDocuments: [
              {
                id: 'doc-gst',
                documentTypeId: 'dt-gst',
                documentNumber: '27AAAAA0000A1Z5',
                expiresAt: null,
                uploadedAt: new Date('2026-01-01'),
                isCurrent: true,
              },
            ],
          },
        ],
      });

      const result = await service.completenessFor(ctx, COMPANY);

      // The assertion that matters. Eight required kinds, one query — and if somebody
      // later "simplifies" this into a loop, this fails rather than merely getting slower.
      expect(calls).toEqual(['documentType.findMany']);
      expect(calls).toHaveLength(1);

      expect(result.present).toHaveLength(1);
      expect(result.missing).toHaveLength(
        REQUIRED_COMPANY_DOCUMENT_KINDS.length - 1,
      );
    });

    /**
     * T080. The 2026-09-16 amendment removed the `code IN (...)` filter so supplementary
     * kinds are visible (FR-001a), which means this query now fetches the company's whole
     * type master. Extending the count assertion here rather than adding a second test:
     * the property at risk is "still one statement", and it is at risk precisely when
     * somebody adds the supplementary half as a follow-up query.
     */
    it('stays ONE query when the company holds supplementary kinds too', async () => {
      const { service, calls, result } = await withTypes([
        requiredType('dt-gst', 'GST', 'GST registration certificate'),
        supplementaryType('dt-msme', 'MSME', 'Udyam registration'),
        supplementaryType('dt-trade', 'TRADE_LICENCE', 'Trade licence'),
      ]);

      expect(calls).toEqual(['documentType.findMany']);
      expect(calls).toHaveLength(1);
      expect(result.supplementary).toHaveLength(2);
    });

    /**
     * FR-001a and plan D2. The bug this replaces: a document filed against a kind outside
     * the required eight was stored and then never appeared anywhere, because the query
     * filtered them out — worse than refusing the upload, because the file exists and
     * nothing says so.
     */
    it('lists a non-required kind as supplementary without moving the count', async () => {
      const { result } = await withTypes([
        requiredType('dt-gst', 'GST', 'GST registration certificate'),
        supplementaryType('dt-msme', 'MSME', 'Udyam registration'),
      ]);

      expect(result.present.map((d) => d.code)).toEqual(['GST']);
      expect(result.supplementary.map((d) => d.code)).toEqual(['MSME']);
      // The compliance figure counts the required eight and nothing else. If filing an
      // Udyam certificate could move it, the number would answer a different question
      // than the one the screen asks.
      expect(result.present).toHaveLength(1);
      expect(result.missing).toHaveLength(
        REQUIRED_COMPANY_DOCUMENT_KINDS.length - 1,
      );
    });

    /**
     * The chicken-and-egg FR-001a shipped with: the upload control was built from kinds
     * that already held a document, so a newly defined type appeared in no list, so it
     * was in no dropdown, so it never received a document, so it stayed in no list.
     * `availableKinds` answers "what may be uploaded", which is a different question from
     * "what do we hold".
     */
    it('offers a defined kind that holds no document yet', async () => {
      const empty = requiredType('dt-msme', 'MSME', 'Udyam registration');
      empty.companyDocuments = [];

      const { result, calls } = await withTypes([
        requiredType('dt-gst', 'GST', 'GST registration certificate'),
        empty,
      ]);

      // In neither "what we hold" list...
      expect(result.supplementary.map((d) => d.code)).not.toContain('MSME');
      expect(result.present.map((d) => d.code)).not.toContain('MSME');
      // ...and still offerable, which is the whole point.
      expect(result.availableKinds.map((k) => k.code)).toContain('MSME');
      // Still one query — `availableKinds` is mapped from rows already fetched.
      expect(calls).toHaveLength(1);
    });

    it('does not offer a deactivated kind', async () => {
      const retired = requiredType('dt-old', 'OLD_LICENCE', 'Retired licence');
      retired.companyDocuments = [];
      retired.isActive = false;

      const { result } = await withTypes([retired]);

      expect(result.availableKinds).toHaveLength(0);
    });

    it('does not count a required kind twice when its code is lower-cased', async () => {
      const { result } = await withTypes([
        requiredType('dt-gst', 'gst', 'GST registration certificate'),
      ]);

      expect(result.present.map((d) => d.code)).toEqual(['gst']);
      expect(result.supplementary).toHaveLength(0);
    });

    it('names what is missing rather than counting it', async () => {
      const { service } = harness({ types: [] });

      const result = await service.completenessFor(ctx, COMPANY);

      // "7 of 8 complete" makes a reader diff two lists by eye. Every missing kind
      // carries the words a person reads.
      expect(result.missing).toHaveLength(
        REQUIRED_COMPANY_DOCUMENT_KINDS.length,
      );
      for (const m of result.missing) {
        expect(m.label.length).toBeGreaterThan(0);
        // Null id: the company never even defined a DocumentType for this code, which
        // the interface needs to know because it must create the type first.
        expect(m.documentTypeId).toBeNull();
      }
      expect(result.missing.map((m) => m.code)).toContain('AADHAAR');
    });
  });

  describe('upload (FR-004, FR-006, T013, T017)', () => {
    it('refuses an expiring kind with no expiry date, before storing anything', async () => {
      const { service, storage } = harness({
        types: [
          {
            id: 'dt-lic',
            code: 'LABOUR_LICENCE',
            name: 'Labour licence',
            hasExpiry: true,
            isRestricted: false,
            companyDocuments: [],
          },
        ],
      });

      const error = await service
        .upload(
          ctx,
          {
            companyId: COMPANY,
            documentTypeId: 'dt-lic',
            data: Buffer.from('pdf'),
            contentType: 'application/pdf',
          },
          { userId: 'u-1', ipAddress: '10.0.0.1' },
        )
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as { response: { code: string } }).response.code).toBe(
        'DOCUMENT_EXPIRY_REQUIRED',
      );

      // Refused before the bytes were written — a rejected upload must leave nothing
      // behind in object storage.
      expect(storage.put).not.toHaveBeenCalled();
    });

    it('demotes the outgoing version and retains it, rather than replacing it (FR-006)', async () => {
      const { service, tx } = harness({
        types: [
          {
            id: 'dt-gst',
            code: 'GST',
            name: 'GST registration certificate',
            hasExpiry: false,
            isRestricted: false,
            companyDocuments: [],
          },
        ],
        currentDoc: { id: 'old-1' },
      });

      await service.upload(
        ctx,
        {
          companyId: COMPANY,
          documentTypeId: 'dt-gst',
          data: Buffer.from('pdf'),
          contentType: 'application/pdf',
        },
        { userId: 'u-1', ipAddress: '10.0.0.1' },
      );

      // Demoted, not deleted. The old row survives with its fileRef intact — a retained
      // record pointing at a deleted blob would not be a retained document.
      expect(tx.companyDocument.update).toHaveBeenCalledWith({
        where: { id: 'old-1' },
        data: { isCurrent: false },
      });
      expect(tx.companyDocument.deleteMany).not.toHaveBeenCalled();

      // And the new row records what it replaced.
      expect(tx.companyDocument.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            isCurrent: true,
            supersedesId: 'old-1',
          }),
        }),
      );
    });

    it('demotes BEFORE inserting, because two rows may not be current at once', async () => {
      const { service, calls } = harness({
        types: [
          {
            id: 'dt-gst',
            code: 'GST',
            name: 'GST registration certificate',
            hasExpiry: false,
            isRestricted: false,
            companyDocuments: [],
          },
        ],
        currentDoc: { id: 'old-1' },
      });

      await service.upload(
        ctx,
        {
          companyId: COMPANY,
          documentTypeId: 'dt-gst',
          data: Buffer.from('pdf'),
          contentType: 'application/pdf',
        },
        { userId: 'u-1', ipAddress: '10.0.0.1' },
      );

      // Order is not incidental: the partial unique index refuses the insert if the
      // outgoing version has not stepped down first.
      const demote = calls.indexOf('companyDocument.update');
      const insert = calls.indexOf('companyDocument.create');
      expect(demote).toBeGreaterThanOrEqual(0);
      expect(insert).toBeGreaterThan(demote);
    });
  });

  /**
   * T084, FR-003a. This route lets a caller holding `COMPANY_SETTINGS` create a
   * `settings.DocumentType` row — something `settings/document-types` guards with
   * `EMPLOYEES`. What keeps that from being a way around the second permission is that
   * the caller names only *which declared kind* to materialise, and every field of the
   * resulting row comes from configuration. These tests assert that boundary rather than
   * trusting the doc comment above the method to keep being true.
   */
  describe('defineRequiredKind (FR-003a)', () => {
    it('refuses a code outside the required set', async () => {
      const { service, calls } = harness({ existingType: null });

      await expect(
        service.defineRequiredKind(ctx, COMPANY, 'MSME', actor),
      ).rejects.toMatchObject({
        response: { code: DOCUMENT_KIND_NOT_REQUIRED },
      });

      // Refused before touching the database at all, so a rejected attempt cannot even
      // be inferred from a row that briefly existed.
      expect(calls).toEqual([]);
    });

    it('takes name, flags and restriction from configuration, not the caller', async () => {
      const { service, tx } = harness({ existingType: null });

      await service.defineRequiredKind(ctx, COMPANY, 'AADHAAR', actor);

      const created = (tx.documentType.create as jest.Mock).mock.calls[0][0]
        .data;
      const kind = REQUIRED_COMPANY_DOCUMENT_KINDS.find(
        (k) => k.code === 'AADHAAR',
      )!;
      expect(created.code).toBe(kind.code);
      expect(created.name).toBe(kind.label);
      expect(created.hasExpiry).toBe(kind.hasExpiry);
      expect(created.needsNumber).toBe(kind.needsNumber);
      // The one that would be a real leak if it were taken from a request body: Aadhaar
      // must come out restricted whatever the caller sends (FR-024).
      expect(created.isRestricted).toBe(true);
      expect(created.companyId).toBe(COMPANY);
    });

    it('accepts the code in any case, and normalises to the declared spelling', async () => {
      const { service, tx } = harness({ existingType: null });

      await service.defineRequiredKind(ctx, COMPANY, '  gst  ', actor);

      expect(
        (tx.documentType.create as jest.Mock).mock.calls[0][0].data.code,
      ).toBe('GST');
    });

    it('is idempotent — a second call returns the first type, it does not create another', async () => {
      const { service, tx } = harness({
        existingType: { id: 'dt-gst', code: 'GST', name: 'GST certificate' },
      });

      const result = await service.defineRequiredKind(
        ctx,
        COMPANY,
        'GST',
        actor,
      );

      expect(result.documentTypeId).toBe('dt-gst');
      expect(tx.documentType.create).not.toHaveBeenCalled();
    });
  });

  describe('download (FR-024, T015)', () => {
    it('writes the audit entry BEFORE the bytes are read', async () => {
      const order: string[] = [];
      const { service, storage, audit, tx } = harness();
      tx.companyDocument.findFirst = jest.fn(async () => ({
        id: 'doc-1',
        documentTypeId: 'dt-aadhaar',
        documentNumber: null,
        expiresAt: null,
        uploadedAt: new Date(),
        isCurrent: true,
        fileRef: 'ref-1',
        documentType: {
          code: 'AADHAAR',
          name: 'Aadhaar',
          isRestricted: true,
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      })) as any;
      audit.record.mockImplementation(async () => {
        order.push('audit');
      });
      storage.get.mockImplementation(async () => {
        order.push('storage');
        return Buffer.from('bytes');
      });

      await service.download(ctx, COMPANY, 'doc-1', {
        userId: 'u-1',
        ipAddress: '10.0.0.1',
      });

      // An entry written only after a successful transfer cannot describe the retrieval
      // that failed halfway — and for a restricted kind the attempt is the thing worth
      // knowing about.
      expect(order).toEqual(['audit', 'storage']);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          changes: expect.objectContaining({
            isRestricted: true,
            retrieved: true,
          }),
        }),
      );
    });
  });
});
