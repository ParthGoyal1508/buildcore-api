import { InterviewOutcome, InterviewStatus, Permission } from '@prisma/client';

import { InterviewService } from './interview.service';

/**
 * Feedback on a panel (2026-10-14).
 *
 * An interview was marked completed by the first feedback submitted, and the screens offer
 * feedback only on a scheduled interview — so on a two-person panel the second interviewer could
 * never record theirs. It is completed when the last of the panel has.
 */
describe('InterviewService — feedback from a panel', () => {
  function build(panel: string[], alreadyGiven: number) {
    const updates: Record<string, unknown>[] = [];
    let given = alreadyGiven;
    const tx = {
      $executeRaw: async () => 0,
      interview: {
        findUnique: async () => ({
          id: 'iv-1',
          companyId: 'co-1',
          status: InterviewStatus.scheduled,
          interviewers: panel.map((employeeId) => ({ employeeId })),
        }),
        update: async (args: { data: Record<string, unknown> }) => {
          updates.push(args.data);
          return { companyId: 'co-1', status: args.data.status };
        },
      },
      interviewFeedback: {
        upsert: async () => {
          given += 1;
          return {};
        },
        count: async () => given,
      },
    };
    const prisma = {
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    };
    const audit = { record: async () => undefined };
    const service = new InterviewService(prisma as never, audit as never);
    return { service, updates };
  }

  const caller = {
    id: 'u-1',
    companyId: 'co-1',
    permissions: [Permission.CROSS_COMPANY_ACCESS],
  } as never;
  const feedback = {
    outcome: InterviewOutcome.recommend,
    score: 8,
    comments: 'Strong on detailing.',
  };

  it('keeps the interview open after the first of two interviewers', async () => {
    const { service } = build(['emp-a', 'emp-b'], 0);
    const result = await service.submitFeedback(
      caller,
      'iv-1',
      { ...feedback, interviewerEmployeeId: 'emp-a' },
      '127.0.0.1',
    );
    expect(result.status).toBe(InterviewStatus.scheduled);
  });

  it('completes it once the last interviewer has given theirs', async () => {
    const { service } = build(['emp-a', 'emp-b'], 1);
    const result = await service.submitFeedback(
      caller,
      'iv-1',
      { ...feedback, interviewerEmployeeId: 'emp-b' },
      '127.0.0.1',
    );
    expect(result.status).toBe(InterviewStatus.completed);
  });

  it('completes a one-person panel on its only feedback', async () => {
    const { service } = build(['emp-a'], 0);
    const result = await service.submitFeedback(
      caller,
      'iv-1',
      { ...feedback, interviewerEmployeeId: 'emp-a' },
      '127.0.0.1',
    );
    expect(result.status).toBe(InterviewStatus.completed);
  });
});
