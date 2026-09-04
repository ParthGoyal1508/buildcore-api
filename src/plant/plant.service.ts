import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';

import { withRlsContext } from '../common/prisma/rls-context';
import { ProjectSourcesRegistry } from '../projects/portfolio/project-sources.registry';
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
  }

  /** True once this module can answer, so a P&L can distinguish "no machinery cost"
   * from "plant has not shipped". */
  isAvailable(): boolean {
    return true;
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
