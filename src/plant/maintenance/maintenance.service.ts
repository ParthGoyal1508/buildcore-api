import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  EquipmentStatus,
  MaintenanceStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { assertInScope, companyScope } from '../../settings/company-scope';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants/plant.constants';
import {
  CloseMaintenanceJobDto,
  CreateMaintenanceJobDto,
  ListMaintenanceDto,
  UpdateMaintenanceJobDto,
} from './dto/maintenance.dto';

export interface MaintenanceJobRow {
  id: string;
  companyId: string;
  equipmentId: string;
  equipmentCode: string;
  equipmentName: string;
  type: string;
  description: string;
  openedAt: Date;
  closedAt: Date | null;
  closingReading: number | null;
  partsDescription: string | null;
  labourCost: number | null;
  /** Accrued from part consumption, never client-supplied. */
  partsCost: number;
  /** Verified service bills against this job. */
  serviceBillCost: number;
  /** Parts + labour + verified service bills (US11 scenario 6). */
  totalCost: number;
  linkedServiceScheduleId: string | null;
  status: MaintenanceStatus;
  createdAt: Date;
}

type JobWithRelations = Prisma.MaintenanceJobGetPayload<{
  include: {
    equipment: { select: { code: true; name: true } };
    serviceBills: {
      select: { netPayable: true; status: true; deletedAt: true };
    };
  };
}>;

/**
 * Maintenance jobs (006 US5).
 *
 * The job is what owns `equipment.status` (FR-002): opening one puts the machine
 * under maintenance, closing one returns it to service, and nothing else may set
 * that value. That is the whole reason the transition is automatic rather than a
 * field on the equipment form — a register and a job list that can disagree about
 * whether a machine is down is worse than either on its own.
 *
 * "At most one open job per equipment" is checked here for a decent 409 and
 * enforced by a partial unique index in the migration for the concurrent case.
 */
@Injectable()
export class MaintenanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  private toRow(row: JobWithRelations): MaintenanceJobRow {
    const partsCost = Number(row.partsCost);
    const labourCost = row.labourCost === null ? null : Number(row.labourCost);
    const serviceBillCost = row.serviceBills
      .filter((bill) => bill.status === 'verified' && bill.deletedAt === null)
      .reduce((sum, bill) => sum + Number(bill.netPayable), 0);

    return {
      id: row.id,
      companyId: row.companyId,
      equipmentId: row.equipmentId,
      equipmentCode: row.equipment.code,
      equipmentName: row.equipment.name,
      type: row.type,
      description: row.description,
      openedAt: row.openedAt,
      closedAt: row.closedAt,
      closingReading:
        row.closingReading === null ? null : Number(row.closingReading),
      partsDescription: row.partsDescription,
      labourCost,
      partsCost,
      serviceBillCost,
      // Computed rather than read from the stored `totalCost` column, so it can
      // never lag a part consumed or a bill verified after the job was last saved.
      totalCost: partsCost + (labourCost ?? 0) + serviceBillCost,
      linkedServiceScheduleId: row.linkedServiceScheduleId,
      status: row.status,
      createdAt: row.createdAt,
    };
  }

  private readonly include = {
    equipment: { select: { code: true, name: true } },
    serviceBills: {
      select: { netPayable: true, status: true, deletedAt: true },
    },
  } as const;

  async findAll(
    caller: AuthenticatedUser,
    query: ListMaintenanceDto,
  ): Promise<{
    items: MaintenanceJobRow[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(
      query.pageSize ?? DEFAULT_PAGE_SIZE,
      MAX_PAGE_SIZE,
    );

    const where: Prisma.MaintenanceJobWhereInput = {
      ...companyScope(caller, query.companyId),
      ...(query.equipmentId ? { equipmentId: query.equipmentId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { type: query.type } : {}),
    };

    return withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
      const [rows, total] = await Promise.all([
        tx.maintenanceJob.findMany({
          where,
          // Open jobs first, then most recent — the list exists to answer "what is
          // down right now", and burying that under closed history inverts it.
          orderBy: [{ status: 'asc' }, { openedAt: 'desc' }],
          skip: (page - 1) * pageSize,
          take: pageSize,
          include: this.include,
        }),
        tx.maintenanceJob.count({ where }),
      ]);
      return {
        items: rows.map((row) => this.toRow(row)),
        total,
        page,
        pageSize,
      };
    });
  }

  async findOne(
    caller: AuthenticatedUser,
    jobId: string,
  ): Promise<MaintenanceJobRow> {
    const row = await withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
      tx.maintenanceJob.findUnique({
        where: { id: jobId },
        include: this.include,
      }),
    );
    if (!row) throw new NotFoundException('Maintenance job not found');
    assertInScope(caller, row, 'Maintenance job');
    return this.toRow(row);
  }

  async create(
    caller: AuthenticatedUser,
    dto: CreateMaintenanceJobDto,
    ipAddress: string,
  ): Promise<MaintenanceJobRow> {
    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const equipment = await tx.equipment.findUnique({
          where: { id: dto.equipmentId },
        });
        if (!equipment) {
          throw new BadRequestException(
            `Equipment ${dto.equipmentId} does not exist.`,
          );
        }
        assertInScope(caller, equipment, 'Equipment');

        const open = await tx.maintenanceJob.findFirst({
          where: {
            equipmentId: dto.equipmentId,
            status: MaintenanceStatus.open,
          },
        });
        if (open) {
          throw new ConflictException(
            `${equipment.code} already has an open maintenance job. ` +
              'Close it before opening another.',
          );
        }

        if (dto.linkedServiceScheduleId) {
          const schedule = await tx.serviceSchedule.findUnique({
            where: { id: dto.linkedServiceScheduleId },
          });
          if (!schedule || schedule.equipmentId !== dto.equipmentId) {
            throw new BadRequestException(
              'linkedServiceScheduleId must be a service schedule on this machine.',
            );
          }
        }

        const job = await tx.maintenanceJob.create({
          data: {
            companyId: equipment.companyId,
            equipmentId: dto.equipmentId,
            type: dto.type,
            description: dto.description.trim(),
            linkedServiceScheduleId: dto.linkedServiceScheduleId ?? null,
          },
          include: this.include,
        });

        // FR-002. In the same transaction as the job: a machine with an open job
        // that still reads `active` is precisely the inconsistency this rule exists
        // to prevent.
        await tx.equipment.update({
          where: { id: dto.equipmentId },
          data: { status: EquipmentStatus.under_maintenance },
        });

        return job;
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.MAINTENANCE_JOB,
      action: AuditAction.CREATE,
      entityId: created.id,
      accountId: caller.id,
      companyId: created.companyId,
      ipAddress,
      changes: { equipmentId: created.equipmentId, type: created.type },
    });
    return this.toRow(created);
  }

  async update(
    caller: AuthenticatedUser,
    jobId: string,
    dto: UpdateMaintenanceJobDto,
    ipAddress: string,
  ): Promise<MaintenanceJobRow> {
    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.maintenanceJob.findUnique({
          where: { id: jobId },
        });
        if (!existing) throw new NotFoundException('Maintenance job not found');
        assertInScope(caller, existing, 'Maintenance job');

        if (dto.linkedServiceScheduleId) {
          const schedule = await tx.serviceSchedule.findUnique({
            where: { id: dto.linkedServiceScheduleId },
          });
          if (!schedule || schedule.equipmentId !== existing.equipmentId) {
            throw new BadRequestException(
              'linkedServiceScheduleId must be a service schedule on this machine.',
            );
          }
        }

        return tx.maintenanceJob.update({
          where: { id: jobId },
          data: {
            ...(dto.description !== undefined
              ? { description: dto.description.trim() }
              : {}),
            ...(dto.partsDescription !== undefined
              ? { partsDescription: dto.partsDescription }
              : {}),
            ...(dto.labourCost !== undefined
              ? { labourCost: dto.labourCost }
              : {}),
            ...(dto.linkedServiceScheduleId !== undefined
              ? { linkedServiceScheduleId: dto.linkedServiceScheduleId }
              : {}),
          },
          include: this.include,
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.MAINTENANCE_JOB,
      action: AuditAction.UPDATE,
      entityId: jobId,
      accountId: caller.id,
      companyId: updated.companyId,
      ipAddress,
      changes: { ...dto },
    });
    return this.toRow(updated);
  }

  /**
   * Closes a job: the machine returns to service, and any linked service schedule
   * is discharged and re-dated forward.
   *
   * The schedule update is the point of the link. Closing a scheduled service
   * without moving `lastDoneReading` would leave the schedule permanently overdue
   * and every subsequent reminder wrong.
   */
  async close(
    caller: AuthenticatedUser,
    jobId: string,
    dto: CloseMaintenanceJobDto,
    ipAddress: string,
  ): Promise<MaintenanceJobRow> {
    const closed = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.maintenanceJob.findUnique({
          where: { id: jobId },
        });
        if (!existing) throw new NotFoundException('Maintenance job not found');
        assertInScope(caller, existing, 'Maintenance job');
        if (existing.status === MaintenanceStatus.closed) {
          throw new ConflictException(
            'This maintenance job is already closed.',
          );
        }

        const job = await tx.maintenanceJob.update({
          where: { id: jobId },
          data: {
            status: MaintenanceStatus.closed,
            closedAt: dto.closedAt ? new Date(dto.closedAt) : new Date(),
            closingReading: dto.closingReading,
            ...(dto.partsDescription !== undefined
              ? { partsDescription: dto.partsDescription }
              : {}),
            ...(dto.labourCost !== undefined
              ? { labourCost: dto.labourCost }
              : {}),
          },
          include: this.include,
        });

        const equipment = await tx.equipment.findUnique({
          where: { id: existing.equipmentId },
          select: { currentReading: true },
        });
        // The closing reading is the machine's meter now — it typically moved while
        // the work was done (test runs, a road move to the workshop). Only ever
        // taken forward: a closing reading below the current one is a typo, not a
        // rewound meter, and accepting it would silently un-due every service
        // schedule on the machine.
        const advanced =
          equipment !== null &&
          dto.closingReading > Number(equipment.currentReading);
        await tx.equipment.update({
          where: { id: existing.equipmentId },
          data: {
            status: EquipmentStatus.active,
            ...(advanced ? { currentReading: dto.closingReading } : {}),
          },
        });

        if (existing.linkedServiceScheduleId) {
          const schedule = await tx.serviceSchedule.findUnique({
            where: { id: existing.linkedServiceScheduleId },
          });
          if (schedule) {
            const interval = Number(
              schedule.intervalHours ?? schedule.intervalKm ?? 0,
            );
            await tx.serviceSchedule.update({
              where: { id: schedule.id },
              data: {
                lastDoneReading: dto.closingReading,
                nextDueReading: dto.closingReading + interval,
              },
            });
          }
        }

        return job;
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.MAINTENANCE_JOB,
      action: AuditAction.UPDATE,
      entityId: jobId,
      accountId: caller.id,
      companyId: closed.companyId,
      ipAddress,
      changes: { status: 'closed', closingReading: dto.closingReading },
    });
    return this.toRow(closed);
  }
}
