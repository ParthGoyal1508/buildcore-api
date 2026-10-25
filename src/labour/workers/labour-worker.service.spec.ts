import { createPrismaMock } from '../../settings/testing/prisma-mock';
import { LabourWorkerService } from './labour-worker.service';

/**
 * The worker list's NOC-status filter (042). The Workers screen filters by open/closed NOC, and
 * doing it client-side only sieved the loaded page — a worker on page 2 with an open NOC simply
 * was not in the "open" view. The filter now lands in the paginated query itself, with the closed
 * set asked of `NocsService` (Principle I).
 */
describe('LabourWorkerService.findAll nocStatus (042)', () => {
  function build(closed: string[]) {
    const prisma = createPrismaMock({
      labourWorker: {
        findMany: jest.fn(async () => []),
        count: jest.fn(async () => 0),
      },
    });
    const supervisorSites = { allowedSiteIds: jest.fn(async () => null) };
    const nocs = { closedSubjectIds: jest.fn(async () => closed) };
    const service = new LabourWorkerService(
      prisma as never,
      {} as never, // audit log
      {} as never, // refs
      {} as never, // storage
      {} as never, // biometrics
      {} as never, // images
      supervisorSites as never,
      nocs as never,
    );
    const caller = { id: 'u1', companyId: 'c1', permissions: [] } as never;
    return { service, prisma, nocs, caller };
  }

  it('narrows to the closed set across the whole register', async () => {
    const { service, prisma, nocs, caller } = build(['w1', 'w3']);

    await service.findAll(caller, { nocStatus: 'closed' });

    expect(nocs.closedSubjectIds).toHaveBeenCalledWith(caller, 'labour_worker');
    const where = (prisma.tx.labourWorker.findMany as jest.Mock).mock
      .calls[0][0].where;
    expect(where.id).toEqual({ in: ['w1', 'w3'] });
    // The count uses the same where, so the pager agrees with the rows.
    expect(
      (prisma.tx.labourWorker.count as jest.Mock).mock.calls[0][0].where,
    ).toBe(where);
  });

  it('inverts for open: everyone not yet closed', async () => {
    const { service, prisma, caller } = build(['w1']);

    await service.findAll(caller, { nocStatus: 'open' });

    const where = (prisma.tx.labourWorker.findMany as jest.Mock).mock
      .calls[0][0].where;
    expect(where.id).toEqual({ notIn: ['w1'] });
  });

  it('leaves the query untouched when no NOC filter is asked for', async () => {
    const { service, prisma, nocs, caller } = build(['w1']);

    await service.findAll(caller, {});

    expect(nocs.closedSubjectIds).not.toHaveBeenCalled();
    const where = (prisma.tx.labourWorker.findMany as jest.Mock).mock
      .calls[0][0].where;
    expect(where.id).toBeUndefined();
  });
});
