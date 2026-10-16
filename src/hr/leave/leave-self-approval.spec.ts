import { ForbiddenException } from '@nestjs/common';
import { LeaveApplicationStatus } from '@prisma/client';

import { createPrismaMock } from '../../settings/testing/prisma-mock';
import { LeaveService } from './leave.service';

/** 2026-10-16 access-control audit, H3: nobody decides their own leave. */
describe('LeaveService.decide — self-approval', () => {
  function build(
    applicantUserId: string | null,
    stage: { managerUserId?: string; managerDecidedAt?: Date } = {},
  ) {
    const update = jest.fn().mockResolvedValue({ id: 'la-1' });
    const prisma = createPrismaMock({
      leaveApplication: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'la-1',
          employeeId: 'emp-1',
          status: LeaveApplicationStatus.pending,
          leaveType: 'lwp',
          managerUserId: null,
          managerDecidedAt: null,
          ...stage,
        }),
        update,
      },
      employee: {
        findFirst: jest.fn().mockResolvedValue({ userId: applicantUserId }),
      },
    });
    const config = { get: () => ({ timezone: 'Asia/Kolkata' }) };
    const service = new LeaveService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { record: jest.fn() } as never,
      config as never,
    );
    return { service, update };
  }

  const caller = {
    userId: 'user-1',
    companyId: 'co-1',
    rls: { isSuperAdmin: false, companyId: 'co-1' },
  } as never;

  it('refuses the applicant deciding their own application', async () => {
    const { service, update } = build('user-1');
    await expect(
      service.decide(caller, 'la-1', { decision: 'approved' } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(update).not.toHaveBeenCalled();
  });

  it('lets someone else decide it', async () => {
    const { service, update } = build('user-2');
    await service
      .decide(caller, 'la-1', { decision: 'rejected' } as never)
      .catch(() => undefined);
    expect(update).toHaveBeenCalled();
  });

  // 2026-10-16: reporting manager first, then HR.
  it('refuses HR deciding an application still with the reporting manager', async () => {
    const { service, update } = build('user-2', { managerUserId: 'mgr-1' });
    await expect(
      service.decide(caller, 'la-1', { decision: 'approved' } as never),
    ).rejects.toMatchObject({ response: { code: 'AWAITING_MANAGER' } });
    expect(update).not.toHaveBeenCalled();
  });

  it('lets HR decide once the manager has approved it on', async () => {
    const { service, update } = build('user-2', {
      managerUserId: 'mgr-1',
      managerDecidedAt: new Date(),
    });
    await service
      .decide(caller, 'la-1', { decision: 'rejected', remarks: 'x' } as never)
      .catch(() => undefined);
    expect(update).toHaveBeenCalled();
  });

  it('a manager approval passes the application to HR without deciding it', async () => {
    const { service, update } = build('user-2', { managerUserId: 'user-1' });
    await service
      .managerDecide(caller, 'la-1', { decision: 'approved' } as never)
      .catch(() => undefined);
    const data = update.mock.calls[0][0].data;
    expect(data.managerDecidedAt).toBeInstanceOf(Date);
    expect(data.status).toBeUndefined();
  });
});
