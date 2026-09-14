import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { PayrollRunStatus } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { ApprovalService } from '../../approvals/approvals.service';
import { ACTION_PAYROLL_RUN } from '../../approvals/default-chains';
import { isLive } from '../../approvals/approval.types';
import type { SettingsConfig } from '../../common/configs/config.interface';
import { withRlsContext } from '../../common/prisma/rls-context';
import {
  ATTENDANCE_CHANGED_UNDER_REVIEW_EVENT,
  AttendanceChangedUnderReviewEvent,
} from '../../hr/attendance/attendance-events';
import { CompaniesService } from '../../settings/companies/companies.service';
import type { Caller } from '../../hr/biometrics/face-enrolment.service';
import { PayrollEngineService } from '../engine/payroll-engine.service';

/** What one scheduled sweep did, so the cron can log something worth reading. */
export interface ScheduledRunResult {
  period: string;
  created: string[];
  alreadyPresent: string[];
  failed: { companyId: string; reason: string }[];
}

/**
 * Monthly payroll creation and the attendance lock that protects it
 * (016 FR-013, FR-014, FR-016, T031, T034, T036).
 *
 * Separate from `PayrollEngineService` because the engine answers "compute this period
 * for this company" and this answers "which periods and companies, and what happens
 * next" — and because the scheduler must be callable directly from a test without a
 * cron running in the background.
 */
@Injectable()
export class PayrollScheduleService {
  private readonly logger = new Logger(PayrollScheduleService.name);
  private readonly timeZone: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly companies: CompaniesService,
    private readonly engine: PayrollEngineService,
    private readonly approvals: ApprovalService,
    configService: ConfigService,
  ) {
    this.timeZone = configService.get<SettingsConfig>('settings').timezone;
  }

  /**
   * Creates the previous period's run for every active company and submits each into its
   * approval chain (FR-013, FR-014).
   *
   * **Idempotency comes from the database, not from this method being careful.** The
   * partial unique index `PayrollRun_companyId_period_regular_key` already guarantees one
   * regular run per (company, period); a cron that fires twice, an instance that restarts
   * mid-sweep, and an operator triggering it manually while the schedule runs all end at
   * the same constraint. Being careful here would have to be correct in every one of those
   * paths; a constraint is correct in all of them at once.
   *
   * One company's failure does not stop the others. A sweep that abandoned twelve
   * companies because the first had a configuration problem would turn a small fault into
   * an outage, and the result below reports exactly what happened.
   */
  async createRunsForPreviousPeriod(
    now = new Date(),
  ): Promise<ScheduledRunResult> {
    const period = previousPeriodOf(now, this.timeZone);
    const result: ScheduledRunResult = {
      period,
      created: [],
      alreadyPresent: [],
      failed: [],
    };

    const companies = await this.companies.listActiveForOtherModules();

    for (const company of companies) {
      // A system actor: no user generated this run, and `AuditLogEntry.accountId` is a
      // foreign key, so recording a fabricated account is not an option.
      const caller: Caller = {
        userId: null,
        companyId: company.id,
        ipAddress: 'system/payroll-schedule',
        rls: { isSuperAdmin: false, companyId: company.id },
        // A system actor holds no role, so it cannot pass a role check by accident.
        roleIds: [],
      };

      try {
        const existing = await this.findRegularRun(company.id, period);
        if (existing) {
          result.alreadyPresent.push(company.id);
          // Still ensure it is in a chain: a run created manually before the schedule
          // fired must not skip approval simply because it got there first.
          await this.submitForApproval(company.id, existing.id, period);
          continue;
        }

        const generated = await this.engine.generate(
          caller,
          company.id,
          period,
        );

        await withRlsContext(this.prisma, caller.rls, (tx) =>
          tx.payrollRun.update({
            where: { id: generated.runId },
            data: { createdBySchedule: true },
          }),
        );

        await this.submitForApproval(company.id, generated.runId, period);
        result.created.push(company.id);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        result.failed.push({ companyId: company.id, reason });
        this.logger.error(
          `Scheduled payroll for ${period} failed for company ${company.id}: ${reason}`,
        );
      }
    }

    return result;
  }

  /**
   * Whether `date` falls in a period whose payroll run is still travelling its chain
   * (FR-016, T036).
   *
   * **Exported for `hr`, which must not read `payroll` tables** (research.md §5,
   * Principle I). A synchronous call rather than an event because the attendance write
   * path needs an answer before it proceeds — events are for fan-out that needs none.
   */
  async isPeriodUnderReview(companyId: string, date: Date): Promise<boolean> {
    const period = periodOf(date, this.timeZone);
    const run = await this.findRegularRun(companyId, period);
    if (!run) return false;

    // A paid run is finished, not under review; editing attendance for it is a different
    // problem (and one the payroll lock day already governs).
    if (run.status === PayrollRunStatus.paid) return false;

    const approval = await this.approvals.stateOfSystem(
      ACTION_PAYROLL_RUN,
      run.id,
      companyId,
    );
    // No chain at all means nothing is reviewing it, so the lock does not apply. A run
    // that never entered a chain is a configuration gap, not a licence to edit — but
    // refusing every attendance edit on account of it would be worse.
    return approval !== null && isLive(approval.state);
  }

  /** The outstanding level on a run's chain, or null when it is clear to proceed. */
  async outstandingApproval(
    companyId: string,
    runId: string,
  ): Promise<{ levelLabel: string | null; state: string } | null> {
    const approval = await this.approvals.stateOfSystem(
      ACTION_PAYROLL_RUN,
      runId,
      companyId,
    );
    if (!approval) return null;
    if (approval.state === 'approved') return null;
    return { levelLabel: approval.levelLabel, state: approval.state };
  }

  /**
   * Restarts a run's chain because its attendance changed underneath it (FR-017).
   *
   * Every approval already given is void: the figures the approvers agreed to are no
   * longer the figures. Abandoning and resubmitting is what makes that true in the record
   * rather than merely in principle.
   */
  async invalidateApprovals(
    companyId: string,
    runId: string,
    reason: string,
  ): Promise<void> {
    await this.approvals.abandon(ACTION_PAYROLL_RUN, runId, companyId, reason);
    await this.submitForApproval(companyId, runId);
  }

  /**
   * Restarts a run's chain when attendance underneath it changed (FR-017, T038).
   *
   * The listener half of the pairing described in `attendance-events.ts`: `hr` announces
   * that it changed something in a reviewed period and needs no answer, so this reacts.
   *
   * Failures are logged, not rethrown. An exception escaping an event handler aborts
   * nothing — the attendance edit is already committed and was legitimate — and the
   * resulting drift is what Phase 6's reconciliation sweep is for.
   */
  @OnEvent(ATTENDANCE_CHANGED_UNDER_REVIEW_EVENT)
  async onAttendanceChangedUnderReview(
    event: AttendanceChangedUnderReviewEvent,
  ): Promise<void> {
    try {
      const run = await this.findRegularRun(event.companyId, event.period);
      if (!run || run.status === PayrollRunStatus.paid) return;

      await this.invalidateApprovals(
        event.companyId,
        run.id,
        `Attendance for ${event.period} was edited after approval began.`,
      );
      this.logger.log(
        `Payroll run ${run.id} (${event.period}) restarted its approval chain after an ` +
          `attendance edit.`,
      );
    } catch (error) {
      this.logger.error(
        `Could not restart the approval chain for ${event.companyId}/${event.period} ` +
          `after an attendance edit: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Puts a run into the payroll chain, tolerating one that is already there. */
  private async submitForApproval(
    companyId: string,
    runId: string,
    period?: string,
  ): Promise<void> {
    const existing = await this.approvals.stateOfSystem(
      ACTION_PAYROLL_RUN,
      runId,
      companyId,
    );
    if (existing && isLive(existing.state)) return;

    const run = period ? { period } : await this.findRunById(companyId, runId);

    try {
      await this.approvals.submit({
        companyId,
        actionType: ACTION_PAYROLL_RUN,
        entityType: ACTION_PAYROLL_RUN,
        entityId: runId,
        // Null, not a stand-in account: nobody raised this run. `ApprovalInstance`
        // records the originator as a real foreign key, so naming an arbitrary user
        // would put a person's name against work the schedule did.
        originatorUserId: null,
        subject: `Payroll run ${run?.period ?? ''}`.trim(),
        href: `/dashboard/hr/payroll/runs/${runId}`,
      });
    } catch (error) {
      // A missing chain is a configuration gap. It must not abort the sweep: the run
      // itself is correct and valuable, and refusing to create it would mean nobody gets
      // paid because nobody has configured an approver yet.
      this.logger.error(
        `Payroll run ${runId} could not enter its approval chain: ` +
          `${
            error instanceof Error ? error.message : String(error)
          }. The run exists and ` +
          `is held from producing a bank sheet until this is fixed.`,
      );
    }
  }

  private findRegularRun(companyId: string, period: string) {
    return withRlsContext(
      this.prisma,
      { isSuperAdmin: false, companyId },
      (tx) =>
        tx.payrollRun.findFirst({
          where: { companyId, period, isFnf: false },
        }),
    );
  }

  private findRunById(companyId: string, runId: string) {
    return withRlsContext(
      this.prisma,
      { isSuperAdmin: false, companyId },
      (tx) => tx.payrollRun.findFirst({ where: { id: runId } }),
    );
  }
}

/** `YYYY-MM` for a date, in the business timezone. */
export function periodOf(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(date);
  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  return `${year}-${month}`;
}

/**
 * The period *before* the one `now` falls in, in the business timezone.
 *
 * Computed from the zoned year and month rather than by subtracting milliseconds: on the
 * 1st at 00:30 Asia/Kolkata it is still the previous day in UTC, so date arithmetic in
 * the wrong zone lands a month out — which for a payroll run means paying the wrong
 * month's wages.
 */
export function previousPeriodOf(now: Date, timeZone: string): string {
  const [year, month] = periodOf(now, timeZone).split('-').map(Number);
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  return `${prevYear}-${String(prevMonth).padStart(2, '0')}`;
}
