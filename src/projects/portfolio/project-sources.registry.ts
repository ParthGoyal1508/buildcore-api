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
 * One category's cost for several projects at once (018 FR-010, task T025).
 *
 * **Batched by `projectIds`, and that is the whole point of the interface.** A per-project signature
 * makes the group view an N+1 that no registrant can fix from their side: the P&L would call each
 * source once per project, and a company with sixty live projects would issue sixty queries per
 * category. The existing `getMachineryCostByProject` and `getMaterialCostByProject` are per-project
 * and predate this; they are called in a loop by `summaryFor` and that loop is the thing this
 * interface exists to stop spreading.
 *
 * Returns a map so a project with no cost in the period is **absent rather than zero**, and the P&L
 * can tell "nothing spent" from "not asked".
 */
/**
 * One record behind a cost figure (018 FR-012).
 *
 * Deliberately shallow and uniform: the drill-down's job is to let a reader see *what* a total is
 * made of and go and open it, not to re-render each module's own screen inside the P&L. `reference`
 * is whatever that module's users call the thing — a bill number, a sheet's period — because an id
 * is not something anybody can look up on a noticeboard.
 */
export interface ProjectCostRecord {
  id: string;
  reference: string;
  /** `YYYY-MM-DD`. */
  date: string;
  amount: number;
  status: string | null;
  description: string | null;
}

export interface ProjectCostSource {
  /** Which budget category this source accounts for. One source per category. */
  readonly category:
    | 'labour'
    | 'materials'
    | 'machinery'
    | 'fuel'
    | 'overheads';
  costsByProject(
    projectIds: string[],
    companyId: string,
    range: { from: Date; to: Date },
  ): Promise<Map<string, number>>;
  /**
   * The records comprising one project's figure, for the drill-down (FR-012).
   *
   * **Optional, and the optionality is the point.** A source that cannot itemise its total declines
   * to implement this, and the drill-down then reports "this module exposes a total only", naming
   * it. The alternative — every source returning `[]` — makes "we cannot itemise this" and "there
   * is nothing to itemise" the same answer, which is the identical mistake
   * `unavailableCategories` exists to avoid one level up.
   *
   * Per-project rather than batched: a drill-down is opened on one figure, by one person, having
   * already decided which project they are looking at.
   */
  recordsByProject?(
    projectId: string,
    companyId: string,
    range: { from: Date; to: Date },
  ): Promise<ProjectCostRecord[]>;
}

/**
 * A batched cost source built from a module's existing per-project method.
 *
 * **It loops, and that is a deliberate, local, reversible choice.** The interface is batched
 * because a per-project *contract* makes the group view an N+1 that no registrant can fix (T025).
 * A registrant that loops behind a batched contract is a different thing: the consumer asks once,
 * and whichever module wants to replace the loop with one query can, without anybody else
 * changing a line.
 *
 * Why not batch them all today: `getMachineryCostByProject` sums four components — verified hire
 * bills, apportioned depreciation, spare parts net of reversals, verified service bills — and it is
 * the shipped, tested figure the project detail page already serves. A second, batched
 * implementation of it would be a second machinery cost in the product, and the first time the two
 * disagreed nobody would know which was right. Looping the tested one is the honest trade until
 * somebody needs the group view across hundreds of projects.
 *
 * Failures stay inside the per-project method, which logs and returns 0 by design — a project that
 * cannot be computed must not take the other fifty-nine down with it.
 */
export function costSourceFromPerProject(
  category: ProjectCostSource['category'],
  perProject: (
    projectId: string,
    companyId: string,
    range: { from: Date; to: Date },
  ) => Promise<number>,
): ProjectCostSource {
  return {
    category,
    async costsByProject(projectIds, companyId, range) {
      const entries = await Promise.all(
        projectIds.map(
          async (projectId) =>
            [projectId, await perProject(projectId, companyId, range)] as const,
        ),
      );
      return new Map(entries);
    },
  };
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

  /**
   * Batched cost sources, keyed by category (018 FR-010).
   *
   * A map rather than a list, because one category with two sources is the same shadowing problem the
   * warnings above exist for — and here it would double a cost figure rather than hide a tab.
   */
  private readonly costSources = new Map<string, ProjectCostSource>();

  registerCostSource(source: ProjectCostSource): void {
    if (this.costSources.has(source.category)) {
      // Loud, because the symptom is a cost figure that is exactly twice what it should be — which
      // reads as a data problem rather than a wiring one, and sends somebody to the wrong module.
      this.logger.warn(
        `A cost source for "${source.category}" is already registered; the second is ignored.`,
      );
      return;
    }
    this.costSources.set(source.category, source);
  }

  costSource(category: string): ProjectCostSource | null {
    return this.costSources.get(category) ?? null;
  }

  /** Which categories have a source. What the P&L reports as *unavailable* is the complement. */
  registeredCostCategories(): string[] {
    return [...this.costSources.keys()];
  }
}
