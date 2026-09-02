import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  MonthlyComplianceStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { assertInScope, companyScope } from '../../settings/company-scope';
import {
  ComplianceStatusService,
  deriveMonthlyStatus,
} from './compliance-status.service';
import {
  CreateComplianceDto,
  ListComplianceDto,
  UpdateComplianceDto,
} from './dto/compliance.dto';

function decimal(value: Prisma.Decimal | null): number | null {
  return value === null ? null : Number(value);
}

/**
 * PF/ESIC filings, one row per contractor per month (007 US4).
 *
 * Every write recomputes the parent contractor's `complianceStatus` in the same
 * transaction — see `ComplianceStatusService` for why that is not a separate step.
 */
@Injectable()
export class ComplianceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly statusService: ComplianceStatusService,
  ) {}

  async findAll(
    caller: AuthenticatedUser,
    query: ListComplianceDto,
  ): Promise<Record<string, unknown>[]> {
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.monthlyCompliance.findMany({
          where: {
            ...companyScope(caller, query.companyId),
            ...(query.contractorProfileId
              ? { contractorProfileId: query.contractorProfileId }
              : {}),
            ...(query.month ? { month: query.month } : {}),
          },
          orderBy: [{ month: 'desc' }],
          include: {
            contractorProfile: {
              select: { vendor: { select: { name: true, code: true } } },
            },
          },
        }),
    );
    return rows.map((row) => this.toView(row));
  }

  async create(
    caller: AuthenticatedUser,
    dto: CreateComplianceDto,
    ipAddress: string,
  ): Promise<Record<string, unknown>> {
    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const profile = await tx.contractorProfile.findUnique({
          where: { id: dto.contractorProfileId },
          select: { id: true, companyId: true },
        });
        if (!profile) {
          throw new NotFoundException(
            `Contractor profile ${dto.contractorProfileId} not found`,
          );
        }
        assertInScope(
          caller,
          profile,
          `Contractor profile ${dto.contractorProfileId}`,
        );

        const clash = await tx.monthlyCompliance.findUnique({
          where: {
            contractorProfileId_month: {
              contractorProfileId: dto.contractorProfileId,
              month: dto.month,
            },
          },
          select: { id: true },
        });
        if (clash) {
          throw new ConflictException(
            `A compliance record for ${dto.month} already exists for this contractor. ` +
              'Update it instead of creating a second one.',
          );
        }

        const record = await tx.monthlyCompliance.create({
          data: {
            companyId: profile.companyId,
            contractorProfileId: dto.contractorProfileId,
            month: dto.month,
            pfChallanNumber: dto.pfChallanNumber ?? null,
            pfAmount: dto.pfAmount ?? null,
            pfDate: dto.pfDate ? new Date(dto.pfDate) : null,
            esicChallanNumber: dto.esicChallanNumber ?? null,
            esicAmount: dto.esicAmount ?? null,
            esicDate: dto.esicDate ? new Date(dto.esicDate) : null,
            status: deriveMonthlyStatus(dto),
          },
        });
        await this.statusService.recompute(tx, dto.contractorProfileId);
        return record;
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.MONTHLY_COMPLIANCE,
      action: AuditAction.CREATE,
      entityId: created.id,
      accountId: caller.id,
      companyId: created.companyId,
      ipAddress,
    });
    return this.toView(created);
  }

  async update(
    caller: AuthenticatedUser,
    id: string,
    dto: UpdateComplianceDto,
    ipAddress: string,
  ): Promise<Record<string, unknown>> {
    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.monthlyCompliance.findUnique({
          where: { id },
        });
        if (!existing) {
          throw new NotFoundException(`Compliance record ${id} not found`);
        }
        assertInScope(caller, existing, `Compliance record ${id}`);

        // A verified record is somebody's signed assertion that the filing was
        // checked. Editing it silently would leave that assertion attached to
        // different numbers than the ones it was made about.
        if (existing.status === MonthlyComplianceStatus.verified) {
          throw new ConflictException(
            'This record has been verified and can no longer be edited.',
          );
        }

        const merged = {
          pfChallanNumber:
            dto.pfChallanNumber !== undefined
              ? dto.pfChallanNumber
              : existing.pfChallanNumber,
          esicChallanNumber:
            dto.esicChallanNumber !== undefined
              ? dto.esicChallanNumber
              : existing.esicChallanNumber,
        };

        const record = await tx.monthlyCompliance.update({
          where: { id },
          data: {
            ...(dto.pfChallanNumber !== undefined
              ? { pfChallanNumber: dto.pfChallanNumber ?? null }
              : {}),
            ...(dto.pfAmount !== undefined
              ? { pfAmount: dto.pfAmount ?? null }
              : {}),
            ...(dto.pfDate !== undefined
              ? { pfDate: dto.pfDate ? new Date(dto.pfDate) : null }
              : {}),
            ...(dto.esicChallanNumber !== undefined
              ? { esicChallanNumber: dto.esicChallanNumber ?? null }
              : {}),
            ...(dto.esicAmount !== undefined
              ? { esicAmount: dto.esicAmount ?? null }
              : {}),
            ...(dto.esicDate !== undefined
              ? { esicDate: dto.esicDate ? new Date(dto.esicDate) : null }
              : {}),
            status: deriveMonthlyStatus(merged),
          },
        });
        await this.statusService.recompute(tx, existing.contractorProfileId);
        return record;
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.MONTHLY_COMPLIANCE,
      action: AuditAction.UPDATE,
      entityId: id,
      changes: { after: { status: updated.status } },
      accountId: caller.id,
      companyId: updated.companyId,
      ipAddress,
    });
    return this.toView(updated);
  }

  async verify(
    caller: AuthenticatedUser,
    id: string,
    ipAddress: string,
  ): Promise<Record<string, unknown>> {
    const verified = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.monthlyCompliance.findUnique({
          where: { id },
        });
        if (!existing) {
          throw new NotFoundException(`Compliance record ${id} not found`);
        }
        assertInScope(caller, existing, `Compliance record ${id}`);

        if (existing.status === MonthlyComplianceStatus.verified) {
          throw new ConflictException('This record is already verified.');
        }
        // Only a complete filing can be verified. Verifying a partial one would
        // record that someone checked a filing that had not been made.
        if (existing.status !== MonthlyComplianceStatus.submitted) {
          throw new ConflictException(
            'Only a submitted record — one with both PF and ESIC challans — can be verified.',
          );
        }

        const record = await tx.monthlyCompliance.update({
          where: { id },
          data: {
            status: MonthlyComplianceStatus.verified,
            verifiedByUserId: caller.id,
            verifiedAt: new Date(),
          },
        });
        await this.statusService.recompute(tx, existing.contractorProfileId);
        return record;
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.MONTHLY_COMPLIANCE,
      action: AuditAction.UPDATE,
      entityId: id,
      changes: { after: { status: 'verified', verifiedByUserId: caller.id } },
      accountId: caller.id,
      companyId: verified.companyId,
      ipAddress,
    });
    return this.toView(verified);
  }

  private toView(record: Record<string, unknown>): Record<string, unknown> {
    const profile = record.contractorProfile as
      | { vendor: { name: string; code: string } }
      | undefined;
    const { contractorProfile: _p, ...rest } = record as Record<
      string,
      unknown
    > & {
      contractorProfile?: unknown;
    };
    return {
      ...rest,
      pfAmount: decimal(record.pfAmount as Prisma.Decimal | null),
      esicAmount: decimal(record.esicAmount as Prisma.Decimal | null),
      ...(profile
        ? {
            contractorName: profile.vendor.name,
            contractorCode: profile.vendor.code,
          }
        : {}),
    };
  }
}
