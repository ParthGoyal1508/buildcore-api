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
  EngagementType,
  LabourPaymentMode,
  MusterStatus,
  PaymentSheetLineStatus,
  PaymentSheetStatus,
  Prisma,
  RateSource,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { StorageService } from '../../common/storage/storage.service';
import { assertInScope, companyScope } from '../../settings/company-scope';
import { ProjectsService } from '../../projects/portfolio/projects.service';
import { ACKNOWLEDGEMENT_NAMESPACE } from '../constants/labour.constants';
import { LabourRefsService } from '../labour-refs.service';
import { WageRateService } from '../wage-rates/wage-rate.service';
import { computeWage, roundMoney, WorkedDay } from './wage-calc.util';
import { computeDenominationBreakup, WorkerNet } from './denomination.util';
import { decodePhotoPayload } from '../../hr/biometrics/photo-payload';
import { ImageProcessingService } from '../../hr/biometrics/image-processing.service';

export interface DeductionEntry {
  type: 'advance' | 'fine';
  advanceId?: string;
  amount: number;
  label: string;
}

@Injectable()
export class PaymentSheetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly refs: LabourRefsService,
    private readonly projects: ProjectsService,
    private readonly wageRates: WageRateService,
    private readonly storage: StorageService,
    private readonly images: ImageProcessingService,
  ) {}

  /**
   * Generates a draft sheet from the period's approved musters (FR-022): one line
   * per worker aggregating days, overtime, gross, advance deductions and net. A
   * worked date with no applicable rate fails with 409 naming the project, skill
   * category and date (FR-007). An overlapping sheet is rejected (FR-023).
   */
  async generate(
    caller: AuthenticatedUser,
    dto: {
      companyId?: string;
      projectId: string;
      periodFrom: string;
      periodTo: string;
      engagementType: EngagementType;
    },
    ipAddress: string,
  ) {
    const companyId = companyScope(caller, dto.companyId).companyId;
    if (!companyId) {
      throw new NotFoundException('Company not found');
    }
    const periodFrom = new Date(`${dto.periodFrom.slice(0, 10)}T00:00:00.000Z`);
    const periodTo = new Date(`${dto.periodTo.slice(0, 10)}T00:00:00.000Z`);
    if (periodTo < periodFrom) {
      throw new BadRequestException('periodTo must be on or after periodFrom');
    }

    const { otMultiplier } = await this.refs.getLabourSettings(companyId);
    const standardHours = this.refs.standardHoursPerDay;
    const siteIds = await this.projects.getSitesByProject(
      dto.projectId,
      rlsContextFor(caller),
    );

    const sheetId = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        // Overlap guard (FR-023).
        const overlap = await tx.labourPaymentSheet.findFirst({
          where: {
            companyId,
            projectId: dto.projectId,
            engagementType: dto.engagementType,
            deletedAt: null,
            periodFrom: { lte: periodTo },
            periodTo: { gte: periodFrom },
          },
        });
        if (overlap) {
          throw new ConflictException({
            message: 'A payment sheet overlapping this period already exists',
            existingSheetId: overlap.id,
          });
        }

        if (siteIds.length === 0) {
          throw new ConflictException(
            'This project has no sites, so there are no approved musters to bill',
          );
        }

        const musterLines = await tx.musterLine.findMany({
          where: {
            muster: {
              siteId: { in: siteIds },
              date: { gte: periodFrom, lte: periodTo },
              status: MusterStatus.approved,
              deletedAt: null,
            },
          },
          include: { muster: { select: { date: true } } },
        });

        if (musterLines.length === 0) {
          throw new ConflictException(
            'No approved musters found for this project and period',
          );
        }

        const workerIds = Array.from(
          new Set(musterLines.map((l) => l.workerId)),
        );
        const workers = await tx.labourWorker.findMany({
          where: { id: { in: workerIds } },
        });
        const workerById = new Map(workers.map((w) => [w.id, w]));

        // Group lines per worker, filtered to the requested engagement type.
        const perWorker = new Map<string, typeof musterLines>();
        for (const line of musterLines) {
          const worker = workerById.get(line.workerId);
          if (!worker || worker.engagementType !== dto.engagementType) continue;
          const list = perWorker.get(line.workerId) ?? [];
          list.push(line);
          perWorker.set(line.workerId, list);
        }

        if (perWorker.size === 0) {
          throw new ConflictException(
            'No approved musters for the requested engagement type in this period',
          );
        }

        const created = await tx.labourPaymentSheet.create({
          data: {
            companyId,
            projectId: dto.projectId,
            periodFrom,
            periodTo,
            engagementType: dto.engagementType,
            status: PaymentSheetStatus.draft,
            createdBy: caller.id,
          },
        });

        let grossTotal = 0;
        let deductionTotal = 0;
        let netTotal = 0;

        for (const [workerId, lines] of perWorker) {
          const worker = workerById.get(workerId);
          if (!worker) continue;
          const rateOverride = worker.rateOverride
            ? worker.rateOverride.toNumber()
            : null;

          const workedDays: WorkedDay[] = [];
          let resolvedRateForLine = rateOverride ?? 0;
          for (const line of lines) {
            const resolved = await this.wageRates.resolveRate(caller, {
              projectId: dto.projectId,
              skillCategoryId: line.skillCategoryIdOnDay,
              rateOverride,
              date: line.muster.date,
              tx,
            });
            if (!resolved) {
              throw new ConflictException({
                message:
                  'No wage rate applies for a worked date; create the rate before generating',
                projectId: dto.projectId,
                skillCategoryId: line.skillCategoryIdOnDay,
                date: line.muster.date.toISOString().slice(0, 10),
              });
            }
            resolvedRateForLine = resolved.rate;
            workedDays.push({
              attendanceType: line.attendanceType,
              overtimeHours: line.overtimeHours
                ? line.overtimeHours.toNumber()
                : 0,
              dailyRate: resolved.rate,
            });
          }

          const wage = computeWage(workedDays, standardHours, otMultiplier);

          const { deductions, deductionAmount } = await this.buildDeductions(
            tx,
            workerId,
            periodFrom,
            wage.grossWage,
          );

          const netPayable = roundMoney(
            Math.max(wage.grossWage - deductionAmount, 0),
          );

          await tx.paymentSheetLine.create({
            data: {
              companyId,
              sheetId: created.id,
              workerId,
              daysWorked: wage.daysWorked,
              overtimeHours: wage.overtimeHours,
              resolvedRate: resolvedRateForLine,
              rateSource:
                rateOverride !== null
                  ? RateSource.override
                  : RateSource.project_rate,
              grossWage: wage.grossWage,
              deductions: deductions as unknown as Prisma.InputJsonValue,
              netPayable,
              carriedForwardBalance: 0,
              status: PaymentSheetLineStatus.pending,
            },
          });

          grossTotal += wage.grossWage;
          deductionTotal += deductionAmount;
          netTotal += netPayable;
        }

        await tx.labourPaymentSheet.update({
          where: { id: created.id },
          data: {
            grossTotal: roundMoney(grossTotal),
            deductionTotal: roundMoney(deductionTotal),
            netTotal: roundMoney(netTotal),
          },
        });

        return created.id;
      },
    );

    await this.audit(AuditAction.CREATE, sheetId, companyId, caller, ipAddress);
    return this.findOne(caller, sheetId);
  }

  async findAll(
    caller: AuthenticatedUser,
    query: {
      companyId?: string;
      projectId?: string;
      engagementType?: EngagementType;
      status?: PaymentSheetStatus;
    },
  ) {
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.labourPaymentSheet.findMany({
          where: {
            ...companyScope(caller, query.companyId),
            deletedAt: null,
            ...(query.projectId ? { projectId: query.projectId } : {}),
            ...(query.engagementType
              ? { engagementType: query.engagementType }
              : {}),
            ...(query.status ? { status: query.status } : {}),
          },
          orderBy: { periodFrom: 'desc' },
        }),
    );
    return rows.map((row) => ({
      id: row.id,
      projectId: row.projectId,
      periodFrom: row.periodFrom.toISOString().slice(0, 10),
      periodTo: row.periodTo.toISOString().slice(0, 10),
      engagementType: row.engagementType,
      status: row.status,
      grossTotal: row.grossTotal.toNumber(),
      deductionTotal: row.deductionTotal.toNumber(),
      netTotal: row.netTotal.toNumber(),
    }));
  }

  async findOne(caller: AuthenticatedUser, id: string) {
    const row = await withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
      tx.labourPaymentSheet.findUnique({
        where: { id },
        include: { lines: true },
      }),
    );
    if (!row || row.deletedAt) {
      throw new NotFoundException(`Payment sheet ${id} not found`);
    }
    assertInScope(caller, row, `Payment sheet ${id}`);

    const disbursed = row.lines.filter(
      (l) => l.status === PaymentSheetLineStatus.disbursed,
    );
    const pending = row.lines.filter(
      (l) => l.status === PaymentSheetLineStatus.pending,
    );
    const disbursedAmount = roundMoney(
      disbursed.reduce((s, l) => s + (l.paidAmount?.toNumber() ?? 0), 0),
    );
    const outstandingAmount = roundMoney(
      pending.reduce((s, l) => s + l.netPayable.toNumber(), 0),
    );

    return {
      id: row.id,
      projectId: row.projectId,
      periodFrom: row.periodFrom.toISOString().slice(0, 10),
      periodTo: row.periodTo.toISOString().slice(0, 10),
      engagementType: row.engagementType,
      status: row.status,
      grossTotal: row.grossTotal.toNumber(),
      deductionTotal: row.deductionTotal.toNumber(),
      netTotal: row.netTotal.toNumber(),
      denominationBreakup: row.denominationBreakup ?? null,
      approvedBy: row.approvedBy,
      closedAt: row.closedAt ? row.closedAt.toISOString() : null,
      summary: {
        disbursedCount: disbursed.length,
        pendingCount: pending.length,
        disbursedAmount,
        outstandingAmount,
      },
      lines: row.lines.map((l) => ({
        id: l.id,
        workerId: l.workerId,
        daysWorked: l.daysWorked.toNumber(),
        overtimeHours: l.overtimeHours.toNumber(),
        resolvedRate: l.resolvedRate.toNumber(),
        rateSource: l.rateSource,
        grossWage: l.grossWage.toNumber(),
        deductions: l.deductions,
        netPayable: l.netPayable.toNumber(),
        paymentMode: l.paymentMode,
        paidOn: l.paidOn ? l.paidOn.toISOString().slice(0, 10) : null,
        paidAmount: l.paidAmount ? l.paidAmount.toNumber() : null,
        shortPaymentReason: l.shortPaymentReason,
        carriedForwardBalance: l.carriedForwardBalance.toNumber(),
        status: l.status,
      })),
    };
  }

  /** Approves a sheet, freezing every figure (FR-026). A direct-engagement sheet
   * gains its cash denomination breakup at this point (FR-027); a contractor sheet
   * does not (FR-028). */
  async approve(caller: AuthenticatedUser, id: string, ipAddress: string) {
    const companyId = caller.companyId;
    await withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
      const sheet = await tx.labourPaymentSheet.findUnique({
        where: { id },
        include: { lines: true },
      });
      if (!sheet || sheet.deletedAt) {
        throw new NotFoundException(`Payment sheet ${id} not found`);
      }
      assertInScope(caller, sheet, `Payment sheet ${id}`);
      if (sheet.status !== PaymentSheetStatus.draft) {
        throw new ConflictException('Only a draft sheet can be approved');
      }

      let denominationBreakup: Prisma.InputJsonValue | undefined;
      if (sheet.engagementType === EngagementType.direct) {
        const { cashDenominations } = await this.refs.getLabourSettings(
          sheet.companyId,
        );
        const nets: WorkerNet[] = sheet.lines.map((l) => ({
          workerId: l.workerId,
          netPayable: l.netPayable.toNumber(),
        }));
        denominationBreakup = computeDenominationBreakup(
          nets,
          cashDenominations,
        ) as unknown as Prisma.InputJsonValue;
      }

      await tx.labourPaymentSheet.update({
        where: { id },
        data: {
          status: PaymentSheetStatus.approved,
          approvedBy: caller.id,
          approvedAt: new Date(),
          ...(denominationBreakup ? { denominationBreakup } : {}),
        },
      });
    });
    await this.audit(
      AuditAction.UPDATE,
      id,
      companyId ?? null,
      caller,
      ipAddress,
    );
    return this.findOne(caller, id);
  }

  /** The cash denomination breakup for an approved direct sheet (FR-027). */
  async getDenominations(caller: AuthenticatedUser, id: string) {
    const sheet = await this.findOne(caller, id);
    if (sheet.engagementType !== EngagementType.direct) {
      throw new BadRequestException(
        'Contractor sheets have no cash denomination breakup',
      );
    }
    if (sheet.status === PaymentSheetStatus.draft) {
      throw new ConflictException(
        'Denominations are available only once the sheet is approved',
      );
    }
    return sheet.denominationBreakup;
  }

  /** Reopens an approved sheet to draft, blocked once any line is disbursed. */
  async reopen(
    caller: AuthenticatedUser,
    id: string,
    reason: string,
    ipAddress: string,
  ) {
    await withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
      const sheet = await tx.labourPaymentSheet.findUnique({
        where: { id },
        include: { lines: true },
      });
      if (!sheet || sheet.deletedAt) {
        throw new NotFoundException(`Payment sheet ${id} not found`);
      }
      assertInScope(caller, sheet, `Payment sheet ${id}`);
      const anyDisbursed = sheet.lines.some(
        (l) => l.status === PaymentSheetLineStatus.disbursed,
      );
      if (anyDisbursed) {
        throw new ConflictException(
          'This sheet has a disbursed line and cannot be reopened',
        );
      }
      await tx.labourPaymentSheet.update({
        where: { id },
        data: {
          status: PaymentSheetStatus.draft,
          reopenReason: reason,
          denominationBreakup: Prisma.DbNull,
          approvedBy: null,
          approvedAt: null,
        },
      });
    });
    await this.audit(
      AuditAction.UPDATE,
      id,
      caller.companyId ?? null,
      caller,
      ipAddress,
    );
    return this.findOne(caller, id);
  }

  private async buildDeductions(
    tx: Prisma.TransactionClient,
    workerId: string,
    periodFrom: Date,
    grossWage: number,
  ): Promise<{ deductions: DeductionEntry[]; deductionAmount: number }> {
    const advances = await tx.labourAdvance.findMany({
      where: {
        workerId,
        status: AdvanceStatus.disbursed,
        outstandingBalance: { gt: 0 },
        recoveryStartPeriod: { lte: periodFrom },
        deletedAt: null,
      },
      orderBy: { createdAt: 'asc' },
    });

    const deductions: DeductionEntry[] = [];
    let remainingGross = grossWage;
    let deductionAmount = 0;

    for (const advance of advances) {
      if (remainingGross <= 0) break;
      const instalment = advance.instalmentAmount.toNumber();
      const outstanding = advance.outstandingBalance.toNumber();
      // Capped so net never goes negative (FR-024); remainder carries forward.
      const amount = roundMoney(
        Math.min(instalment, outstanding, remainingGross),
      );
      if (amount <= 0) continue;
      deductions.push({
        type: 'advance',
        advanceId: advance.id,
        amount,
        label: 'Advance recovery',
      });
      deductionAmount += amount;
      remainingGross -= amount;
    }

    return { deductions, deductionAmount: roundMoney(deductionAmount) };
  }

  private async audit(
    action: AuditAction,
    entityId: string,
    companyId: string | null,
    caller: AuthenticatedUser,
    ipAddress: string,
  ) {
    await this.auditLog.record({
      entityType: AuditEntityType.LABOUR_PAYMENT_SHEET,
      action,
      entityId,
      accountId: caller.id,
      companyId,
      ipAddress,
    });
  }

  // ── Disbursement (US6) ────────────────────────────────────────────────────────

  async disburseLine(
    caller: AuthenticatedUser,
    lineId: string,
    dto: {
      paymentMode: LabourPaymentMode;
      paidOn: string;
      paidAmount: number;
      acknowledgement?: string;
      shortPaymentReason?: string;
    },
    ipAddress: string,
  ) {
    let sheetId = '';
    await withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
      const line = await tx.paymentSheetLine.findUnique({
        where: { id: lineId },
        include: { sheet: true },
      });
      if (!line) {
        throw new NotFoundException(`Payment line ${lineId} not found`);
      }
      assertInScope(caller, line, `Payment line ${lineId}`);
      sheetId = line.sheetId;

      if (
        line.sheet.status !== PaymentSheetStatus.approved &&
        line.sheet.status !== PaymentSheetStatus.partially_disbursed
      ) {
        throw new ConflictException('Only an approved sheet can be disbursed');
      }
      if (line.status !== PaymentSheetLineStatus.pending) {
        throw new ConflictException('This line is already disbursed');
      }

      let acknowledgementRef: string | null = null;
      if (dto.paymentMode === LabourPaymentMode.cash) {
        if (!dto.acknowledgement) {
          throw new BadRequestException(
            'A cash disbursement requires an acknowledgement image',
          );
        }
        const bytes = decodePhotoPayload(
          dto.acknowledgement,
          'Acknowledgement image',
        );
        const compressed = await this.images.compressReceipt(bytes);
        acknowledgementRef = await this.storage.put(
          ACKNOWLEDGEMENT_NAMESPACE,
          compressed,
          'image/jpeg',
        );
      } else {
        const worker = await tx.labourWorker.findUnique({
          where: { id: line.workerId },
          select: { bankAccount: true },
        });
        if (!worker?.bankAccount) {
          throw new BadRequestException(
            'This worker has no recorded bank account for a bank transfer',
          );
        }
      }

      const netPayable = line.netPayable.toNumber();
      let carriedForward = 0;
      if (dto.paidAmount !== netPayable) {
        if (!dto.shortPaymentReason) {
          throw new BadRequestException(
            'A paid amount differing from net payable requires a reason',
          );
        }
        carriedForward = roundMoney(netPayable - dto.paidAmount);
      }

      // Apply advance recovery (FR-025): outstanding reduced only now.
      const deductions = Array.isArray(line.deductions)
        ? (line.deductions as unknown as DeductionEntry[])
        : [];
      for (const d of deductions) {
        if (d.type === 'advance' && d.advanceId) {
          await this.applyRecovery(tx, d.advanceId, d.amount);
        }
      }

      await tx.paymentSheetLine.update({
        where: { id: lineId },
        data: {
          paymentMode: dto.paymentMode,
          paidOn: new Date(`${dto.paidOn.slice(0, 10)}T00:00:00.000Z`),
          paidAmount: dto.paidAmount,
          acknowledgementRef,
          shortPaymentReason: dto.shortPaymentReason ?? null,
          carriedForwardBalance: carriedForward,
          status: PaymentSheetLineStatus.disbursed,
        },
      });

      await this.recomputeSheetStatus(tx, line.sheetId);
    });

    await this.audit(
      AuditAction.UPDATE,
      sheetId,
      caller.companyId ?? null,
      caller,
      ipAddress,
    );
    return this.findOne(caller, sheetId);
  }

  async reverseLine(
    caller: AuthenticatedUser,
    lineId: string,
    reason: string,
    ipAddress: string,
  ) {
    let sheetId = '';
    await withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
      const line = await tx.paymentSheetLine.findUnique({
        where: { id: lineId },
        include: { sheet: true },
      });
      if (!line) {
        throw new NotFoundException(`Payment line ${lineId} not found`);
      }
      assertInScope(caller, line, `Payment line ${lineId}`);
      sheetId = line.sheetId;

      if (line.status !== PaymentSheetLineStatus.disbursed) {
        throw new ConflictException('Only a disbursed line can be reversed');
      }
      if (line.sheet.status === PaymentSheetStatus.closed) {
        throw new ConflictException(
          'Reopen the closed sheet before reversing a line',
        );
      }

      const deductions = Array.isArray(line.deductions)
        ? (line.deductions as unknown as DeductionEntry[])
        : [];
      for (const d of deductions) {
        if (d.type === 'advance' && d.advanceId) {
          await this.applyRecovery(tx, d.advanceId, -d.amount);
        }
      }

      await tx.paymentSheetLine.update({
        where: { id: lineId },
        data: {
          status: PaymentSheetLineStatus.pending,
          paymentMode: null,
          paidOn: null,
          paidAmount: null,
          acknowledgementRef: null,
          shortPaymentReason: null,
          carriedForwardBalance: 0,
          reversalReason: reason,
        },
      });

      await this.recomputeSheetStatus(tx, line.sheetId);
    });

    await this.audit(
      AuditAction.UPDATE,
      sheetId,
      caller.companyId ?? null,
      caller,
      ipAddress,
    );
    return this.findOne(caller, sheetId);
  }

  /** Reduces an advance's outstanding balance by `amount` (negative reverses),
   * closing it at zero (US7 AC7). */
  private async applyRecovery(
    tx: Prisma.TransactionClient,
    advanceId: string,
    amount: number,
  ) {
    const advance = await tx.labourAdvance.findUnique({
      where: { id: advanceId },
    });
    if (!advance) return;
    const next = roundMoney(
      Math.max(advance.outstandingBalance.toNumber() - amount, 0),
    );
    await tx.labourAdvance.update({
      where: { id: advanceId },
      data: {
        outstandingBalance: next,
        status: next <= 0 ? AdvanceStatus.closed : AdvanceStatus.disbursed,
      },
    });
  }

  private async recomputeSheetStatus(
    tx: Prisma.TransactionClient,
    sheetId: string,
  ) {
    const lines = await tx.paymentSheetLine.findMany({
      where: { sheetId },
      select: { status: true },
    });
    const anyDisbursed = lines.some(
      (l) => l.status === PaymentSheetLineStatus.disbursed,
    );
    const allDisbursed = lines.every(
      (l) => l.status === PaymentSheetLineStatus.disbursed,
    );
    await tx.labourPaymentSheet.update({
      where: { id: sheetId },
      data: allDisbursed
        ? { status: PaymentSheetStatus.closed, closedAt: new Date() }
        : anyDisbursed
        ? { status: PaymentSheetStatus.partially_disbursed, closedAt: null }
        : { status: PaymentSheetStatus.approved, closedAt: null },
    });
  }
}
