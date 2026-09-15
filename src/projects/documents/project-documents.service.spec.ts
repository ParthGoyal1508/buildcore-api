import { BadRequestException } from '@nestjs/common';

import { REQUIRED_PROJECT_DOCUMENT_KINDS } from '../../settings/document-kinds';
import { ProjectDocumentsService } from './project-documents.service';

const COMPANY = 'co-1';
const ctx = { isSuperAdmin: false, companyId: COMPANY };

type Requirement = { documentTypeId: string; isMandatory: boolean };
type DocRow = { projectId: string; documentTypeId: string | null };
type TypeRow = { id: string; code: string; name: string };

/**
 * Unit tests for project document readiness (017 T024).
 *
 * The harness counts Prisma calls rather than only checking results, for the reason 016
 * and US1 both established: the requirement here is a **query cost**, and a result-only
 * assertion passes an N+1 happily. The N+1 is invisible in development, where three
 * projects hide it perfectly, and expensive in production (quickstart Pass 4).
 */
function harness(
  opts: {
    requirements?: Requirement[];
    documents?: DocRow[];
    types?: TypeRow[];
  } = {},
) {
  const calls: string[] = [];

  const tx = {
    projectDocumentRequirement: {
      findMany: jest.fn(async () => {
        calls.push('projectDocumentRequirement.findMany');
        return opts.requirements ?? [];
      }),
      deleteMany: jest.fn(async () => {
        calls.push('projectDocumentRequirement.deleteMany');
        return { count: 0 };
      }),
      createMany: jest.fn(async () => {
        calls.push('projectDocumentRequirement.createMany');
        return { count: 0 };
      }),
    },
    projectDocument: {
      findMany: jest.fn(async () => {
        calls.push('projectDocument.findMany');
        return opts.documents ?? [];
      }),
    },
    // `withRlsContext` sets the session variables the policies read before it runs the
    // callback. Not counted as a query: it is the transaction's preamble, not a read.
    $executeRaw: jest.fn(),
  };

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const prisma: any = {
    $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) =>
      fn(tx),
    ),
  };
  const documentTypes: any = {
    listForCompany: jest.fn(async () => {
      calls.push('documentTypes.listForCompany');
      return opts.types ?? [];
    }),
  };
  const audit: any = { record: jest.fn().mockResolvedValue(undefined) };
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const service = new ProjectDocumentsService(prisma, documentTypes, audit);
  return { service, calls, tx, documentTypes, audit };
}

const REQUIRED_IDS = ['dt-loi', 'dt-wo', 'dt-ins'];
const configured: Requirement[] = REQUIRED_IDS.map((id) => ({
  documentTypeId: id,
  isMandatory: true,
}));

const shippedTypes: TypeRow[] = REQUIRED_PROJECT_DOCUMENT_KINDS.map((k) => ({
  id: `dt-${k.code}`,
  code: k.code,
  name: k.label,
}));

describe('ProjectDocumentsService.readinessFor (FR-008, T021, T024)', () => {
  it('costs the same number of queries for 50 projects as for 1', async () => {
    const projectIds = Array.from({ length: 50 }, (_, i) => `p-${i}`);
    const documents: DocRow[] = projectIds.map((projectId) => ({
      projectId,
      documentTypeId: 'dt-loi',
    }));

    const many = harness({ requirements: configured, documents });
    await many.service.readinessFor(ctx, COMPANY, projectIds);

    const one = harness({
      requirements: configured,
      documents: [documents[0]],
    });
    await one.service.readinessFor(ctx, COMPANY, ['p-0']);

    // The assertion that matters. Not "fewer than N" — *identical*, because a cost that
    // grows at all with the page is the N+1 this exists to prevent.
    expect(many.calls).toEqual([
      'projectDocumentRequirement.findMany',
      'projectDocument.findMany',
    ]);
    expect(many.calls).toEqual(one.calls);
  });

  it('answers every project in the batch, including ones holding nothing', async () => {
    const { service } = harness({
      requirements: configured,
      documents: [{ projectId: 'p-1', documentTypeId: 'dt-loi' }],
    });

    const readiness = await service.readinessFor(ctx, COMPANY, ['p-1', 'p-2']);

    // p-2 has no documents at all. A map that simply omitted it would make the caller
    // guess whether that meant "ready" or "not asked".
    expect(readiness.size).toBe(2);
    expect(readiness.get('p-1')).toEqual({
      required: 3,
      present: 1,
      missingTypeIds: ['dt-wo', 'dt-ins'],
    });
    expect(readiness.get('p-2')).toEqual({
      required: 3,
      present: 0,
      missingTypeIds: REQUIRED_IDS,
    });
  });

  it('reports complete when every required kind is held (US2 scenario 4)', async () => {
    const { service } = harness({
      requirements: configured,
      documents: REQUIRED_IDS.map((documentTypeId) => ({
        projectId: 'p-1',
        documentTypeId,
      })),
    });

    const readiness = await service.readinessFor(ctx, COMPANY, ['p-1']);
    expect(readiness.get('p-1')).toEqual({
      required: 3,
      present: 3,
      missingTypeIds: [],
    });
  });

  it('counts only mandatory requirements', async () => {
    const { service } = harness({
      requirements: [
        { documentTypeId: 'dt-loi', isMandatory: true },
        { documentTypeId: 'dt-optional', isMandatory: false },
      ],
      documents: [{ projectId: 'p-1', documentTypeId: 'dt-loi' }],
    });

    const readiness = await service.readinessFor(ctx, COMPANY, ['p-1']);

    // A project short of an optional paper is not unready. If optional kinds counted,
    // `isMandatory` would change nothing anywhere and would be worth deleting.
    expect(readiness.get('p-1')).toEqual({
      required: 1,
      present: 1,
      missingTypeIds: [],
    });
  });

  it('falls back to the shipped set when nothing is configured', async () => {
    const { service, calls } = harness({
      requirements: [],
      types: shippedTypes,
      documents: [],
    });

    const readiness = await service.readinessFor(ctx, COMPANY, ['p-1']);

    // Without the fallback a company that configured nothing reports every project
    // complete — vacuously true, and worse than no figure because it looks like one.
    expect(readiness.get('p-1')?.required).toBe(
      REQUIRED_PROJECT_DOCUMENT_KINDS.length,
    );
    expect(readiness.get('p-1')?.present).toBe(0);
    // The type names cross a module boundary through an exported service method, never
    // a query into `settings` (Principle I).
    expect(calls).toContain('documentTypes.listForCompany');
  });

  it('does NOT fall back when the configured set is entirely optional', async () => {
    const { service, calls } = harness({
      requirements: [{ documentTypeId: 'dt-loi', isMandatory: false }],
      types: shippedTypes,
      documents: [],
    });

    const readiness = await service.readinessFor(ctx, COMPANY, ['p-1']);

    // A company that deliberately marked every requirement optional has configured
    // something. Overriding that with the defaults would undo their decision silently.
    expect(readiness.get('p-1')?.required).toBe(0);
    expect(calls).not.toContain('documentTypes.listForCompany');
  });

  it('queries nothing at all for an empty page', async () => {
    const { service, calls } = harness({ requirements: configured });
    const readiness = await service.readinessFor(ctx, COMPANY, []);
    expect(readiness.size).toBe(0);
    expect(calls).toEqual([]);
  });

  it('ignores supplementary documents, which answer no required kind', async () => {
    const { service } = harness({
      requirements: configured,
      // A `null` documentTypeId is what "supplementary" means (US2 scenario 5).
      documents: [
        { projectId: 'p-1', documentTypeId: null },
        { projectId: 'p-1', documentTypeId: 'dt-loi' },
      ],
    });

    const readiness = await service.readinessFor(ctx, COMPANY, ['p-1']);
    expect(readiness.get('p-1')?.present).toBe(1);
  });
});

describe('ProjectDocumentsService.setRequirements (FR-007, T020)', () => {
  it('refuses a document type this company does not have', async () => {
    const { service, tx } = harness({ types: shippedTypes });

    const error = await service
      .setRequirements(
        ctx,
        COMPANY,
        { requirements: [{ documentTypeId: 'dt-not-ours' }] },
        { userId: 'u-1', ipAddress: '10.0.0.1' },
      )
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as { response: { code: string } }).response.code).toBe(
      'PROJECT_DOCUMENT_TYPE_UNKNOWN',
    );
    // Refused before anything was written — a half-applied required set is not a state
    // worth being able to reach.
    expect(tx.projectDocumentRequirement.deleteMany).not.toHaveBeenCalled();
  });

  it('replaces the set rather than appending to it', async () => {
    const { service, tx, calls } = harness({ types: shippedTypes });

    await service.setRequirements(
      ctx,
      COMPANY,
      { requirements: [{ documentTypeId: shippedTypes[0].id }] },
      { userId: 'u-1', ipAddress: '10.0.0.1' },
    );

    // Delete then create, in that order: "remove LOI from the requirements" has no
    // other honest expression.
    expect(calls.indexOf('projectDocumentRequirement.deleteMany')).toBeLessThan(
      calls.indexOf('projectDocumentRequirement.createMany'),
    );
    expect(tx.projectDocumentRequirement.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          {
            companyId: COMPANY,
            documentTypeId: shippedTypes[0].id,
            isMandatory: true,
          },
        ],
      }),
    );
  });

  it('accepts an empty set, which clears the requirements', async () => {
    const { service, tx } = harness({ types: shippedTypes });

    await service.setRequirements(
      ctx,
      COMPANY,
      { requirements: [] },
      { userId: 'u-1', ipAddress: '10.0.0.1' },
    );

    expect(tx.projectDocumentRequirement.deleteMany).toHaveBeenCalled();
    expect(tx.projectDocumentRequirement.createMany).not.toHaveBeenCalled();
  });
});

describe('ProjectDocumentsService.listRequirements (FR-007)', () => {
  it('names the required kinds a company has no document type for', async () => {
    const { service } = harness({
      requirements: [],
      types: shippedTypes.filter((t) => t.code !== 'BOQ'),
    });

    const set = await service.listRequirements(ctx, COMPANY);

    // Silently shrinking the required set from six to five is how a missing type turns
    // into a missing document nobody ever notices.
    expect(set.usingDefaults).toBe(true);
    expect(set.undefinedCodes).toEqual(['BOQ']);
    expect(set.requirements).toHaveLength(
      REQUIRED_PROJECT_DOCUMENT_KINDS.length - 1,
    );
  });

  it('reports a configured set as configured, not as defaults', async () => {
    const { service } = harness({
      requirements: [{ documentTypeId: shippedTypes[0].id, isMandatory: true }],
      types: shippedTypes,
    });

    const set = await service.listRequirements(ctx, COMPANY);
    expect(set.usingDefaults).toBe(false);
    expect(set.requirements).toEqual([
      {
        documentTypeId: shippedTypes[0].id,
        code: shippedTypes[0].code,
        name: shippedTypes[0].name,
        isMandatory: true,
      },
    ]);
  });
});
