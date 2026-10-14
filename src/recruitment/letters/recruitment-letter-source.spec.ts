import { Prisma } from '@prisma/client';

import { LetterRecordSources } from '../../letters/letter-record-sources';
import { RecruitmentLetterSource } from './recruitment-letter-source';

/* eslint-disable @typescript-eslint/no-explicit-any */
function harness(over: { offer?: any; resignation?: any } = {}) {
  const tx: any = {
    candidate: {
      findFirst: jest.fn(async (args: any) =>
        args.where.id === 'c-1'
          ? {
              id: 'c-1',
              fullName: 'Ravi Sharma',
              fatherName: 'Mohan Sharma',
              address: 'Washim, Maharashtra',
              phone: '9876500000',
              email: 'ravi@example.com',
              requisition: { siteId: 'site-a', projectId: null },
            }
          : null,
      ),
    },
    offer: {
      findFirst: jest.fn(async () =>
        over.offer === undefined
          ? {
              designationId: 'des-1',
              departmentId: 'dep-1',
              offeredCtc: new Prisma.Decimal(480000),
              proposedJoiningDate: new Date('2026-11-01'),
              confirmedJoiningDate: null,
              probationMonths: 6,
              noticePeriodDays: 30,
              reportingManagerEmployeeId: 'e-boss',
            }
          : over.offer,
      ),
    },
    resignation: { findFirst: jest.fn(async () => over.resignation ?? null) },
    $executeRaw: jest.fn(),
  };
  const prisma: any = {
    $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
  };
  const refs: any = {
    designationName: jest.fn(async () => 'Site Engineer'),
    departmentName: jest.fn(async () => 'Projects'),
    getEmployee: jest.fn(async () => ({
      id: 'e-boss',
      employeeCode: 'PRPL-0001',
      firstName: 'Sunil',
      lastName: 'Agarwal',
      mobile: '9000000001',
    })),
  };
  const sites: any = {
    getSiteById: jest.fn(async () => ({ id: 'site-a', name: 'Washim Camp' })),
  };
  const projects: any = { getProjectIdentityById: jest.fn(async () => null) };
  const registry = new LetterRecordSources();
  const source = new RecruitmentLetterSource(
    prisma,
    registry,
    refs,
    sites,
    projects,
  );
  return { source, registry, tx };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const caller = { id: 'u-1', companyId: 'co-1', permissions: [] } as any; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('RecruitmentLetterSource', () => {
  it('builds the candidate record from the candidate and their latest offer', async () => {
    const { source, tx } = harness();
    const r = (await source.candidateRecord(caller, 'c-1'))! as any; // eslint-disable-line @typescript-eslint/no-explicit-any

    expect(r).toEqual(
      expect.objectContaining({
        fullName: 'Ravi Sharma',
        fatherName: 'Mohan Sharma',
        address: 'Washim, Maharashtra',
        phone: '9876500000',
        email: 'ravi@example.com',
      }),
    );
    expect(r.offer).toEqual(
      expect.objectContaining({
        designation: 'Site Engineer',
        department: 'Projects',
        joiningDate: new Date('2026-11-01'),
        ctcInWords: 'Rupees Four Lakh Eighty Thousand Only',
        probationMonths: 6,
        noticeDays: 30,
        reportingManager: 'Sunil Agarwal',
        reportingManagerMobile: '9000000001',
        // No project on the requisition, so the site names the place.
        placeOfPosting: 'Washim Camp',
      }),
    );
    expect(String(r.offer.ctc)).toBe('480000');
    expect(String(r.offer.ctcMonthly)).toBe('40000');
    // A superseded offer is the one the candidate was not given.
    expect(tx.offer.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: { not: 'superseded' } }),
      }),
    );
  });

  it('leaves `offer` out when there is none yet', async () => {
    const { source } = harness({ offer: null });
    const r = (await source.candidateRecord(caller, 'c-1'))!;
    expect(r.offer).toBeUndefined();
    expect(r.fullName).toBe('Ravi Sharma');
  });

  it('answers null for an unknown candidate', async () => {
    const { source } = harness();
    await expect(source.candidateRecord(caller, 'c-x')).resolves.toBeNull();
  });

  it('contributes the accepted resignation to the employee record', async () => {
    const { source, registry } = harness({
      resignation: {
        resignationDate: new Date('2026-08-16'),
        noticePeriodDays: 30,
        expectedLastWorkingDay: new Date('2026-09-15'),
        agreedLastWorkingDay: null,
      },
    });
    source.onModuleInit();

    await expect(registry.resolve(caller, 'employee', 'e-1')).resolves.toEqual({
      resignation: {
        date: new Date('2026-08-16'),
        lastWorkingDay: new Date('2026-09-15'),
      },
      fnf: { noticeRequiredDays: 30, noticeServedDays: 30 },
    });
  });

  it('contributes nothing without an accepted resignation', async () => {
    const { source } = harness();
    await expect(
      source.resignationContribution(caller, 'e-1'),
    ).resolves.toBeNull();
  });
});
