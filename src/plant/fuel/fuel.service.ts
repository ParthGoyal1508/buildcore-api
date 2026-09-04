import { BadRequestException, Injectable } from '@nestjs/common';
import { AuditAction, AuditEntityType, Prisma } from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { assertInScope, companyScope } from '../../settings/company-scope';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants/plant.constants';
import { PlantRefsService } from '../plant-refs.service';
import {
  CreateFuelEntryDto,
  FuelSummaryDto,
  ListFuelDto,
} from './dto/fuel.dto';

export interface FuelRow {
  id: string;
  companyId: string;
  equipmentId: string;
  equipmentCode: string;
  equipmentName: string;
  date: Date;
  quantity: number;
  rate: number;
  amount: number;
  vendorId: string | null;
  vendorName: string | null;
  variancePercent: number | null;
  varianceAlert: boolean;
  createdAt: Date;
}

/** What a `fuel_variance` listener receives. Named so the shape is a contract
 * rather than an accident of whatever this service happened to have in scope. */
export interface FuelVarianceEvent {
  companyId: string;
  fuelEntryId: string;
  equipmentId: string;
  equipmentCode: string;
  date: Date;
  variancePercent: number;
  thresholdPercent: number;
}

export const FUEL_VARIANCE_EVENT = 'fuel_variance';

/**
 * The result of comparing a day's consumption against its category's benchmark.
 *
 * Extracted so the arithmetic is testable on its own, and so the one place a
 * threshold is read stays visible: the *category's* configured
 * `fuelVarianceThresholdPercent`, never the hardcoded `> 15` the original spec
 * carried (FR-004, research.md §10).
 */
export function computeFuelVariance(params: {
  /** Litres burned that day, per the logbook. */
  fuelConsumed: number | null;
  /** Meter units run that day, per the logbook. */
  totalHours: number | null;
  /** Litres per meter unit the category expects. */
  benchmark: number | null;
  thresholdPercent: number;
}): { variancePercent: number | null; varianceAlert: boolean } {
  const { fuelConsumed, totalHours, benchmark, thresholdPercent } = params;

  // No benchmark means nothing to compare against, and inventing one would flag
  // every entry on a category nobody has configured yet.
  if (benchmark === null || benchmark <= 0) {
    return { variancePercent: null, varianceAlert: false };
  }
  // A machine that ran no hours has no consumption *rate* — dividing would be a
  // division by zero, and treating it as infinite variance would flag every idle
  // day (spec Assumptions).
  if (fuelConsumed === null || totalHours === null || totalHours <= 0) {
    return { variancePercent: null, varianceAlert: false };
  }

  const actual = fuelConsumed / totalHours;
  const variancePercent =
    Math.round(((actual - benchmark) / benchmark) * 100 * 100) / 100;

  return {
    variancePercent,
    varianceAlert: variancePercent > thresholdPercent,
  };
}

/**
 * Fuel entries and their variance alerts (006 US4).
 *
 * The variance is computed once, at save, and stored (research.md §3). Deriving it
 * on read would look tidier but is wrong: editing a category's benchmark next month
 * would then silently rewrite whether last month's entries were flagged, and a
 * flag that changes retroactively is worse than no flag.
 */
@Injectable()
export class FuelService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly refs: PlantRefsService,
    private readonly events: EventEmitter2,
  ) {}

  async findAll(
    caller: AuthenticatedUser,
    query: ListFuelDto,
  ): Promise<{
    items: FuelRow[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(
      query.pageSize ?? DEFAULT_PAGE_SIZE,
      MAX_PAGE_SIZE,
    );

    const where: Prisma.FuelEntryWhereInput = {
      ...companyScope(caller, query.companyId),
      ...(query.equipmentId ? { equipmentId: query.equipmentId } : {}),
      ...(query.varianceOnly === 'true' ? { varianceAlert: true } : {}),
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
          tx.fuelEntry.findMany({
            where,
            orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
            skip: (page - 1) * pageSize,
            take: pageSize,
            include: { equipment: { select: { code: true, name: true } } },
          }),
          tx.fuelEntry.count({ where }),
        ]);
        return { rows, total };
      },
    );

    const vendorNames = await this.refs.vendorNames(
      caller,
      rows.flatMap((row) => (row.vendorId ? [row.vendorId] : [])),
    );

    return {
      items: rows.map((row) => ({
        id: row.id,
        companyId: row.companyId,
        equipmentId: row.equipmentId,
        equipmentCode: row.equipment.code,
        equipmentName: row.equipment.name,
        date: row.date,
        quantity: Number(row.quantity),
        rate: Number(row.rate),
        amount: Number(row.amount),
        vendorId: row.vendorId,
        vendorName: row.vendorId
          ? vendorNames.get(row.vendorId) ?? 'Unknown vendor'
          : null,
        variancePercent:
          row.variancePercent === null ? null : Number(row.variancePercent),
        varianceAlert: row.varianceAlert,
        createdAt: row.createdAt,
      })),
      total,
      page,
      pageSize,
    };
  }

  async create(
    caller: AuthenticatedUser,
    dto: CreateFuelEntryDto,
    ipAddress: string,
  ): Promise<FuelRow> {
    const date = this.refs.parseDate(dto.date);
    if (dto.vendorId) await this.refs.requireVendorName(caller, dto.vendorId);

    const { created, variance, threshold } = await withRlsContext(
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

        const category = await tx.equipmentCategory.findUnique({
          where: { id: equipment.categoryId },
          select: {
            fuelBenchmark: true,
            fuelVarianceThresholdPercent: true,
          },
        });

        // The logbook is the authority on what was burned and how far the machine
        // ran. Where the operator recorded no consumption, what was *bought* that
        // day is the best available proxy — a fuel entry with no logbook entry at
        // all yields no variance, which is honest rather than guessed.
        const logbook = await tx.logbookEntry.findUnique({
          where: {
            equipmentId_date: { equipmentId: dto.equipmentId, date },
          },
          select: { fuelConsumed: true, totalHours: true },
        });

        const threshold = Number(category?.fuelVarianceThresholdPercent ?? 15);
        const variance = computeFuelVariance({
          fuelConsumed:
            logbook?.fuelConsumed !== null &&
            logbook?.fuelConsumed !== undefined
              ? Number(logbook.fuelConsumed)
              : logbook
              ? dto.quantity
              : null,
          totalHours: logbook ? Number(logbook.totalHours) : null,
          benchmark:
            category?.fuelBenchmark === null ||
            category?.fuelBenchmark === undefined
              ? null
              : Number(category.fuelBenchmark),
          thresholdPercent: threshold,
        });

        const created = await tx.fuelEntry.create({
          data: {
            companyId: equipment.companyId,
            equipmentId: dto.equipmentId,
            date,
            quantity: dto.quantity,
            rate: dto.rate,
            amount: Math.round(dto.quantity * dto.rate * 100) / 100,
            vendorId: dto.vendorId ?? null,
            variancePercent: variance.variancePercent,
            varianceAlert: variance.varianceAlert,
          },
          include: { equipment: { select: { code: true, name: true } } },
        });
        return { created, variance, threshold };
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.FUEL_ENTRY,
      action: AuditAction.CREATE,
      entityId: created.id,
      accountId: caller.id,
      companyId: created.companyId,
      ipAddress,
      changes: {
        equipmentId: created.equipmentId,
        quantity: dto.quantity,
        amount: Number(created.amount),
        varianceAlert: created.varianceAlert,
      },
    });

    if (variance.varianceAlert && variance.variancePercent !== null) {
      // Emitted, not delivered: this module's job is to notice, and the
      // notifications surface's job is to decide who hears about it. The same
      // arrangement 007's compliance cron uses.
      const event: FuelVarianceEvent = {
        companyId: created.companyId,
        fuelEntryId: created.id,
        equipmentId: created.equipmentId,
        equipmentCode: created.equipment.code,
        date: created.date,
        variancePercent: variance.variancePercent,
        thresholdPercent: threshold,
      };
      this.events.emit(FUEL_VARIANCE_EVENT, event);
    }

    const vendorName = created.vendorId
      ? await this.refs.requireVendorName(caller, created.vendorId)
      : null;

    return {
      id: created.id,
      companyId: created.companyId,
      equipmentId: created.equipmentId,
      equipmentCode: created.equipment.code,
      equipmentName: created.equipment.name,
      date: created.date,
      quantity: Number(created.quantity),
      rate: Number(created.rate),
      amount: Number(created.amount),
      vendorId: created.vendorId,
      vendorName,
      variancePercent:
        created.variancePercent === null
          ? null
          : Number(created.variancePercent),
      varianceAlert: created.varianceAlert,
      createdAt: created.createdAt,
    };
  }

  /**
   * Per-equipment fuel totals for one calendar month.
   *
   * Grouped in the database rather than in Node: a company with 200 machines and a
   * busy month is thousands of rows, and shipping them all back to sum them is the
   * kind of thing that reads fine in review and times out in the yard.
   */
  async getMonthlySummary(
    caller: AuthenticatedUser,
    query: FuelSummaryDto,
  ): Promise<{
    month: string;
    items: {
      equipmentId: string;
      equipmentCode: string;
      equipmentName: string;
      totalQuantity: number;
      totalAmount: number;
      entryCount: number;
      alertCount: number;
    }[];
    totalQuantity: number;
    totalAmount: number;
  }> {
    const [year, month] = query.month.split('-').map(Number);
    const from = new Date(Date.UTC(year, month - 1, 1));
    const to = new Date(Date.UTC(year, month, 0));

    const { grouped, equipment } = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const where: Prisma.FuelEntryWhereInput = {
          ...companyScope(caller, query.companyId),
          date: { gte: from, lte: to },
        };
        const grouped = await tx.fuelEntry.groupBy({
          by: ['equipmentId'],
          where,
          _sum: { quantity: true, amount: true },
          _count: { _all: true },
        });
        const alerts = await tx.fuelEntry.groupBy({
          by: ['equipmentId'],
          where: { ...where, varianceAlert: true },
          _count: { _all: true },
        });
        const equipment = await tx.equipment.findMany({
          where: { id: { in: grouped.map((row) => row.equipmentId) } },
          select: { id: true, code: true, name: true },
        });
        return {
          grouped: grouped.map((row) => ({
            ...row,
            alertCount:
              alerts.find((alert) => alert.equipmentId === row.equipmentId)
                ?._count._all ?? 0,
          })),
          equipment,
        };
      },
    );

    const names = new Map(equipment.map((row) => [row.id, row]));
    const items = grouped
      .map((row) => ({
        equipmentId: row.equipmentId,
        equipmentCode: names.get(row.equipmentId)?.code ?? 'Unknown',
        equipmentName: names.get(row.equipmentId)?.name ?? 'Unknown machine',
        totalQuantity: Number(row._sum.quantity ?? 0),
        totalAmount: Number(row._sum.amount ?? 0),
        entryCount: row._count._all,
        alertCount: row.alertCount,
      }))
      .sort((a, b) => b.totalAmount - a.totalAmount);

    return {
      month: query.month,
      items,
      totalQuantity: items.reduce((sum, row) => sum + row.totalQuantity, 0),
      totalAmount: items.reduce((sum, row) => sum + row.totalAmount, 0),
    };
  }
}
