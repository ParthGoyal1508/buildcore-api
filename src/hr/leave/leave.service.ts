import {
  ForbiddenException,
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  AuditAction,
  AuditEntityType,
  Employee,
  LeaveApplication,
  LeaveApplicationStatus,
  LeaveTypeCode,
  Permission,
  Prisma,
} from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'nestjs-prisma';
import {
  APPROVAL_COMPLETED_EVENT,
  APPROVAL_REJECTED_EVENT,
  ApprovalService,
  type ApprovalCompletedEvent,
  type ApprovalRejectedEvent,
} from '../../approvals/approvals.service';
import { ACTION_LEAVE_APPLICATION } from '../../approvals/default-chains';
import { ApprovalDecisionAction } from '@prisma/client';
import type { AuthenticatedUser } from '../../auth/authenticated-user';
import { AuditLogService } from '../../auth/audit-log.service';
import { webRoutes } from '../../common/web-routes';
import type { SettingsConfig } from '../../common/configs/config.interface';
import { RlsContext, withRlsContext } from '../../common/prisma/rls-context';
import { SitesService } from '../../projects/sites/sites.service';
import { HolidaysService } from '../holidays/holidays.service';
import { CompaniesService } from '../../settings/companies/companies.service';
import type { Caller } from '../biometrics/face-enrolment.service';
import { EMPLOYEE_NAME_SELECT, withEmployeeNames } from '../employee-name';
import { EmployeesService } from '../employees/employees.service';
import { isPayrollLocked } from '../punch/payroll-lock';
import { CreateLeaveApplicationDto } from './dto/leave-application.dto';
import { LeaveDecisionDto } from './dto/leave-decision.dto';
import {
  countLeaveDays,
  eachDateInRange,
  financialYearOf,
  parseDateOnly,
  toDateOnly,
  zonedDateOnly,
} from './leave-days';

/** HTTP 423 Locked — the contract's status for a write into a closed payroll
 * period. Nest's `HttpStatus` enum has no member for it. */
const HTTP_STATUS_LOCKED = 423;

const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface LeaveBalanceView {
  leaveType: LeaveTypeCode;
  financialYear: string;
  opening: number;
  accrued: number;
  used: number;
  /** Computed from the three above, never stored — see the note on the
   * `LeaveBalance` model. */
  balance: number;
}

/**
 * Leave balances, applications, and the admin decision layer (US4).
 *
 * Employee-facing methods resolve the employee from the caller's token and never
 * from a parameter (FR-028); the two admin methods take an application id and rely
 * on RLS to confine what an approver can reach to their own company.
 */
const LEAVE_TYPE_LABELS: Record<LeaveTypeCode, string> = {
  earned: 'Earned leave',
  casual: 'Casual leave',
  sick: 'Sick leave',
  lwp: 'Leave without pay',
};

@Injectable()
export class LeaveService {
  private readonly timeZone: string;
  private readonly logger = new Logger(LeaveService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly employees: EmployeesService,
    private readonly sites: SitesService,
    private readonly holidays: HolidaysService,
    private readonly companies: CompaniesService,
    private readonly auditLog: AuditLogService,
    private readonly approvals: ApprovalService,
    configService: ConfigService,
  ) {
    this.timeZone = configService.get<SettingsConfig>('settings').timezone;
  }

  /** Today's calendar date for the employee, as `YYYY-MM-DD`. */
  private today(): string {
    return zonedDateOnly(new Date(), this.timeZone);
  }

  /** The caller's own entitlement for a financial year, defaulting to the current
   * one (FR-018). */
  async getBalance(
    caller: Caller,
    financialYear?: string,
  ): Promise<LeaveBalanceView[]> {
    const employee = await this.employees.requireByUserId(
      caller.rls,
      caller.userId,
    );
    return this.balanceFor(caller, employee.id, financialYear);
  }

  /**
   * The same balance projection for an employee named by an admin (005 US4).
   *
   * Shares `balanceFor` with the self-service path rather than reimplementing the
   * zero-fill and rounding — two copies of "what is this employee's balance" is
   * exactly how an admin screen and an employee screen end up disagreeing.
   */
  async getBalanceForEmployee(
    caller: Caller,
    employeeId: string,
    financialYear?: string,
  ): Promise<LeaveBalanceView[]> {
    const employee = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.employee.findFirst({
        where: { id: employeeId },
        select: { id: true },
      }),
    );
    if (!employee) throw new NotFoundException('Employee not found');
    return this.balanceFor(caller, employee.id, financialYear);
  }

  private async balanceFor(
    caller: Caller,
    employeeId: string,
    financialYear?: string,
  ): Promise<LeaveBalanceView[]> {
    const employee = { id: employeeId };
    // The financial year it is *here*, not at UTC: on 1 April the two disagree
    // for the first five and a half hours, and an employee opening the app that
    // morning would be shown last year's entitlement.
    const year = financialYear ?? financialYearOf(parseDateOnly(this.today()));

    const rows = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.leaveBalance.findMany({
        where: { employeeId: employee.id, financialYear: year },
      }),
    );

    // Every leave type is returned, including ones with no row yet. A missing row
    // means "nothing granted", which is a zero balance — returning a short list
    // instead would make the screen show four types one year and two the next.
    return Object.values(LeaveTypeCode).map((leaveType) => {
      const row = rows.find((r) => r.leaveType === leaveType);
      const opening = row ? row.opening.toNumber() : 0;
      const accrued = row ? row.accrued.toNumber() : 0;
      const used = row ? row.used.toNumber() : 0;
      return {
        leaveType,
        financialYear: year,
        opening,
        accrued,
        used,
        balance: round2(opening + accrued - used),
      };
    });
  }

  /** The caller's own applications, newest first (FR-022). */
  async listMine(caller: Caller): Promise<LeaveApplication[]> {
    const employee = await this.employees.requireByUserId(
      caller.rls,
      caller.userId,
    );
    return withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.leaveApplication.findMany({
        where: { employeeId: employee.id },
        orderBy: { fromDate: 'desc' },
      }),
    );
  }

  /** Submits a leave application for the caller (FR-019, FR-020). */
  async apply(
    caller: Caller,
    dto: CreateLeaveApplicationDto,
  ): Promise<LeaveApplication> {
    const employee = await this.employees.requireByUserId(
      caller.rls,
      caller.userId,
    );

    const from = parseDateOnly(dto.fromDate);
    const to = parseDateOnly(dto.toDate);
    if (to.getTime() < from.getTime()) {
      throw new BadRequestException('toDate cannot precede fromDate.');
    }

    await this.assertPeriodOpen(employee, from);

    const dayCount = await this.computeDayCount(
      caller.rls,
      employee,
      dto.fromDate,
      dto.toDate,
    );
    if (dayCount === 0) {
      // Every date in the range is a weekly off or a site holiday, so there is
      // nothing to apply for. Recording a zero-day application would put a row in
      // the approver's queue that costs the employee nothing and decides nothing.
      throw new BadRequestException(
        'That range contains no working days — no leave is needed for it.',
      );
    }

    // LWP is the one type never balance-checked (FR-020): it is unpaid by
    // definition, so there is no entitlement for it to exhaust.
    if (dto.leaveType !== LeaveTypeCode.lwp) {
      const financialYear = financialYearOf(from);
      const balances = await this.getBalance(caller, financialYear);
      const available =
        balances.find((b) => b.leaveType === dto.leaveType)?.balance ?? 0;
      if (dayCount > available) {
        throw new BadRequestException(
          `This application is ${dayCount} day(s) but only ${available} day(s) of ${dto.leaveType} leave remain for ${financialYear}.`,
        );
      }
    }

    // Straight to head office (2026-10-20). The reporting-manager stage added on 2026-10-16 was
    // withdrawn at the client's request; the manager columns stay for applications decided then.
    const created = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.leaveApplication.create({
        data: {
          employeeId: employee.id,
          leaveType: dto.leaveType,
          fromDate: from,
          toDate: to,
          dayCount: new Prisma.Decimal(dayCount),
          reason: dto.reason,
          status: LeaveApplicationStatus.pending,
        },
      }),
    );

    // Into its approval chain (2026-10-20). A company with no chain cannot take the application:
    // undone rather than left pending where nobody could ever decide it.
    try {
      await this.submitForApproval(created, employee, caller.userId);
    } catch (error) {
      await withRlsContext(this.prisma, caller.rls, (tx) =>
        tx.leaveApplication.delete({ where: { id: created.id } }),
      );
      throw error;
    }

    await this.auditLog.record({
      entityType: AuditEntityType.LEAVE_APPLICATION,
      action: AuditAction.CREATE,
      entityId: created.id,
      changes: {
        leaveType: dto.leaveType,
        fromDate: dto.fromDate,
        toDate: dto.toDate,
        dayCount,
      } as Prisma.InputJsonValue,
      accountId: caller.userId,
      companyId: employee.companyId,
      ipAddress: caller.ipAddress,
    });

    return created;
  }

  /** Withdraws a still-pending application (FR-021). */
  async cancel(caller: Caller, id: string): Promise<LeaveApplication> {
    const employee = await this.employees.requireByUserId(
      caller.rls,
      caller.userId,
    );

    const cancelled = await withRlsContext(
      this.prisma,
      caller.rls,
      async (tx) => {
        // Filtered on employeeId as well as id. RLS already confines this to the
        // caller's company, but a company contains other employees — a
        // company-scoped filter alone would let one worker cancel another's leave.
        const application = await tx.leaveApplication.findFirst({
          where: { id, employeeId: employee.id },
        });
        if (!application) {
          throw new NotFoundException('Leave application not found');
        }
        if (application.status !== LeaveApplicationStatus.pending) {
          throw new ConflictException(
            `This application is already ${application.status} and can no longer be cancelled.`,
          );
        }
        return tx.leaveApplication.update({
          where: { id },
          data: { status: LeaveApplicationStatus.cancelled },
        });
      },
    );

    // Nothing left for the approver to decide.
    await this.approvals.abandon(
      ACTION_LEAVE_APPLICATION,
      cancelled.id,
      employee.companyId,
      'Cancelled by the employee.',
    );

    await this.auditLog.record({
      entityType: AuditEntityType.LEAVE_APPLICATION,
      action: AuditAction.UPDATE,
      entityId: cancelled.id,
      changes: {
        status: LeaveApplicationStatus.cancelled,
      } as Prisma.InputJsonValue,
      accountId: caller.userId,
      companyId: employee.companyId,
      ipAddress: caller.ipAddress,
    });

    return cancelled;
  }

  /** The approver's queue (FR-022a). RLS confines it to their own company. */
  async listForReview(
    caller: Caller,
    /**
     * Omit to list every status.
     *
     * Deliberately no default: the two callers want different things — the
     * approver queue wants pending, the HR admin list wants everything — and a
     * default here silently gave the second one the first one's answer. Each
     * controller now states its own intent.
     */
    status?: LeaveApplicationStatus,
  ): Promise<LeaveApplication[]> {
    return withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.leaveApplication.findMany({
        where: {
          status,
          // The company is also stated, not left to row-level security alone (2026-10-15): the
          // queue now feeds the Approvals page and its badge, and a database role that bypasses
          // RLS — a superuser, as local development runs — listed every company's leave under
          // the one selected.
          ...(caller.rls.companyId
            ? { employee: { companyId: caller.rls.companyId } }
            : {}),
        },
        orderBy: { fromDate: 'asc' },
      }),
    );
  }

  /**
   * The same queue, with each application's employee named (`employee-name.ts`).
   *
   * Separate from `listForReview` rather than folded into it because the dashboard
   * providers that also call it count and aggregate rows and never display a name —
   * charging them a second query for a column nobody renders would be the kind of
   * cost that is invisible until a widget is slow.
   *
   * One query for the page's distinct employees, not one per row. The roster read runs
   * in the caller's own RLS context, so an application belonging to a company they
   * cannot see comes back with a null name and a null code rather than with a
   * borrowed one.
   */
  async listForReviewNamed(caller: Caller, status?: LeaveApplicationStatus) {
    const rows = await this.listForReview(caller, status);
    if (rows.length === 0) return [];

    const employees = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.employee.findMany({
        where: { id: { in: [...new Set(rows.map((row) => row.employeeId))] } },
        select: EMPLOYEE_NAME_SELECT,
      }),
    );
    return withEmployeeNames(rows, employees);
  }

  /**
   * An approver's verdict from the HR leave screen (FR-022a), recorded on the application's
   * approval chain (2026-10-20).
   *
   * The chain decides who may act and when the decision is final: a company that adds a Director
   * level after Head Office sees an approval here move the application on, not approve it. Only
   * the final approval debits the balance — in `applyOutcome`, which the Approvals page reaches
   * through the spine's events. Returns the application as it now stands.
   */
  async decide(
    caller: Caller,
    id: string,
    dto: LeaveDecisionDto,
    user: AuthenticatedUser,
  ): Promise<LeaveApplication> {
    const application = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.leaveApplication.findFirst({ where: { id } }),
    );
    if (!application)
      throw new NotFoundException('Leave application not found');
    if (application.status !== LeaveApplicationStatus.pending) {
      throw new ConflictException(
        `This application is already ${application.status}.`,
      );
    }
    // Nobody decides their own leave (2026-10-16 access-control audit, H3) — also refused by the
    // spine for anything submitted since 2026-10-20; kept for applications filed before then.
    const applicant = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.employee.findFirst({
        where: { id: application.employeeId },
        select: {
          userId: true,
          companyId: true,
          firstName: true,
          lastName: true,
        },
      }),
    );
    if (applicant?.userId && applicant.userId === caller.userId) {
      throw new ForbiddenException({
        code: 'SELF_APPROVAL',
        message:
          'You cannot decide your own leave application. Another approver must.',
      });
    }
    if (applicant) await this.ensureInChain(application, applicant);

    const view = await this.approvals.decideByEntity(
      ACTION_LEAVE_APPLICATION,
      id,
      {
        action:
          dto.decision === 'approved'
            ? ApprovalDecisionAction.approve
            : ApprovalDecisionAction.reject,
        reason: dto.remarks ?? null,
      },
      user,
      caller.ipAddress,
    );
    if (view.state === 'approved' || view.state === 'rejected') {
      await this.applyOutcome(id, view.state, caller.userId, dto.remarks);
    }
    return withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.leaveApplication.findFirstOrThrow({ where: { id } }),
    );
  }

  /** The chain approved the application at its last level (2026-10-20). */
  @OnEvent(APPROVAL_COMPLETED_EVENT)
  async onApprovalCompleted(event: ApprovalCompletedEvent): Promise<void> {
    if (event.entityType !== ACTION_LEAVE_APPLICATION) return;
    await this.onChainOutcome(event.entityId, event.companyId, 'approved');
  }

  /** The chain rejected it, at any level. */
  @OnEvent(APPROVAL_REJECTED_EVENT)
  async onApprovalRejected(event: ApprovalRejectedEvent): Promise<void> {
    if (event.entityType !== ACTION_LEAVE_APPLICATION) return;
    await this.onChainOutcome(event.entityId, event.companyId, 'rejected');
  }

  /**
   * Applies a chain's outcome from its event. Logs rather than throws: the decision is already
   * committed in the spine, and an exception here would surface on nobody's request.
   */
  private async onChainOutcome(
    id: string,
    companyId: string,
    outcome: 'approved' | 'rejected',
  ): Promise<void> {
    try {
      const state = await this.approvals.stateOfSystem(
        ACTION_LEAVE_APPLICATION,
        id,
        companyId,
      );
      const latest = state?.latestDecision;
      await this.applyOutcome(
        id,
        outcome,
        latest?.actorUserId ?? null,
        latest?.reason ?? undefined,
        companyId,
      );
    } catch (error) {
      this.logger.error(
        `Could not apply the ${outcome} chain outcome to leave application ${id}`,
        error as Error,
      );
    }
  }

  /**
   * The final decision, written once (2026-10-20). Conditional on the application still being
   * pending, so the module's own decide and the spine's event — which both arrive for a decision
   * taken on the HR screen — debit the balance once between them.
   *
   * The balance is debited at approval, not at application: a pending request that is later
   * rejected must not have consumed entitlement in the meantime.
   */
  private async applyOutcome(
    id: string,
    outcome: 'approved' | 'rejected',
    deciderUserId: string | null,
    remarks: string | undefined,
    companyId?: string,
  ): Promise<void> {
    const status =
      outcome === 'approved'
        ? LeaveApplicationStatus.approved
        : LeaveApplicationStatus.rejected;
    const applied = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      async (tx) => {
        const moved = await tx.leaveApplication.updateMany({
          where: { id, status: LeaveApplicationStatus.pending },
          data: {
            status,
            adminRemarks: remarks?.trim() || null,
            decidedByUserId: deciderUserId,
            decidedAt: new Date(),
          },
        });
        if (moved.count !== 1) return null;
        const application = await tx.leaveApplication.findFirstOrThrow({
          where: { id },
        });
        if (
          status === LeaveApplicationStatus.approved &&
          application.leaveType !== LeaveTypeCode.lwp
        ) {
          const financialYear = financialYearOf(application.fromDate);
          await tx.leaveBalance.upsert({
            where: {
              employeeId_leaveType_financialYear: {
                employeeId: application.employeeId,
                leaveType: application.leaveType,
                financialYear,
              },
            },
            create: {
              employeeId: application.employeeId,
              leaveType: application.leaveType,
              financialYear,
              used: application.dayCount,
            },
            update: { used: { increment: application.dayCount } },
          });
        }
        return application;
      },
    );
    if (!applied) return;

    // Notifying the employee is FR-022a's other half; the decision is surfaced on their own
    // applications list until a notifications transport is wired here.
    await this.auditLog.record({
      entityType: AuditEntityType.LEAVE_APPLICATION,
      action: AuditAction.UPDATE,
      entityId: id,
      changes: { status, remarks: remarks ?? null } as Prisma.InputJsonValue,
      accountId: deciderUserId ?? undefined,
      companyId: companyId ?? null,
      ipAddress: '',
    });
  }

  /** Puts an application into its chain. */
  private async submitForApproval(
    application: LeaveApplication,
    employee: Pick<Employee, 'companyId' | 'firstName' | 'lastName' | 'userId'>,
    originatorUserId: string | null,
  ): Promise<void> {
    const days = Number(application.dayCount);
    const name = `${employee.firstName} ${employee.lastName ?? ''}`.trim();
    await this.approvals.submit({
      companyId: employee.companyId,
      actionType: ACTION_LEAVE_APPLICATION,
      entityType: ACTION_LEAVE_APPLICATION,
      entityId: application.id,
      originatorUserId,
      subject: `${name} — ${
        LEAVE_TYPE_LABELS[application.leaveType]
      }, ${days} day${days === 1 ? '' : 's'} from ${toDateOnly(
        application.fromDate,
      )}`,
      // The employee's Leave tab: the balance is what this decision turns on (2026-10-20).
      href: `${webRoutes.employee(application.employeeId)}?tab=leave`,
      viewPermission: Permission.ATTENDANCE,
      // The applicant never decides their own leave.
      excludedUserIds: [employee.userId, originatorUserId],
    });
  }

  /**
   * An application filed before leave joined the spine has no chain; it is put into one when
   * first decided, so the decision still runs through the company's configured levels.
   */
  private async ensureInChain(
    application: LeaveApplication,
    applicant: Pick<
      Employee,
      'companyId' | 'firstName' | 'lastName' | 'userId'
    >,
  ): Promise<boolean> {
    const state = await this.approvals.stateOfSystem(
      ACTION_LEAVE_APPLICATION,
      application.id,
      applicant.companyId,
    );
    if (state) return false;
    await this.submitForApproval(application, applicant, applicant.userId);
    return true;
  }

  /**
   * Puts every pending application with no approval chain into one (2026-10-20) — those raised before
   * leave applications joined the spine, so they reach the Approvals queue rather than waiting for somebody to
   * open the module screen. Idempotent; run by `npm run backfill:approvals`. Returns how many it
   * submitted.
   */
  async backfillApprovals(): Promise<number> {
    const rows = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      (tx) =>
        tx.leaveApplication.findMany({
          where: { status: LeaveApplicationStatus.pending },
          include: {
            employee: {
              select: {
                companyId: true,
                firstName: true,
                lastName: true,
                userId: true,
              },
            },
          },
        }),
    );
    let submitted = 0;
    for (const { employee, ...application } of rows) {
      if (await this.ensureInChain(application, employee)) submitted += 1;
    }
    return submitted;
  }

  /**
   * Dates covered by an approved application, for attendance-status computation
   * (research.md §6).
   *
   * Exposed as a lookup rather than letting `AttendanceHistoryService` query
   * `LeaveApplication` itself, so "which dates count as on leave" has exactly one
   * definition and the history screen cannot drift from the leave screen.
   */
  async getApprovedLeaveDates(
    ctx: RlsContext,
    employeeId: string,
    fromDate: string,
    toDate: string,
  ): Promise<Set<string>> {
    const from = parseDateOnly(fromDate);
    const to = parseDateOnly(toDate);

    const applications = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.leaveApplication.findMany({
        where: {
          employeeId,
          status: LeaveApplicationStatus.approved,
          // Overlap, not containment: an application spanning a month boundary
          // covers days in this month even though neither endpoint falls in it.
          fromDate: { lte: to },
          toDate: { gte: from },
        },
        select: { fromDate: true, toDate: true },
      }),
    );

    const covered = new Set<string>();
    for (const application of applications) {
      for (const date of eachDateInRange(
        toDateOnly(application.fromDate),
        toDateOnly(application.toDate),
      )) {
        covered.add(date);
      }
    }
    return covered;
  }

  /**
   * Which of the given employees are on approved leave on one date (005 FR-069).
   *
   * The batch sibling of `getApprovedLeaveDates` above, for the admin Daily
   * Register: that one answers "which dates" for one employee, this one answers
   * "which employees" for one date. Calling the per-employee method in a loop
   * would issue a query per employee on every page load of a screen that renders
   * the whole company.
   *
   * It lives here for the same reason its sibling does — so "what counts as on
   * leave" has exactly one definition and the attendance screens cannot drift
   * from the leave screen.
   */
  async getEmployeesOnApprovedLeave(
    ctx: RlsContext,
    employeeIds: string[],
    date: string,
  ): Promise<Set<string>> {
    if (employeeIds.length === 0) return new Set();
    const day = parseDateOnly(date);

    const applications = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.leaveApplication.findMany({
        where: {
          employeeId: { in: employeeIds },
          status: LeaveApplicationStatus.approved,
          // The date falls inside the application's span, endpoints included.
          fromDate: { lte: day },
          toDate: { gte: day },
        },
        select: { employeeId: true },
      }),
    );

    return new Set(applications.map((a) => a.employeeId));
  }

  /**
   * The apply form's preview (036 G3): the same count `apply` will charge, plus what it left out
   * and why, so the form can say "excludes Sun 14-09 (weekly off)". 400 for a reversed range or one
   * over a year — a preview of a typo is not worth a year-long walk.
   */
  async previewDayCount(
    caller: Caller,
    fromDate: string,
    toDate: string,
  ): Promise<{
    days: number;
    weeklyOffDay: number | null;
    excluded: { date: string; reason: 'weekly_off' | 'holiday' }[];
  }> {
    const from = parseDateOnly(fromDate);
    const to = parseDateOnly(toDate);
    if (to.getTime() < from.getTime()) {
      throw new BadRequestException('toDate cannot precede fromDate.');
    }
    if (to.getTime() - from.getTime() > 366 * 86_400_000) {
      throw new BadRequestException('A leave range cannot exceed a year.');
    }
    const employee = await this.employees.requireByUserId(
      caller.rls,
      caller.userId,
    );
    const [weeklyOffDay, holidays] = await Promise.all([
      this.sites.getWeeklyOffDay(caller.rls, employee.siteId),
      this.holidays.getHolidayCalendar(
        caller.rls,
        employee.companyId,
        employee.siteId,
      ),
    ]);
    const holidaySet = new Set(holidays);
    const excluded: { date: string; reason: 'weekly_off' | 'holiday' }[] = [];
    for (const date of eachDateInRange(fromDate, toDate)) {
      if (holidaySet.has(date)) excluded.push({ date, reason: 'holiday' });
      else if (parseDateOnly(date).getUTCDay() === weeklyOffDay)
        excluded.push({ date, reason: 'weekly_off' });
    }
    return {
      days: countLeaveDays(fromDate, toDate, weeklyOffDay, holidays),
      weeklyOffDay,
      excluded,
    };
  }

  /** Chargeable days in the range, against the employee's own site calendar. */
  private async computeDayCount(
    ctx: RlsContext,
    employee: Employee,
    fromDate: string,
    toDate: string,
  ): Promise<number> {
    const [weeklyOffDay, holidays] = await Promise.all([
      this.sites.getWeeklyOffDay(ctx, employee.siteId),
      this.holidays.getHolidayCalendar(
        ctx,
        employee.companyId,
        employee.siteId,
      ),
    ]);
    return countLeaveDays(fromDate, toDate, weeklyOffDay, holidays);
  }

  /** Rejects a range reaching into a closed payroll period (FR-010) with 423. */
  private async assertPeriodOpen(
    employee: Employee,
    from: Date,
  ): Promise<void> {
    const payrollLockDay = await this.companies.getPayrollLockDay(
      employee.companyId,
    );
    // Only the start date is checked: a range runs forward, so if its first day is
    // open every later day is too, and if its first day is locked the application
    // would rewrite a closed period regardless of where it ends.
    if (isPayrollLocked(from, payrollLockDay, new Date(), this.timeZone)) {
      throw new HttpException(
        'That date range falls in a payroll period that is already locked.',
        HTTP_STATUS_LOCKED,
      );
    }
  }
}
