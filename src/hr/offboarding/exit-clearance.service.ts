import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  OnboardingItemStatus,
  OnboardingItemType,
  SalaryAdvanceStatus,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { ACTOR_NAME_SELECT, actorNameOf } from '../../common/actor-name';
import { RlsContext, withRlsContext } from '../../common/prisma/rls-context';
import { ExitCustodyRegistry } from './exit-custody.registry';

/** The kinds of obligation a clearance can carry. Stable strings, because a waiver stores one. */
export const CLEARANCE_KIND = {
  asset: 'asset_custody',
  kit: 'recoverable_kit',
  advance: 'salary_advance',
  access: 'account_access',
} as const;

export type ClearanceKind =
  (typeof CLEARANCE_KIND)[keyof typeof CLEARANCE_KIND];

export interface ClearanceItem {
  kind: ClearanceKind;
  /** The obligation's id in its owning module. What a waiver points at. */
  ref: string;
  label: string;
  /** One disambiguating fact — a site, a due date, a balance. */
  detail: string | null;
  outstanding: boolean;
  waiver: {
    reason: string;
    waivedByUserId: string;
    /**
     * Who waived it, as a person reads it (021 FR-016).
     *
     * The id alone is not enough: FR-016 requires the waiver to **display its author**, and
     * a screen handed only a cuid either renders the cuid or invents its own lookup. Resolved
     * here through `actorNameOf`, the same chain `ApprovalsService.namesFor` and 016's
     * attendance-modification view use, so the same person cannot appear under two names on
     * two screens.
     *
     * Added 2026-10-01 while building the clearance screen, which could not satisfy FR-016
     * without it.
     */
    waivedByName: string;
    waivedAt: Date;
  } | null;
}

export interface ExitClearance {
  exitRecordId: string;
  employeeId: string;
  /**
   * Obligation kinds that could not be checked because their module is not deployed.
   *
   * Never a permission failure and never "there were none" — this is "we could not ask", which
   * a reader must be able to tell from "there is nothing outstanding".
   */
  unavailableSources: string[];
  items: ClearanceItem[];
  /** True when nothing is outstanding and unwaived — the gate FR-015 applies. */
  settleable: boolean;
}

/**
 * The exit clearance (021 FR-014 to FR-018b) — `bugs.md` item 10.
 *
 * **Derived, not stored.** Every obligation is read fresh from the module that owns it; only
 * waivers are persisted. A stored checklist would be a second copy of custody, stale the moment
 * an asset came back through the asset register — and FR-014c requires a return there to satisfy
 * the item here with no second action. Deriving makes those the same fact rather than two facts
 * somebody has to keep in step, and it is also what FR-014e means by recomputing at read time:
 * an allocation opened after the exit was initiated is caught rather than missed.
 *
 * Asset custody is read through `AllocationService`, never by joining into `assets` —
 * `ExitRecord` is in `hr` and `AssetAllocation` is in `assets`, and Principle I forbids a query
 * spanning them.
 */
@Injectable()
export class ExitClearanceService {
  constructor(
    private readonly prisma: PrismaService,
    // Registered by the assets module on init, because importing it here would be a cycle —
    // see `ExitCustodyRegistry`.
    private readonly custody: ExitCustodyRegistry,
  ) {}

  async forEmployee(
    ctx: RlsContext,
    companyId: string,
    employeeId: string,
  ): Promise<ExitClearance> {
    const exitRecord = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.exitRecord.findFirst({
        where: { employeeId },
        orderBy: { createdAt: 'desc' },
      }),
    );
    if (!exitRecord) {
      throw new NotFoundException(
        'No exit has been initiated for this employee.',
      );
    }

    const custodySource = this.custody.source();

    const [assets, kit, advances, waivers] = await Promise.all([
      custodySource
        ? custodySource.openCustodyFor(ctx, companyId, employeeId)
        : Promise.resolve([]),
      this.recoverableKit(ctx, companyId, employeeId),
      this.outstandingAdvances(ctx, employeeId),
      withRlsContext(this.prisma, ctx, (tx) =>
        tx.exitClearanceWaiver.findMany({
          where: { exitRecordId: exitRecord.id },
        }),
      ),
    ]);

    // One query for every waiver's author rather than one per item. A clearance with six
    // waivers would otherwise be six round trips for a column.
    const waiverNames = await this.namesFor(
      waivers.map((w) => w.waivedByUserId),
    );

    const waiverFor = (kind: ClearanceKind, ref: string) => {
      const found = waivers.find(
        (w) => w.itemKind === kind && w.itemRef === ref,
      );
      return found
        ? {
            reason: found.reason,
            waivedByUserId: found.waivedByUserId,
            // Falls back to the id rather than to a blank or an em dash. A waiver whose
            // author's row has gone is still a waiver somebody made, and an unreadable
            // identifier is more honest than a dash where a person belongs.
            waivedByName:
              waiverNames.get(found.waivedByUserId) ?? found.waivedByUserId,
            waivedAt: found.waivedAt,
          }
        : null;
    };

    const items: ClearanceItem[] = [
      ...assets.map((asset) => ({
        kind: CLEARANCE_KIND.asset,
        ref: asset.allocationId,
        label: `${asset.assetName}${
          asset.assetCode ? ` (${asset.assetCode})` : ''
        }`,
        // The quantity is stated where an allocation covers more than one unit. An allocation is
        // open or closed as a whole — the asset register holds no partial return — so the
        // checklist reports the count rather than pretending some came back.
        detail:
          `Site ${asset.siteId}` +
          (asset.quantity > 1 ? `, ${asset.quantity} units` : '') +
          `, due ${asset.expectedReturnDate.toISOString().slice(0, 10)}`,
        outstanding: true,
        waiver: waiverFor(CLEARANCE_KIND.asset, asset.allocationId),
      })),
      ...kit.map((item) => ({
        kind: CLEARANCE_KIND.kit,
        ref: item.ref,
        label: item.label,
        detail: null,
        outstanding: true,
        waiver: waiverFor(CLEARANCE_KIND.kit, item.ref),
      })),
      ...advances.map((advance) => ({
        kind: CLEARANCE_KIND.advance,
        ref: advance.ref,
        label: 'Outstanding salary advance',
        detail: `Balance ${advance.balance}`,
        outstanding: true,
        waiver: waiverFor(CLEARANCE_KIND.advance, advance.ref),
      })),
    ];

    return {
      exitRecordId: exitRecord.id,
      employeeId,
      // "Could not ask" is not "nothing held". A clearance that reported no assets because the
      // asset module is absent would be lying, and the lie would let somebody leave with a
      // laptop — so the caller is told, exactly as a project page is told which of its sources
      // were unavailable.
      unavailableSources: custodySource ? [] : ['asset_custody'],
      items,
      // FR-015. An item is settled when it is no longer outstanding, or when somebody waived it
      // with their name against the decision.
      // Unsettleable while a source could not be asked, deliberately. The safe answer to "is
      // anything outstanding?" when part of the question went unanswered is "assume yes".
      settleable:
        custodySource !== null &&
        items.every((item) => !item.outstanding || item.waiver !== null),
    };
  }

  /**
   * Resolves waiver authors to names (FR-016).
   *
   * `isSuperAdmin: true` on the context, as `ApprovalsService.namesFor` does and for the same
   * reason: `User` is a `shared` table, and a deactivated author must still be nameable —
   * history that cannot say who acted is not history, and a waiver is precisely the decision
   * somebody will later want attributed.
   */
  private async namesFor(userIds: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(userIds)];
    if (unique.length === 0) return new Map();

    const rows = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      (tx) =>
        tx.user.findMany({
          where: { id: { in: unique } },
          select: ACTOR_NAME_SELECT,
        }),
    );
    return new Map(rows.map((user) => [user.id, actorNameOf(user)]));
  }

  /**
   * Waives one obligation (FR-016).
   *
   * **Does not discharge it** (FR-014c). An asset waived here stays open in the asset register,
   * because a waiver records that the company stopped chasing the asset — not that it came back.
   * Marking it returned would put a false fact in the register that owns the truth.
   */
  async waive(
    ctx: RlsContext,
    companyId: string,
    employeeId: string,
    input: { kind: ClearanceKind; ref: string; reason: string },
    waivedByUserId: string,
  ): Promise<ExitClearance> {
    const clearance = await this.forEmployee(ctx, companyId, employeeId);
    const item = clearance.items.find(
      (i) => i.kind === input.kind && i.ref === input.ref,
    );
    if (!item) {
      throw new NotFoundException(
        'That obligation is not on this exit’s clearance.',
      );
    }

    await withRlsContext(this.prisma, ctx, (tx) =>
      tx.exitClearanceWaiver.upsert({
        where: {
          exitRecordId_itemKind_itemRef: {
            exitRecordId: clearance.exitRecordId,
            itemKind: input.kind,
            itemRef: input.ref,
          },
        },
        create: {
          companyId,
          exitRecordId: clearance.exitRecordId,
          itemKind: input.kind,
          itemRef: input.ref,
          reason: input.reason,
          waivedByUserId,
        },
        // Re-waiving records the newer reason and author rather than refusing. Somebody
        // correcting a reason should not have to delete evidence to do it.
        update: { reason: input.reason, waivedByUserId, waivedAt: new Date() },
      }),
    );

    return this.forEmployee(ctx, companyId, employeeId);
  }

  /**
   * The gate FR-015 applies before a final settlement may complete.
   *
   * Throws rather than returning a boolean, and **names every blocking item**: a refusal that
   * says only "something is outstanding" sends somebody hunting through a screen they have
   * already read.
   */
  async assertSettleable(
    ctx: RlsContext,
    companyId: string,
    employeeId: string,
  ): Promise<void> {
    const clearance = await this.forEmployee(ctx, companyId, employeeId);
    if (clearance.settleable) return;

    const blocking = clearance.items
      .filter((item) => item.outstanding && item.waiver === null)
      .map((item) => `${item.kind}: ${item.label}`);

    throw new BadRequestException({
      statusCode: 400,
      code: 'EXIT_CLEARANCE_OUTSTANDING',
      message:
        `Final settlement is blocked by ${blocking.length} outstanding item(s): ` +
        `${blocking.join(
          '; ',
        )}. Each must be returned or settled, or waived with a reason.`,
      blocking,
    });
  }

  /**
   * Recoverable kit still held (FR-014).
   *
   * Kit reaches an employee through their onboarding checklist, so an unreturned item is a kit
   * item flagged `isRecoverableAtExit` whose checklist row never completed.
   */
  private async recoverableKit(
    ctx: RlsContext,
    companyId: string,
    employeeId: string,
  ): Promise<{ ref: string; label: string }[]> {
    const rows = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.onboardingItem.findMany({
        where: {
          companyId,
          itemType: OnboardingItemType.kit,
          status: { not: OnboardingItemStatus.completed },
          checklist: { employeeId },
        },
        select: { id: true, label: true, kitItemId: true },
      }),
    );
    if (rows.length === 0) return [];

    const kitItems = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.kitItem.findMany({
        where: {
          companyId,
          id: { in: rows.map((r) => r.kitItemId).filter(Boolean) as string[] },
          isRecoverableAtExit: true,
        },
        select: { id: true },
      }),
    );
    const recoverable = new Set(kitItems.map((k) => k.id));

    // Only kit the company expects back. A branded notebook is issued and not recovered, and
    // listing it would make every exit look incomplete.
    return rows
      .filter((row) => row.kitItemId && recoverable.has(row.kitItemId))
      .map((row) => ({ ref: row.id, label: row.label }));
  }

  /** Advances with a balance still owed (FR-014). */
  private async outstandingAdvances(
    ctx: RlsContext,
    employeeId: string,
  ): Promise<{ ref: string; balance: string }[]> {
    const rows = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.salaryAdvance.findMany({
        where: {
          employeeId,
          // `closed` is the settled state; anything else with a balance is still owed. Keyed on
          // the balance as well as the status, because a status alone would list an approved
          // advance that has already been recovered in full.
          status: { not: SalaryAdvanceStatus.closed },
          outstandingBalance: { gt: 0 },
        },
        select: { id: true, outstandingBalance: true },
      }),
    );
    return rows.map((row) => ({
      ref: row.id,
      balance: String(row.outstandingBalance),
    }));
  }
}
