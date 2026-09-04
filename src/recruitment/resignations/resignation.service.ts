import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  ResignationReasonCategory,
  ResignationStatus,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import {
  RlsContext,
  rlsContextFor,
  withRlsContext,
} from '../../common/prisma/rls-context';
import { assertInScope, companyScope } from '../../settings/company-scope';
import { RecruitmentRefsService } from '../recruitment-refs.service';

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}
const parseDate = (v: string) => new Date(`${v.slice(0, 10)}T00:00:00.000Z`);
const dateOnly = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

@Injectable()
export class ResignationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly refs: RecruitmentRefsService,
  ) {}

  async findAll(
    caller: AuthenticatedUser,
    query: {
      companyId?: string;
      status?: ResignationStatus;
      employeeId?: string;
    },
  ) {
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.resignation.findMany({
          where: {
            ...companyScope(caller, query.companyId),
            deletedAt: null,
            ...(query.status ? { status: query.status } : {}),
            ...(query.employeeId ? { employeeId: query.employeeId } : {}),
          },
          orderBy: { createdAt: 'desc' },
        }),
    );
    return rows.map((r) => this.toView(r));
  }

  async create(
    caller: AuthenticatedUser,
    dto: {
      companyId?: string;
      employeeId: string;
      resignationDate: string;
      reasonCategory: ResignationReasonCategory;
      reasonDetail: string;
      noticePeriodDays: number;
    },
    ipAddress: string,
  ) {
    const companyId = companyScope(caller, dto.companyId).companyId;
    if (!companyId) throw new NotFoundException('Company not found');

    const employee = await this.refs.getEmployee(caller, dto.employeeId);
    if (!employee) throw new NotFoundException('Employee not found');
    if (!employee.isActive) {
      throw new ConflictException('That employee is already inactive.');
    }

    const resignationDate = parseDate(dto.resignationDate);
    const expectedLastWorkingDay = addDays(
      resignationDate,
      dto.noticePeriodDays,
    );

    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const open = await tx.resignation.findFirst({
          where: {
            employeeId: dto.employeeId,
            status: { not: ResignationStatus.withdrawn },
            deletedAt: null,
          },
        });
        if (open) {
          throw new ConflictException(
            'An open resignation already exists for that employee.',
          );
        }
        return tx.resignation.create({
          data: {
            companyId,
            employeeId: dto.employeeId,
            resignationDate,
            reasonCategory: dto.reasonCategory,
            reasonDetail: dto.reasonDetail,
            noticePeriodDays: dto.noticePeriodDays,
            expectedLastWorkingDay,
            createdBy: caller.id,
          },
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
    return this.toView(created);
  }

  async accept(
    caller: AuthenticatedUser,
    id: string,
    dto: {
      agreedLastWorkingDay?: string;
      noticeWaiverDays?: number;
      waiverReason?: string;
    },
    ipAddress: string,
  ) {
    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.resignation.findUnique({ where: { id } });
        if (!existing || existing.deletedAt) {
          throw new NotFoundException(`Resignation ${id} not found`);
        }
        assertInScope(caller, existing, `Resignation ${id}`);
        if (existing.status !== ResignationStatus.submitted) {
          throw new ConflictException(
            'Only a submitted resignation can be accepted',
          );
        }

        const agreed = dto.agreedLastWorkingDay
          ? parseDate(dto.agreedLastWorkingDay)
          : existing.expectedLastWorkingDay;
        if (agreed < existing.expectedLastWorkingDay) {
          if (!dto.noticeWaiverDays || !dto.waiverReason) {
            throw new BadRequestException(
              'An earlier last working day requires waiver days and a reason.',
            );
          }
        }
        return tx.resignation.update({
          where: { id },
          data: {
            status: ResignationStatus.accepted,
            agreedLastWorkingDay: agreed,
            noticeWaiverDays: dto.noticeWaiverDays ?? null,
            waiverReason: dto.waiverReason ?? null,
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
    return this.toView(updated);
  }

  async withdraw(
    caller: AuthenticatedUser,
    id: string,
    reason: string,
    ipAddress: string,
  ) {
    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.resignation.findUnique({ where: { id } });
        if (!existing || existing.deletedAt) {
          throw new NotFoundException(`Resignation ${id} not found`);
        }
        assertInScope(caller, existing, `Resignation ${id}`);
        if (existing.status === ResignationStatus.withdrawn) {
          throw new ConflictException('Resignation is already withdrawn');
        }
        return tx.resignation.update({
          where: { id },
          data: { status: ResignationStatus.withdrawn, withdrawReason: reason },
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
    return this.toView(updated);
  }

  /** The accepted resignation for an employee — consumed by 005's exit flow (FR-065). */
  async getAcceptedResignation(
    employeeId: string,
    ctx: RlsContext = { isSuperAdmin: true },
  ) {
    const row = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.resignation.findFirst({
        where: {
          employeeId,
          status: ResignationStatus.accepted,
          deletedAt: null,
        },
        orderBy: { createdAt: 'desc' },
      }),
    );
    if (!row) return null;
    return {
      employeeId: row.employeeId,
      agreedLastWorkingDay: dateOnly(row.agreedLastWorkingDay),
      expectedLastWorkingDay: dateOnly(row.expectedLastWorkingDay),
      noticeWaiverDays: row.noticeWaiverDays,
      reasonCategory: row.reasonCategory,
    };
  }

  private toView(r: {
    id: string;
    employeeId: string;
    resignationDate: Date;
    reasonCategory: ResignationReasonCategory;
    reasonDetail: string;
    noticePeriodDays: number;
    expectedLastWorkingDay: Date;
    agreedLastWorkingDay: Date | null;
    noticeWaiverDays: number | null;
    status: ResignationStatus;
  }) {
    return {
      id: r.id,
      employeeId: r.employeeId,
      resignationDate: dateOnly(r.resignationDate),
      reasonCategory: r.reasonCategory,
      reasonDetail: r.reasonDetail,
      noticePeriodDays: r.noticePeriodDays,
      expectedLastWorkingDay: dateOnly(r.expectedLastWorkingDay),
      agreedLastWorkingDay: dateOnly(r.agreedLastWorkingDay),
      noticeWaiverDays: r.noticeWaiverDays,
      status: r.status,
    };
  }

  private async audit(
    action: AuditAction,
    entityId: string,
    companyId: string,
    caller: AuthenticatedUser,
    ipAddress: string,
  ) {
    await this.auditLog.record({
      entityType: AuditEntityType.RESIGNATION,
      action,
      entityId,
      accountId: caller.id,
      companyId,
      ipAddress,
    });
  }
}
