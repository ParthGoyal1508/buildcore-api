import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AuditAction,
  AuditEntityType,
  Prisma,
  PunchSource,
  PunchType,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import type {
  HrPayrollConfig,
  SettingsConfig,
} from '../../common/configs/config.interface';
import { withRlsContext } from '../../common/prisma/rls-context';
import { CompaniesService } from '../../settings/companies/companies.service';
import type { Caller } from '../biometrics/face-enrolment.service';
import { EmployeeDocumentsService } from '../employees/documents/employee-documents.service';
import { isPayrollLocked } from '../punch/payroll-lock';
import { AttendanceHistoryService } from '../punch/attendance-history.service';
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

  constructor(
    private readonly prisma: PrismaService,
    private readonly companies: CompaniesService,
    private readonly employeeDocuments: EmployeeDocumentsService,
    private readonly attendanceHistory: AttendanceHistoryService,
    private readonly referenceData: ReferenceDataService,
    private readonly auditLog: AuditLogService,
    configService: ConfigService,
  ) {
    this.timeZone = configService.get<SettingsConfig>('settings').timezone;
    this.hrPayroll = configService.get<HrPayrollConfig>('hrPayroll');
  }

  /** Attendance for one date, optionally narrowed to a site. */
  async daily(
    caller: Caller,
    companyId: string,
    query: DailyAttendanceQueryDto,
  ): Promise<DailyAttendanceRow[]> {
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
  async mark(
    caller: Caller,
    dto: MarkAttendanceDto,
  ): Promise<{ employeeId: string; date: string }> {
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

    await this.employeeDocuments.assertMandatoryDocsComplete(
      employee.id,
      employee.companyId,
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

    return { employeeId: dto.employeeId, date: dto.date };
  }

  /** The Modifications audit trail, newest first. */
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
        select: { id: true, employeeCode: true, firstName: true, lastName: true },
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

    const threshold =
      this.hrPayroll.shiftCompliance.repeatLateComerThreshold;
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

  private snapshot(rows: { type: PunchType; capturedAt: Date; statusOverride: string | null }[]) {
    return {
      inTime: this.timeOf(rows.find((r) => r.type === PunchType.in)?.capturedAt),
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
