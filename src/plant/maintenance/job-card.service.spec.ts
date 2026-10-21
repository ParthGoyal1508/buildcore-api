import { ConflictException } from '@nestjs/common';
import { JobCardStatus, Prisma } from '@prisma/client';

import {
  callerFor,
  createPrismaMock,
} from '../../settings/testing/prisma-mock';
import { JobCardService, changedFields } from './job-card.service';
import { JOB_CARD_ERRORS } from './job-card-workflow';

/**
 * Saving the card under the 039 workflow: site edits it only while it is a draft or sent back for
 * correction, and each save leaves a line in the card's history.
 */
describe('JobCardService.save (039)', () => {
  const caller = callerFor('co-1');

  const build = (job: Record<string, unknown>) => {
    const row = {
      id: 'job-1',
      companyId: 'co-1',
      equipmentId: 'eq-1',
      type: 'breakdown',
      description: 'Hose burst',
      openedAt: new Date('2026-10-20'),
      jobCardNo: 'JC-0001',
      card: { complaint: 'Hose burst', priority: 'Breakdown' },
      jobCardStatus: JobCardStatus.draft as JobCardStatus | null,
      jobCardReturnRemarks: null,
      quotationAmount: null,
      quotationFileRef: null,
      quotationFileName: null,
      finalBillAmount: null,
      finalBillFileRef: null,
      finalBillUploadedBy: null,
      partMovements: [],
      jobCardPayments: [],
      ...job,
    };
    const prisma = createPrismaMock({
      maintenanceJob: {
        findUnique: jest.fn().mockResolvedValue(row),
        findFirst: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      equipment: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'eq-1',
          companyId: 'co-1',
          name: 'JCB 3DX',
          code: 'EX-01',
          currentReading: new Prisma.Decimal(1200),
          meterType: 'hours',
          deployedSiteId: null,
          operatorName: 'Ramesh',
        }),
      },
      logbookEntry: { findFirst: jest.fn().mockResolvedValue(null) },
      jobCardEvent: { create: jest.fn().mockResolvedValue({}) },
    });
    const codeSeries = { next: jest.fn().mockResolvedValue('JC-0002') };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const cash = { isHidden: jest.fn().mockResolvedValue(false) };
    const service = new JobCardService(
      prisma as never,
      {} as never,
      codeSeries as never,
      audit as never,
      cash as never,
    );
    return { service, tx: prisma.tx };
  };

  it.each([
    JobCardStatus.pending_approval,
    JobCardStatus.approved,
    JobCardStatus.bill_uploaded,
    JobCardStatus.paid,
  ])('refuses to change a card that is %s', async (status) => {
    const { service, tx } = build({ jobCardStatus: status });
    const error = await service
      .save(caller, 'job-1', { complaint: 'Changed' }, 'ip')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(
      (error as ConflictException).getResponse() as { code: string },
    ).toEqual(expect.objectContaining({ code: JOB_CARD_ERRORS.notEditable }));
    expect(tx.maintenanceJob.updateMany).not.toHaveBeenCalled();
  });

  it('edits a returned card and records which fields changed', async () => {
    const { service, tx } = build({ jobCardStatus: JobCardStatus.returned });
    const view = await service.save(
      caller,
      'job-1',
      { complaint: 'Hose burst', priority: 'Urgent' },
      'ip',
    );
    expect(
      (tx.maintenanceJob.updateMany as jest.Mock).mock.calls[0][0].data
        .jobCardStatus,
    ).toBe(JobCardStatus.returned);
    expect(tx.jobCardEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: 'edited',
        detail: { fields: ['priority'] },
      }),
    });
    expect(view.workflow?.status).toBe(JobCardStatus.returned);
  });

  it('stores draft on the first write to a card saved before 039', async () => {
    const { service, tx } = build({ jobCardStatus: null });
    await service.save(caller, 'job-1', { complaint: 'Hose burst' }, 'ip');
    expect(
      (tx.maintenanceJob.updateMany as jest.Mock).mock.calls[0][0].data
        .jobCardStatus,
    ).toBe(JobCardStatus.draft);
  });

  it('numbers a new card, starts it as a draft and records its creation', async () => {
    const { service, tx } = build({
      jobCardNo: null,
      card: null,
      jobCardStatus: null,
    });
    await service.save(caller, 'job-1', { complaint: 'Hose burst' }, 'ip');
    expect(
      (tx.maintenanceJob.updateMany as jest.Mock).mock.calls[0][0],
    ).toEqual(
      expect.objectContaining({
        where: { id: 'job-1', jobCardStatus: null },
        data: expect.objectContaining({
          jobCardNo: 'JC-0002',
          jobCardStatus: JobCardStatus.draft,
        }),
      }),
    );
    expect(tx.jobCardEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: 'created' }),
    });
  });

  it('changedFields compares values, not key order', () => {
    expect(
      changedFields(
        { complaint: 'a', inspections: [{ fault: 'x' }] },
        { inspections: [{ fault: 'x' }], complaint: 'a', remarks: 'new' },
      ),
    ).toEqual(['remarks']);
  });
});
