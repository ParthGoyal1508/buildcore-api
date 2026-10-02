import { SlipDeliveryService } from './slip-delivery.service';

/**
 * Emailing payslips (021 FR-005 to FR-007, tasks T038 to T040) — `bugs.md` item 8.
 *
 * Three properties, and the second is the one that keeps somebody's job: failures are isolated, a
 * retry sends once, and two employees sharing a mailbox each get their own slip.
 */

interface EmployeeFixture {
  id: string;
  employeeCode: string;
  firstName: string;
  lastName: string;
  email: string | null;
}

function employee(over: Partial<EmployeeFixture> = {}): EmployeeFixture {
  return {
    id: 'e1',
    employeeCode: 'EMP001',
    firstName: 'Asha',
    lastName: 'Pawar',
    email: 'asha@example.com',
    ...over,
  };
}

function build(opts: {
  employees?: EmployeeFixture[];
  existing?: {
    employeeId: string;
    address: string;
    status: string;
    failureReason?: string | null;
  }[];
  /** Addresses the transport rejects. */
  rejectAddresses?: string[];
  outstandingApproval?: { state: string; levelLabel?: string } | null;
  noSlipFor?: string[];
}) {
  const employees = opts.employees ?? [employee()];
  const writes: Record<string, unknown>[] = [];
  const sent: { to: string; filename: string }[] = [];
  const queries: Record<string, unknown>[] = [];

  const dec = (value: number) => ({ toNumber: () => value });
  const slipFor = (employeeId: string) => ({
    employeeId,
    period: '2026-07',
    monthDays: 31,
    payableDays: dec(31),
    lopDays: dec(0),
    otHours: dec(0),
    earningBasic: dec(20000),
    earningHra: dec(8000),
    earningConveyance: dec(1600),
    earningSiteAllowance: dec(0),
    earningSpecialAllowance: dec(0),
    earningOt: dec(0),
    fullEarningBasic: dec(20000),
    fullEarningHra: dec(8000),
    fullEarningConveyance: dec(1600),
    fullEarningSiteAllowance: dec(0),
    fullEarningSpecialAllowance: dec(0),
    deductionPf: dec(2400),
    deductionEsic: dec(0),
    deductionPt: dec(200),
    deductionTds: dec(0),
    deductionLoanEmi: dec(0),
    deductionAdvanceRecovery: dec(0),
    deductionFuelRecovery: dec(0),
    employerPf: dec(0),
    employerEps: dec(0),
    employerEdli: dec(0),
    employerAdminCharges: dec(0),
    employerGratuity: dec(0),
    employerBonus: dec(0),
    netPay: dec(27000),
    minimumWagesNote: null,
  });

  const tx = {
    $executeRaw: async () => 0,
    payrollRun: {
      findFirst: async () => ({
        id: 'run-1',
        companyId: 'co-1',
        period: '2026-07',
        lineItems: employees.map((e) => ({ employeeId: e.id })),
      }),
    },
    company: { findUnique: async () => ({ name: 'Tirupati Enterprises' }) },
    employee: { findMany: async () => employees },
    salarySlip: {
      findMany: async () =>
        employees
          .filter((e) => !(opts.noSlipFor ?? []).includes(e.id))
          .map((e) => slipFor(e.id)),
    },
    slipDelivery: {
      findMany: async (args: { where: Record<string, unknown> }) => {
        queries.push(args.where);
        const rows = opts.existing ?? [];
        const wanted = (args.where as { status?: string }).status;
        return rows
          .filter((r) => (wanted ? r.status === wanted : true))
          .map((r) => ({
            ...r,
            failureReason: r.failureReason ?? null,
            sentAt: null,
          }));
      },
      upsert: async (args: Record<string, unknown>) => {
        writes.push(args);
        return args;
      },
    },
  };
  const prisma = {
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };

  const email = {
    sendPayslipEmail: async (input: { to: string; filename: string }) => {
      if ((opts.rejectAddresses ?? []).includes(input.to)) {
        throw new Error('mailbox unavailable');
      }
      sent.push({ to: input.to, filename: input.filename });
    },
  };
  const pdf = { render: async () => Buffer.from('%PDF-1.4 fake') };
  const schedule = {
    outstandingApproval: async () => opts.outstandingApproval ?? null,
  };

  return {
    service: new SlipDeliveryService(
      prisma as never,
      email as never,
      pdf as never,
      schedule as never,
    ),
    writes,
    sent,
    queries,
  };
}

const ctx = { isSuperAdmin: true } as never;

/** The status an upsert wrote, for an employee. */
function statusFor(
  writes: Record<string, unknown>[],
  employeeId: string,
): string | undefined {
  const write = writes.find(
    (w) =>
      (w.where as { payrollRunId_employeeId: { employeeId: string } })
        .payrollRunId_employeeId.employeeId === employeeId,
  );
  return (write?.create as { status?: string } | undefined)?.status;
}

describe('SlipDeliveryService', () => {
  it('sends one slip per employee in the run', async () => {
    const { service, sent } = build({
      employees: [
        employee(),
        employee({
          id: 'e2',
          employeeCode: 'EMP002',
          email: 'ravi@example.com',
        }),
      ],
    });

    await service.send(ctx, 'run-1');

    expect(sent.map((s) => s.to)).toEqual([
      'asha@example.com',
      'ravi@example.com',
    ]);
  });

  it('one failing address does not stop the other sends (T038)', async () => {
    // NFR-003's "failures isolated" is not a performance target. It is the difference between one
    // employee chasing their payslip and a run that stopped halfway with no record of where.
    const { service, sent, writes } = build({
      employees: [
        employee({ id: 'e1', email: 'bad@example.com' }),
        employee({
          id: 'e2',
          employeeCode: 'EMP002',
          email: 'ravi@example.com',
        }),
        employee({
          id: 'e3',
          employeeCode: 'EMP003',
          email: 'meera@example.com',
        }),
      ],
      rejectAddresses: ['bad@example.com'],
    });

    await service.send(ctx, 'run-1');

    expect(sent).toHaveLength(2);
    expect(statusFor(writes, 'e1')).toBe('failed');
    expect(statusFor(writes, 'e2')).toBe('sent');
    expect(statusFor(writes, 'e3')).toBe('sent');
  });

  it('records the provider’s own reason on a failure', async () => {
    // Stored so the retry decision can be made from the screen rather than from a log nobody
    // reading the screen has access to.
    const { service, writes } = build({
      employees: [employee({ email: 'bad@example.com' })],
      rejectAddresses: ['bad@example.com'],
    });

    await service.send(ctx, 'run-1');

    expect(
      (writes[0].create as { failureReason: string }).failureReason,
    ).toContain('mailbox unavailable');
  });

  it('marks an employee with no address undeliverable, not failed', async () => {
    // A retry would fail identically every time. These need somebody to find an address first, which
    // is why a sweep of "failures" must not pick them up forever.
    const { service, writes } = build({
      employees: [employee({ email: null })],
    });

    await service.send(ctx, 'run-1');

    expect(statusFor(writes, 'e1')).toBe('undeliverable');
  });

  it('marks an employee with no slip undeliverable, naming why', async () => {
    const { service, writes } = build({ noSlipFor: ['e1'] });

    await service.send(ctx, 'run-1');

    expect(statusFor(writes, 'e1')).toBe('undeliverable');
    expect(
      (writes[0].create as { failureReason: string }).failureReason,
    ).toMatch(/no salary slip/i);
  });

  it('stores the address as sent', async () => {
    // T032. An employee whose email is corrected after a failure must not have the old failure read
    // as though it went to the new address — which is exactly what a join at read time would show.
    const { service, writes } = build({});

    await service.send(ctx, 'run-1');

    expect((writes[0].create as { address: string }).address).toBe(
      'asha@example.com',
    );
  });

  describe('a second send does not re-send (T039)', () => {
    it('skips an employee already sent to', async () => {
      // Somebody will press this twice, because the first press takes minutes for 500 people.
      const { service, sent } = build({
        existing: [
          { employeeId: 'e1', address: 'asha@example.com', status: 'sent' },
        ],
      });

      await service.send(ctx, 'run-1');

      expect(sent).toEqual([]);
    });

    it('retries only the failures, never the successes or the undeliverables', async () => {
      // Asserted on the **query**, because that is what makes it true. A filter applied after
      // fetching everybody would be one edit away from "send all" — and the difference is 12 emails
      // or 500.
      const { service, queries } = build({
        existing: [
          { employeeId: 'e1', address: 'asha@example.com', status: 'failed' },
        ],
      });

      await service.retry(ctx, 'run-1');

      expect(queries.some((q) => q.status === 'failed')).toBe(true);
      expect(queries.some((q) => q.status === 'sent')).toBe(false);
    });

    it('retries nothing when nothing failed', async () => {
      const { service, sent } = build({
        existing: [
          { employeeId: 'e1', address: 'asha@example.com', status: 'sent' },
        ],
      });

      await service.retry(ctx, 'run-1');

      expect(sent).toEqual([]);
    });
  });

  it('gives two employees sharing one mailbox their own slip each (T040)', async () => {
    // The spec's edge case. Keyed on the employee, not the address — which is why this works, and
    // this test is what stops somebody "de-duplicating" it later.
    const { service, sent, writes } = build({
      employees: [
        employee({
          id: 'e1',
          employeeCode: 'EMP001',
          email: 'site@example.com',
        }),
        employee({
          id: 'e2',
          employeeCode: 'EMP002',
          email: 'site@example.com',
        }),
      ],
    });

    await service.send(ctx, 'run-1');

    expect(sent).toHaveLength(2);
    expect(sent.map((s) => s.filename)).toEqual([
      'payslip-2026-07-EMP001.pdf',
      'payslip-2026-07-EMP002.pdf',
    ]);
    expect(writes).toHaveLength(2);
  });

  describe('an unapproved run refuses delivery (FR-007)', () => {
    it('refuses while the chain is pending, naming the level', async () => {
      // The same gate the bank sheet applies, through the same service, so the two cannot disagree
      // about whether a run is approved.
      const { service, sent } = build({
        outstandingApproval: { state: 'pending', levelLabel: 'Director' },
      });

      await expect(service.send(ctx, 'run-1')).rejects.toThrow(/Director/);
      expect(sent).toEqual([]);
    });

    it('refuses a rejected run', async () => {
      const { service } = build({
        outstandingApproval: { state: 'rejected' },
      });

      await expect(service.send(ctx, 'run-1')).rejects.toThrow(/rejected/);
    });

    it('refuses a retry on an unapproved run too', async () => {
      // Otherwise the retry is a way around the gate — and a retry is the control somebody presses
      // when the send did not appear to work.
      const { service } = build({
        outstandingApproval: { state: 'pending' },
      });

      await expect(service.retry(ctx, 'run-1')).rejects.toThrow();
    });
  });

  it('reports sent, failed, undeliverable and not-attempted separately', async () => {
    // "Nobody has tried yet" is a different thing to say from "it failed", and a screen that
    // conflates them sends somebody retrying what was never attempted.
    const { service } = build({
      employees: [
        employee(),
        employee({ id: 'e2', employeeCode: 'EMP002' }),
        employee({ id: 'e3', employeeCode: 'EMP003' }),
      ],
      existing: [
        { employeeId: 'e1', address: 'asha@example.com', status: 'sent' },
        { employeeId: 'e2', address: 'x@example.com', status: 'failed' },
      ],
    });

    const report = await service.report(ctx, 'run-1');

    expect(report).toMatchObject({
      sent: 1,
      failed: 1,
      undeliverable: 0,
      notAttempted: 1,
    });
  });
});
