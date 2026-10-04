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

/**
 * One asset this employee was ever given, as the **settlement summary** needs it (021 FR-018a).
 *
 * A different question from `HeldAsset`, and the difference is the whole of the client's item 10.
 * The clearance asks "what is still outstanding"; the settlement summary is the record of how each
 * asset *ended*. An asset returned during the notice period disappears from the first and **must
 * still appear in the second** — "any assets assigned to the employee should appear in the F&F
 * summary", read literally.
 */
export interface CustodyRecord extends HeldAsset {
  /** `open` while still held; `closed` once returned or written off. */
  status: 'open' | 'closed';
  /** The day it actually came back. Null while it has not. */
  actualReturnDate: Date | null;
}

/** What feature 012 contributes to an exit clearance. */
export interface ExitCustodySource {
  openCustodyFor(
    ctx: RlsContext,
    companyId: string,
    employeeId: string,
  ): Promise<HeldAsset[]>;

  /**
   * Every allocation naming this employee as custodian, open **and** closed.
   *
   * Separate from `openCustodyFor` rather than a flag on it, because the two have different
   * callers with different needs and a boolean parameter is how one of them silently gets the
   * other's answer. The clearance must not list a returned asset as outstanding; the settlement
   * summary must not omit it.
   */
  custodyHistoryFor(
    ctx: RlsContext,
    companyId: string,
    employeeId: string,
  ): Promise<CustodyRecord[]>;
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
