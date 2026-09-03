/**
 * The contracts the Project P&L (spec FR-008) reads its actual costs through.
 *
 * Principle I forbids this module from querying the `hr`, `payroll`, `plant`,
 * `inventory` or `partners` schemas. Every cost figure therefore arrives as an
 * in-process call against one of the interfaces below, which is what keeps the six
 * modules independently extractable later.
 *
 * State of the four sources as of feature 008 US1–US3:
 *
 * | Source     | Owning feature | Today |
 * |------------|----------------|-------|
 * | Partners   | 007 (shipped)  | `PartnersService.getSubcontractorCostByProject()` exists and delegates to `ProjectsService.getWorkOrderTotalByProject()` — real once US6 fills that in |
 * | HR/Payroll | 005 (shipped)  | No labour-cost-by-project method yet; needs `PayrollLineItem.projectId`, which is a 005 amendment this feature has not made |
 * | Plant      | 006            | Module not built — `src/plant` does not exist |
 * | Inventory  | 009            | Module not built |
 *
 * So all four are declarations, not yet injections. That is deliberate: the P&L is
 * User Story 7 and out of the US1–US3 scope, and writing the seam now is what lets
 * that story be built against a fixed contract rather than around whatever each
 * module happens to expose on the day.
 *
 * Every method returns a number rather than throwing when a source is unavailable.
 * A P&L that fails because Inventory does not exist yet is useless; one that reports
 * 0 material cost **and names Inventory in `unavailableModules`** is honest about
 * what it could not measure. Presenting an unavailable source as a measured zero is
 * the one outcome none of these may produce.
 */

/** A cost query is always scoped to one project, optionally to a period. */
export interface CostByProjectQuery {
  projectId: string;
  from?: Date;
  to?: Date;
}

/** Materials issued to a project — feature 009. */
export interface PnlInventorySource {
  getMaterialCostByProject(query: CostByProjectQuery): Promise<number>;
}

/** Subcontracted work billed against a project — feature 007. */
export interface PnlPartnersSource {
  getSubcontractorCostByProject(
    projectId: string,
    dateRange?: { from?: Date; to?: Date },
  ): Promise<number>;
}

/** Machinery deployment and fuel drawn on a project — feature 006. */
export interface PnlPlantSource {
  getMachineryCostByProject(query: CostByProjectQuery): Promise<number>;
  getFuelCostByProject(query: CostByProjectQuery): Promise<number>;
}

/** Wages and salary apportioned to a project — feature 005. */
export interface PnlHrPayrollSource {
  getLabourCostByProject(query: CostByProjectQuery): Promise<number>;
}

/**
 * Stand-ins for the two modules that do not exist at all yet.
 *
 * They return 0 rather than throwing for the reason given above, and they are typed
 * against the same interfaces the real implementations will satisfy — so when 006
 * and 009 land, the change is a provider swap and not a rewrite of the caller.
 */
export const UNAVAILABLE_INVENTORY_SOURCE: PnlInventorySource = {
  async getMaterialCostByProject(): Promise<number> {
    return 0;
  },
};

export const UNAVAILABLE_PLANT_SOURCE: PnlPlantSource = {
  async getMachineryCostByProject(): Promise<number> {
    return 0;
  },
  async getFuelCostByProject(): Promise<number> {
    return 0;
  },
};

/**
 * A reference to a unit of planned work — a BOQ task group ("Activity") or a BOQ
 * task item — as another module needs it to validate and label a link to one
 * (009 FR-019).
 *
 * Deliberately the same shape for both: the consumer stores an id and renders a
 * name, and giving the two kinds different shapes would push a discriminated union
 * into every caller for no gain.
 */
export interface ProjectWorkReference {
  id: string;
  name: string;
  /** The BOQ number, for display beside the name. */
  reference: string;
  projectId: string;
}
