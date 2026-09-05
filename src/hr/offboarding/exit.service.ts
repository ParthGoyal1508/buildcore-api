import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, AuditEntityType, ExitReason } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import {
  withRlsContext,
  type RlsContext,
} from '../../common/prisma/rls-context';
import type { Caller } from '../biometrics/face-enrolment.service';
import type { InitiateExitDto } from './dto/exit.dto';

/**
 * Employee offboarding (005 US11, FR-031/FR-034/FR-035).
 *
 * Owns the exit *record* and the deactivation that follows a settled F&F. The
 * settlement arithmetic lives in `payroll`, because it is payroll — see
 * `FnfService`.
 */
@Injectable()
export class ExitService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  /**
   * Records an employee's exit.
   *
   * The employee stays active until the F&F is processed (FR-034): they may still
   * be working out a notice period, and deactivating them here would block the
   * attendance that period generates — attendance the settlement then needs.
   */
  async initiate(caller: Caller, employeeId: string, dto: InitiateExitDto) {
    const employee = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.employee.findFirst({
        where: { id: employeeId },
        select: { id: true, companyId: true, isActive: true },
      }),
    );
    if (!employee) throw new NotFoundException('Employee not found');
    if (!employee.isActive) {
      throw new ConflictException('That employee is already inactive.');
    }

    const open = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.exitRecord.findFirst({
        where: { employeeId, fnfPayrollRunId: null },
      }),
    );
    if (open) {
      throw new ConflictException(
        'An exit is already in progress for that employee.',
      );
    }

    const record = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.exitRecord.create({
        data: {
          employeeId,
          // No companyId column: ExitRecord is employee-owned and scoped through
          // the Employee by RLS, deliberately not carrying a copied tenant key.
          lastWorkingDay: new Date(`${dto.lastWorkingDay}T00:00:00.000Z`),
          reason: dto.reason,
          remarks: dto.remarks?.trim() ?? null,
          initiatedByUserId: caller.userId,
        },
      }),
    );

    await this.auditLog.record({
      entityType: AuditEntityType.EXIT_RECORD,
      action: AuditAction.CREATE,
      entityId: record.id,
      changes: {
        lastWorkingDay: dto.lastWorkingDay,
        reason: dto.reason,
      },
      accountId: caller.userId,
      companyId: employee.companyId,
      ipAddress: caller.ipAddress,
    });

    return this.toView(record);
  }

  /** The open exit record for an employee, if there is one. */
  async getOpen(caller: Caller, employeeId: string) {
    const record = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.exitRecord.findFirst({
        where: { employeeId },
        orderBy: { createdAt: 'desc' },
      }),
    );
    return record ? this.toView(record) : null;
  }

  /**
   * Whether the employee's Full & Final run has been processed — an exit record
   * that carries a `fnfPayrollRunId`. Exported for feature 011, which gates
   * relieving-letter generation on it (011 FR-023). Takes an `RlsContext` rather
   * than a full `Caller` so a cross-module caller can pass its own scope.
   */
  async isFnfProcessed(ctx: RlsContext, employeeId: string): Promise<boolean> {
    const record = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.exitRecord.findFirst({
        where: { employeeId, fnfPayrollRunId: { not: null } },
        select: { id: true },
      }),
    );
    return record !== null;
  }

  /**
   * Deactivates an employee and their login once the F&F run is processed
   * (FR-034).
   *
   * Both halves matter: an inactive employee who can still sign in retains access
   * to `/my/*`, and an active employee record keeps appearing in payroll
   * generation. Historical records are untouched — the employee is retired, not
   * erased.
   */
  async deactivateAfterSettlement(
    caller: Caller,
    employeeId: string,
    exitRecordId: string,
    fnfPayrollRunId: string,
  ): Promise<void> {
    await withRlsContext(this.prisma, caller.rls, async (tx) => {
      const employee = await tx.employee.update({
        where: { id: employeeId },
        data: { isActive: false },
        select: { userId: true, companyId: true },
      });

      await tx.exitRecord.update({
        where: { id: exitRecordId },
        data: { fnfPayrollRunId },
      });

      if (employee.userId) {
        await tx.user.update({
          where: { id: employee.userId },
          data: { status: 'deactivated' },
        });
        // Every issued refresh token is revoked, not just the current one: a
        // deactivated account that can still mint an access token from a stored
        // refresh token has not really been deactivated.
        await tx.refreshToken.updateMany({
          where: { accountId: employee.userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
    });

    await this.auditLog.record({
      entityType: AuditEntityType.EXIT_RECORD,
      action: AuditAction.UPDATE,
      entityId: exitRecordId,
      changes: { employeeDeactivated: true, fnfPayrollRunId },
      accountId: caller.userId,
      companyId: caller.companyId,
      ipAddress: caller.ipAddress,
    });
  }

  /**
   * Rejects attendance, leave and payroll actions against an inactive employee
   * (FR-035).
   *
   * Exported so every such path calls the same check rather than each
   * remembering to test the flag.
   */
  async assertEmployeeActive(
    caller: Caller,
    employeeId: string,
  ): Promise<void> {
    const employee = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.employee.findFirst({
        where: { id: employeeId },
        select: { isActive: true },
      }),
    );
    if (!employee) throw new NotFoundException('Employee not found');
    if (!employee.isActive) {
      throw new BadRequestException(
        'That employee has exited; attendance, leave and payroll actions are closed.',
      );
    }
  }

  private toView(record: {
    id: string;
    employeeId: string;
    lastWorkingDay: Date;
    reason: ExitReason;
    remarks: string | null;
    fnfPayrollRunId: string | null;
    createdAt: Date;
  }) {
    return {
      id: record.id,
      employeeId: record.employeeId,
      lastWorkingDay: record.lastWorkingDay.toISOString().slice(0, 10),
      reason: record.reason,
      remarks: record.remarks,
      fnfPayrollRunId: record.fnfPayrollRunId,
      settled: record.fnfPayrollRunId !== null,
      createdAt: record.createdAt,
    };
  }
}
