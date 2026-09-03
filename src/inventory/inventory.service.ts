import { Injectable, Logger } from '@nestjs/common';

import { ProjectsService } from '../projects/portfolio/projects.service';
import { PurchasesService } from './purchases/purchases.service';

/**
 * The inventory module's outward contract.
 *
 * One method today: the material cost feeding 008's Project P&L (FR-009).
 */
@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(
    private readonly projects: ProjectsService,
    private readonly purchases: PurchasesService,
  ) {}

  /** True once this module can answer, so a P&L can distinguish "no material cost"
   * from "inventory has not shipped". */
  isAvailable(): boolean {
    return true;
  }

  /**
   * Total material purchased for a project's sites in a date range (FR-009).
   *
   * Site resolution goes through `ProjectsService.getSitesByProject()` rather than
   * a join, because the sites live in the `projects` schema (Principle I). That
   * method is a real query now that 008 has shipped `Site.projectId`, so this
   * returns measured figures rather than the zero the original task list expected
   * from a stub.
   *
   * Returns 0 rather than throwing when the project has no sites or the lookup
   * fails: a P&L that renders every other cost line and shows zero material is more
   * useful than one that fails outright, and the caller is expected to say which of
   * its sources were unavailable. The failure is logged so a persistent zero is not
   * mistaken for a measurement.
   */
  async getMaterialCostByProject(
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
      return await this.purchases.materialCostForSites(
        siteIds,
        companyId,
        dateRange,
      );
    } catch (error) {
      this.logger.warn(
        `Material cost for project ${projectId} could not be computed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 0;
    }
  }
}
