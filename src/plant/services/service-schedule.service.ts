import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, AuditEntityType, Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { assertInScope, companyScope } from '../../settings/company-scope';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  SERVICE_DUE_SOON_MARGIN,
} from '../constants/plant.constants';
import { serviceScheduleStatus } from '../equipment/equipment.service';
import {
  CreateServiceScheduleDto,
  ListServiceSchedulesDto,
  UpdateServiceScheduleDto,
} from './dto/service-schedule.dto';

export interface ServiceScheduleRow {
  id: string;
  companyId: string;
  equipmentId: string;
  equipmentCode: string;
  equipmentName: string;
  serviceType: string;
  intervalHours: number | null;
  intervalKm: number | null;
  lastDoneReading: number;
  nextDueReading: number;
  currentReading: number;
  /** Derived on every read (FR-006) — never stored, so it cannot go stale. */
  status: 'ok' | 'due_soon' | 'overdue';
  /** Negative when overdue. Meter units, not days. */
  readingsRemaining: number;
  createdAt: Date;
}

/**
 * Service schedules (006 US6).
 *
 * `status` is computed on read rather than stored (research.md §4): it depends on
 * `equipment.currentReading`, which every logbook entry moves, and storing it would
 * mean rewriting every schedule on a machine on every daily entry — an O(N) write
 * to save an O(1) read that nobody makes often.
 *
 * The cost of that choice shows up in `findAll`: a status *filter* cannot be a
 * Prisma `where`, because Prisma cannot compare two columns. It is resolved with a
 * raw id query before paging rather than by filtering the page after fetching it —
 * filtering after paging returns a short page and a wrong total, which is the exact
 * bug 009's `belowReorderLevel` filter shipped with and had to be corrected.
 */
@Injectable()
export class ServiceScheduleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  async findAll(
    caller: AuthenticatedUser,
    query: ListServiceSchedulesDto,
  ): Promise<{
    items: ServiceScheduleRow[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(
      query.pageSize ?? DEFAULT_PAGE_SIZE,
      MAX_PAGE_SIZE,
    );

    return withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
      let statusIds: string[] | null = null;
      if (query.status) {
        const rows = await tx.$queryRaw<{ id: string }[]>`
          SELECT s."id"
          FROM "plant"."ServiceSchedule" s
          JOIN "plant"."Equipment" e ON e."id" = s."equipmentId"
          WHERE (
            ${query.status} = 'overdue'
              AND e."currentReading" >= s."nextDueReading"
            OR ${query.status} = 'due_soon'
              AND e."currentReading" < s."nextDueReading"
              AND s."nextDueReading" - e."currentReading" <= ${SERVICE_DUE_SOON_MARGIN}
            OR ${query.status} = 'ok'
              AND s."nextDueReading" - e."currentReading" > ${SERVICE_DUE_SOON_MARGIN}
          )
        `;
        statusIds = rows.map((row) => row.id);
        if (statusIds.length === 0) {
          return { items: [], total: 0, page, pageSize };
        }
      }

      const where: Prisma.ServiceScheduleWhereInput = {
        ...companyScope(caller, query.companyId),
        ...(query.equipmentId ? { equipmentId: query.equipmentId } : {}),
        ...(statusIds ? { id: { in: statusIds } } : {}),
      };

      const [rows, total] = await Promise.all([
        tx.serviceSchedule.findMany({
          where,
          orderBy: { nextDueReading: 'asc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
          include: {
            equipment: {
              select: { code: true, name: true, currentReading: true },
            },
          },
        }),
        tx.serviceSchedule.count({ where }),
      ]);

      return {
        items: rows.map((row) => this.toRow(row)),
        total,
        page,
        pageSize,
      };
    });
  }

  private toRow(
    row: Prisma.ServiceScheduleGetPayload<{
      include: {
        equipment: {
          select: { code: true; name: true; currentReading: true };
        };
      };
    }>,
  ): ServiceScheduleRow {
    const currentReading = Number(row.equipment.currentReading);
    const nextDueReading = Number(row.nextDueReading);
    return {
      id: row.id,
      companyId: row.companyId,
      equipmentId: row.equipmentId,
      equipmentCode: row.equipment.code,
      equipmentName: row.equipment.name,
      serviceType: row.serviceType,
      intervalHours:
        row.intervalHours === null ? null : Number(row.intervalHours),
      intervalKm: row.intervalKm === null ? null : Number(row.intervalKm),
      lastDoneReading: Number(row.lastDoneReading),
      nextDueReading,
      currentReading,
      status: serviceScheduleStatus(currentReading, nextDueReading),
      readingsRemaining:
        Math.round((nextDueReading - currentReading) * 1000) / 1000,
      createdAt: row.createdAt,
    };
  }

  /** The interval that applies, given which one the caller supplied. */
  private intervalOf(dto: {
    intervalHours?: number;
    intervalKm?: number;
  }): number {
    const interval = dto.intervalHours ?? dto.intervalKm;
    if (interval === undefined) {
      throw new BadRequestException(
        'A schedule needs an interval — supply intervalHours for an hours-metered ' +
          'machine or intervalKm for a km-metered one.',
      );
    }
    return interval;
  }

  async create(
    caller: AuthenticatedUser,
    dto: CreateServiceScheduleDto,
    ipAddress: string,
  ): Promise<ServiceScheduleRow> {
    const interval = this.intervalOf(dto);

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

        return tx.serviceSchedule.create({
          data: {
            companyId: equipment.companyId,
            equipmentId: dto.equipmentId,
            serviceType: dto.serviceType.trim(),
            intervalHours: dto.intervalHours ?? null,
            intervalKm: dto.intervalKm ?? null,
            lastDoneReading: dto.lastDoneReading,
            nextDueReading: dto.lastDoneReading + interval,
          },
          include: {
            equipment: {
              select: { code: true, name: true, currentReading: true },
            },
          },
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.SERVICE_SCHEDULE,
      action: AuditAction.CREATE,
      entityId: created.id,
      accountId: caller.id,
      companyId: created.companyId,
      ipAddress,
      changes: {
        equipmentId: created.equipmentId,
        serviceType: created.serviceType,
        nextDueReading: Number(created.nextDueReading),
      },
    });
    return this.toRow(created);
  }

  async update(
    caller: AuthenticatedUser,
    scheduleId: string,
    dto: UpdateServiceScheduleDto,
    ipAddress: string,
  ): Promise<ServiceScheduleRow> {
    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.serviceSchedule.findUnique({
          where: { id: scheduleId },
        });
        if (!existing)
          throw new NotFoundException('Service schedule not found');
        assertInScope(caller, existing, 'Service schedule');

        const lastDone =
          dto.lastDoneReading ?? Number(existing.lastDoneReading);
        const interval =
          dto.intervalHours ??
          dto.intervalKm ??
          Number(existing.intervalHours ?? existing.intervalKm ?? 0);
        if (interval <= 0) {
          throw new BadRequestException(
            'A schedule needs a positive interval.',
          );
        }

        return tx.serviceSchedule.update({
          where: { id: scheduleId },
          data: {
            ...(dto.serviceType !== undefined
              ? { serviceType: dto.serviceType.trim() }
              : {}),
            ...(dto.intervalHours !== undefined
              ? { intervalHours: dto.intervalHours }
              : {}),
            ...(dto.intervalKm !== undefined
              ? { intervalKm: dto.intervalKm }
              : {}),
            ...(dto.lastDoneReading !== undefined
              ? { lastDoneReading: dto.lastDoneReading }
              : {}),
            // Always recomputed rather than accepted: `nextDueReading` is a derived
            // figure, and a client that could set it directly could put a machine's
            // next service anywhere it liked.
            nextDueReading: lastDone + interval,
          },
          include: {
            equipment: {
              select: { code: true, name: true, currentReading: true },
            },
          },
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.SERVICE_SCHEDULE,
      action: AuditAction.UPDATE,
      entityId: scheduleId,
      accountId: caller.id,
      companyId: updated.companyId,
      ipAddress,
      changes: { ...dto },
    });
    return this.toRow(updated);
  }

  async remove(
    caller: AuthenticatedUser,
    scheduleId: string,
    ipAddress: string,
  ): Promise<void> {
    const removed = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.serviceSchedule.findUnique({
          where: { id: scheduleId },
        });
        if (!existing)
          throw new NotFoundException('Service schedule not found');
        assertInScope(caller, existing, 'Service schedule');

        // A job that linked to this schedule keeps its own history; the link is
        // nulled rather than the job being touched.
        await tx.maintenanceJob.updateMany({
          where: { linkedServiceScheduleId: scheduleId },
          data: { linkedServiceScheduleId: null },
        });
        await tx.serviceSchedule.delete({ where: { id: scheduleId } });
        return existing;
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.SERVICE_SCHEDULE,
      action: AuditAction.DELETE,
      entityId: scheduleId,
      accountId: caller.id,
      companyId: removed.companyId,
      ipAddress,
    });
  }
}
