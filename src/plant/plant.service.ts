import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { HireBillStatus } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { withRlsContext } from '../common/prisma/rls-context';
import {
  EquipmentLogbookDay,
  ProjectSourcesRegistry,
  costSourceFromPerProject,
} from '../projects/portfolio/project-sources.registry';
import { ProjectsService } from '../projects/portfolio/projects.service';
import { MONTHS_PER_YEAR } from './constants/plant.constants';

/** Whole months, inclusive of both ends, that a date range covers. */
function monthsBetween(from: Date, to: Date): number {
  const months =
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 +
    (to.getUTCMonth() - from.getUTCMonth()) +
    1;
  return Math.max(0, months);
}

/**
 * The plant module's outward contract (FR-008).
 *
 * Two methods, both feeding 008's Project P&L. Everything another module needs from
 * `plant` arrives through here — a table in this schema is never read from outside
 * it (Principle I).
 *
 * Both return 0 rather than throwing when a project has no sites or the lookup
 * fails. A P&L that renders every other cost line and shows zero machinery is more
 * useful than one that fails outright, and the caller is expected to say which of
 * its sources were unavailable. The failure is logged so a persistent zero is not
 * mistaken for a measurement.
 */
@Injectable()
export class PlantService implements OnModuleInit {
  private readonly logger = new Logger(PlantService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
    private readonly sources: ProjectSourcesRegistry,
  ) {}

  /**
   * Announces this module to the project page.
   *
   * Registration rather than `ProjectsModule` importing this one: that module is
   * already imported *by* this one, and closing the loop would make the dependency
   * a cycle spanning five modules. See `ProjectSourcesRegistry`.
   */
  onModuleInit(): void {
    this.sources.registerMachinerySource(this);
    // 022 FR-032. A daily work report shows the equipment's own logbook entry for the work date
    // beside a presence-paid line — the odometer register printed beneath each measurement sheet in
    // the client's real bill package. Registered from this side for the reason the comment below
    // gives: `projects` importing this module would close the cycle.
    this.sources.registerLogbookSource(this);
    // 018 T028. Two categories, because `plant` accounts for two: a machine's cost of ownership
    // and the diesel it burns are budgeted separately and overrun separately, and a single figure
    // would hide which. Registering them is what moves the P&L's machinery and fuel lines out of
    // `unavailableCategories` — until a module registers, the P&L correctly refuses to call them
    // zero.
    this.sources.registerCostSource(
      costSourceFromPerProject('machinery', (projectId, companyId, range) =>
        this.getMachineryCostByProject(projectId, companyId, range),
      ),
    );
    this.sources.registerCostSource(
      costSourceFromPerProject('fuel', (projectId, companyId, range) =>
        this.getFuelCostByProject(projectId, companyId, range),
      ),
    );
  }

  /**
   * One machine's logbook days, for a daily work report's measurement line (022 FR-032, FR-033).
   *
   * **Returns a map, and a date with no entry is absent from it rather than present with zeros.**
   * That is the requirement rather than a convenience: a run of zero kilometres and a missing
   * register page are different facts, and only one of them is a reason to go and ask somebody. A
   * report that rendered the second as the first would quietly turn an unrecorded day into a day
   * the asset did nothing, which is the sort of figure a client's deduction is argued from.
   *
   * One query for every date asked about, not one per date — the registry's own lesson about
   * per-project signatures, applied to dates.
   */
  async getLogbookDays(
    equipmentId: string,
    companyId: string,
    dates: string[],
  ): Promise<Map<string, EquipmentLogbookDay>> {
    if (dates.length === 0) return new Map();

    const entries = await this.prisma.logbookEntry.findMany({
      where: {
        companyId,
        equipmentId,
        date: { in: dates.map((d) => new Date(`${d}T00:00:00.000Z`)) },
      },
      select: {
        date: true,
        openingReading: true,
        closingReading: true,
        totalHours: true,
        fuelConsumed: true,
        remarks: true,
      },
    });

    return new Map(
      entries.map((entry) => [
        entry.date.toISOString().slice(0, 10),
        {
          date: entry.date.toISOString().slice(0, 10),
          openingReading: entry.openingReading.toFixed(3),
          closingReading: entry.closingReading.toFixed(3),
          totalHours: entry.totalHours.toFixed(3),
          fuelConsumed: entry.fuelConsumed?.toFixed(3) ?? null,
          remarks: entry.remarks,
        },
      ]),
    );
  }

  /** True once this module can answer, so a P&L can distinguish "no machinery cost""
   * from "plant has not shipped". */
  isAvailable(): boolean {
    return true;
  }

  /**
   * The machines standing at one site (2026-10-12).
   *
   * For the Site Dashboard's Machinery Deployed count and its Machinery at Site table,
   * both of which were "waiting on the machinery module" placeholders. `deployedSiteId`
   * is the field the equipment register already filters on, so the dashboard and the
   * register agree by construction.
   *
   * Site ids come from the `projects` schema; this only ever compares the one it is
   * handed against its own column, so no cross-schema read is involved.
   */
  async getSiteMachinery(
    companyId: string,
    siteId: string,
  ): Promise<{ id: string; code: string; name: string; status: string }[]> {
    return withRlsContext(
      this.prisma,
      { isSuperAdmin: false, companyId },
      (tx) =>
        tx.equipment.findMany({
          where: { companyId, deployedSiteId: siteId },
          select: { id: true, code: true, name: true, status: true },
          orderBy: { code: 'asc' },
        }),
    );
  }

  /**
   * The three company-wide plant figures the dashboard shows (2026-10-12).
   *
   * One method rather than three, and on this façade rather than by exporting
   * `EquipmentService`, `FuelService` and `HireBillsService`: this module exports
   * deliberately little — the note on `FuelRecoveryService` above says why — and three
   * new exports to render three numbers would widen that surface more than the numbers
   * are worth. It is also one round trip instead of three.
   *
   * `unpaidHireBills` counts everything not yet paid, verified or not. The card answers
   * "what is outstanding on hired plant", and a bill nobody has verified yet is still
   * money the company expects to pay — unlike `getMachineryCostByProject` above, which
   * excludes unverified bills precisely because a P&L must not book a claim as a cost.
   * The two differ on purpose.
   */
  async getCompanyTotals(
    companyId: string,
    month: { from: Date; to: Date },
  ): Promise<{
    equipmentCount: number;
    fuelSpend: number;
    unpaidHireBills: number;
  }> {
    return withRlsContext(
      this.prisma,
      { isSuperAdmin: false, companyId },
      async (tx) => {
        const [equipmentCount, fuel, hire] = await Promise.all([
          tx.equipment.count({ where: { companyId } }),
          tx.fuelEntry.aggregate({
            where: { companyId, date: { gte: month.from, lte: month.to } },
            _sum: { amount: true },
          }),
          tx.hireBill.aggregate({
            where: { companyId, status: { not: HireBillStatus.paid } },
            _sum: { netPayable: true },
          }),
        ]);
        return {
          equipmentCount,
          fuelSpend: Number(fuel._sum.amount ?? 0),
          unpaidHireBills: Number(hire._sum.netPayable ?? 0),
        };
      },
    );
  }

  /**
   * One site's fuel for one month, and how much of its history this cannot see.
   *
   * `FuelEntry.siteId` was added on 2026-10-12. Entries made before it have none, and
   * there is no honest backfill — the only candidate is the machine's *current*
   * deployment, which would file last month's diesel wherever the machine stands today
   * and restate the figure every time one moved.
   *
   * So `unattributed` is returned alongside the total, and it is not decoration: a site
   * card showing a confident ₹0 for a month whose entries all predate the column is
   * worse than one saying it cannot answer yet. The widget reads it and says so.
   *
   * Counted for the whole company in the month, not for the site — an entry with no
   * site cannot be known to belong to this one, which is the entire problem.
   */
  async getSiteFuelForMonth(
    companyId: string,
    siteId: string,
    month: { from: Date; to: Date },
  ): Promise<{ litres: number; spend: number; unattributed: number }> {
    return withRlsContext(
      this.prisma,
      { isSuperAdmin: false, companyId },
      async (tx) => {
        const period = { gte: month.from, lte: month.to };
        const [atSite, unattributed] = await Promise.all([
          tx.fuelEntry.aggregate({
            where: { companyId, siteId, date: period },
            _sum: { quantity: true, amount: true },
          }),
          tx.fuelEntry.count({
            where: { companyId, siteId: null, date: period },
          }),
        ]);
        return {
          litres: Number(atSite._sum.quantity ?? 0),
          spend: Number(atSite._sum.amount ?? 0),
          unattributed,
        };
      },
    );
  }

  /**
   * What machinery cost a project over a period (FR-008, corrected by FR-025).
   *
   * Four components, and the last two are the correction:
   *
   * - **Hired** machines: verified `HireBill.netPayable` overlapping the range.
   *   Unverified bills are excluded — an unverified invoice is a claim, not a cost.
   * - **Owned** machines: straight-line depreciation apportioned by month,
   *   `purchaseCost × depreciationRate / 100 / 12` per month in range.
   * - **Spare parts** consumed on those machines, net of reversals.
   * - **Verified service bills** against those machines' maintenance jobs.
   *
   * The original FR-008 counted only the first two, which systematically understated
   * machinery cost by every repair and every part fitted — a machine that cost a
   * fortune to keep running reported the same as one that never broke. The amendment
   * (FR-025) is what corrects that, and it is why this method sums four things
   * rather than two.
   *
   * Site resolution goes through `ProjectsService.getSitesByProject()` rather than a
   * join, because the sites live in the `projects` schema (Principle I).
   */
  async getMachineryCostByProject(
    projectId: string,
    companyId: string,
    dateRange: { from: Date; to: Date },
  ): Promise<number> {
    try {
      const siteIds = await this.projects.getSitesByProject(projectId, {
        isSuperAdmin: false,
        companyId,
      });
      if (siteIds.length === 0) return 0;

      return await withRlsContext(
        this.prisma,
        { isSuperAdmin: false, companyId },
        async (tx) => {
          const equipment = await tx.equipment.findMany({
            where: { companyId, deployedSiteId: { in: siteIds } },
            select: {
              id: true,
              ownership: true,
              purchaseCost: true,
              depreciationRate: true,
            },
          });
          if (equipment.length === 0) return 0;
          const equipmentIds = equipment.map((row) => row.id);

          const [hireBills, jobs, movements] = await Promise.all([
            tx.hireBill.findMany({
              where: {
                companyId,
                equipmentId: { in: equipmentIds },
                status: 'verified',
                // Overlap, not containment: a bill spanning a month boundary is
                // still a cost of the period it reaches into, and requiring the
                // whole period to sit inside the range would drop it entirely.
                billingPeriodFrom: { lte: dateRange.to },
                billingPeriodTo: { gte: dateRange.from },
              },
              select: { netPayable: true },
            }),
            tx.maintenanceJob.findMany({
              where: { companyId, equipmentId: { in: equipmentIds } },
              select: { id: true },
            }),
            tx.sparePartMovement.findMany({
              where: {
                companyId,
                deletedAt: null,
                movementDate: { gte: dateRange.from, lte: dateRange.to },
                maintenanceJob: { equipmentId: { in: equipmentIds } },
              },
              select: { type: true, amount: true },
            }),
          ]);

          const jobIds = jobs.map((job) => job.id);
          const serviceBills =
            jobIds.length === 0
              ? []
              : await tx.serviceBill.findMany({
                  where: {
                    companyId,
                    maintenanceJobId: { in: jobIds },
                    status: 'verified',
                    deletedAt: null,
                    billDate: { gte: dateRange.from, lte: dateRange.to },
                  },
                  select: { netPayable: true },
                });

          const hireCost = hireBills.reduce(
            (sum, bill) => sum + Number(bill.netPayable),
            0,
          );

          const months = monthsBetween(dateRange.from, dateRange.to);
          const depreciation = equipment
            .filter((row) => row.ownership === 'owned')
            .reduce((sum, row) => {
              const cost = Number(row.purchaseCost ?? 0);
              const rate = Number(row.depreciationRate ?? 0);
              return sum + ((cost * rate) / 100 / MONTHS_PER_YEAR) * months;
            }, 0);

          // A reversal cancels its consumption, so it subtracts. Receipts are not
          // counted at all: buying a part is stock, not a project cost — it becomes
          // one when it is fitted to a machine working there.
          const partsCost = movements.reduce((sum, movement) => {
            if (movement.type === 'consumption') {
              return sum + Number(movement.amount);
            }
            if (movement.type === 'reversal') {
              return sum - Number(movement.amount);
            }
            return sum;
          }, 0);

          const serviceCost = serviceBills.reduce(
            (sum, bill) => sum + Number(bill.netPayable),
            0,
          );

          return (
            Math.round(
              (hireCost + depreciation + partsCost + serviceCost) * 100,
            ) / 100
          );
        },
      );
    } catch (error) {
      this.logger.warn(
        `Machinery cost for project ${projectId} could not be computed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 0;
    }
  }

  /** Fuel drawn by machines deployed at a project's sites in the range (FR-008). */
  async getFuelCostByProject(
    projectId: string,
    companyId: string,
    dateRange: { from: Date; to: Date },
  ): Promise<number> {
    try {
      const siteIds = await this.projects.getSitesByProject(projectId, {
        isSuperAdmin: false,
        companyId,
      });
      if (siteIds.length === 0) return 0;

      return await withRlsContext(
        this.prisma,
        { isSuperAdmin: false, companyId },
        async (tx) => {
          const equipment = await tx.equipment.findMany({
            where: { companyId, deployedSiteId: { in: siteIds } },
            select: { id: true },
          });
          if (equipment.length === 0) return 0;

          const total = await tx.fuelEntry.aggregate({
            where: {
              companyId,
              equipmentId: { in: equipment.map((row) => row.id) },
              date: { gte: dateRange.from, lte: dateRange.to },
            },
            _sum: { amount: true },
          });
          return Number(total._sum.amount ?? 0);
        },
      );
    } catch (error) {
      this.logger.warn(
        `Fuel cost for project ${projectId} could not be computed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 0;
    }
  }

  /**
   * Machines deployed at a project's sites, for 008's project-detail machinery tab.
   *
   * Returns an empty list rather than throwing for the same reason the cost methods
   * return 0: a project page that fails because one tab could not load is worse than
   * one that renders with a tab it admits it could not fill.
   */
  async getMachineryByProject(
    projectId: string,
    companyId: string,
  ): Promise<
    {
      id: string;
      code: string;
      name: string;
      status: string;
      deployedSiteId: string | null;
      utilizationPercent: number;
    }[]
  > {
    try {
      const siteIds = await this.projects.getSitesByProject(projectId, {
        isSuperAdmin: false,
        companyId,
      });
      if (siteIds.length === 0) return [];

      return await withRlsContext(
        this.prisma,
        { isSuperAdmin: false, companyId },
        async (tx) => {
          const rows = await tx.equipment.findMany({
            where: { companyId, deployedSiteId: { in: siteIds } },
            orderBy: { code: 'asc' },
            select: {
              id: true,
              code: true,
              name: true,
              status: true,
              deployedSiteId: true,
              utilizationPercent: true,
            },
          });
          return rows.map((row) => ({
            id: row.id,
            code: row.code,
            name: row.name,
            status: row.status,
            deployedSiteId: row.deployedSiteId,
            utilizationPercent: Number(row.utilizationPercent),
          }));
        },
      );
    } catch (error) {
      this.logger.warn(
        `Machinery for project ${projectId} could not be listed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return [];
    }
  }
}
