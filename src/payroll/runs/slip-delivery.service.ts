import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, SlipDeliveryStatus } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import type { RlsContext } from '../../common/prisma/rls-context';
import { withRlsContext } from '../../common/prisma/rls-context';
import { EmailService } from '../../shared/email/email.service';
import { SalaryPdfService, periodLabel } from '../salary/salary-pdf.service';
import { slipViewFrom } from '../salary/salary.service';
import { PayrollScheduleService } from './payroll-schedule.service';

/** One row of the delivery report (FR-006). */
export interface SlipDeliveryView {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  /** The address **as sent**, never re-joined — see the model's comment. */
  address: string;
  status: SlipDeliveryStatus;
  failureReason: string | null;
  sentAt: Date | null;
}

export interface SlipDeliverySummary {
  runId: string;
  period: string;
  sent: number;
  failed: number;
  undeliverable: number;
  /** Employees in the run with no delivery row at all — never attempted. */
  notAttempted: number;
  rows: SlipDeliveryView[];
}

/**
 * Emailing employees their payslips (021 FR-005 to FR-007) — `bugs.md` item 8.
 *
 * ## An explicit action, not an automatic one
 *
 * FR-005 reads as automatic delivery when a run is marked paid, and the client asked us to check
 * that. Unanswered, so this is built as the **explicit send** (T042's instruction): an explicit send
 * can be automated later behind the same method, whereas an automatic send that was wrong has
 * already emailed five hundred people their salary.
 *
 * ## Failures are isolated, by construction
 *
 * One employee at a time, each in its own try/catch, each writing its own row. A rejection records
 * `failed` with its reason and the loop continues — NFR-003's "500 employees, failures isolated"
 * is not a performance target here, it is the difference between one unpaid-looking employee and a
 * run that stopped halfway with no record of where.
 *
 * ## Why the retry cannot double-send
 *
 * `@@unique([payrollRunId, employeeId])` makes every write an upsert per employee. `retry` selects
 * `status: failed` and nothing else, so a successful row is not merely skipped — it is not in the
 * query. Both halves matter: a filter alone would be one edit away from sending everything.
 */
@Injectable()
export class SlipDeliveryService {
  private readonly logger = new Logger(SlipDeliveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly pdf: SalaryPdfService,
    private readonly schedule: PayrollScheduleService,
  ) {}

  /**
   * Sends to every employee in the run who has not already been sent to (FR-005).
   *
   * Refuses a run whose approval chain is incomplete (FR-007), with a code naming the reason —
   * the same gate the bank sheet applies, and for the same reason: this is the point where a figure
   * leaves the company, in this case into an inbox the company cannot recall it from.
   */
  async send(ctx: RlsContext, runId: string): Promise<SlipDeliverySummary> {
    const run = await this.requireApprovedRun(ctx, runId);
    const targets = await this.targetsFor(ctx, run, { onlyFailures: false });
    await this.deliver(ctx, run, targets);
    return this.report(ctx, runId);
  }

  /**
   * Resends **only** the failures (FR-006).
   *
   * Never the undeliverable ones: those have no address, so a retry would fail identically every
   * time it ran. They need somebody to find an address first, which is why the model keeps them as a
   * separate status rather than as a kind of failure.
   */
  async retry(ctx: RlsContext, runId: string): Promise<SlipDeliverySummary> {
    const run = await this.requireApprovedRun(ctx, runId);
    const targets = await this.targetsFor(ctx, run, { onlyFailures: true });
    await this.deliver(ctx, run, targets);
    return this.report(ctx, runId);
  }

  /** Delivered, failed and undeliverable, for the screen (FR-006). */
  async report(ctx: RlsContext, runId: string): Promise<SlipDeliverySummary> {
    const run = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.payrollRun.findFirst({
        where: { id: runId },
        include: { lineItems: { select: { employeeId: true } } },
      }),
    );
    if (!run) throw new NotFoundException('Payroll run not found');

    const [deliveries, employees] = await Promise.all([
      withRlsContext(this.prisma, ctx, (tx) =>
        tx.slipDelivery.findMany({ where: { payrollRunId: runId } }),
      ),
      withRlsContext(this.prisma, ctx, (tx) =>
        tx.employee.findMany({
          where: { id: { in: run.lineItems.map((l) => l.employeeId) } },
          select: {
            id: true,
            employeeCode: true,
            firstName: true,
            lastName: true,
          },
        }),
      ),
    ]);
    const byId = new Map(employees.map((e) => [e.id, e]));

    const rows: SlipDeliveryView[] = deliveries.map((d) => {
      const employee = byId.get(d.employeeId);
      return {
        employeeId: d.employeeId,
        employeeCode: employee?.employeeCode ?? d.employeeId,
        employeeName: nameOf(employee),
        address: d.address,
        status: d.status,
        failureReason: d.failureReason,
        sentAt: d.sentAt,
      };
    });

    const count = (status: SlipDeliveryStatus) =>
      rows.filter((r) => r.status === status).length;

    return {
      runId,
      period: run.period,
      sent: count(SlipDeliveryStatus.sent),
      failed: count(SlipDeliveryStatus.failed),
      undeliverable: count(SlipDeliveryStatus.undeliverable),
      // Reported rather than inferred from the difference: a run whose line items changed after a
      // send would otherwise show a negative or a nonsense figure, and "nobody has tried yet" is a
      // different thing to say from "it failed".
      notAttempted: run.lineItems.length - rows.length,
      rows,
    };
  }

  /**
   * The run, or a refusal naming why it cannot send yet (FR-007).
   *
   * Shares `PayrollScheduleService.outstandingApproval` with the bank sheet, so the two cannot
   * disagree about whether a run is approved. A second implementation of "is this approved" is how
   * one of them ends up more permissive than the other.
   */
  private async requireApprovedRun(ctx: RlsContext, runId: string) {
    const run = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.payrollRun.findFirst({
        where: { id: runId },
        include: { lineItems: true },
      }),
    );
    if (!run) throw new NotFoundException('Payroll run not found');

    const outstanding = await this.schedule.outstandingApproval(
      run.companyId,
      run.id,
    );
    if (outstanding) {
      throw new ConflictException({
        statusCode: 409,
        code: 'PAYROLL_RUN_NOT_APPROVED',
        message:
          outstanding.state === 'pending'
            ? `This payroll run is awaiting ${
                outstanding.levelLabel ?? 'approval'
              }. Salary slips cannot be emailed until every level has approved.`
            : `This payroll run was ${outstanding.state} and cannot have its slips emailed.`,
      });
    }
    return run;
  }

  /**
   * Who to send to on this pass.
   *
   * On a retry this is `status: failed` **as a query**, not as a filter applied to everybody. The
   * difference is the one that matters: a query that returns only failures cannot be turned into
   * "send everything" by an edit somewhere else in the method.
   */
  private async targetsFor(
    ctx: RlsContext,
    run: { id: string; lineItems: { employeeId: string }[] },
    options: { onlyFailures: boolean },
  ): Promise<string[]> {
    if (options.onlyFailures) {
      const failed = await withRlsContext(this.prisma, ctx, (tx) =>
        tx.slipDelivery.findMany({
          where: {
            payrollRunId: run.id,
            status: SlipDeliveryStatus.failed,
          },
          select: { employeeId: true },
        }),
      );
      return failed.map((d) => d.employeeId);
    }

    const alreadySent = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.slipDelivery.findMany({
        where: { payrollRunId: run.id, status: SlipDeliveryStatus.sent },
        select: { employeeId: true },
      }),
    );
    const done = new Set(alreadySent.map((d) => d.employeeId));
    // A second `send` tops up rather than repeating. Somebody pressing it twice — which they will,
    // because the first press takes minutes for 500 people — must not send 500 second copies.
    return run.lineItems.map((l) => l.employeeId).filter((id) => !done.has(id));
  }

  /** One employee at a time, each independently. */
  private async deliver(
    ctx: RlsContext,
    run: { id: string; companyId: string; period: string },
    employeeIds: string[],
  ): Promise<void> {
    if (employeeIds.length === 0) return;

    const [company, employees, slips] = await Promise.all([
      withRlsContext(this.prisma, { isSuperAdmin: true }, (tx) =>
        tx.company.findUnique({
          where: { id: run.companyId },
          select: { name: true },
        }),
      ),
      withRlsContext(this.prisma, ctx, (tx) =>
        tx.employee.findMany({ where: { id: { in: employeeIds } } }),
      ),
      withRlsContext(this.prisma, ctx, (tx) =>
        tx.salarySlip.findMany({
          where: { employeeId: { in: employeeIds }, period: run.period },
        }),
      ),
    ]);
    const slipOf = new Map(slips.map((s) => [s.employeeId, s]));
    const label = periodLabel(run.period);
    const companyName = company?.name ?? '';

    for (const employee of employees) {
      const slip = slipOf.get(employee.id);
      const address = employee.email?.trim() ?? '';

      if (!address || !slip) {
        // Undeliverable rather than failed: a retry would fail identically every time, and these
        // need somebody to find an address — or a reason the run produced no slip for them.
        await this.record(ctx, run, employee.id, {
          address,
          status: SlipDeliveryStatus.undeliverable,
          failureReason: !address
            ? 'No email address on file'
            : 'No salary slip exists for this employee in this period',
        });
        continue;
      }

      try {
        // The same `SalarySlipView` the JSON endpoint and the download produce, through the one
        // mapper. Three code paths reading the same rows could still round differently, and a slip
        // that disagrees with the screen is a wage dispute.
        const view = slipViewFrom(slip, employee.employeeCode);
        const pdf = await this.pdf.render(view, nameOf(employee));
        await this.email.sendPayslipEmail({
          to: address,
          employeeName: nameOf(employee),
          periodLabel: label,
          companyName,
          pdf,
          filename: `payslip-${run.period}-${employee.employeeCode}.pdf`,
        });
        await this.record(ctx, run, employee.id, {
          address,
          status: SlipDeliveryStatus.sent,
          failureReason: null,
          sentAt: new Date(),
        });
      } catch (error) {
        // Caught per employee and **never rethrown**. One rejected address must not abandon the run
        // partway with no record of how far it got.
        const reason =
          error instanceof Error ? error.message : 'Delivery failed';
        this.logger.warn(
          `Payslip delivery failed for ${employee.employeeCode} on run ${run.id}: ${reason}`,
        );
        await this.record(ctx, run, employee.id, {
          address,
          status: SlipDeliveryStatus.failed,
          failureReason: reason,
        });
      }
    }
  }

  /** The upsert that makes a repeat run idempotent per employee. */
  private async record(
    ctx: RlsContext,
    run: { id: string; companyId: string },
    employeeId: string,
    data: {
      address: string;
      status: SlipDeliveryStatus;
      failureReason: string | null;
      sentAt?: Date;
    },
  ): Promise<void> {
    const payload = {
      address: data.address,
      status: data.status,
      failureReason: data.failureReason,
      sentAt: data.sentAt ?? null,
    } satisfies Prisma.SlipDeliveryUpdateInput;

    await withRlsContext(this.prisma, ctx, (tx) =>
      tx.slipDelivery.upsert({
        where: {
          payrollRunId_employeeId: { payrollRunId: run.id, employeeId },
        },
        create: {
          companyId: run.companyId,
          payrollRunId: run.id,
          employeeId,
          ...payload,
        },
        update: payload,
      }),
    );
  }
}

function nameOf(
  employee: { firstName: string | null; lastName: string | null } | undefined,
): string {
  if (!employee) return '';
  return [employee.firstName, employee.lastName]
    .filter(Boolean)
    .join(' ')
    .trim();
}
