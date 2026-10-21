import { ForbiddenException } from '@nestjs/common';
import { LeaveApplicationStatus } from '@prisma/client';

import { createPrismaMock } from '../../settings/testing/prisma-mock';
import { LeaveService } from './leave.service';

/**
 * Deciding leave from the HR screen (2026-10-20: leave is on the approval spine).
 *
 * Nobody decides their own leave (2026-10-16 access-control audit, H3); the chain decides who may
 * act and when the decision is final; the balance moves only on the final approval, once.
 */
describe('LeaveService.decide', () => {
  function build(
    applicantUserId: string | null,
    chain: { state?: string; inChain?: boolean } = {},
    leaveType = 'casual',
  ) {
    const application = {
      id: 'la-1',
      employeeId: 'emp-1',
      status: LeaveApplicationStatus.pending,
      leaveType,
      fromDate: new Date('2026-10-25'),
      dayCount: 1,
    };
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const upsert = jest.fn().mockResolvedValue({});
    const prisma = createPrismaMock({
      leaveApplication: {
        findFirst: jest.fn().mockResolvedValue(application),
        findFirstOrThrow: jest.fn().mockResolvedValue(application),
        updateMany,
      },
      leaveBalance: { upsert },
      employee: {
        findFirst: jest.fn().mockResolvedValue({
          userId: applicantUserId,
          companyId: 'co-1',
          firstName: 'Hemraj',
          lastName: 'Saini',
        }),
      },
    });
    const approvals = {
      stateOfSystem: jest
        .fn()
        .mockResolvedValue(
          chain.inChain === false ? null : { state: 'pending' },
        ),
      submit: jest.fn().mockResolvedValue({}),
      decideByEntity: jest
        .fn()
        .mockResolvedValue({ state: chain.state ?? 'approved' }),
    };
    const config = { get: () => ({ timezone: 'Asia/Kolkata' }) };
    const service = new LeaveService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { record: jest.fn() } as never,
      approvals as never,
      config as never,
    );
    return { service, approvals, updateMany, upsert };
  }

  const caller = {
    userId: 'user-1',
    companyId: 'co-1',
    ipAddress: '',
    rls: { isSuperAdmin: false, companyId: 'co-1' },
  } as never;
  const user = { id: 'user-1' } as never;

  it('refuses the applicant deciding their own application', async () => {
    const { service, approvals } = build('user-1');
    await expect(
      service.decide(caller, 'la-1', { decision: 'approved' } as never, user),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(approvals.decideByEntity).not.toHaveBeenCalled();
  });

  it('records the decision on the chain and debits the balance on final approval', async () => {
    const { service, approvals, updateMany, upsert } = build('user-2');
    await service.decide(
      caller,
      'la-1',
      { decision: 'approved' } as never,
      user,
    );
    expect(approvals.decideByEntity).toHaveBeenCalledWith(
      'leave_application',
      'la-1',
      expect.objectContaining({ action: 'approve' }),
      user,
      '',
    );
    expect(updateMany.mock.calls[0][0].data.status).toBe('approved');
    expect(upsert).toHaveBeenCalled();
  });

  it('leaves the application pending when the chain moves on to another level', async () => {
    const { service, updateMany } = build('user-2', { state: 'pending' });
    await service.decide(
      caller,
      'la-1',
      { decision: 'approved' } as never,
      user,
    );
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('does not debit the balance twice when the spine event arrives as well', async () => {
    const { service, updateMany, upsert } = build('user-2');
    updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    await service.decide(
      caller,
      'la-1',
      { decision: 'approved' } as never,
      user,
    );
    await service.onApprovalCompleted({
      entityType: 'leave_application',
      entityId: 'la-1',
      companyId: 'co-1',
      instanceId: 'i-1',
    });
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('puts an application filed before 2026-10-20 into its chain before deciding', async () => {
    const { service, approvals } = build('user-2', { inChain: false });
    await service.decide(
      caller,
      'la-1',
      { decision: 'rejected', remarks: 'x' } as never,
      user,
    );
    expect(approvals.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: 'leave_application',
        excludedUserIds: ['user-2', 'user-2'],
      }),
    );
  });
});
