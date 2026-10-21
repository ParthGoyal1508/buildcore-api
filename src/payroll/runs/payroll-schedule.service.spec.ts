import { PayrollRunStatus } from '@prisma/client';

import { createPrismaMock } from '../../settings/testing/prisma-mock';
import { ACTION_PAYROLL_RUN } from '../../approvals/default-chains';
import type { ApprovalInstanceView } from '../../approvals/approval.types';
import {
  PayrollScheduleService,
  periodOf,
  previousPeriodOf,
} from './payroll-schedule.service';

const TZ = 'Asia/Kolkata';

const view = (over: Partial<ApprovalInstanceView> = {}): ApprovalInstanceView =>
  ({
    instanceId: 'inst-1',
    companyId: 'co-1',
    actionType: ACTION_PAYROLL_RUN,
    entityType: ACTION_PAYROLL_RUN,
    entityId: 'run-1',
    subject: 'Payroll run 2026-08',
    href: null,
    state: 'pending',
    currentPosition: 1,
    totalLevels: 3,
    round: 1,
    returnCount: 0,
    originatorUserId: null,
    originatorName: 'The system',
    levelLabel: 'Site Incharge',
    awaitingRoleName: 'Site Incharge',
    awaitingUserName: null,
    awaitingHolderCount: 1,
    canActNow: false,
    inertReason: null,
    latestDecision: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as ApprovalInstanceView);

function harness(
  opts: {
    companies?: { id: string }[];
    existingRuns?: Record<string, { id: string; status: PayrollRunStatus }>;
    approval?: ApprovalInstanceView | null;
    generateThrowsFor?: string;
  } = {},
) {
  const existingRuns = opts.existingRuns ?? {};

  const prisma = createPrismaMock({
    payrollRun: {
      findFirst: jest.fn(
        async ({ where }: { where: { companyId: string; id?: string } }) =>
          where.id
            ? Object.values(existingRuns).find((r) => r.id === where.id) ?? null
            : existingRuns[where.companyId] ?? null,
      ),
      update: jest.fn(async () => ({})),
    },
  });

  const companies = {
    listActiveForOtherModules: jest.fn(
      async () => opts.companies ?? [{ id: 'co-1' }, { id: 'co-2' }],
    ),
  };

  const engine = {
    generate: jest.fn(async (_c: unknown, companyId: string) => {
      if (opts.generateThrowsFor === companyId) {
        throw new Error('No active employees to pay');
      }
      return { runId: `run-${companyId}`, period: '2026-08', lineCount: 3 };
    }),
  };

  const approvals = {
    submit: jest.fn(async () => view()),
    resubmit: jest.fn(async () => view()),
    abandon: jest.fn(async () => undefined),
    stateOfSystem: jest.fn(async () =>
      opts.approval === undefined ? null : opts.approval,
    ),
  };

  const configService = { get: () => ({ timezone: TZ }) };

  const service = new PayrollScheduleService(
    prisma as never,
    companies as never,
    engine as never,
    approvals as never,
    configService as never,
  );

  return { service, prisma, companies, engine, approvals };
}

describe('period arithmetic in the business timezone', () => {
  it('reads the 1st at 00:30 IST as the 1st, not the previous month', () => {
    // 2026-09-01T00:30 Asia/Kolkata is 2026-08-31T19:00Z. Subtracting a month from the
    // UTC date would yield July — and pay the wrong month's wages.
    const firstOfSeptIst = new Date('2026-08-31T19:00:00Z');
    expect(periodOf(firstOfSeptIst, TZ)).toBe('2026-09');
    expect(previousPeriodOf(firstOfSeptIst, TZ)).toBe('2026-08');
  });

  it('rolls the year back across January', () => {
    const firstOfJanIst = new Date('2026-12-31T19:00:00Z');
    expect(periodOf(firstOfJanIst, TZ)).toBe('2027-01');
    expect(previousPeriodOf(firstOfJanIst, TZ)).toBe('2026-12');
  });

  it('pads single-digit months', () => {
    expect(previousPeriodOf(new Date('2026-11-15T06:00:00Z'), TZ)).toBe(
      '2026-10',
    );
    expect(previousPeriodOf(new Date('2026-02-15T06:00:00Z'), TZ)).toBe(
      '2026-01',
    );
  });
});

describe('PayrollScheduleService.createRunsForPreviousPeriod (T031, T039)', () => {
  const onTheFirst = new Date('2026-08-31T19:00:00Z'); // 1 Sep 00:30 IST

  it('creates the previous period’s run for every active company and leaves it for HR to send (039)', async () => {
    const { service, engine, approvals, prisma } = harness();
    const result = await service.createRunsForPreviousPeriod(onTheFirst);

    expect(result.period).toBe('2026-08');
    expect(result.created).toEqual(['co-1', 'co-2']);
    expect(engine.generate).toHaveBeenCalledTimes(2);
    expect(engine.generate).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'co-1', userId: null, roleIds: [] }),
      'co-1',
      '2026-08',
    );

    // Flagged as scheduled, so an operator can tell automation from handwork — which
    // matters because the instance may be suspended when the cron is due.
    expect(prisma.tx.payrollRun.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { createdBySchedule: true } }),
    );

    // 039: HR reviews, corrects and sends the run. A run the schedule pushed into the Director's
    // queue could not be corrected, and — with no originator — never resubmitted after a return.
    expect(approvals.submit).not.toHaveBeenCalled();
  });

  it('creates no duplicate when the period already has a run', async () => {
    const { service, engine } = harness({
      existingRuns: {
        'co-1': { id: 'run-1', status: PayrollRunStatus.draft },
        'co-2': { id: 'run-2', status: PayrollRunStatus.draft },
      },
    });

    const result = await service.createRunsForPreviousPeriod(onTheFirst);

    expect(result.created).toEqual([]);
    expect(result.alreadyPresent).toEqual(['co-1', 'co-2']);
    expect(engine.generate).not.toHaveBeenCalled();
  });

  it('does not submit a manually created run either (039)', async () => {
    const { service, approvals } = harness({
      existingRuns: { 'co-1': { id: 'run-1', status: PayrollRunStatus.draft } },
      companies: [{ id: 'co-1' }],
    });

    await service.createRunsForPreviousPeriod(onTheFirst);
    expect(approvals.submit).not.toHaveBeenCalled();
  });

  it('does not resubmit a run already travelling its chain', async () => {
    const { service, approvals } = harness({
      existingRuns: { 'co-1': { id: 'run-1', status: PayrollRunStatus.draft } },
      companies: [{ id: 'co-1' }],
      approval: view({ state: 'pending' }),
    });

    await service.createRunsForPreviousPeriod(onTheFirst);
    expect(approvals.submit).not.toHaveBeenCalled();
  });

  // 2026-10-16: the sweep repeats over the first week, so it must never reopen a finished chain.
  it.each(['approved', 'rejected', 'abandoned'] as const)(
    'does not resubmit a run whose chain is already %s',
    async (state) => {
      const { service, approvals } = harness({
        existingRuns: {
          'co-1': { id: 'run-1', status: PayrollRunStatus.draft },
        },
        companies: [{ id: 'co-1' }],
        approval: view({ state }),
      });

      await service.createRunsForPreviousPeriod(onTheFirst);
      expect(approvals.submit).not.toHaveBeenCalled();
    },
  );

  it('is idempotent across a repeated fire', async () => {
    // The real guarantee is the partial unique index; this proves the service does not
    // fight it, and that a second sweep reports rather than duplicates.
    const runs: Record<string, { id: string; status: PayrollRunStatus }> = {};
    const { service, engine, prisma } = harness({ existingRuns: runs });

    // First sweep: nothing exists.
    const first = await service.createRunsForPreviousPeriod(onTheFirst);
    expect(first.created).toHaveLength(2);

    // Now the runs exist; sweep again.
    runs['co-1'] = { id: 'run-co-1', status: PayrollRunStatus.draft };
    runs['co-2'] = { id: 'run-co-2', status: PayrollRunStatus.draft };
    const second = await service.createRunsForPreviousPeriod(onTheFirst);

    expect(second.created).toHaveLength(0);
    expect(second.alreadyPresent).toHaveLength(2);
    expect(engine.generate).toHaveBeenCalledTimes(2); // not four
    void prisma;
  });

  it('reports one company’s failure and carries on with the rest', async () => {
    // A sweep that abandoned every other company because the first had a configuration
    // problem would turn a small fault into an outage.
    const { service } = harness({ generateThrowsFor: 'co-1' });
    const result = await service.createRunsForPreviousPeriod(onTheFirst);

    expect(result.failed).toEqual([
      { companyId: 'co-1', reason: 'No active employees to pay' },
    ]);
    expect(result.created).toEqual(['co-2']);
  });
});

describe('PayrollScheduleService.isPeriodUnderReview (T036)', () => {
  const august = new Date('2026-08-15T06:00:00Z');

  it('is true while the run is still travelling its chain', async () => {
    const { service } = harness({
      existingRuns: { 'co-1': { id: 'run-1', status: PayrollRunStatus.draft } },
      approval: view({ state: 'pending' }),
    });
    await expect(service.isPeriodUnderReview('co-1', august)).resolves.toBe(
      true,
    );
  });

  it('is true for a returned run — it is still in motion', async () => {
    const { service } = harness({
      existingRuns: { 'co-1': { id: 'run-1', status: PayrollRunStatus.draft } },
      approval: view({ state: 'returned' }),
    });
    await expect(service.isPeriodUnderReview('co-1', august)).resolves.toBe(
      true,
    );
  });

  it('is false once the chain is approved', async () => {
    const { service } = harness({
      existingRuns: { 'co-1': { id: 'run-1', status: PayrollRunStatus.draft } },
      approval: view({ state: 'approved' }),
    });
    await expect(service.isPeriodUnderReview('co-1', august)).resolves.toBe(
      false,
    );
  });

  it('is false when there is no run for the period', async () => {
    const { service } = harness({ approval: view({ state: 'pending' }) });
    await expect(service.isPeriodUnderReview('co-1', august)).resolves.toBe(
      false,
    );
  });

  it('is false when the run never entered a chain', async () => {
    // A configuration gap is not a licence to edit, but refusing every attendance edit
    // on account of it would be worse — and the bank sheet is held either way.
    const { service } = harness({
      existingRuns: { 'co-1': { id: 'run-1', status: PayrollRunStatus.draft } },
      approval: null,
    });
    await expect(service.isPeriodUnderReview('co-1', august)).resolves.toBe(
      false,
    );
  });

  it('is false for a paid run', async () => {
    const { service } = harness({
      existingRuns: { 'co-1': { id: 'run-1', status: PayrollRunStatus.paid } },
      approval: view({ state: 'pending' }),
    });
    await expect(service.isPeriodUnderReview('co-1', august)).resolves.toBe(
      false,
    );
  });
});

describe('PayrollScheduleService — invalidation on attendance change (T038)', () => {
  it('abandons the live chain and hands the run back to HR (039)', async () => {
    const { service, approvals } = harness({
      existingRuns: { 'co-1': { id: 'run-1', status: PayrollRunStatus.draft } },
      approval: null,
    });

    await service.onAttendanceChangedUnderReview({
      companyId: 'co-1',
      period: '2026-08',
      employeeId: 'emp-1',
      actorUserId: 'hr-1',
    });

    expect(approvals.abandon).toHaveBeenCalledWith(
      ACTION_PAYROLL_RUN,
      'run-1',
      'co-1',
      expect.stringContaining('edited after approval began'),
    );
    // 039: not resubmitted. The lines do not change with attendance — only a regeneration does —
    // so restarting the chain put the same stale figures back in front of the Director.
    expect(approvals.submit).not.toHaveBeenCalled();
  });

  it('leaves a paid run alone', async () => {
    const { service, approvals } = harness({
      existingRuns: { 'co-1': { id: 'run-1', status: PayrollRunStatus.paid } },
    });

    await service.onAttendanceChangedUnderReview({
      companyId: 'co-1',
      period: '2026-08',
      employeeId: 'emp-1',
      actorUserId: 'hr-1',
    });
    expect(approvals.abandon).not.toHaveBeenCalled();
  });

  it('does not rethrow when the restart fails', async () => {
    // The attendance edit is already committed and was legitimate; an exception escaping
    // this handler aborts nothing and reports nowhere.
    const { service, approvals } = harness({
      existingRuns: { 'co-1': { id: 'run-1', status: PayrollRunStatus.draft } },
    });
    approvals.abandon = jest.fn(async () => {
      throw new Error('connection reset');
    });

    await expect(
      service.onAttendanceChangedUnderReview({
        companyId: 'co-1',
        period: '2026-08',
        employeeId: 'emp-1',
        actorUserId: 'hr-1',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('PayrollScheduleService.sendToDirector (039)', () => {
  const hr = { id: 'hr-1' } as never;
  const draft = { 'co-1': { id: 'run-1', status: PayrollRunStatus.draft } };

  it('submits a never-sent draft with the sender as originator', async () => {
    const { service, approvals } = harness({ existingRuns: draft });
    await service.sendToDirector('co-1', 'run-1', hr);
    expect(approvals.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: ACTION_PAYROLL_RUN,
        entityId: 'run-1',
        // Recorded, so the spine's originator-only resubmit works after a return.
        originatorUserId: 'hr-1',
      }),
    );
  });

  it('resubmits a run its sender gets back, keeping the instance and its history', async () => {
    const { service, approvals } = harness({
      existingRuns: draft,
      approval: view({ state: 'returned', originatorUserId: 'hr-1' }),
    });
    await service.sendToDirector('co-1', 'run-1', hr);
    expect(approvals.resubmit).toHaveBeenCalledWith(
      ACTION_PAYROLL_RUN,
      'run-1',
      'co-1',
      'hr-1',
      hr,
    );
    expect(approvals.abandon).not.toHaveBeenCalled();
    expect(approvals.submit).not.toHaveBeenCalled();
  });

  it('abandons and submits afresh a returned run the schedule sent (null originator)', async () => {
    const { service, approvals } = harness({
      existingRuns: draft,
      approval: view({ state: 'returned', originatorUserId: null }),
    });
    await service.sendToDirector('co-1', 'run-1', hr);
    expect(approvals.resubmit).not.toHaveBeenCalled();
    expect(approvals.abandon).toHaveBeenCalledWith(
      ACTION_PAYROLL_RUN,
      'run-1',
      'co-1',
      expect.any(String),
    );
    expect(approvals.submit).toHaveBeenCalledWith(
      expect.objectContaining({ originatorUserId: 'hr-1' }),
    );
  });

  it.each([
    ['pending', 'PAYROLL_RUN_AWAITING_APPROVAL'],
    ['approved', 'PAYROLL_RUN_ALREADY_APPROVED'],
  ] as const)('refuses a run whose chain is %s', async (state, code) => {
    const { service, approvals } = harness({
      existingRuns: draft,
      approval: view({ state }),
    });
    const error = await service
      .sendToDirector('co-1', 'run-1', hr)
      .catch((e) => e);
    expect(error.getResponse()).toMatchObject({ code });
    expect(approvals.submit).not.toHaveBeenCalled();
  });

  it('refuses a paid run', async () => {
    const { service } = harness({
      existingRuns: { 'co-1': { id: 'run-1', status: PayrollRunStatus.paid } },
    });
    const error = await service
      .sendToDirector('co-1', 'run-1', hr)
      .catch((e) => e);
    expect(error.getResponse()).toMatchObject({
      code: 'PAYROLL_RUN_ALREADY_PAID',
    });
  });

  it('starts a fresh chain after a rejection', async () => {
    const { service, approvals } = harness({
      existingRuns: draft,
      approval: view({ state: 'rejected' }),
    });
    await service.sendToDirector('co-1', 'run-1', hr);
    expect(approvals.submit).toHaveBeenCalled();
  });
});
