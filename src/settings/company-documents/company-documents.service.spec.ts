import { BadRequestException } from '@nestjs/common';

import { CompanyDocumentsService } from './company-documents.service';
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
        return opts.types?.[0] ?? null;
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

  const service = new CompanyDocumentsService(prisma, storage, audit);
  return { service, calls, tx, storage, audit };
}

const ctx = { isSuperAdmin: false, companyId: COMPANY };

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
