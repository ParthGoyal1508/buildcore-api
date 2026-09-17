import { BadRequestException } from '@nestjs/common';

import { REQUIRED_PROJECT_DOCUMENT_KINDS } from '../../settings/document-kinds';
import { ProjectDocumentsService } from './project-documents.service';

const COMPANY = 'co-1';
const ctx = { isSuperAdmin: false, companyId: COMPANY };

type Requirement = { documentTypeId: string; isMandatory: boolean };
type DocRow = { projectId: string; documentTypeId: string | null };
type TypeRow = {
  id: string;
  code: string;
  name: string;
  scope?: string;
  isActive?: boolean;
};

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
    defineDeclaredKind: jest.fn(async () => ({
      documentTypeId: 'dt-new',
      code: 'NEW',
      name: 'New kind',
    })),
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
  scope: 'company',
  isActive: true,
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

/**
 * FR-007a. The set has been writable since this feature shipped; what no interface had
 * was a way to name a kind without knowing its identifier, which is what made the screen
 * read-only.
 */
describe('ProjectDocumentsService.listRequirements availableTypes (FR-007a)', () => {
  // Built from `shippedTypes`' own ids. `REQUIRED_IDS` above is the readiness fixture and
  // names ids no type in this block has — a requirement pointing at a missing type is
  // dropped by design, which would make every assertion here vacuous.
  const requiredHere = shippedTypes
    .slice(0, 3)
    .map((t) => ({ documentTypeId: t.id, isMandatory: true }));

  const employeeType: TypeRow = {
    id: 'dt-marksheet',
    code: 'MARKSHEET_10',
    name: '10th Marksheet',
    scope: 'employee',
    isActive: true,
  };
  const sharedType: TypeRow = {
    id: 'dt-aadhaar',
    code: 'AADHAAR',
    name: 'Aadhaar Card',
    scope: 'both',
    isActive: true,
  };

  it("offers the organisation's kinds and not the employee file", async () => {
    const { service } = harness({
      requirements: requiredHere,
      types: [...shippedTypes, employeeType, sharedType],
    });

    const result = await service.listRequirements(ctx, COMPANY);
    const codes = result.availableTypes.map((t) => t.code);

    // A marksheet is not something a project holds. Offering it would be the same
    // mixing `DocumentType.scope` exists to end.
    expect(codes).not.toContain('MARKSHEET_10');
    // `both` belongs to the organisation as well, so it is offerable here.
    expect(codes).toContain('AADHAAR');
    expect(codes).toContain('LOI');
  });

  it('marks which of the available kinds are already required', async () => {
    const { service } = harness({
      requirements: requiredHere,
      types: shippedTypes,
    });

    const result = await service.listRequirements(ctx, COMPANY);
    const required = result.availableTypes
      .filter((t) => t.isRequired)
      .map((t) => t.documentTypeId);

    expect(required.sort()).toEqual(
      requiredHere.map((r) => r.documentTypeId).sort(),
    );
    // The picker subtracts these; an interface offering an option that silently does
    // nothing is its own bug, separate from the backend deduplicating the write.
    expect(result.availableTypes.length).toBeGreaterThan(required.length);
  });

  it('omits a deactivated kind', async () => {
    const { service } = harness({
      requirements: requiredHere,
      types: [
        ...shippedTypes,
        {
          id: 'dt-old',
          code: 'OLD_PERMIT',
          name: 'Retired permit',
          scope: 'company',
          isActive: false,
        },
      ],
    });

    const result = await service.listRequirements(ctx, COMPANY);
    expect(result.availableTypes.map((t) => t.code)).not.toContain(
      'OLD_PERMIT',
    );
  });

  /**
   * T101. `availableTypes` is a mapping over rows `listRequirements` already fetched. The
   * failure worth guarding is a later "let me just fetch the types" refactor turning it
   * into a second call, which no result-only assertion would notice.
   */
  it('costs no extra query — it maps rows already in hand', async () => {
    const { service, calls } = harness({
      requirements: requiredHere,
      types: shippedTypes,
    });

    const result = await service.listRequirements(ctx, COMPANY);

    // Sorted: the two run under `Promise.all`, so their completion order is not part of
    // the contract. What IS the contract is that there are exactly two.
    expect([...calls].sort()).toEqual([
      'documentTypes.listForCompany',
      'projectDocumentRequirement.findMany',
    ]);
    expect(calls).toHaveLength(2);
    expect(result.availableTypes.length).toBeGreaterThan(0);
  });

  it('offers them on the defaults branch too, where nothing is configured', async () => {
    const { service } = harness({ requirements: [], types: shippedTypes });

    const result = await service.listRequirements(ctx, COMPANY);

    expect(result.usingDefaults).toBe(true);
    expect(result.availableTypes.map((t) => t.code)).toContain('LOI');
    // Every shipped kind is already required on this branch, so the picker is empty —
    // correctly, and only because `isRequired` is computed rather than assumed false.
    expect(result.availableTypes.every((t) => t.isRequired)).toBe(true);
  });
});

/**
 * T103, FR-007a. This route lets a `SETTINGS` holder create a `settings.DocumentType`.
 * What keeps that from being a second door to the two permissions that guard type
 * creation elsewhere is that it resolves against the PROJECT set and nothing else.
 */
describe('ProjectDocumentsService.defineRequiredKind (FR-007a)', () => {
  const actor = { userId: 'user-1', ipAddress: '127.0.0.1' };

  it('refuses a code from the COMPANY set — a different permission owns those', async () => {
    const { service, documentTypes } = harness();

    await expect(
      service.defineRequiredKind(ctx, COMPANY, 'GST', actor),
    ).rejects.toBeInstanceOf(BadRequestException);

    // Refused before reaching the service that owns the table, so a rejected attempt
    // cannot even be inferred from a row that briefly existed.
    expect(documentTypes.defineDeclaredKind).not.toHaveBeenCalled();
  });

  it('refuses a code nobody declared', async () => {
    const { service } = harness();
    await expect(
      service.defineRequiredKind(ctx, COMPANY, 'MSME', actor),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('hands the declared kind through, in the spelling configuration uses', async () => {
    const { service, documentTypes } = harness();

    await service.defineRequiredKind(ctx, COMPANY, '  work_order  ', actor);

    const kind = documentTypes.defineDeclaredKind.mock.calls[0][2];
    const declared = REQUIRED_PROJECT_DOCUMENT_KINDS.find(
      (k) => k.code === 'WORK_ORDER',
    )!;
    // The whole declared object, not a code the delegate would have to re-resolve —
    // which is what keeps the delegate free of any code list of its own.
    expect(kind).toEqual(declared);
  });
});
