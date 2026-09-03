import { Injectable } from '@nestjs/common';
import { AuditAction, AuditEntityType, Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { ProjectsService } from '../../projects/portfolio/projects.service';
import { CompaniesService } from '../../settings/companies/companies.service';
import { companyScope } from '../../settings/company-scope';
import { CreateBocwPaymentDto } from './dto/bocw.dto';

export type BocwStatus = 'pending' | 'partial' | 'paid';

export interface BocwProjectRow {
  projectId: string;
  projectName: string;
  contractValue: number;
  cessRate: number;
  cessLiability: number;
  totalPaid: number;
  balance: number;
  status: BocwStatus;
}

export interface BocwListResponse {
  cessRate: number;
  rows: BocwProjectRow[];
  /**
   * Modules whose data this view needs but cannot get. Present so the screen can say
   * *why* it is empty instead of implying the company has no projects.
   */
  unavailableModules: string[];
}

/** Rounded to paise. Cess is money owed to a statutory board, and a floating-point
 * tail on a figure someone pays against is a reconciliation problem later. */
function toPaise(value: number): number {
  return Math.round(value * 100) / 100;
}

export function deriveStatus(balance: number, totalPaid: number): BocwStatus {
  if (balance <= 0) return 'paid';
  if (totalPaid > 0) return 'partial';
  return 'pending';
}

/**
 * BOCW cess liability and payments (007 US6).
 *
 * Liability, total paid and balance are all computed at request time from the
 * contract value, the company's rate and the payments on file (research.md §5). None
 * is stored: a persisted balance is a second source of truth that goes stale the
 * moment a payment is corrected, and reconciling it would be work with no upside.
 *
 * The project side of this depends on feature 008, which does not exist. Rather than
 * failing, the list comes back empty with `unavailableModules: ['projects']`.
 */
@Injectable()
export class BOCWService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly projects: ProjectsService,
    private readonly companies: CompaniesService,
  ) {}

  async list(
    caller: AuthenticatedUser,
    companyId?: string,
  ): Promise<BocwListResponse> {
    const scope = companyScope(caller, companyId);
    const targetCompanyId = scope.companyId;
    if (!targetCompanyId) {
      return { cessRate: 0, rows: [], unavailableModules: ['projects'] };
    }

    const cessRate = await this.companies.getBocwCessRate(targetCompanyId);
    const unavailableModules = this.projects.isPortfolioAvailable()
      ? []
      : ['projects'];
    const projects = await this.projects.getProjectsWithContractValues(
      targetCompanyId,
    );

    if (projects.length === 0) {
      return { cessRate, rows: [], unavailableModules };
    }

    const payments = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.bOCWPayment.groupBy({
          by: ['projectId'],
          where: {
            companyId: targetCompanyId,
            projectId: { in: projects.map((project) => project.projectId) },
          },
          _sum: { amountPaid: true },
        }),
    );
    const paidByProject = new Map(
      payments.map((row) => [row.projectId, Number(row._sum.amountPaid ?? 0)]),
    );

    return {
      cessRate,
      unavailableModules,
      rows: projects.map((project) => {
        const cessLiability = toPaise(project.contractValue * cessRate);
        const totalPaid = toPaise(paidByProject.get(project.projectId) ?? 0);
        const balance = toPaise(cessLiability - totalPaid);
        return {
          projectId: project.projectId,
          projectName: project.name,
          contractValue: project.contractValue,
          cessRate,
          cessLiability,
          totalPaid,
          balance,
          status: deriveStatus(balance, totalPaid),
        };
      }),
    };
  }

  async listPayments(
    caller: AuthenticatedUser,
    projectId: string,
    companyId?: string,
  ): Promise<Record<string, unknown>[]> {
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.bOCWPayment.findMany({
          where: { ...companyScope(caller, companyId), projectId },
          orderBy: { paymentDate: 'desc' },
        }),
    );
    return rows.map((row) => ({
      ...row,
      amountPaid: Number(row.amountPaid as unknown as Prisma.Decimal),
    }));
  }

  async recordPayment(
    caller: AuthenticatedUser,
    projectId: string,
    dto: CreateBocwPaymentDto,
    ipAddress: string,
    companyId?: string,
  ): Promise<Record<string, unknown>> {
    const scope = companyScope(caller, companyId);
    const targetCompanyId = scope.companyId ?? caller.companyId;
    if (!targetCompanyId) {
      throw new Error('companyId is required for a cross-company caller.');
    }

    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.bOCWPayment.create({
          data: {
            companyId: targetCompanyId,
            projectId,
            amountPaid: dto.amountPaid,
            paymentDate: new Date(dto.paymentDate),
            referenceNumber: dto.referenceNumber.trim(),
            remarks: dto.remarks?.trim() ?? null,
            recordedByUserId: caller.id,
          },
        }),
    );

    await this.auditLog.record({
      entityType: AuditEntityType.BOCW_PAYMENT,
      action: AuditAction.CREATE,
      entityId: created.id,
      accountId: caller.id,
      companyId: created.companyId,
      ipAddress,
    });
    return { ...created, amountPaid: Number(created.amountPaid) };
  }
}
