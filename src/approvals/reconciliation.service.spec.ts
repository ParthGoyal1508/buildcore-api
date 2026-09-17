import { ApprovalReconciler } from './approval-reconciler';
import { createPrismaMock } from '../settings/testing/prisma-mock';
import { ReconciliationService } from './reconciliation.service';

const COMPANY_A = 'company-a';
const COMPANY_B = 'company-b';

const live = (overrides: Record<string, unknown> = {}) => ({
  id: 'inst-1',
  companyId: COMPANY_A,
  entityType: 'attendance_exception',
  entityId: 'punch-1',
  state: 'pending',
  subject: 'Rajesh Kulkarni — 11 Sep',
  ...overrides,
});

/**
 * A stand-in module reconciler. Decorator metadata is applied by hand rather than by the
 * decorator, because `DiscoveryService` is mocked here — what is under test is the sweep's
 * reading of the metadata, not Nest's ability to set it.
 */
function reconciler(
  entityType: string,
  impl: ApprovalReconciler['reconcile'],
): ApprovalReconciler {
  return { entityType, reconcile: impl };
}

function harness(
  instances: ReturnType<typeof live>[],
  reconcilers: ApprovalReconciler[],
) {
  const prisma = createPrismaMock({
    approvalInstance: { findMany: jest.fn(async () => instances) },
  });

  const discovery = {
    getProviders: () =>
      reconcilers.map((instance) => ({
        instance,
        metatype: instance.constructor,
      })),
  };

  // The sweep reads metadata off the metatype; setting it directly keeps the test about
  // the sweep rather than about Reflect.
  for (const r of reconcilers) {
    Reflect.defineMetadata('approvals:reconciler', true, r.constructor);
  }

  return {
    service: new ReconciliationService(prisma as never, discovery as never),
    prisma,
  };
}

describe('ReconciliationService (T052)', () => {
  afterEach(() => {
    Reflect.deleteMetadata('approvals:reconciler', Object);
  });

  it('reports an approval whose item has gone as orphaned', async () => {
    const { service } = harness(
      [live()],
      [
        reconciler('attendance_exception', async (_c, ids) =>
          ids.map((entityId) => ({ entityId, exists: false, inStep: null })),
        ),
      ],
    );

    const report = await service.sweep();

    // The price of having no foreign key into seven other schemas (research.md §1),
    // reported rather than repaired — deleting the approval would destroy the evidence
    // that anybody was ever asked to decide.
    expect(report.scanned).toBe(1);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({
      kind: 'orphaned',
      entityId: 'punch-1',
      instanceId: 'inst-1',
    });
    expect(report.findings[0].detail).toContain('abandon()');
  });

  it('reports an item whose own status disagrees with the spine as drifted', async () => {
    const { service } = harness(
      [live()],
      [
        reconciler('attendance_exception', async (_c, ids) =>
          ids.map((entityId) => ({ entityId, exists: true, inStep: false })),
        ),
      ],
    );

    const report = await service.sweep();

    expect(report.findings[0].kind).toBe('drifted');
    // research.md §8: the spine is authoritative and the module's status is derived, so
    // the remedy is replay rather than a debate about which is right.
    expect(report.findings[0].detail).toContain('authoritative');
  });

  it('says nothing about an item the module vouches for', async () => {
    const { service } = harness(
      [live()],
      [
        reconciler('attendance_exception', async (_c, ids) =>
          ids.map((entityId) => ({ entityId, exists: true, inStep: true })),
        ),
      ],
    );

    await expect(service.sweep()).resolves.toMatchObject({
      scanned: 1,
      findings: [],
      unreconciledTypes: [],
    });
  });

  it('treats "no opinion" as not-drifted rather than as drift', async () => {
    const { service } = harness(
      [live()],
      [
        reconciler('attendance_exception', async (_c, ids) =>
          ids.map((entityId) => ({ entityId, exists: true, inStep: null })),
        ),
      ],
    );

    // A module with no status column of its own has nothing to disagree with. Null is
    // honest and must not be read as false, or every such module would report drift
    // nightly and the report would stop being read.
    await expect(service.sweep()).resolves.toMatchObject({ findings: [] });
  });

  it('names an entity type that has live approvals and no reconciler', async () => {
    const { service } = harness([live({ entityType: 'payroll_run' })], []);

    const report = await service.sweep();

    // Itself the finding: a module put work into the spine and never taught the spine
    // how to check on it.
    expect(report.unreconciledTypes).toEqual(['payroll_run']);
    expect(report.findings).toEqual([]);
  });

  it('keeps sweeping when one module’s reconciler throws', async () => {
    const { service } = harness(
      [
        live({ id: 'inst-1', entityType: 'broken' }),
        live({ id: 'inst-2', entityType: 'working', entityId: 'punch-2' }),
      ],
      [
        reconciler('broken', async () => {
          throw new Error('module is down');
        }),
        reconciler('working', async (_c, ids) =>
          ids.map((entityId) => ({ entityId, exists: false, inStep: null })),
        ),
      ],
    );

    const report = await service.sweep();

    // A sweep that reports nothing because the first reconciler threw is
    // indistinguishable from a clean run, which is the worst possible outcome for a job
    // whose only product is visibility.
    const kinds = report.findings.map((f) => f.kind);
    expect(kinds).toContain('unreconcilable');
    expect(kinds).toContain('orphaned');
    expect(
      report.findings.find((f) => f.kind === 'unreconcilable').detail,
    ).toContain('module is down');
  });

  it('calls each reconciler once per company, never across tenants', async () => {
    const seen: { companyId: string; ids: string[] }[] = [];
    const { service } = harness(
      [
        live({ id: 'i1', companyId: COMPANY_A, entityId: 'a1' }),
        live({ id: 'i2', companyId: COMPANY_A, entityId: 'a2' }),
        live({ id: 'i3', companyId: COMPANY_B, entityId: 'b1' }),
      ],
      [
        reconciler('attendance_exception', async (companyId, ids) => {
          seen.push({ companyId, ids });
          return ids.map((entityId) => ({
            entityId,
            exists: true,
            inStep: true,
          }));
        }),
      ],
    );

    await service.sweep();

    // Batched per tenant: one call per (company, type) rather than one per item, and a
    // module is never handed ids from a company it should not see.
    expect(seen).toHaveLength(2);
    expect(seen.find((s) => s.companyId === COMPANY_A).ids).toEqual([
      'a1',
      'a2',
    ]);
    expect(seen.find((s) => s.companyId === COMPANY_B).ids).toEqual(['b1']);
  });

  it('scans only live approvals — a finished chain cannot drift', async () => {
    const { service, prisma } = harness([], []);

    await service.sweep();

    expect(prisma.tx.approvalInstance.findMany.mock.calls[0][0].where).toEqual({
      state: { in: ['pending', 'returned'] },
    });
  });

  it('refuses two reconcilers claiming one entity type', async () => {
    class First implements ApprovalReconciler {
      readonly entityType = 'attendance_exception';
      async reconcile() {
        return [];
      }
    }
    class Second implements ApprovalReconciler {
      readonly entityType = 'attendance_exception';
      async reconcile() {
        return [];
      }
    }
    Reflect.defineMetadata('approvals:reconciler', true, First);
    Reflect.defineMetadata('approvals:reconciler', true, Second);

    const prisma = createPrismaMock({
      approvalInstance: { findMany: jest.fn(async () => []) },
    });
    const discovery = {
      getProviders: () => [
        { instance: new First(), metatype: First },
        { instance: new Second(), metatype: Second },
      ],
    };
    const service = new ReconciliationService(
      prisma as never,
      discovery as never,
    );

    // Two reconcilers for one type would each see half the picture and disagree about
    // the other half. Loud beats silent-at-02:40.
    await expect(service.sweep()).rejects.toThrow(/Two approval reconcilers/);
  });
});
