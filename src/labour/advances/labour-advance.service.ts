import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AdvanceStatus,
  AuditAction,
  AuditEntityType,
  Prisma,
  WorkerStatus,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { assertInScope, companyScope } from '../../settings/company-scope';
import { SkillCategoriesService } from '../../settings/skill-categories/skill-categories.service';
import { LabourRefsService } from '../labour-refs.service';
import { roundMoney } from '../payment-sheets/wage-calc.util';
import { parseDateOnly } from '../wage-rates/wage-rate.service';

export interface AdvanceView {
  id: string;
  workerId: string;
  amount: number;
  reason: string;
  recoveryInstalments: number;
  instalmentAmount: number;
  recoveryStartPeriod: string;
  outstandingBalance: number;
  exceedsLimit: boolean;
  status: AdvanceStatus;
  recoveryAtRisk: boolean;
}

@Injectable()
export class LabourAdvanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly refs: LabourRefsService,
    private readonly skillCategories: SkillCategoriesService,
  ) {}

  async findAll(
    caller: AuthenticatedUser,
    query: { companyId?: string; workerId?: string; status?: AdvanceStatus },
  ): Promise<AdvanceView[]> {
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.labourAdvance.findMany({
          where: {
            ...companyScope(caller, query.companyId),
            deletedAt: null,
            ...(query.workerId ? { workerId: query.workerId } : {}),
            ...(query.status ? { status: query.status } : {}),
          },
          orderBy: { createdAt: 'desc' },
        }),
    );

    const workerStatuses = await this.workerStatuses(
      caller,
      rows.map((r) => r.workerId),
    );
    return rows.map((row) =>
      this.toView(
        row,
        workerStatuses.get(row.workerId) === WorkerStatus.inactive,
      ),
    );
  }

  async findOne(caller: AuthenticatedUser, id: string) {
    const row = await withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
      tx.labourAdvance.findUnique({ where: { id } }),
    );
    if (!row || row.deletedAt) {
      throw new NotFoundException(`Advance ${id} not found`);
    }
    assertInScope(caller, row, `Advance ${id}`);

    const statuses = await this.workerStatuses(caller, [row.workerId]);
    // Recovery history: disbursed sheet lines whose deductions recovered this advance.
    const disbursedLines = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.paymentSheetLine.findMany({
          where: { workerId: row.workerId, status: 'disbursed' },
          select: { id: true, sheetId: true, deductions: true, paidOn: true },
        }),
    );
    const recoveryHistory = disbursedLines.flatMap((line) => {
      const deductions = Array.isArray(line.deductions)
        ? (line.deductions as unknown as DeductionEntry[])
        : [];
      return deductions
        .filter((d) => d.type === 'advance' && d.advanceId === id)
        .map((d) => ({
          sheetId: line.sheetId,
          lineId: line.id,
          amount: d.amount,
          paidOn: line.paidOn ? line.paidOn.toISOString().slice(0, 10) : null,
        }));
    });

    return {
      ...this.toView(row, statuses.get(row.workerId) === WorkerStatus.inactive),
      recoveryHistory,
    };
  }

  async create(
    caller: AuthenticatedUser,
    dto: {
      companyId?: string;
      workerId: string;
      amount: number;
      reason: string;
      recoveryInstalments: number;
      recoveryStartPeriod: string;
    },
    ipAddress: string,
  ): Promise<AdvanceView> {
    const companyId = companyScope(caller, dto.companyId).companyId;
    if (!companyId) {
      throw new NotFoundException('Company not found');
    }
    if (dto.recoveryInstalments < 1) {
      throw new BadRequestException('Recovery instalments must be at least 1');
    }

    const dailyRate = await this.workerDailyRate(caller, dto.workerId);
    const exceedsLimit =
      dailyRate !== null &&
      dto.amount > dailyRate * this.refs.advanceLimitMultiple;

    const instalmentAmount = roundMoney(dto.amount / dto.recoveryInstalments);

    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.labourAdvance.create({
          data: {
            companyId,
            workerId: dto.workerId,
            amount: dto.amount,
            reason: dto.reason,
            recoveryInstalments: dto.recoveryInstalments,
            instalmentAmount,
            recoveryStartPeriod: parseDateOnly(dto.recoveryStartPeriod),
            outstandingBalance: 0,
            exceedsLimit,
            status: AdvanceStatus.pending,
            createdBy: caller.id,
          },
        }),
    );

    await this.audit(
      AuditAction.CREATE,
      created.id,
      companyId,
      caller,
      ipAddress,
    );
    return this.toView(created, false);
  }

  async approve(caller: AuthenticatedUser, id: string, ipAddress: string) {
    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.labourAdvance.findUnique({ where: { id } });
        if (!existing || existing.deletedAt) {
          throw new NotFoundException(`Advance ${id} not found`);
        }
        assertInScope(caller, existing, `Advance ${id}`);
        if (existing.status !== AdvanceStatus.pending) {
          throw new ConflictException('Only a pending advance can be approved');
        }
        return tx.labourAdvance.update({
          where: { id },
          data: {
            status: AdvanceStatus.approved,
            approvedBy: caller.id,
            approvedAt: new Date(),
          },
        });
      },
    );
    await this.audit(
      AuditAction.UPDATE,
      id,
      updated.companyId,
      caller,
      ipAddress,
    );
    return this.toView(updated, false);
  }

  /** Disburses an approved advance: its outstanding balance becomes the full amount
   * and recovery begins from the configured start period (US7 AC4). */
  async disburse(caller: AuthenticatedUser, id: string, ipAddress: string) {
    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.labourAdvance.findUnique({ where: { id } });
        if (!existing || existing.deletedAt) {
          throw new NotFoundException(`Advance ${id} not found`);
        }
        assertInScope(caller, existing, `Advance ${id}`);
        if (existing.status !== AdvanceStatus.approved) {
          throw new ConflictException(
            'Only an approved advance can be disbursed',
          );
        }
        return tx.labourAdvance.update({
          where: { id },
          data: {
            status: AdvanceStatus.disbursed,
            outstandingBalance: existing.amount,
            disbursedOn: new Date(),
          },
        });
      },
    );
    await this.audit(
      AuditAction.UPDATE,
      id,
      updated.companyId,
      caller,
      ipAddress,
    );
    return this.toView(updated, false);
  }

  private toView(
    row: {
      id: string;
      workerId: string;
      amount: Prisma.Decimal;
      reason: string;
      recoveryInstalments: number;
      instalmentAmount: Prisma.Decimal;
      recoveryStartPeriod: Date;
      outstandingBalance: Prisma.Decimal;
      exceedsLimit: boolean;
      status: AdvanceStatus;
    },
    recoveryAtRisk: boolean,
  ): AdvanceView {
    return {
      id: row.id,
      workerId: row.workerId,
      amount: row.amount.toNumber(),
      reason: row.reason,
      recoveryInstalments: row.recoveryInstalments,
      instalmentAmount: row.instalmentAmount.toNumber(),
      recoveryStartPeriod: row.recoveryStartPeriod.toISOString().slice(0, 10),
      outstandingBalance: row.outstandingBalance.toNumber(),
      exceedsLimit: row.exceedsLimit,
      status: row.status,
      recoveryAtRisk,
    };
  }

  private async workerDailyRate(
    caller: AuthenticatedUser,
    workerId: string,
  ): Promise<number | null> {
    const worker = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.labourWorker.findUnique({
          where: { id: workerId },
          select: {
            rateOverride: true,
            skillCategoryId: true,
            deletedAt: true,
          },
        }),
    );
    if (!worker || worker.deletedAt) {
      throw new BadRequestException(`Worker ${workerId} not found`);
    }
    if (worker.rateOverride) return worker.rateOverride.toNumber();
    const category = await this.skillCategories.getById(
      caller,
      worker.skillCategoryId,
    );
    return category?.defaultDailyRate ?? null;
  }

  private async workerStatuses(
    caller: AuthenticatedUser,
    workerIds: string[],
  ): Promise<Map<string, WorkerStatus>> {
    if (workerIds.length === 0) return new Map();
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.labourWorker.findMany({
          where: { id: { in: workerIds } },
          select: { id: true, status: true },
        }),
    );
    return new Map(rows.map((r) => [r.id, r.status]));
  }

  private async audit(
    action: AuditAction,
    entityId: string,
    companyId: string | null,
    caller: AuthenticatedUser,
    ipAddress: string,
  ) {
    await this.auditLog.record({
      entityType: AuditEntityType.LABOUR_ADVANCE,
      action,
      entityId,
      accountId: caller.id,
      companyId,
      ipAddress,
    });
  }
}

interface DeductionEntry {
  type: 'advance' | 'fine';
  advanceId?: string;
  amount: number;
  label: string;
}
