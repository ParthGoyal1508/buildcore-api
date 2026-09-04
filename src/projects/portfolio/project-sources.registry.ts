import { Injectable, Logger } from '@nestjs/common';

import { AuthenticatedUser } from '../../auth/authenticated-user';

/** One machine deployed on a project, as the detail page's machinery tab shows it. */
export interface ProjectMachineryRow {
  id: string;
  code: string;
  name: string;
  status: string;
  deployedSiteId: string | null;
  utilizationPercent: number;
}

/** One material issued to a project's sites, as its materials tab shows it. */
export interface ProjectMaterialRow {
  itemId: string;
  itemName: string;
  itemCode: string;
  unit: string;
  issuedQuantity: number;
}

/** What feature 006 contributes to a project page. */
export interface ProjectMachinerySource {
  getMachineryByProject(
    projectId: string,
    companyId: string,
  ): Promise<ProjectMachineryRow[]>;
  getMachineryCostByProject(
    projectId: string,
    companyId: string,
    dateRange: { from: Date; to: Date },
  ): Promise<number>;
  getFuelCostByProject(
    projectId: string,
    companyId: string,
    dateRange: { from: Date; to: Date },
  ): Promise<number>;
}

/** What feature 009 contributes. */
export interface ProjectMaterialsSource {
  getMaterialsByProject(
    caller: AuthenticatedUser,
    projectId: string,
    companyId: string,
  ): Promise<ProjectMaterialRow[]>;
  getMaterialCostByProject(
    projectId: string,
    companyId: string,
    dateRange: { from: Date; to: Date },
  ): Promise<number>;
}

/**
 * Where the modules that feed a project page announce themselves.
 *
 * The obvious wiring — `ProjectsModule` importing `PlantModule` and
 * `InventoryModule` — is not available: both of those already import *this* module,
 * because both resolve their sites through `ProjectsService.getSitesByProject()`.
 * Making the edge bidirectional turns a straight dependency into a cycle spanning
 * five modules, and every module on it then needs `forwardRef` — including
 * `PartnersModule` and `HrModule`, which have nothing to do with the change. That is
 * a lot of blast radius for a project page tab.
 *
 * So the dependency stays pointing one way and the *data* flows back through here:
 * a contributing module injects this registry (which it can, since it already
 * imports this one) and registers itself on init. `ProjectsService` reads whatever
 * turned up. It is the same shape feature 004's reminder-rule discovery uses, and
 * for the same reason — the consumer must not have to know its contributors.
 *
 * A source that never registers is not an error. It is exactly the state
 * `ProjectDetail.unavailableModules` exists to describe: "we could not ask", as
 * distinct from "we asked and there is none".
 */
@Injectable()
export class ProjectSourcesRegistry {
  private readonly logger = new Logger(ProjectSourcesRegistry.name);

  private machinery: ProjectMachinerySource | null = null;
  private materials: ProjectMaterialsSource | null = null;

  registerMachinerySource(source: ProjectMachinerySource): void {
    if (this.machinery) {
      // Two machinery sources means one is shadowing the other and half the page is
      // silently coming from somewhere nobody expects. Loud, because the symptom
      // otherwise is a number that is merely wrong.
      this.logger.warn(
        'A machinery source is already registered; the second registration is ignored.',
      );
      return;
    }
    this.machinery = source;
  }

  registerMaterialsSource(source: ProjectMaterialsSource): void {
    if (this.materials) {
      this.logger.warn(
        'A materials source is already registered; the second registration is ignored.',
      );
      return;
    }
    this.materials = source;
  }

  /** Null when feature 006 is not part of this deployment. */
  machinerySource(): ProjectMachinerySource | null {
    return this.machinery;
  }

  /** Null when feature 009 is not part of this deployment. */
  materialsSource(): ProjectMaterialsSource | null {
    return this.materials;
  }
}
