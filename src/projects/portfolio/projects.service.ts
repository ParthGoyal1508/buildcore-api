import { Injectable } from '@nestjs/common';

/** One project's contract value, as the cess calculation needs it. */
export interface ProjectContractValue {
  projectId: string;
  name: string;
  contractValue: number;
}

/**
 * The `projects` module's outward contract for the Project master.
 *
 * Both methods are stubs. Feature 008 owns `projects.Project`, its contract values
 * and its work orders, and has not been built — 007 needs to call them now, and
 * Principle I says the call must go through this module rather than through a
 * cross-schema query that would have to be unpicked later.
 *
 * They return empty rather than throwing, deliberately. A consumer that must handle
 * "no projects yet" already handles "module not built yet" correctly, so 007's BOCW
 * screen shows an empty list with an explanation instead of an error — and the day
 * 008 lands, these two method bodies are the only thing that changes.
 */
@Injectable()
export class ProjectsService {
  /**
   * Whether the Project Portfolio actually exists yet.
   *
   * Without this, a consumer cannot tell "this company has no projects" from "the
   * module that would know has not been built" — and the two demand completely
   * different things on screen: an empty state, or an explanation. One boolean, one
   * place to change when 008 lands.
   */
  isPortfolioAvailable(): boolean {
    // TODO(008): return true once the Project Portfolio story ships.
    return false;
  }

  /**
   * Projects with a contract value, for BOCW cess liability (007 FR-008).
   *
   * TODO(008): implement against `projects.Project` once the Project Portfolio
   * story ships. Until then the BOCW list is empty and reports `projects` as an
   * unavailable module rather than pretending the company has none.
   */
  async getProjectsWithContractValues(
    _companyId: string,
  ): Promise<ProjectContractValue[]> {
    return [];
  }

  /**
   * Total value of work orders raised against a project in a date range, for
   * subcontractor cost in the Project P&L (007 FR-009).
   *
   * TODO(008): implement against `projects.WorkOrder`. Returning 0 means a P&L
   * built today understates subcontractor cost rather than failing — which is why
   * the caller must surface the gap rather than presenting 0 as a measured figure.
   */
  async getWorkOrderTotalByProject(
    _projectId: string,
    _range?: { from?: Date; to?: Date },
  ): Promise<number> {
    return 0;
  }
}
