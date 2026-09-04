import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, AuditEntityType, Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { assertInScope, companyScope } from '../../settings/company-scope';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants/plant.constants';
import { EquipmentService } from '../equipment/equipment.service';
import { PlantRefsService } from '../plant-refs.service';
import {
  CreateLogbookEntryDto,
  ListLogbookDto,
  UpdateLogbookEntryDto,
} from './dto/logbook.dto';

export interface LogbookRow {
  id: string;
  companyId: string;
  equipmentId: string;
  equipmentCode: string;
  equipmentName: string;
  date: Date;
  openingReading: number;
  closingReading: number;
  totalHours: number;
  fuelConsumed: number | null;
  operatorId: string | null;
  operatorName: string | null;
  projectId: string | null;
  remarks: string | null;
  createdAt: Date;
}

/**
 * The daily logbook (006 US3).
 *
 * Three things happen on every write, and they are one transaction on purpose: the
 * entry is recorded, the machine's `currentReading` is brought up to date, and its
 * utilisation % is recomputed for the month (FR-007). A crash between any two would
 * leave the register describing a machine that the logbook contradicts.
 */
@Injectable()
export class LogbookService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly refs: PlantRefsService,
    private readonly equipment: EquipmentService,
  ) {}

  async findAll(
    caller: AuthenticatedUser,
    query: ListLogbookDto,
  ): Promise<{
    items: LogbookRow[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(
      query.pageSize ?? DEFAULT_PAGE_SIZE,
      MAX_PAGE_SIZE,
    );

    const where: Prisma.LogbookEntryWhereInput = {
      ...companyScope(caller, query.companyId),
      ...(query.equipmentId ? { equipmentId: query.equipmentId } : {}),
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.dateFrom || query.dateTo
        ? {
            date: {
              ...(query.dateFrom
                ? { gte: this.refs.parseDate(query.dateFrom) }
                : {}),
              ...(query.dateTo
                ? { lte: this.refs.parseDate(query.dateTo) }
                : {}),
            },
          }
        : {}),
    };

    const { rows, total } = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const [rows, total] = await Promise.all([
          tx.logbookEntry.findMany({
            where,
            orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
            skip: (page - 1) * pageSize,
            take: pageSize,
            include: { equipment: { select: { code: true, name: true } } },
          }),
          tx.logbookEntry.count({ where }),
        ]);
        return { rows, total };
      },
    );

    const operatorNames = await this.refs.employeeNames(
      caller,
      rows.flatMap((row) => (row.operatorId ? [row.operatorId] : [])),
    );

    return {
      items: rows.map((row) => ({
        id: row.id,
        companyId: row.companyId,
        equipmentId: row.equipmentId,
        equipmentCode: row.equipment.code,
        equipmentName: row.equipment.name,
        date: row.date,
        openingReading: Number(row.openingReading),
        closingReading: Number(row.closingReading),
        totalHours: Number(row.totalHours),
        fuelConsumed:
          row.fuelConsumed === null ? null : Number(row.fuelConsumed),
        operatorId: row.operatorId,
        operatorName: row.operatorId
          ? operatorNames.get(row.operatorId) ?? 'Unknown operator'
          : null,
        projectId: row.projectId,
        remarks: row.remarks,
        createdAt: row.createdAt,
      })),
      total,
      page,
      pageSize,
    };
  }

  async create(
    caller: AuthenticatedUser,
    dto: CreateLogbookEntryDto,
    ipAddress: string,
  ): Promise<LogbookRow> {
    if (dto.closingReading < dto.openingReading) {
      throw new BadRequestException(
        'closingReading cannot be less than openingReading — a meter does not run backwards.',
      );
    }
    const date = this.refs.parseDate(dto.date);

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

        // Checked before inserting so the caller gets a useful message; the UNIQUE
        // index behind it (FR-003) is what makes the guarantee real under
        // concurrency.
        const clash = await tx.logbookEntry.findUnique({
          where: {
            equipmentId_date: { equipmentId: dto.equipmentId, date },
          },
        });
        if (clash) {
          throw new ConflictException(
            `${equipment.code} already has a logbook entry for ${dto.date.slice(
              0,
              10,
            )}. ` +
              'One entry per machine per day — edit the existing one instead.',
          );
        }

        if (dto.operatorId) {
          await this.refs.requireEmployee(
            caller,
            dto.operatorId,
            equipment.companyId,
          );
        }

        const entry = await tx.logbookEntry.create({
          data: {
            companyId: equipment.companyId,
            equipmentId: dto.equipmentId,
            date,
            openingReading: dto.openingReading,
            closingReading: dto.closingReading,
            totalHours: dto.closingReading - dto.openingReading,
            fuelConsumed: dto.fuelConsumed ?? null,
            operatorId: dto.operatorId ?? null,
            projectId: dto.projectId ?? null,
            remarks: dto.remarks ?? null,
          },
          include: { equipment: { select: { code: true, name: true } } },
        });

        await this.syncEquipmentFromLogbook(tx, caller, dto.equipmentId);
        return entry;
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.LOGBOOK_ENTRY,
      action: AuditAction.CREATE,
      entityId: created.id,
      accountId: caller.id,
      companyId: created.companyId,
      ipAddress,
      changes: {
        equipmentId: created.equipmentId,
        date: dto.date.slice(0, 10),
        totalHours: Number(created.totalHours),
      },
    });

    return this.toRow(caller, created);
  }

  async update(
    caller: AuthenticatedUser,
    entryId: string,
    dto: UpdateLogbookEntryDto,
    ipAddress: string,
  ): Promise<LogbookRow> {
    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.logbookEntry.findUnique({
          where: { id: entryId },
        });
        if (!existing) throw new NotFoundException('Logbook entry not found');
        assertInScope(caller, existing, 'Logbook entry');

        if (dto.operatorId) {
          await this.refs.requireEmployee(
            caller,
            dto.operatorId,
            existing.companyId,
          );
        }

        return tx.logbookEntry.update({
          where: { id: entryId },
          data: {
            ...(dto.fuelConsumed !== undefined
              ? { fuelConsumed: dto.fuelConsumed }
              : {}),
            ...(dto.remarks !== undefined ? { remarks: dto.remarks } : {}),
            ...(dto.operatorId !== undefined
              ? { operatorId: dto.operatorId }
              : {}),
          },
          include: { equipment: { select: { code: true, name: true } } },
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.LOGBOOK_ENTRY,
      action: AuditAction.UPDATE,
      entityId: entryId,
      accountId: caller.id,
      companyId: updated.companyId,
      ipAddress,
      changes: { ...dto },
    });
    return this.toRow(caller, updated);
  }

  async remove(
    caller: AuthenticatedUser,
    entryId: string,
    ipAddress: string,
  ): Promise<void> {
    const removed = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.logbookEntry.findUnique({
          where: { id: entryId },
        });
        if (!existing) throw new NotFoundException('Logbook entry not found');
        assertInScope(caller, existing, 'Logbook entry');

        await tx.logbookEntry.delete({ where: { id: entryId } });
        await this.syncEquipmentFromLogbook(tx, caller, existing.equipmentId);
        return existing;
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.LOGBOOK_ENTRY,
      action: AuditAction.DELETE,
      entityId: entryId,
      accountId: caller.id,
      companyId: removed.companyId,
      ipAddress,
      changes: { equipmentId: removed.equipmentId },
    });
  }

  /**
   * Brings a machine's `currentReading` and `utilizationPercent` back in step with
   * its logbook.
   *
   * `currentReading` is taken from the *latest-dated* surviving entry rather than
   * from whatever entry was just written. Blindly assigning the new closing reading
   * would let a backdated correction wind the meter backwards — and a wound-back
   * meter silently un-dues every service schedule on that machine.
   *
   * A machine whose last entry was just deleted falls back to the opening reading of
   * nothing at all, so the reading is left where it is: there is no honest value to
   * move it to, and zeroing it would be worse than stale.
   */
  private async syncEquipmentFromLogbook(
    tx: Prisma.TransactionClient,
    caller: AuthenticatedUser,
    equipmentId: string,
  ): Promise<void> {
    const latest = await tx.logbookEntry.findFirst({
      where: { equipmentId },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      select: { closingReading: true },
    });
    if (latest) {
      await tx.equipment.update({
        where: { id: equipmentId },
        data: { currentReading: latest.closingReading },
      });
    }

    const equipment = await tx.equipment.findUnique({
      where: { id: equipmentId },
      select: { categoryId: true },
    });
    const category = equipment
      ? await tx.equipmentCategory.findUnique({
          where: { id: equipment.categoryId },
          select: { targetHoursPerMonth: true },
        })
      : null;

    await this.equipment.recomputeUtilisation(
      tx,
      caller,
      equipmentId,
      category?.targetHoursPerMonth ?? 0,
    );
  }

  private async toRow(
    caller: AuthenticatedUser,
    row: Prisma.LogbookEntryGetPayload<{
      include: { equipment: { select: { code: true; name: true } } };
    }>,
  ): Promise<LogbookRow> {
    const operatorName = row.operatorId
      ? (await this.refs.employeeNames(caller, [row.operatorId])).get(
          row.operatorId,
        ) ?? 'Unknown operator'
      : null;
    return {
      id: row.id,
      companyId: row.companyId,
      equipmentId: row.equipmentId,
      equipmentCode: row.equipment.code,
      equipmentName: row.equipment.name,
      date: row.date,
      openingReading: Number(row.openingReading),
      closingReading: Number(row.closingReading),
      totalHours: Number(row.totalHours),
      fuelConsumed: row.fuelConsumed === null ? null : Number(row.fuelConsumed),
      operatorId: row.operatorId,
      operatorName,
      projectId: row.projectId,
      remarks: row.remarks,
      createdAt: row.createdAt,
    };
  }
}
