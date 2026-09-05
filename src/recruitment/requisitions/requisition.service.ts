import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  CodeSeriesType,
  Prisma,
  RequisitionEmploymentType,
  RequisitionStatus,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { assertInScope, companyScope } from '../../settings/company-scope';
import { CodeSeriesService } from '../../settings/code-series/code-series.service';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  REQUISITION_CODE_INFIX,
} from '../constants/recruitment.constants';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface RequisitionView {
  id: string;
  requisitionCode: string;
  departmentId: string;
  designationId: string;
  positionCount: number;
  filledPositions: number;
  openPositions: number;
  employmentType: RequisitionEmploymentType;
  projectId: string | null;
  siteId: string | null;
  targetJoiningDate: string;
  budgetedCtcMin: number;
  budgetedCtcMax: number;
  justification: string;
  status: RequisitionStatus;
  candidateCount: number;
  ageInDays: number;
}

@Injectable()
export class RequisitionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly codeSeries: CodeSeriesService,
  ) {}

  private toView(
    row: {
      id: string;
      requisitionCode: string;
      departmentId: string;
      designationId: string;
      positionCount: number;
      filledPositions: number;
      employmentType: RequisitionEmploymentType;
      projectId: string | null;
      siteId: string | null;
      targetJoiningDate: Date;
      budgetedCtcMin: Prisma.Decimal;
      budgetedCtcMax: Prisma.Decimal;
      justification: string;
      status: RequisitionStatus;
      createdAt: Date;
    },
    candidateCount: number,
  ): RequisitionView {
    return {
      id: row.id,
      requisitionCode: row.requisitionCode,
      departmentId: row.departmentId,
      designationId: row.designationId,
      positionCount: row.positionCount,
      filledPositions: row.filledPositions,
      openPositions: row.positionCount - row.filledPositions,
      employmentType: row.employmentType,
      projectId: row.projectId,
      siteId: row.siteId,
      targetJoiningDate: row.targetJoiningDate.toISOString().slice(0, 10),
      budgetedCtcMin: row.budgetedCtcMin.toNumber(),
      budgetedCtcMax: row.budgetedCtcMax.toNumber(),
      justification: row.justification,
      status: row.status,
      candidateCount,
      ageInDays: Math.max(
        0,
        Math.floor((Date.now() - row.createdAt.getTime()) / MS_PER_DAY),
      ),
    };
  }

  async findAll(
    caller: AuthenticatedUser,
    query: {
      companyId?: string;
      status?: RequisitionStatus;
      departmentId?: string;
      projectId?: string;
      page?: number;
      pageSize?: number;
    },
  ) {
    const page = Math.max(query.page ?? 1, 1);
    const pageSize = Math.min(
      Math.max(query.pageSize ?? DEFAULT_PAGE_SIZE, 1),
      MAX_PAGE_SIZE,
    );
    const where: Prisma.RequisitionWhereInput = {
      ...companyScope(caller, query.companyId),
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.departmentId ? { departmentId: query.departmentId } : {}),
      ...(query.projectId ? { projectId: query.projectId } : {}),
    };

    const { rows, total } = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const [rows, total] = await Promise.all([
          tx.requisition.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip: (page - 1) * pageSize,
            take: pageSize,
            include: { _count: { select: { candidates: true } } },
          }),
          tx.requisition.count({ where }),
        ]);
        return { rows, total };
      },
    );

    return {
      items: rows.map((r) => this.toView(r, r._count.candidates)),
      total,
      page,
      pageSize,
    };
  }

  async findOne(
    caller: AuthenticatedUser,
    id: string,
  ): Promise<RequisitionView> {
    const row = await withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
      tx.requisition.findUnique({
        where: { id },
        include: { _count: { select: { candidates: true } } },
      }),
    );
    if (!row || row.deletedAt) {
      throw new NotFoundException(`Requisition ${id} not found`);
    }
    assertInScope(caller, row, `Requisition ${id}`);
    return this.toView(row, row._count.candidates);
  }

  async create(
    caller: AuthenticatedUser,
    dto: {
      companyId?: string;
      departmentId: string;
      designationId: string;
      positionCount: number;
      employmentType: RequisitionEmploymentType;
      projectId?: string;
      siteId?: string;
      targetJoiningDate: string;
      budgetedCtcMin: number;
      budgetedCtcMax: number;
      justification: string;
    },
    ipAddress: string,
  ): Promise<RequisitionView> {
    const companyId = companyScope(caller, dto.companyId).companyId;
    if (!companyId) {
      // A 400, not a 404: the company is not missing — the caller never named one.
      // A cross-company Super Admin has no `companyId` of their own for
      // `companyScope()` to fall back on, so a write from them must say which
      // company it belongs to. Reporting "Company not found" sent people hunting
      // for a deleted company instead of picking one. Same message every other
      // module uses for this case.
      throw new BadRequestException(
        'companyId is required for a cross-company caller.',
      );
    }
    if (dto.positionCount < 1) {
      throw new BadRequestException('Position count must be at least 1');
    }
    if (dto.budgetedCtcMin > dto.budgetedCtcMax) {
      throw new BadRequestException(
        'Budgeted CTC minimum cannot exceed the maximum',
      );
    }

    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const requisitionCode = await this.codeSeries.next(
          tx,
          companyId,
          CodeSeriesType.REQUISITION,
          REQUISITION_CODE_INFIX,
        );
        return tx.requisition.create({
          data: {
            companyId,
            requisitionCode,
            departmentId: dto.departmentId,
            designationId: dto.designationId,
            positionCount: dto.positionCount,
            employmentType: dto.employmentType,
            projectId: dto.projectId ?? null,
            siteId: dto.siteId ?? null,
            targetJoiningDate: new Date(
              `${dto.targetJoiningDate.slice(0, 10)}T00:00:00.000Z`,
            ),
            budgetedCtcMin: dto.budgetedCtcMin,
            budgetedCtcMax: dto.budgetedCtcMax,
            justification: dto.justification,
            createdBy: caller.id,
          },
          include: { _count: { select: { candidates: true } } },
        });
      },
    );

    await this.audit(
      AuditAction.CREATE,
      created.id,
      companyId,
      caller,
      ipAddress,
    );
    return this.toView(created, created._count.candidates);
  }

  async submit(caller: AuthenticatedUser, id: string, ipAddress: string) {
    return this.transition(caller, id, ipAddress, (status) => {
      if (status !== RequisitionStatus.draft) {
        throw new ConflictException(
          'Only a draft requisition can be submitted',
        );
      }
      return { status: RequisitionStatus.pending_approval };
    });
  }

  async approve(caller: AuthenticatedUser, id: string, ipAddress: string) {
    return this.transition(caller, id, ipAddress, (status) => {
      if (status !== RequisitionStatus.pending_approval) {
        throw new ConflictException(
          'Only a requisition pending approval can be approved',
        );
      }
      return {
        status: RequisitionStatus.open,
        approvedBy: caller.id,
        approvedAt: new Date(),
      };
    });
  }

  async reject(
    caller: AuthenticatedUser,
    id: string,
    reason: string,
    ipAddress: string,
  ) {
    return this.transition(caller, id, ipAddress, (status) => {
      if (status !== RequisitionStatus.pending_approval) {
        throw new ConflictException(
          'Only a requisition pending approval can be rejected',
        );
      }
      return { status: RequisitionStatus.rejected, rejectionReason: reason };
    });
  }

  async remove(caller: AuthenticatedUser, id: string, ipAddress: string) {
    await withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
      const existing = await tx.requisition.findUnique({
        where: { id },
        include: { _count: { select: { candidates: true } } },
      });
      if (!existing || existing.deletedAt) {
        throw new NotFoundException(`Requisition ${id} not found`);
      }
      assertInScope(caller, existing, `Requisition ${id}`);
      if (existing._count.candidates > 0) {
        throw new ConflictException(
          'Requisition has candidates — cannot delete',
        );
      }
      await tx.requisition.update({
        where: { id },
        data: { deletedAt: new Date(), deletedBy: caller.id },
      });
    });
    await this.audit(
      AuditAction.DELETE,
      id,
      caller.companyId ?? null,
      caller,
      ipAddress,
    );
  }

  /**
   * Increments filled positions inside the joining transaction, auto-closing the
   * requisition when every position is filled (FR-014). Runs on the caller's tx.
   */
  async incrementFilledInTx(
    tx: Prisma.TransactionClient,
    requisitionId: string,
  ): Promise<void> {
    const requisition = await tx.requisition.findUnique({
      where: { id: requisitionId },
    });
    if (!requisition) throw new NotFoundException('Requisition not found');
    if (requisition.status === RequisitionStatus.closed) {
      throw new ConflictException('Requisition is already closed');
    }
    const filled = requisition.filledPositions + 1;
    await tx.requisition.update({
      where: { id: requisitionId },
      data: {
        filledPositions: filled,
        status:
          filled >= requisition.positionCount
            ? RequisitionStatus.closed
            : requisition.status,
      },
    });
  }

  /** Releases one filled position when a joined candidate is marked no-show. */
  async releasePositionInTx(
    tx: Prisma.TransactionClient,
    requisitionId: string,
  ): Promise<void> {
    const requisition = await tx.requisition.findUnique({
      where: { id: requisitionId },
    });
    if (!requisition) return;
    await tx.requisition.update({
      where: { id: requisitionId },
      data: {
        filledPositions: Math.max(0, requisition.filledPositions - 1),
        status:
          requisition.status === RequisitionStatus.closed
            ? RequisitionStatus.open
            : requisition.status,
      },
    });
  }

  /** Asserts a requisition is open and accepting candidates. */
  async assertOpen(
    tx: Prisma.TransactionClient,
    caller: AuthenticatedUser,
    requisitionId: string,
  ): Promise<void> {
    const requisition = await tx.requisition.findUnique({
      where: { id: requisitionId },
    });
    if (!requisition || requisition.deletedAt) {
      throw new BadRequestException('Requisition not found');
    }
    assertInScope(caller, requisition, 'Requisition');
    if (requisition.status !== RequisitionStatus.open) {
      throw new ConflictException(
        'Candidates can only be added to an open requisition',
      );
    }
  }

  private async transition(
    caller: AuthenticatedUser,
    id: string,
    ipAddress: string,
    decide: (status: RequisitionStatus) => Prisma.RequisitionUpdateInput,
  ): Promise<RequisitionView> {
    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.requisition.findUnique({ where: { id } });
        if (!existing || existing.deletedAt) {
          throw new NotFoundException(`Requisition ${id} not found`);
        }
        assertInScope(caller, existing, `Requisition ${id}`);
        return tx.requisition.update({
          where: { id },
          data: decide(existing.status),
          include: { _count: { select: { candidates: true } } },
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
    return this.toView(updated, updated._count.candidates);
  }

  private async audit(
    action: AuditAction,
    entityId: string,
    companyId: string | null,
    caller: AuthenticatedUser,
    ipAddress: string,
  ) {
    await this.auditLog.record({
      entityType: AuditEntityType.REQUISITION,
      action,
      entityId,
      accountId: caller.id,
      companyId,
      ipAddress,
    });
  }
}
