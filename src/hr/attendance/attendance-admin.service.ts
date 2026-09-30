import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import {
  AuditAction,
  AuditEntityType,
  Prisma,
  PunchSource,
  PunchType,
} from '@prisma/client';
import { Permission } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { randomUUID } from 'crypto';

import { SLOT_HR } from '../../approvals/approval-slots';
import {
  APPROVAL_COMPLETED_EVENT,
  ApprovalCompletedEvent,
  ApprovalService,
} from '../../approvals/approvals.service';
import { ACTION_ATTENDANCE_CORRECTION } from '../../approvals/default-chains';
import { ChainsService } from '../../approvals/chains.service';
import { AuditLogService } from '../../auth/audit-log.service';
import type {
  HrPayrollConfig,
  SettingsConfig,
} from '../../common/configs/config.interface';
import { withRlsContext } from '../../common/prisma/rls-context';
import { PayrollScheduleService } from '../../payroll/runs/payroll-schedule.service';
import { CompaniesService } from '../../settings/companies/companies.service';
import type { Caller } from '../biometrics/face-enrolment.service';
import { EmployeeDocumentsService } from '../employees/documents/employee-documents.service';
import { zonedDateOnly } from '../leave/leave-days';
import {
  ATTENDANCE_CHANGED_UNDER_REVIEW_EVENT,
  AttendanceChangedUnderReviewEvent,
} from './attendance-events';
import { isPayrollLocked } from '../punch/payroll-lock';
import {
  AttendanceHistoryService,
  type AttendanceStatus,
} from '../punch/attendance-history.service';
import { ReferenceDataService } from '../../settings/reference-data/reference-data.service';
import {
  dayCompliance,
  summarise,
  type DayCompliance,
  type ShiftWindow,
} from './shift-compliance';
import type {
  DailyAttendanceQueryDto,
  MarkAttendanceDto,
  ModificationsQueryDto,
} from './dto/mark-attendance.dto';

/** One employee's attendance for one day, as the admin daily view renders it. */
export interface DailyAttendanceRow {
  employeeId: string;
  employeeCode: string;
  name: string;
  siteId: string;
  inTime: string | null;
  outTime: string | null;
  /**
   * The status to display: the admin's override where one was set, otherwise the
   * status derived from punches, leave and the site calendar (FR-069, FR-070).
   *
   * Sent derived rather than left to the client. When this field did not exist the
   * web fell back to `present` for every row without an override, which is almost
   * every row — so an employee who had not punched at all read as Present.
   */
  status: AttendanceStatus;
  statusOverride: string | null;
  adminEdited: boolean;
  remarks: string | null;
  hasException: boolean;
}

/**
 * Admin attendance administration (005 US3).
 *
 * Writes into the same `hr.PunchRecord` table the self-service flow uses, tagged
 * `source: admin_correction` — one attendance representation, not a parallel one,
 * so every downstream reader (history, payroll, reports) sees admin corrections
 * without knowing they exist. Every edit additionally appends an
 * `AttendanceModification` row carrying the before/after the Modifications Modal
 * renders (research.md §7).
 */
@Injectable()
export class AttendanceAdminService {
  private readonly timeZone: string;
  private readonly hrPayroll: HrPayrollConfig;

  private readonly logger = new Logger(AttendanceAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly companies: CompaniesService,
    private readonly employeeDocuments: EmployeeDocumentsService,
    private readonly attendanceHistory: AttendanceHistoryService,
    private readonly referenceData: ReferenceDataService,
    private readonly auditLog: AuditLogService,
    // 016 FR-016: payroll owns the answer to "is this period under review"; `hr` must
    // never read `payroll` tables to find out (research.md §5). forwardRef because
    // PayrollModule imports HrModule for the engine's attendance reads.
    @Inject(forwardRef(() => PayrollScheduleService))
    private readonly payrollSchedule: PayrollScheduleService,
    // 016 FR-016: which role *is* HR is answered by the chain's slot mapping, not by a
    // permission — there is deliberately no HR permission to check.
    private readonly chains: ChainsService,
    // 016 FR-012: a manual correction enters the chain rather than taking effect in one
    // step. `hr` submits and listens; it never reads a spine table (Principle I).
    private readonly approvals: ApprovalService,
    private readonly events: EventEmitter2,
    configService: ConfigService,
  ) {
    this.timeZone = configService.get<SettingsConfig>('settings').timezone;
    this.hrPayroll = configService.get<HrPayrollConfig>('hrPayroll');
  }

  /**
   * Whether a date has not happened yet (FR-071, FR-072, FR-073).
   *
   * Attendance is a record of what occurred, not a roster of what is planned. The
   * daily view previously answered for any date it was handed, returning a row per
   * active employee — which, with the client's old `present` fallback, rendered a
   * fully-staffed working day for a date in the future.
   *
   * Public because the bulk import (FR-073) must apply the same rule per row while
   * reporting it as a row error rather than as a rejected request, and it must be
   * the same rule — an import path that accepted what the direct path refuses
   * would make the refusal decorative.
   *
   * "Today" is the business timezone's today, never `toISOString()`'s (FR-074). At
   * UTC+5:30 a UTC-truncated comparison calls the genuinely current date "future"
   * for the first five and a half hours of every working day — refusing an admin
   * marking early-shift attendance at 07:00 IST. Both sides are `YYYY-MM-DD`, so a
   * string comparison is the date comparison.
   */
  isFutureDate(date: string): boolean {
    return date > zonedDateOnly(new Date(), this.timeZone);
  }

  /** FR-071 / FR-072 as a rejection; see `isFutureDate` for the rule itself. */
  /**
   * Every gate a manual correction must pass, applied at **submission** (016 T076).
   *
   * Factored out of `mark` so submission and application cannot disagree about what is
   * allowed. Checking at submission rather than at apply is what stops a reviewer approving
   * a correction that then fails: a date in a locked payroll period should be refused to
   * the person typing it, while they are still looking at the screen.
   */
  private async validateCorrection(
    caller: Caller,
    dto: MarkAttendanceDto,
  ): Promise<{ id: string; companyId: string; name?: string | null }> {
    if (!dto.inTime && !dto.outTime && !dto.statusOverride) {
      throw new BadRequestException(
        'Provide at least one of inTime, outTime or statusOverride.',
      );
    }
    if (dto.inTime && dto.outTime && dto.outTime < dto.inTime) {
      throw new BadRequestException('outTime cannot precede inTime.');
    }

    const employee = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.employee.findFirst({
        where: { id: dto.employeeId },
        select: { id: true, companyId: true },
      }),
    );
    if (!employee) throw new NotFoundException('Employee not found');

    this.assertNotFuture(dto.date);

    const date = new Date(`${dto.date}T00:00:00.000Z`);
    const lockDay = await this.companies.getPayrollLockDay(employee.companyId);
    if (isPayrollLocked(date, lockDay, new Date(), this.timeZone)) {
      // 423 Locked, matching how the self-service path reports the same rule.
      throw new BadRequestException({
        statusCode: 423,
        message:
          'That date falls in a payroll period that is already locked (FR-010).',
      });
    }

    // 016 FR-016. A run under review has been computed from this attendance and is
    // sitting in front of approvers; a site user quietly adjusting its inputs is exactly
    // the thing the chain exists to prevent. HR keeps the right because corrections are
    // real and someone has to be able to make them.
    const underReview = await this.payrollSchedule.isPeriodUnderReview(
      employee.companyId,
      date,
    );
    if (underReview) {
      const hrRoleId = await this.chains.resolveSlot(
        caller.rls,
        employee.companyId,
        SLOT_HR,
      );
      const isHr = hrRoleId !== null && caller.roleIds.includes(hrRoleId);
      if (!isHr) {
        throw new ForbiddenException({
          statusCode: 403,
          message:
            hrRoleId === null
              ? 'Attendance for this period is under payroll review, and no role has ' +
                'been mapped to HR for this company, so nobody can edit it. An ' +
                'administrator must map the HR slot in settings.'
              : 'Attendance for this period is under payroll review. Only HR may edit ' +
                'it until the run is approved or returned.',
          code:
            hrRoleId === null
              ? 'APPROVAL_SLOT_UNMAPPED'
              : 'ATTENDANCE_UNDER_PAYROLL_REVIEW',
        });
      }
    }

    await this.employeeDocuments.assertMandatoryDocsComplete(
      employee.id,
      employee.companyId,
    );

    return employee;
  }

  /** The employee a correction belongs to, with no gate applied. */
  private async requireEmployee(
    caller: Caller,
    employeeId: string,
  ): Promise<{ id: string; companyId: string }> {
    const employee = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.employee.findFirst({
        where: { id: employeeId },
        select: { id: true, companyId: true },
      }),
    );
    if (!employee) throw new NotFoundException('Employee not found');
    return employee;
  }

  private assertNotFuture(date: string): void {
    if (this.isFutureDate(date)) {
      throw new BadRequestException(
        'That date is in the future. Attendance can only be viewed or recorded up to today.',
      );
    }
  }

  /** Attendance for one date, optionally narrowed to a site. */
  async daily(
    caller: Caller,
    companyId: string,
    query: DailyAttendanceQueryDto,
  ): Promise<DailyAttendanceRow[]> {
    this.assertNotFuture(query.date);
    const date = new Date(`${query.date}T00:00:00.000Z`);

    const employees = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.employee.findMany({
        where: {
          companyId,
          isActive: true,
          ...(query.siteId ? { siteId: query.siteId } : {}),
        },
        select: {
          id: true,
          employeeCode: true,
          firstName: true,
          lastName: true,
          siteId: true,
        },
        orderBy: { employeeCode: 'asc' },
      }),
    );
    if (employees.length === 0) return [];

    const punches = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.punchRecord.findMany({
        where: {
          employeeId: { in: employees.map((e) => e.id) },
          punchDate: date,
        },
        orderBy: { capturedAt: 'asc' },
      }),
    );

    const byEmployee = new Map<string, typeof punches>();
    for (const p of punches) {
      const list = byEmployee.get(p.employeeId) ?? [];
      list.push(p);
      byEmployee.set(p.employeeId, list);
    }

    // The same rule the employee's own history screen and payroll read, applied
    // here rather than reimplemented (FR-069).
    const statuses = await this.attendanceHistory.statusesForDate(
      caller,
      companyId,
      employees,
      query.date,
      (employeeId) => (byEmployee.get(employeeId)?.length ?? 0) > 0,
    );

    return employees.map((e) => {
      const rows = byEmployee.get(e.id) ?? [];
      const inPunch = rows.find((r) => r.type === PunchType.in);
      const outPunch = rows.find((r) => r.type === PunchType.out);
      return {
        employeeId: e.id,
        employeeCode: e.employeeCode,
        name: [e.firstName, e.lastName].filter(Boolean).join(' ').trim(),
        siteId: e.siteId,
        inTime: this.timeOf(inPunch?.capturedAt),
        outTime: this.timeOf(outPunch?.capturedAt),
        // An explicit override outranks the derivation: an admin who marked
        // someone absent on a day a punch exists for meant it (FR-070).
        status:
          (inPunch?.statusOverride as AttendanceStatus | undefined) ??
          statuses.get(e.id) ??
          'absent',
        statusOverride: inPunch?.statusOverride ?? null,
        adminEdited: rows.some((r) => r.adminEdited),
        remarks: inPunch?.remarks ?? outPunch?.remarks ?? null,
        hasException: rows.some(
          (r) =>
            r.faceMatchResult === 'exception' ||
            r.geofenceResult === 'exception',
        ),
      };
    });
  }

  /**
   * Creates or corrects an employee's attendance for a day.
   *
   * Gated on the same two rules the self-service path obeys — the payroll lock and
   * the mandatory-document check — because an admin route that bypassed them would
   * make both trivially avoidable.
   */
  /**
   * Submits a manual correction into the approval chain (016 FR-012, plan D15).
   *
   * **This is what `POST /attendance` now calls.** The path and the DTO are unchanged;
   * what changed is what comes back — a pending approval instance rather than an applied
   * row. Until the chain completes, the attendance is untouched, and the employee's own
   * view shows nothing (FR-009c on the web side depends on that being true here).
   *
   * Every gate `mark` applies is applied **here, at submission**, not deferred to apply
   * time. Validating at submission is what stops a reviewer approving something that will
   * then fail: a correction into a locked payroll period should be refused to the person
   * who typed it, while they are still looking at the screen, not three approvals later.
   *
   * The payroll lock and the chain are **independent** gates and both remain (FR-016,
   * T076). An HR correction during payroll review passes the first and still enters the
   * second; neither subsumes the other.
   */
  async submitCorrection(
    caller: Caller,
    dto: MarkAttendanceDto,
  ): Promise<{ approvalInstanceId: string; state: string }> {
    const employee = await this.validateCorrection(caller, dto);

    // Generated here rather than by the database, so the spine can be given a real
    // entityId at submit while the row it points at is written immediately afterwards. The
    // alternative — submit, create, then retarget — would need a new spine method for the
    // retarget, and the spine's whole point is that modules do not reach into it.
    const correctionId = randomUUID();

    const instance = await this.approvals.submit({
      companyId: employee.companyId,
      actionType: ACTION_ATTENDANCE_CORRECTION,
      entityType: ACTION_ATTENDANCE_CORRECTION,
      entityId: correctionId,
      originatorUserId: caller.userId,
      subject: `${employee.name ?? employee.id} — ${
        dto.date
      }, manual attendance correction`,
      href: `/hr/attendance?employeeId=${dto.employeeId}&date=${dto.date}`,
      viewPermission: Permission.ATTENDANCE,
    });

    // If this fails after the submit succeeded, the result is an approval instance whose
    // entity does not exist. `onApprovalCompleted` finds nothing and returns, so nothing is
    // applied on the strength of a missing correction, and the reconciliation sweep reports
    // the orphan. That is the right failure: an item nobody can approve into effect.
    await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.pendingAttendanceCorrection.create({
        data: {
          id: correctionId,
          companyId: employee.companyId,
          employeeId: dto.employeeId,
          date: new Date(`${dto.date}T00:00:00.000Z`),
          payload: dto as unknown as Prisma.InputJsonValue,
          submittedByUserId: caller.userId,
          approvalInstanceId: instance.instanceId,
        },
      }),
    );

    return { approvalInstanceId: instance.instanceId, state: instance.state };
  }

  /**
   * Applies a correction whose chain has completed (016 FR-012, T074).
   *
   * **Idempotent**, because it will be redelivered: the event bus offers no once-only
   * guarantee and a decision can reach completion through more than one path. `appliedAt`
   * is the guard — a row already stamped is skipped, so applying the same event twice
   * writes once.
   */
  @OnEvent(APPROVAL_COMPLETED_EVENT)
  async onApprovalCompleted(event: ApprovalCompletedEvent): Promise<void> {
    if (event.entityType !== ACTION_ATTENDANCE_CORRECTION) return;

    try {
      const pending = await withRlsContext(
        this.prisma,
        { isSuperAdmin: true },
        (tx) =>
          tx.pendingAttendanceCorrection.findUnique({
            where: { approvalInstanceId: event.instanceId },
          }),
      );
      if (!pending || pending.appliedAt) return;

      const dto = pending.payload as unknown as MarkAttendanceDto;
      await this.mark(
        {
          userId: pending.submittedByUserId,
          roleIds: [],
          // `AuditLogEntry.ipAddress` is a required column and there is no request behind
          // an application: the chain completed on somebody else's decision, possibly
          // minutes later. Following `payroll-schedule.service.ts`'s convention of naming
          // the system path rather than passing an empty string, so the audit row says what
          // actually caused it.
          ipAddress: 'system/attendance-correction',
          rls: { isSuperAdmin: false, companyId: pending.companyId },
        } as Caller,
        dto,
        { skipGates: true },
      );

      await withRlsContext(this.prisma, { isSuperAdmin: true }, (tx) =>
        tx.pendingAttendanceCorrection.update({
          where: { id: pending.id },
          data: { appliedAt: new Date() },
        }),
      );
    } catch (error) {
      // A handler that throws takes nothing with it — the decision is already committed
      // and the spine is authoritative — so this is logged rather than rethrown, and the
      // drift is what the reconciliation sweep exists to report. Same reasoning as
      // `attendance-exceptions.service.ts`.
      this.logger.error(
        `Approval ${event.instanceId} completed but its attendance correction could ` +
          `not be applied: ${
            error instanceof Error ? error.message : String(error)
          }`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  /**
   * Applies a correction immediately, writing the `AttendanceModification` row.
   *
   * **Two callers, and the difference matters** (016 T077):
   *
   * 1. `onApprovalCompleted` above, once a chain has finished. Gates were already checked
   *    at submission, so it passes `skipGates`.
   * 2. `attendance-import.service.ts`'s commit, which is **deliberately exempt from the
   *    chain**. A month's CSV for 150 employees is several thousand rows; raising a chain
   *    item per row would create thousands of pending approvals that nobody will ever walk
   *    through, and the import already has its own human gate — the two-phase
   *    validate-then-commit flow, where a person reads the validation report before
   *    committing. That review is the approval. Every imported row is still logged as a
   *    modification (FR-012a, FR-012e: the log does not depend on whether approval was
   *    required), so the audit and the employee's own view are complete either way.
   *
   * It is no longer reachable from `POST /attendance` — that route submits instead.
   */
  async mark(
    caller: Caller,
    dto: MarkAttendanceDto,
    options: { skipGates?: boolean } = {},
  ): Promise<{ employeeId: string; date: string }> {
    const employee = options.skipGates
      ? await this.requireEmployee(caller, dto.employeeId)
      : await this.validateCorrection(caller, dto);

    const date = new Date(`${dto.date}T00:00:00.000Z`);

    // 016 FR-017's trigger. Recomputed here rather than passed down from the gate, because
    // an application arriving through the chain is a *later* moment than its submission and
    // a run may have entered review in between — which is precisely when the approvers'
    // figures need voiding.
    const underReview = await this.payrollSchedule.isPeriodUnderReview(
      employee.companyId,
      date,
    );

    const before = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.punchRecord.findMany({
        where: { employeeId: dto.employeeId, punchDate: date },
        orderBy: { capturedAt: 'asc' },
      }),
    );

    await withRlsContext(this.prisma, caller.rls, async (tx) => {
      await this.upsertSide(tx, dto, date, PunchType.in, dto.inTime, caller);
      await this.upsertSide(tx, dto, date, PunchType.out, dto.outTime, caller);

      // Append-only: the Modifications Modal renders a diff, so it needs the
      // specific before/after values, which the generic audit log's `changes`
      // blob is a poor structure to query (research.md §7).
      await tx.attendanceModification.create({
        data: {
          employeeId: dto.employeeId,
          date,
          actorUserId: caller.userId,
          before: this.snapshot(before) as Prisma.InputJsonValue,
          after: {
            inTime: dto.inTime ?? null,
            outTime: dto.outTime ?? null,
            statusOverride: dto.statusOverride ?? null,
          } as Prisma.InputJsonValue,
          reason: dto.remarks ?? null,
        },
      });
    });

    await this.auditLog.record({
      entityType: AuditEntityType.ATTENDANCE,
      action: before.length ? AuditAction.UPDATE : AuditAction.CREATE,
      entityId: dto.employeeId,
      changes: { date: dto.date },
      accountId: caller.userId,
      companyId: employee.companyId,
      ipAddress: caller.ipAddress,
    });

    // 016 FR-017. The run's approvers agreed to figures that no longer hold, so every
    // approval already given is void and the chain must start again. Announced rather
    // than called: `hr` needs no answer, and Principle I puts exactly this kind of
    // fan-out on the event bus.
    //
    // Emitted after the write commits, not inside it — a listener that restarted a chain
    // for an edit the transaction then rolled back would invalidate approvals over a
    // change that never happened.
    //
    // `emitAsync`, and awaited. `emit` does not wait for asynchronous listeners, which
    // leaves a window between this edit being acknowledged and the approvals actually
    // being voided — and in that window a director can approve figures that have already
    // changed underneath them. Awaiting is not asking payroll for an answer (the listener
    // swallows its own failures and returns nothing); it is refusing to report the edit
    // as done while the consequence the requirement promises is still outstanding.
    if (underReview) {
      const event: AttendanceChangedUnderReviewEvent = {
        companyId: employee.companyId,
        period: dto.date.slice(0, 7),
        employeeId: dto.employeeId,
        actorUserId: caller.userId,
      };
      await this.events.emitAsync(ATTENDANCE_CHANGED_UNDER_REVIEW_EVENT, event);
    }

    return { employeeId: dto.employeeId, date: dto.date };
  }

  /** The Modifications audit trail, newest first. */
  /**
   * One employee's attendance month, for the admin Employee Detail calendar.
   *
   * The same `AttendanceHistoryService` call `/my/punch/history` serves, but keyed
   * on an employee named by the caller rather than derived from their own token.
   * That difference is the whole reason it needs its own route: `/my/*` deliberately
   * accepts no employee parameter (FR-028), so an admin looking at somebody else's
   * calendar cannot go through it. RLS still scopes the lookup to the caller's
   * company, and the route is guarded by ATTENDANCE like every other admin route
   * here.
   */
  async employeeMonth(
    caller: Caller,
    companyId: string,
    employeeId: string,
    month: number,
    year: number,
  ) {
    const employee = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.employee.findFirst({ where: { id: employeeId, companyId } }),
    );
    if (!employee) {
      throw new NotFoundException('Employee not found');
    }
    return this.attendanceHistory.getMonthForEmployee(
      caller,
      employee,
      month,
      year,
    );
  }

  async modifications(
    caller: Caller,
    companyId: string,
    query: ModificationsQueryDto,
  ) {
    const page = Number(query.page ?? 1);
    const pageSize = Math.min(Number(query.pageSize ?? 50), 200);

    const employees = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.employee.findMany({ where: { companyId }, select: { id: true } }),
    );

    const where: Prisma.AttendanceModificationWhereInput = {
      employeeId: query.employeeId ?? { in: employees.map((e) => e.id) },
      // 016 FR-012d. Spread as an optional key rather than `actorUserId: query.actorUserId`
      // — an explicit `undefined` would be a filter on nothing in some Prisma versions and
      // a no-op in others, and the difference is an audit silently returning everything.
      ...(query.actorUserId ? { actorUserId: query.actorUserId } : {}),
      ...(query.from || query.to
        ? {
            date: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };

    const [items, total] = await withRlsContext(
      this.prisma,
      caller.rls,
      async (tx) =>
        Promise.all([
          tx.attendanceModification.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip: (page - 1) * pageSize,
            take: pageSize,
          }),
          tx.attendanceModification.count({ where }),
        ]),
    );

    return { items, total, page, pageSize };
  }

  /** Punches flagged as a face-match or geofence exception and not yet resolved. */
  async exceptions(caller: Caller, companyId: string) {
    const employees = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.employee.findMany({
        where: { companyId },
        select: {
          id: true,
          employeeCode: true,
          firstName: true,
          lastName: true,
        },
      }),
    );
    const byId = new Map(employees.map((e) => [e.id, e]));

    const rows = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.punchRecord.findMany({
        where: {
          employeeId: { in: employees.map((e) => e.id) },
          OR: [
            { faceMatchResult: 'exception' },
            { geofenceResult: 'exception' },
          ],
          exceptionResolution: 'pending',
        },
        orderBy: { capturedAt: 'desc' },
        take: 200,
      }),
    );

    return rows.map((r) => ({
      punchId: r.id,
      employeeId: r.employeeId,
      employeeCode: byId.get(r.employeeId)?.employeeCode ?? null,
      capturedAt: r.capturedAt,
      punchDate: r.punchDate.toISOString().slice(0, 10),
      faceMatchResult: r.faceMatchResult,
      geofenceResult: r.geofenceResult,
    }));
  }

  /**
   * The late-coming report (005 amendment US17).
   *
   * Reads the shift configuration 002 has carried since it was built and nothing
   * has consumed until now. Lateness is informational only — it never deducts pay
   * (FR-064); any deduction policy has to be specified explicitly rather than
   * inferred from this report existing.
   */
  async lateComingReport(
    caller: Caller,
    companyId: string,
    month: number,
    year: number,
    filters: { departmentId?: string; siteId?: string } = {},
  ) {
    const employees = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.employee.findMany({
        where: {
          companyId,
          isActive: true,
          ...(filters.departmentId
            ? { departmentId: filters.departmentId }
            : {}),
          ...(filters.siteId ? { siteId: filters.siteId } : {}),
        },
        orderBy: { employeeCode: 'asc' },
      }),
    );

    const threshold = this.hrPayroll.shiftCompliance.repeatLateComerThreshold;
    const rows = [];

    for (const employee of employees) {
      const shift = await this.shiftWindowFor(employee.shiftId);
      const { days } = await this.attendanceHistory.getMonthForEmployee(
        caller,
        employee,
        month,
        year,
      );

      const compliance: DayCompliance[] = days.map((d) =>
        dayCompliance(
          shift,
          { inTime: d.inTime, outTime: d.outTime },
          // Leave, holidays and weekly offs are not lateness — the employee was
          // never expected (FR-063).
          {
            excluded:
              d.status === 'on_leave' ||
              d.status === 'holiday' ||
              d.status === 'weekly_off',
          },
        ),
      );

      const summary = summarise(compliance, threshold);
      rows.push({
        employeeId: employee.id,
        employeeCode: employee.employeeCode,
        name: [employee.firstName, employee.lastName]
          .filter(Boolean)
          .join(' ')
          .trim(),
        departmentId: employee.departmentId,
        siteId: employee.siteId,
        ...summary,
      });
    }

    // Worst first — the report exists to surface who needs a conversation.
    rows.sort((a, b) => b.lateDays - a.lateDays);

    return {
      period: `${year}-${String(month).padStart(2, '0')}`,
      repeatLateComerThreshold: threshold,
      note: 'Informational only — lateness does not deduct pay (FR-064).',
      rows,
    };
  }

  /** The shift window for an employee, or null when none is configured. */
  private async shiftWindowFor(
    shiftId: string | null,
  ): Promise<ShiftWindow | null> {
    if (!shiftId) return null;
    try {
      const shift = await this.referenceData.getShift(shiftId);
      if (!shift) return null;
      return {
        inTime: shift.inTime,
        outTime: shift.outTime,
        graceMinutes: shift.graceMinutes,
      };
    } catch {
      // A shift that no longer resolves is "not configured" for reporting
      // purposes — better than failing the whole report for one bad reference.
      return null;
    }
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  /**
   * Writes one side (in or out) of an admin-marked day.
   *
   * `source: admin_correction` is what lets these rows exist without a photo or a
   * geofence result — the DB CHECK added alongside the nullable columns requires
   * capture data only for `employee`-sourced punches.
   */
  private async upsertSide(
    tx: Prisma.TransactionClient,
    dto: MarkAttendanceDto,
    date: Date,
    type: PunchType,
    time: string | undefined,
    caller: Caller,
  ): Promise<void> {
    const existing = await tx.punchRecord.findFirst({
      where: { employeeId: dto.employeeId, punchDate: date, type },
    });

    if (!time) {
      // A status-only mark (e.g. "absent") still needs somewhere to hang the
      // override and remarks, so update an existing row if there is one and
      // otherwise leave the day without punches.
      if (existing && (dto.statusOverride || dto.remarks)) {
        await tx.punchRecord.update({
          where: { id: existing.id },
          data: {
            statusOverride: dto.statusOverride ?? existing.statusOverride,
            remarks: dto.remarks ?? existing.remarks,
            adminEdited: true,
            editedByUserId: caller.userId,
            editedAt: new Date(),
          },
        });
      }
      return;
    }

    const capturedAt = new Date(`${dto.date}T${time}:00.000Z`);
    if (existing) {
      await tx.punchRecord.update({
        where: { id: existing.id },
        data: {
          capturedAt,
          statusOverride: dto.statusOverride ?? existing.statusOverride,
          remarks: dto.remarks ?? existing.remarks,
          adminEdited: true,
          editedByUserId: caller.userId,
          editedAt: new Date(),
        },
      });
      return;
    }

    await tx.punchRecord.create({
      data: {
        employeeId: dto.employeeId,
        type,
        capturedAt,
        punchDate: date,
        source: PunchSource.admin_correction,
        statusOverride: dto.statusOverride ?? null,
        remarks: dto.remarks ?? null,
        adminEdited: true,
        editedByUserId: caller.userId,
        editedAt: new Date(),
      },
    });
  }

  private snapshot(
    rows: {
      type: PunchType;
      capturedAt: Date;
      statusOverride: string | null;
    }[],
  ) {
    return {
      inTime: this.timeOf(
        rows.find((r) => r.type === PunchType.in)?.capturedAt,
      ),
      outTime: this.timeOf(
        rows.find((r) => r.type === PunchType.out)?.capturedAt,
      ),
      statusOverride:
        rows.find((r) => r.statusOverride)?.statusOverride ?? null,
    };
  }

  private timeOf(at: Date | undefined | null): string | null {
    if (!at) return null;
    return at.toISOString().slice(11, 16);
  }
}
