import { Injectable, Logger } from '@nestjs/common';

/**
 * The assets module's outward contract.
 *
 * Everything another module needs from `assets` arrives through here — a table in
 * this schema is never read from outside it (Principle I). Today that is one method,
 * the seam 008's Project P&L will read once the asset-cost slice ships.
 */
@Injectable()
export class AssetsService {
  private readonly logger = new Logger(AssetsService.name);

  /** True once this module can answer a cost question, so a P&L can distinguish
   * "no asset cost" from "assets has not shipped". */
  isAvailable(): boolean {
    return false;
  }

  /**
   * Depreciation attributable to a project over a period (spec FR-021, FR-022).
   *
   * Returns 0 deliberately, and `isAvailable()` says so: the arithmetic exists and
   * is unit-tested (`depreciationForDays` in `depreciation.ts`), but the allocation
   * data it would sum over is only meaningful once the allocation slice has been in
   * use, and a P&L that quietly reported a number computed from an empty allocation
   * history would present 0 as a *measurement* rather than as "not asked yet".
   * That distinction is the whole point of `ProjectSourcesRegistry`'s
   * unavailable-module reporting, so this stub is honest rather than convenient.
   */
  async getAssetCostByProject(
    _projectId: string,
    _companyId: string,
    _dateRange: { from: Date; to: Date },
  ): Promise<number> {
    return 0;
  }
}
