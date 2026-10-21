import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { Permission, PayrollRunStatus } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { ApprovalService } from '../../approvals/approvals.service';
import { ACTION_PAYROLL_RUN } from '../../approvals/default-chains';
import {
  isLive,
  type ApprovalInstanceView,
} from '../../approvals/approval.types';
import type { AuthenticatedUser } from '../../auth/authenticated-user';
import type { SettingsConfig } from '../../common/configs/config.interface';
import { withRlsContext } from '../../common/prisma/rls-context';
import {
  ATTENDANCE_CHANGED_UNDER_REVIEW_EVENT,
  AttendanceChangedUnderReviewEvent,
} from '../../hr/attendance/attendance-events';
import { CompaniesService } from '../../settings/companies/companies.service';
import type { Caller } from '../../hr/biometrics/face-enrolment.service';
import { PayrollEngineService } from '../engine/payroll-engine.service';
import { webRoutes } from '../../common/web-routes';

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
   * Creates the previous period's run for every active company (FR-013) — and, since 039, stops
   * there.
   *
   * **No longer submits the run into its chain (039).** The client's flow is: payroll is generated,
   * HR reviews and corrects it (each change justified), and HR *sends* it to the Director. A run the
   * schedule pushed straight into the Director's queue was one HR could no longer correct — edits
   * are locked while the Director has it — and, with no originator, one that could never be
   * resubmitted after a return. So the sweep generates the draft and HR sends it from the run screen
   * (`sendToDirector`). The bank sheet stays held until the Director approves, as before (FR-014's
   * control is unchanged; only who starts the chain is).
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

  /**
   * The outstanding level on a run's chain, or null when it is clear to proceed.
   *
   * A thin wrapper over `ApprovalService.mayTakeEffect` rather than its own logic, and
   * deliberately so: FR-018's rule must have exactly one implementation. The moment
   * payroll answers "is this approved?" its own way, the answer can differ from the one
   * feature 017 gets for a work order, and the discrepancy is found by money having
   * already moved.
   *
   * What payroll keeps is its *vocabulary* — the caller here wants a level to name in a
   * bank-sheet refusal, not the spine's gate shape.
   */
  async outstandingApproval(
    companyId: string,
    runId: string,
  ): Promise<{
    levelLabel: string | null;
    state: string;
    /** False when the run was never put into its approval chain at all (2026-10-17). */
    submitted: boolean;
  } | null> {
    const gate = await this.approvals.mayTakeEffect({
      actionType: ACTION_PAYROLL_RUN,
      entityType: ACTION_PAYROLL_RUN,
      entityId: runId,
      companyId,
    });
    if (gate.allowed) return null;
    return {
      levelLabel: gate.levelLabel,
      // `state` is null when the run was never submitted at all — which for
      // `payroll_run`, one of FR-018's named action types, is now a refusal rather than a
      // pass. Reported as `pending` because that is what it means to whoever is waiting:
      // the sheet is held and somebody has to approve something.
      state: gate.state ?? 'pending',
      submitted: gate.state !== null,
    };
  }

  /**
   * Puts an F&F run into its approval chain when it is processed, if it has never been in one
   * (2026-10-17).
   *
   * Since 039 a regular run is sent to the Director by HR *before* processing, and processing
   * refuses without the approval — so for a regular run this always finds the chain already there
   * and does nothing. It remains for F&F runs, which are still approved after processing. A run
   * already in a chain, in any state, is left alone.
   */
  async submitIfNeverSubmitted(
    companyId: string,
    runId: string,
    originatorUserId: string | null,
  ): Promise<'submitted' | 'already_submitted'> {
    const existing = await this.approvals.stateOfSystem(
      ACTION_PAYROLL_RUN,
      runId,
      companyId,
    );
    if (existing) return 'already_submitted';
    const run = await this.findRunById(companyId, runId);
    await this.approvals.submit({
      companyId,
      actionType: ACTION_PAYROLL_RUN,
      entityType: ACTION_PAYROLL_RUN,
      entityId: runId,
      originatorUserId,
      subject: `Payroll run ${run?.period ?? ''}`.trim(),
      href: webRoutes.payrollRun(runId),
      viewPermission: Permission.PAYROLL,
    });
    return 'submitted';
  }

  /**
   * HR sends the run to the Director (039): the explicit step after reviewing and correcting it.
   *
   * The sender is recorded as the originator, which is what lets the spine's originator-only
   * `resubmit` work after a return — the schedule used to submit with a null originator, and such a
   * run could never be sent again. A returned run sent by its originator is resubmitted (a new
   * round on the same instance, its history kept). A returned run whose originator is somebody else
   * or nobody (submitted by the schedule before 039) is abandoned and submitted afresh under the
   * sender: payroll is HR's as a team, and a return must not strand a run because the colleague who
   * first sent it is away. Rejected or abandoned chains likewise start a fresh one.
   */
  async sendToDirector(
    companyId: string,
    runId: string,
    sender: AuthenticatedUser,
  ): Promise<ApprovalInstanceView> {
    const run = await this.findRunById(companyId, runId);
    if (!run) throw new NotFoundException('Payroll run not found');
    if (run.status === PayrollRunStatus.paid) {
      throw new ConflictException({
        statusCode: 409,
        code: 'PAYROLL_RUN_ALREADY_PAID',
        message: 'This payroll run has been paid; there is nothing to approve.',
      });
    }

    const existing = await this.approvals.stateOfSystem(
      ACTION_PAYROLL_RUN,
      runId,
      companyId,
    );
    if (existing?.state === 'pending') {
      throw new ConflictException({
        statusCode: 409,
        code: 'PAYROLL_RUN_AWAITING_APPROVAL',
        message: `This payroll run is already with ${
          existing.levelLabel ?? 'the Director'
        } for approval.`,
      });
    }
    if (existing?.state === 'approved') {
      throw new ConflictException({
        statusCode: 409,
        code: 'PAYROLL_RUN_ALREADY_APPROVED',
        message: 'The Director has already approved this payroll run.',
      });
    }
    if (existing?.state === 'returned') {
      if (existing.originatorUserId === sender.id) {
        return this.approvals.resubmit(
          ACTION_PAYROLL_RUN,
          runId,
          companyId,
          sender.id,
          sender,
        );
      }
      await this.approvals.abandon(
        ACTION_PAYROLL_RUN,
        runId,
        companyId,
        'Returned run sent again by another HR user; a fresh chain replaces it.',
      );
    }

    return this.approvals.submit({
      companyId,
      actionType: ACTION_PAYROLL_RUN,
      entityType: ACTION_PAYROLL_RUN,
      entityId: runId,
      originatorUserId: sender.id,
      subject: `Payroll run ${run.period}`,
      href: webRoutes.payrollRun(runId),
      // Who may read this run's approval history (FR-009). Payroll figures are not
      // company-wide reading, so this is the `PAYROLL` permission and not a laxer one.
      viewPermission: Permission.PAYROLL,
    });
  }

  /**
   * Voids a run's approval because its attendance changed underneath it (FR-017).
   *
   * Every approval already given is void: the figures the approvers agreed to are no longer the
   * figures. **Since 039 the chain is abandoned and not restarted.** The stored lines do not
   * change when attendance does — only a regeneration recomputes them — so restarting the chain
   * put the same stale figures back in front of the Director. Abandoning hands the run back to HR,
   * who regenerate (or correct) it and send it again.
   */
  async invalidateApprovals(
    companyId: string,
    runId: string,
    reason: string,
  ): Promise<void> {
    await this.approvals.abandon(ACTION_PAYROLL_RUN, runId, companyId, reason);
  }

  /**
   * Voids a run's approval when attendance underneath it changed (FR-017, T038; 039: abandoned,
   * not restarted — see `invalidateApprovals`).
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
        `Payroll run ${run.id} (${event.period}) had its approval voided after an ` +
          `attendance edit; HR must send it again.`,
      );
    } catch (error) {
      this.logger.error(
        `Could not void the approval chain for ${event.companyId}/${event.period} ` +
          `after an attendance edit: ` +
          `${error instanceof Error ? error.message : String(error)}`,
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
