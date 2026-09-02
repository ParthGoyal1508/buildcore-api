import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  Employee,
  LeaveApplication,
  LeaveApplicationStatus,
  LeaveTypeCode,
  Prisma,
} from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'nestjs-prisma';
import { AuditLogService } from '../../auth/audit-log.service';
import type { SettingsConfig } from '../../common/configs/config.interface';
import { RlsContext, withRlsContext } from '../../common/prisma/rls-context';
import { SitesService } from '../../projects/sites/sites.service';
import { HolidaysService } from '../holidays/holidays.service';
import { CompaniesService } from '../../settings/companies/companies.service';
import type { Caller } from '../biometrics/face-enrolment.service';
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
@Injectable()
export class LeaveService {
  private readonly timeZone: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly employees: EmployeesService,
    private readonly sites: SitesService,
    private readonly holidays: HolidaysService,
    private readonly companies: CompaniesService,
    private readonly auditLog: AuditLogService,
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
      tx.employee.findFirst({ where: { id: employeeId }, select: { id: true } }),
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
        where: { status },
        orderBy: { fromDate: 'asc' },
      }),
    );
  }

  /** Records an approver's verdict, debiting the balance on approval (FR-022a). */
  async decide(
    caller: Caller,
    id: string,
    dto: LeaveDecisionDto,
  ): Promise<LeaveApplication> {
    const status =
      dto.decision === 'approved'
        ? LeaveApplicationStatus.approved
        : LeaveApplicationStatus.rejected;

    const decided = await withRlsContext(
      this.prisma,
      caller.rls,
      async (tx) => {
        const application = await tx.leaveApplication.findFirst({
          where: { id },
        });
        if (!application) {
          throw new NotFoundException('Leave application not found');
        }
        if (application.status !== LeaveApplicationStatus.pending) {
          throw new ConflictException(
            `This application is already ${application.status}.`,
          );
        }

        const updated = await tx.leaveApplication.update({
          where: { id },
          data: {
            status,
            adminRemarks: dto.remarks ?? null,
            decidedByUserId: caller.userId,
            decidedAt: new Date(),
          },
        });

        // The balance is debited at approval, not at application: a pending request
        // that is later rejected must not have consumed entitlement in the meantime.
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

        return updated;
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.LEAVE_APPLICATION,
      action: AuditAction.UPDATE,
      entityId: decided.id,
      changes: {
        status,
        remarks: dto.remarks ?? null,
      } as Prisma.InputJsonValue,
      accountId: caller.userId,
      companyId: caller.companyId,
      ipAddress: caller.ipAddress,
    });

    // Notifying the employee is FR-022a's other half. This codebase has no
    // notification transport wired here yet — `EmailService` exists (feature 010) but
    // nothing in this module calls it — so
    // the decision is recorded and surfaced on the employee's own applications
    // list. When a notifications module lands, this is its call site.
    return decided;
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
