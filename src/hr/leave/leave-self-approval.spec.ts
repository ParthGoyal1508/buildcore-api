import { ForbiddenException } from '@nestjs/common';
import { LeaveApplicationStatus } from '@prisma/client';

import { createPrismaMock } from '../../settings/testing/prisma-mock';
import { LeaveService } from './leave.service';

/** 2026-10-16 access-control audit, H3: nobody decides their own leave. */
describe('LeaveService.decide — self-approval', () => {
  function build(applicantUserId: string | null) {
    const update = jest.fn().mockResolvedValue({ id: 'la-1' });
    const prisma = createPrismaMock({
      leaveApplication: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'la-1',
          employeeId: 'emp-1',
          status: LeaveApplicationStatus.pending,
          leaveType: 'lwp',
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
});
