import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { JobCardPaymentMode, JobCardStatus, Prisma } from '@prisma/client';

import { ACTION_JOB_CARD } from '../../approvals/default-chains';
import { cashHiddenError } from '../../common/cash/cash-policy';
import {
  callerFor,
  createPrismaMock,
} from '../../settings/testing/prisma-mock';
import { JobCardFlowService } from './job-card-flow.service';
import { JOB_CARD_ERRORS } from './job-card-workflow';

/**
 * The job card workflow (039): site raises it with a quotation, Head Office approves or sends it
 * back, site uploads the final bill, Head Office pays it. The properties pinned are the ones where
 * the card would lie about where it stands, or money would move wrongly — submitting without a
 * quotation, a decision lost or applied twice, a bill paid beyond its amount, hidden cash recorded.
 */
describe('JobCardFlowService', () => {
  const caller = callerFor('co-1');
  const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF\n').toString(
    'base64',
  );

  const jobRow = (over: Record<string, unknown> = {}) => ({
    id: 'job-1',
    companyId: 'co-1',
    jobCardNo: 'JC-0012',
    card: { complaint: 'Hose burst' },
    jobCardStatus: JobCardStatus.draft as JobCardStatus | null,
    jobCardApprovalItemId: null,
    jobCardReturnRemarks: null,
    quotationAmount: new Prisma.Decimal(45000) as Prisma.Decimal | null,
    quotationFileRef: 'job-cards/co-1/q1' as string | null,
    quotationFileName: 'quote.pdf',
    quotationContentType: 'application/pdf',
    finalBillAmount: null as Prisma.Decimal | null,
    finalBillFileRef: null as string | null,
    equipment: { code: 'EX-01', name: 'JCB 3DX' },
    jobCardPayments: [] as { id: string }[],
    ...over,
  });

  const build = (
    opts: {
      job?: Record<string, unknown>;
      updatedCount?: number;
      cashHidden?: boolean;
      /** Payments already on the bill, for the locked balance read. */
      paid?: number[];
      spineState?: Record<string, unknown> | null;
      events?: Record<string, unknown>[];
    } = {},
  ) => {
    const job = jobRow(opts.job);
    const prisma = createPrismaMock({
      maintenanceJob: {
        findUnique: jest.fn().mockResolvedValue(job),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          jobCardStatus: job.jobCardStatus,
          finalBillAmount: job.finalBillAmount,
          jobCardPayments: (opts.paid ?? []).map((amount) => ({
            amount: new Prisma.Decimal(amount),
          })),
        }),
        updateMany: jest
          .fn()
          .mockResolvedValue({ count: opts.updatedCount ?? 1 }),
        update: jest.fn().mockResolvedValue({}),
      },
      jobCardEvent: {
        create: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue(opts.events ?? []),
      },
      jobCardPayment: {
        create: jest.fn().mockResolvedValue({ id: 'pay-1' }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      user: { findMany: jest.fn().mockResolvedValue([]) },
    });
    const approvals = {
      submit: jest.fn().mockResolvedValue({ instanceId: 'inst-new' }),
      resubmit: jest.fn().mockResolvedValue({ instanceId: 'inst-1' }),
      abandon: jest.fn().mockResolvedValue(undefined),
      stateOfSystem: jest.fn().mockResolvedValue(opts.spineState ?? null),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const storage = {
      put: jest.fn().mockResolvedValue('job-cards/co-1/new'),
      get: jest.fn().mockResolvedValue(Buffer.from('x')),
      deleteMany: jest.fn().mockResolvedValue(undefined),
    };
    const cash = {
      isHidden: jest.fn().mockResolvedValue(opts.cashHidden ?? false),
      assertCashAllowed: jest.fn(async () => {
        if (opts.cashHidden) throw cashHiddenError();
      }),
    };
    const service = new JobCardFlowService(
      prisma as never,
      approvals as never,
      audit as never,
      storage as never,
      cash as never,
    );
    const tx = prisma.tx;
    const eventKinds = () =>
      (tx.jobCardEvent.create as jest.Mock).mock.calls.map(
        ([arg]) => (arg as { data: { kind: string } }).data.kind,
      );
    return { service, prisma, tx, approvals, audit, storage, eventKinds };
  };

  const codeOf = (error: unknown) =>
    (error as { getResponse(): { code: string } }).getResponse().code;

  describe('submit', () => {
    it('sends a draft to Head Office, linked to the card, and records it', async () => {
      const { service, tx, approvals, eventKinds } = build();

      const result = await service.submit(caller, 'job-1', '127.0.0.1');

      expect(approvals.submit).toHaveBeenCalledWith(
        expect.objectContaining({
          actionType: ACTION_JOB_CARD,
          entityId: 'job-1',
          originatorUserId: 'caller-1',
          viewPermission: 'MAINTENANCE',
          href: '/dashboard/plant/maintenance?jobCard=job-1',
          subject: expect.stringContaining('Job card JC-0012 · EX-01 JCB 3DX'),
        }),
      );
      expect(tx.maintenanceJob.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            jobCardStatus: JobCardStatus.pending_approval,
            jobCardApprovalItemId: 'inst-new',
          }),
        }),
      );
      expect(eventKinds()).toEqual(['submitted']);
      expect(result.status).toBe(JobCardStatus.pending_approval);
    });

    it('refuses without the quotation file or amount', async () => {
      for (const job of [
        { quotationFileRef: null },
        { quotationAmount: null },
      ]) {
        const { service, approvals } = build({ job });
        const error = await service
          .submit(caller, 'job-1', 'ip')
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(BadRequestException);
        expect(codeOf(error)).toBe(JOB_CARD_ERRORS.quotationRequired);
        expect(approvals.submit).not.toHaveBeenCalled();
      }
    });

    it('refuses a card already with Head Office', async () => {
      const { service } = build({
        job: { jobCardStatus: JobCardStatus.pending_approval },
      });
      const error = await service
        .submit(caller, 'job-1', 'ip')
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect(codeOf(error)).toBe(JOB_CARD_ERRORS.notSubmittable);
    });

    it('treats a pre-039 card with no status as a draft', async () => {
      const { service, approvals } = build({ job: { jobCardStatus: null } });
      await service.submit(caller, 'job-1', 'ip');
      expect(approvals.submit).toHaveBeenCalled();
    });

    it('resubmits through the spine when the originator resubmits', async () => {
      const { service, approvals, eventKinds } = build({
        job: { jobCardStatus: JobCardStatus.returned },
        spineState: {
          instanceId: 'inst-1',
          state: 'returned',
          originatorUserId: 'caller-1',
        },
      });
      await service.submit(caller, 'job-1', 'ip');
      expect(approvals.resubmit).toHaveBeenCalledWith(
        ACTION_JOB_CARD,
        'job-1',
        'co-1',
        'caller-1',
        caller,
      );
      expect(approvals.abandon).not.toHaveBeenCalled();
      expect(eventKinds()).toEqual(['resubmitted']);
    });

    it('raises a fresh item when another site user resubmits', async () => {
      const { service, approvals } = build({
        job: { jobCardStatus: JobCardStatus.returned },
        spineState: {
          instanceId: 'inst-1',
          state: 'returned',
          originatorUserId: 'someone-else',
        },
      });
      await service.submit(caller, 'job-1', 'ip');
      expect(approvals.resubmit).not.toHaveBeenCalled();
      expect(approvals.abandon).toHaveBeenCalled();
      expect(approvals.submit).toHaveBeenCalledWith(
        expect.objectContaining({ originatorUserId: 'caller-1' }),
      );
    });

    it('closes the raised item when the card was moved meanwhile', async () => {
      const { service, approvals } = build({ updatedCount: 0 });
      await expect(service.submit(caller, 'job-1', 'ip')).rejects.toThrow(
        ConflictException,
      );
      expect(approvals.abandon).toHaveBeenCalled();
    });
  });

  describe("Head Office's decision", () => {
    it('a return sends the card back with the remarks, once', async () => {
      const { service, tx, eventKinds } = build({
        job: { jobCardStatus: JobCardStatus.pending_approval },
      });
      await service.onApprovalReturned({
        entityType: ACTION_JOB_CARD,
        entityId: 'job-1',
        companyId: 'co-1',
        instanceId: 'inst-1',
        reason: 'Get a second quotation',
        actorUserId: 'ho-1',
      });
      expect(tx.maintenanceJob.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'job-1',
          companyId: 'co-1',
          jobCardStatus: JobCardStatus.pending_approval,
        },
        data: {
          jobCardStatus: JobCardStatus.returned,
          jobCardReturnRemarks: 'Get a second quotation',
        },
      });
      expect(eventKinds()).toEqual(['returned']);
      expect(
        (tx.jobCardEvent.create as jest.Mock).mock.calls[0][0].data,
      ).toEqual(
        expect.objectContaining({
          actorUserId: 'ho-1',
          remarks: 'Get a second quotation',
        }),
      );
    });

    it('a redelivered decision changes nothing', async () => {
      const { service, eventKinds } = build({ updatedCount: 0 });
      await service.onApprovalCompleted({
        entityType: ACTION_JOB_CARD,
        entityId: 'job-1',
        companyId: 'co-1',
        instanceId: 'inst-1',
      });
      expect(eventKinds()).toEqual([]);
    });

    it('approval marks the card approved, naming the approver', async () => {
      const { service, tx, eventKinds } = build({
        spineState: {
          latestDecision: { actorUserId: 'ho-1', reason: null },
        },
      });
      await service.onApprovalCompleted({
        entityType: ACTION_JOB_CARD,
        entityId: 'job-1',
        companyId: 'co-1',
        instanceId: 'inst-1',
      });
      expect(
        (tx.maintenanceJob.updateMany as jest.Mock).mock.calls[0][0].data
          .jobCardStatus,
      ).toBe(JobCardStatus.approved);
      expect(eventKinds()).toEqual(['approved']);
    });

    it('a rejection puts the card back to draft with the reason', async () => {
      const { service, tx } = build({
        spineState: {
          latestDecision: { actorUserId: 'ho-1', reason: 'Too costly' },
        },
      });
      await service.onApprovalRejected({
        entityType: ACTION_JOB_CARD,
        entityId: 'job-1',
        companyId: 'co-1',
        instanceId: 'inst-1',
      });
      expect(
        (tx.maintenanceJob.updateMany as jest.Mock).mock.calls[0][0].data,
      ).toEqual({
        jobCardStatus: JobCardStatus.draft,
        jobCardReturnRemarks: 'Too costly',
      });
    });

    it("ignores another module's items", async () => {
      const { service, tx } = build();
      await service.onApprovalReturned({
        entityType: 'payroll_run',
        entityId: 'run-1',
        companyId: 'co-1',
        instanceId: 'i',
        reason: 'x',
        actorUserId: 'u',
      });
      expect(tx.maintenanceJob.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('final bill', () => {
    const bill = {
      billNumber: 'SM/0412',
      billDate: '2026-10-21',
      amount: 42000,
      file: PDF,
      fileName: 'bill.pdf',
    };

    it('is refused before approval', async () => {
      const { service, storage } = build();
      const error = await service
        .uploadFinalBill(caller, 'job-1', bill, 'ip')
        .catch((e: unknown) => e);
      expect(codeOf(error)).toBe(JOB_CARD_ERRORS.notApproved);
      expect(storage.put).not.toHaveBeenCalled();
    });

    it('moves an approved card to bill_uploaded', async () => {
      const { service, eventKinds } = build({
        job: { jobCardStatus: JobCardStatus.approved },
      });
      const result = await service.uploadFinalBill(caller, 'job-1', bill, 'ip');
      expect(result.status).toBe(JobCardStatus.bill_uploaded);
      expect(eventKinds()).toEqual(['bill_uploaded']);
    });

    it('cannot be replaced once a payment is recorded', async () => {
      const { service } = build({
        job: {
          jobCardStatus: JobCardStatus.bill_uploaded,
          jobCardPayments: [{ id: 'pay-1' }],
        },
      });
      const error = await service
        .uploadFinalBill(caller, 'job-1', bill, 'ip')
        .catch((e: unknown) => e);
      expect(codeOf(error)).toBe(JOB_CARD_ERRORS.billLocked);
    });
  });

  describe('payment', () => {
    const billed = {
      jobCardStatus: JobCardStatus.bill_uploaded,
      finalBillAmount: new Prisma.Decimal(42000),
    };
    const payment = (
      amount: number,
      mode: JobCardPaymentMode = 'bank_transfer',
    ) => ({
      amount,
      paidOn: '2026-10-01',
      mode,
    });

    it('a part payment leaves the card billed, with the balance', async () => {
      const { service, eventKinds } = build({ job: billed, paid: [10000] });
      const result = await service.recordPayment(
        caller,
        'job-1',
        payment(12000),
        'ip',
      );
      expect(result).toEqual(
        expect.objectContaining({
          status: JobCardStatus.bill_uploaded,
          balance: 20000,
        }),
      );
      expect(eventKinds()).toEqual(['payment']);
    });

    it('the payment that reaches the bill marks it paid', async () => {
      const { service, tx, eventKinds } = build({ job: billed, paid: [30000] });
      const result = await service.recordPayment(
        caller,
        'job-1',
        payment(12000),
        'ip',
      );
      expect(result.status).toBe(JobCardStatus.paid);
      expect(tx.maintenanceJob.update).toHaveBeenCalledWith({
        where: { id: 'job-1' },
        data: { jobCardStatus: JobCardStatus.paid },
      });
      expect(eventKinds()).toEqual(['payment', 'paid']);
    });

    it('refuses more than the balance', async () => {
      const { service, tx } = build({ job: billed, paid: [30000] });
      const error = await service
        .recordPayment(caller, 'job-1', payment(12000.01), 'ip')
        .catch((e: unknown) => e);
      expect(codeOf(error)).toBe(JOB_CARD_ERRORS.overpayment);
      expect(tx.jobCardPayment.create).not.toHaveBeenCalled();
    });

    it('refuses before the bill is uploaded', async () => {
      const { service } = build({
        job: { jobCardStatus: JobCardStatus.approved },
      });
      const error = await service
        .recordPayment(caller, 'job-1', payment(100), 'ip')
        .catch((e: unknown) => e);
      expect(codeOf(error)).toBe(JOB_CARD_ERRORS.billNotUploaded);
    });

    it('refuses cash while the company hides cash (038)', async () => {
      const { service, tx } = build({ job: billed, cashHidden: true });
      const error = await service
        .recordPayment(caller, 'job-1', payment(100, 'cash'), 'ip')
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ForbiddenException);
      expect(codeOf(error)).toBe('CASH_HIDDEN');
      expect(tx.jobCardPayment.create).not.toHaveBeenCalled();
    });

    it('leaves cash out of the list and the total while hidden', async () => {
      const { service, tx } = build({ job: billed, cashHidden: true });
      await service.payments(caller, 'job-1');
      expect(tx.jobCardPayment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { maintenanceJobId: 'job-1', mode: { not: 'cash' } },
        }),
      );
    });
  });

  it('history leaves out a hidden cash payment', async () => {
    const at = new Date();
    const { service } = build({
      cashHidden: true,
      events: [
        {
          id: 'e1',
          kind: 'submitted',
          detail: null,
          actorUserId: null,
          createdAt: at,
        },
        {
          id: 'e2',
          kind: 'payment',
          detail: { mode: 'cash' },
          actorUserId: null,
          createdAt: at,
        },
        {
          id: 'e3',
          kind: 'payment',
          detail: { mode: 'upi' },
          actorUserId: null,
          createdAt: at,
        },
      ],
    });
    const history = await service.history(caller, 'job-1');
    expect(history.map((e) => e.id)).toEqual(['e1', 'e3']);
  });

  it('a quotation can be changed only while the card is site’s', async () => {
    const { service } = build({
      job: { jobCardStatus: JobCardStatus.approved },
    });
    const error = await service
      .saveQuotation(caller, 'job-1', { amount: 1, file: PDF }, 'ip')
      .catch((e: unknown) => e);
    expect(codeOf(error)).toBe(JOB_CARD_ERRORS.notEditable);
  });
});
