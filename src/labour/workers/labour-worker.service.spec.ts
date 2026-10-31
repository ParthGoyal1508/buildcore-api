import {
  EngagementType,
  LabourGender,
  LabourPunchType,
  Permission,
  Prisma,
  SiteStatus,
  WorkerStatus,
} from '@prisma/client';

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
      { contractorNames: jest.fn(async () => new Map()) } as never, // refs
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

/** 052: editing and transferring a worker. */
describe('LabourWorkerService edit and transfer (052)', () => {
  const worker = {
    id: 'w1',
    companyId: 'c1',
    labourCode: 'LAB-0001',
    fullName: 'Dummy Ramesh',
    fatherName: null,
    gender: LabourGender.male,
    phone: null,
    dateOfBirth: null,
    skillCategoryId: null,
    engagementType: EngagementType.direct,
    contractorId: null,
    siteId: 's1',
    status: WorkerStatus.active,
    aadhaarNumber: null,
    bankAccount: null,
    rateOverride: null as Prisma.Decimal | null,
    faceEnrolmentId: 'face-1',
    deletedAt: null,
  };

  function build(
    opts: {
      permissions?: Permission[];
      row?: Partial<typeof worker>;
      clash?: boolean;
      lastPunch?: unknown;
      site?: unknown;
    } = {},
  ) {
    const row = { ...worker, ...opts.row };
    const prisma = createPrismaMock({
      labourWorker: {
        findUnique: jest.fn(async () => row),
        findFirst: jest.fn(async () => (opts.clash ? { id: 'w9' } : null)),
        update: jest.fn(async ({ data }) => ({
          ...row,
          ...data,
          transfers: [],
        })),
      },
      labourPunch: { findFirst: jest.fn(async () => opts.lastPunch ?? null) },
      gangMember: { updateMany: jest.fn(async () => ({ count: 1 })) },
      labourWorkerTransfer: { create: jest.fn(async () => ({})) },
    });
    const audit = { record: jest.fn(async () => undefined) };
    const refs = {
      contractorNames: jest.fn(
        async () => new Map([['v1', 'Dummy Contractor']]),
      ),
      assertActiveContractor: jest.fn(async () => undefined),
      requireSkillCategory: jest.fn(async () => ({})),
      findSite: jest.fn(async () =>
        opts.site === undefined
          ? {
              id: 's2',
              companyId: 'c1',
              name: 'Site 2',
              status: SiteStatus.active,
            }
          : opts.site,
      ),
      timeZone: 'Asia/Kolkata',
    };
    const supervisorSites = {
      assertSiteAllowed: jest.fn(async () => undefined),
    };
    const service = new LabourWorkerService(
      prisma as never,
      audit as never,
      refs as never,
      {} as never,
      {} as never,
      {} as never,
      supervisorSites as never,
      {} as never,
    );
    const caller = {
      id: 'u1',
      companyId: 'c1',
      permissions: opts.permissions ?? [Permission.DAILY_WORKER_REGISTRY],
    } as never;
    return { service, prisma, audit, refs, supervisorSites, caller };
  }

  describe('update', () => {
    it('saves only the changed fields and audits their names, never the values', async () => {
      const { service, prisma, audit, caller } = build();
      const res = await service.update(
        caller,
        'w1',
        { fullName: 'Dummy Ramesh Kumar', aadhaarNumber: '999988887777' },
        '::1',
      );
      const data = (prisma.tx.labourWorker.update as jest.Mock).mock.calls[0][0]
        .data;
      expect(data).toEqual({
        fullName: 'Dummy Ramesh Kumar',
        aadhaarNumber: '999988887777',
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          changes: { fields: ['fullName', 'aadhaarNumber'] },
        }),
      );
      expect(JSON.stringify(audit.record.mock.calls)).not.toContain('9999');
      expect(res.aadhaarNumber).toBe('••••••••7777');
      expect(res.labourCode).toBe('LAB-0001');
    });

    it('refuses an Aadhaar another active worker holds', async () => {
      const { service, caller } = build({ clash: true });
      await expect(
        service.update(caller, 'w1', { aadhaarNumber: '111122223333' }, '::1'),
      ).rejects.toMatchObject({ status: 409 });
    });

    it('needs a contractor when the worker becomes contractor-engaged', async () => {
      const { service, caller } = build();
      await expect(
        service.update(
          caller,
          'w1',
          { engagementType: EngagementType.contractor },
          '::1',
        ),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('checks a newly named contractor against the company', async () => {
      const { service, refs, caller } = build();
      await service.update(
        caller,
        'w1',
        { engagementType: EngagementType.contractor, contractorId: 'v1' },
        '::1',
      );
      expect(refs.assertActiveContractor).toHaveBeenCalledWith(
        caller,
        'v1',
        'c1',
      );
    });

    it('needs LABOUR_APPROVE to set, change or clear the special rate', async () => {
      const { service, caller } = build();
      await expect(
        service.update(caller, 'w1', { rateOverride: 700 }, '::1'),
      ).rejects.toMatchObject({ status: 403 });

      const approver = build({
        permissions: [
          Permission.DAILY_WORKER_REGISTRY,
          Permission.LABOUR_APPROVE,
        ],
        row: { rateOverride: new Prisma.Decimal(650) },
      });
      const res = await approver.service.update(
        approver.caller,
        'w1',
        { rateOverride: null },
        '::1',
      );
      expect(res.rateOverride).toBeNull();
    });

    it('writes nothing when nothing changes', async () => {
      const { service, prisma, audit, caller } = build();
      await service.update(caller, 'w1', { fullName: 'Dummy Ramesh' }, '::1');
      expect(prisma.tx.labourWorker.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('transfer', () => {
    it('moves the worker, ends the gang membership and keeps the history and face', async () => {
      const { service, prisma, supervisorSites, caller } = build();
      const res = await service.transfer(
        caller,
        'w1',
        { siteId: 's2', reason: ' Needed at s2 ' },
        '::1',
      );
      expect(supervisorSites.assertSiteAllowed).toHaveBeenCalledWith(
        caller,
        's1',
      );
      expect(supervisorSites.assertSiteAllowed).toHaveBeenCalledWith(
        caller,
        's2',
      );
      expect(prisma.tx.gangMember.updateMany).toHaveBeenCalled();
      expect(prisma.tx.labourWorkerTransfer.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          workerId: 'w1',
          fromSiteId: 's1',
          toSiteId: 's2',
          reason: 'Needed at s2',
        }),
      });
      expect(
        (prisma.tx.labourWorker.update as jest.Mock).mock.calls[0][0].data,
      ).toEqual({ siteId: 's2' });
      expect(res.faceEnrolled).toBe(true);
    });

    it.each([
      ['the same site', { siteId: 's1' }, {}, 400],
      [
        'another company',
        { siteId: 's2' },
        {
          site: {
            id: 's2',
            companyId: 'c2',
            name: 'X',
            status: SiteStatus.active,
          },
        },
        400,
      ],
      ['an unknown site', { siteId: 's2' }, { site: null }, 400],
      [
        'an inactive site',
        { siteId: 's2' },
        {
          site: {
            id: 's2',
            companyId: 'c1',
            name: 'X',
            status: SiteStatus.inactive,
          },
        },
        400,
      ],
      [
        'an inactive worker',
        { siteId: 's2' },
        { row: { status: WorkerStatus.inactive } },
        400,
      ],
    ])('refuses %s', async (_label, body, opts, status) => {
      const { service, prisma, caller } = build(opts as never);
      await expect(
        service.transfer(caller, 'w1', body, '::1'),
      ).rejects.toMatchObject({ status });
      expect(prisma.tx.labourWorkerTransfer.create).not.toHaveBeenCalled();
    });

    it('refuses while the worker is punched in', async () => {
      const { service, prisma, caller } = build({
        lastPunch: {
          type: LabourPunchType.in,
          punchDate: new Date(Date.now() + 86_400_000),
        },
      });
      await expect(
        service.transfer(caller, 'w1', { siteId: 's2' }, '::1'),
      ).rejects.toMatchObject({ status: 409 });
      expect(prisma.tx.labourWorkerTransfer.create).not.toHaveBeenCalled();
    });
  });
});
