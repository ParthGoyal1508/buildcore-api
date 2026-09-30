import { Injectable, Logger } from '@nestjs/common';

import { RlsContext } from '../../common/prisma/rls-context';

/** One asset still held by a departing employee, as the clearance needs it. */
export interface HeldAsset {
  allocationId: string;
  assetId: string;
  assetName: string;
  assetCode: string | null;
  projectId: string;
  siteId: string;
  quantity: number;
  expectedReturnDate: Date;
}

/** What feature 012 contributes to an exit clearance. */
export interface ExitCustodySource {
  openCustodyFor(
    ctx: RlsContext,
    companyId: string,
    employeeId: string,
  ): Promise<HeldAsset[]>;
}

/**
 * Where the assets module announces that it can answer "what does this leaver still hold?"
 * (021 FR-014a, plan D15).
 *
 * The obvious wiring — `HrModule` importing `AssetsModule` — is not available: `AssetsModule`
 * already imports `HrModule`, so closing the loop would make the dependency a cycle. The same
 * situation `ProjectSourcesRegistry` was built for, and the same answer: the dependency stays
 * pointing one way and the *data* flows back through here.
 *
 * A source that never registers is **not an error**. It means feature 012 is not part of this
 * deployment, and a clearance that then reported no assets would be lying — so
 * `ExitClearanceService` distinguishes "no assets held" from "could not ask", exactly as a
 * project page distinguishes them.
 */
@Injectable()
export class ExitCustodyRegistry {
  private readonly logger = new Logger(ExitCustodyRegistry.name);

  private custody: ExitCustodySource | null = null;

  register(source: ExitCustodySource): void {
    if (this.custody) {
      // Two sources means one shadows the other and a clearance is silently reading from
      // somewhere nobody expects. Loud, because the symptom otherwise is a leaver clearing
      // exit while still holding a laptop.
      this.logger.warn(
        'An exit custody source is already registered; the second registration is ignored.',
      );
      return;
    }
    this.custody = source;
  }

  /** Null when feature 012 is not deployed. */
  source(): ExitCustodySource | null {
    return this.custody;
  }
}
