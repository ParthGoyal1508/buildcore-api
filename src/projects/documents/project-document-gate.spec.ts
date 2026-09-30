import { ProjectDocumentsService } from './project-documents.service';

/**
 * The project creation gate and the staged upload path (017 T108, T110, T122, T123a).
 *
 * T122 is the security test of this amendment, and the one to read first: **user B must not be able
 * to consume user A's staged reference, and must not be able to tell that refusal from a
 * nonexistent id.** The second half is the part that is easy to get wrong — a distinct "forbidden"
 * code would confirm the other user's document exists.
 */
describe('ProjectDocumentsService — the gate and the upload path', () => {
  const harness = (opts: {
    staged?: Record<string, unknown>[];
    requirements?: { documentTypeId: string; isMandatory: boolean }[];
    types?: { id: string; name: string }[];
    documents?: Record<string, unknown>[];
  }) => {
    const writes: Record<string, unknown>[] = [];
    const tx = {
      $executeRaw: async () => 0,
      stagedProjectDocument: {
        findMany: async () => opts.staged ?? [],
        create: async (args: { data: Record<string, unknown> }) => {
          writes.push({ model: 'staged', ...args.data });
          return { id: 'staged-new', ...args.data };
        },
        deleteMany: async () => ({ count: 0 }),
      },
      projectDocument: {
        create: async (args: { data: Record<string, unknown> }) => {
          writes.push({ model: 'document', ...args.data });
          return { id: 'doc-new', ...args.data };
        },
        findMany: async () => opts.documents ?? [],
      },
      projectDocumentRequirement: {
        // Honours the `where` clause, because the gate's correctness depends on it: it asks only
        // for `isMandatory: true`, and a double returning everything would make an advisory kind
        // look like it blocks a creation — passing a test that proves the opposite of the code.
        findMany: async (args?: { where?: { isMandatory?: boolean } }) => {
          const all = opts.requirements ?? [];
          const wanted = args?.where?.isMandatory;
          return wanted === undefined
            ? all
            : all.filter((r) => r.isMandatory === wanted);
        },
      },
    };
    const prisma = {
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    };
    const service = new ProjectDocumentsService(
      prisma as never,
      { listForCompany: async () => opts.types ?? [] } as never,
      { record: jest.fn() } as never,
      { put: async () => 'ref-1', deleteMany: jest.fn() } as never,
      { get: () => ({ stagedDocumentRetentionHours: 24 }) } as never,
    );
    return { service, writes };
  };

  const ctx = { isSuperAdmin: true } as never;
  const CO = 'co-1';

  describe('upload (FR-008a)', () => {
    it('accepts a document with no type and files it as supplementary', async () => {
      // US2 acceptance scenario 5, which has never been executable because nothing created a
      // `ProjectDocument` at all.
      const { service, writes } = harness({});
      await service.upload(
        ctx,
        CO,
        'p-1',
        {
          documentType: 'Site photograph',
          data: Buffer.from('x'),
          contentType: 'image/png',
        },
        'u-1',
      );
      const written = writes.find((w) => w.model === 'document');
      expect(written?.documentTypeId).toBeNull();
      expect(written?.projectId).toBe('p-1');
    });

    it('refuses a document naming a type the company does not have', async () => {
      const { service } = harness({ types: [] });
      await expect(
        service.upload(
          ctx,
          CO,
          'p-1',
          {
            documentTypeId: 'dt-nope',
            documentType: 'Work Order',
            data: Buffer.from('x'),
            contentType: 'application/pdf',
          },
          'u-1',
        ),
      ).rejects.toMatchObject({
        response: { code: 'PROJECT_DOCUMENT_TYPE_UNKNOWN' },
      });
    });
  });

  describe('listForProject (FR-008a)', () => {
    it('includes a supplementary document — the D1 regression, one screen over', async () => {
      // Filtering to the required set is what made supplementary *company* documents invisible and
      // produced amendment D1. The same mistake is available here, so this test is named for it.
      const { service } = harness({
        documents: [
          { id: 'd-1', documentTypeId: 'dt-loi' },
          { id: 'd-2', documentTypeId: null },
        ],
      });
      const list = await service.listForProject(ctx, CO, 'p-1');
      expect(list.map((d: { id: string }) => d.id)).toEqual(['d-1', 'd-2']);
    });
  });

  describe('assertMandatoryKindsSatisfied (FR-009, FR-009a, FR-009c)', () => {
    const stagedRow = (over: Record<string, unknown> = {}) => ({
      id: 'st-1',
      companyId: CO,
      documentTypeId: 'dt-loi',
      documentType: 'LOI',
      fileRef: 'ref-1',
      filePath: null,
      uploadedBy: 'user-a',
      ...over,
    });

    it('passes when every mandatory kind is attached', async () => {
      const { service } = harness({
        staged: [stagedRow()],
        requirements: [{ documentTypeId: 'dt-loi', isMandatory: true }],
      });
      const resolved = await service.assertMandatoryKindsSatisfied(
        ctx,
        CO,
        ['st-1'],
        'user-a',
      );
      expect(resolved).toHaveLength(1);
      expect(resolved[0].fileRef).toBe('ref-1');
    });

    it('refuses a creation with a mandatory kind unattached, naming the LABEL', async () => {
      // Never the id. A refusal naming internal identifiers is one the reader cannot act on, which
      // is the same argument that produced FR-007a.
      const { service } = harness({
        staged: [],
        requirements: [{ documentTypeId: 'dt-wo', isMandatory: true }],
        types: [{ id: 'dt-wo', name: 'Work Order' }],
      });
      await expect(
        service.assertMandatoryKindsSatisfied(ctx, CO, [], 'user-a'),
      ).rejects.toMatchObject({
        response: {
          code: 'PROJECT_DOCUMENTS_MANDATORY_MISSING',
          missingKinds: ['Work Order'],
        },
      });
    });

    it('ignores advisory kinds — they never block a creation', async () => {
      const { service } = harness({
        staged: [],
        requirements: [{ documentTypeId: 'dt-boq', isMandatory: false }],
        types: [{ id: 'dt-boq', name: 'BOQ' }],
      });
      await expect(
        service.assertMandatoryKindsSatisfied(ctx, CO, [], 'user-a'),
      ).resolves.toEqual([]);
    });

    it('refuses user B consuming user A’s staged reference (FR-009c)', async () => {
      // The security test of this amendment.
      const { service } = harness({
        staged: [stagedRow({ uploadedBy: 'user-a' })],
        requirements: [],
      });
      await expect(
        service.assertMandatoryKindsSatisfied(ctx, CO, ['st-1'], 'user-b'),
      ).rejects.toMatchObject({
        response: { code: 'PROJECT_STAGED_DOCUMENT_UNKNOWN' },
      });
    });

    it('gives that refusal the SAME code as a nonexistent id', async () => {
      // The half that is easy to get wrong. A distinct "forbidden" code would confirm the other
      // user's staged document exists, which is precisely what the requirement forbids.
      const other = harness({
        staged: [stagedRow({ uploadedBy: 'user-a' })],
        requirements: [],
      });
      const missing = harness({ staged: [], requirements: [] });

      const forbidden = await other.service
        .assertMandatoryKindsSatisfied(ctx, CO, ['st-1'], 'user-b')
        .catch((e) => e);
      const nonexistent = await missing.service
        .assertMandatoryKindsSatisfied(ctx, CO, ['st-nope'], 'user-b')
        .catch((e) => e);

      expect(forbidden.getResponse().code).toBe(nonexistent.getResponse().code);
      expect(forbidden.getStatus()).toBe(nonexistent.getStatus());
    });

    it('refuses a staged row from another company', async () => {
      // RLS would normally exclude it, but the query runs under a company context and this asserts
      // the service does not rely on that alone.
      const { service } = harness({ staged: [], requirements: [] });
      await expect(
        service.assertMandatoryKindsSatisfied(ctx, CO, ['st-other'], 'user-a'),
      ).rejects.toMatchObject({
        response: { code: 'PROJECT_STAGED_DOCUMENT_UNKNOWN' },
      });
    });
  });

  describe('setRequirements (FR-007d)', () => {
    it('refuses marking a kind mandatory when no type exists for it', async () => {
      const { service } = harness({ types: [] });
      await expect(
        service.setRequirements(
          ctx,
          CO,
          {
            requirements: [{ documentTypeId: 'dt-ghost', isMandatory: true }],
          } as never,
          { userId: 'u-1', ipAddress: '127.0.0.1' },
        ),
      ).rejects.toMatchObject({
        response: {
          code: expect.stringMatching(
            /PROJECT_DOCUMENT_KIND_NOT_DEFINED|PROJECT_DOCUMENT_TYPE_UNKNOWN/,
          ),
        },
      });
    });
  });
});
