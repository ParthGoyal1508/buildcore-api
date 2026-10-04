import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  OnboardingItemStatus,
  OnboardingItemType,
  Permission,
  SalaryAdvanceStatus,
} from '@prisma/client';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from 'nestjs-prisma';

import {
  APPROVAL_COMPLETED_EVENT,
  type ApprovalCompletedEvent,
  ApprovalService,
} from '../../approvals/approvals.service';
import type { ApprovalInstanceView } from '../../approvals/approval.types';
import { ACTION_EXIT_CLEARANCE_WAIVER } from '../../approvals/default-chains';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { ACTOR_NAME_SELECT, actorNameOf } from '../../common/actor-name';
import { RlsContext, withRlsContext } from '../../common/prisma/rls-context';
import { ExitCustodyRegistry } from './exit-custody.registry';

/** A proposal's lifecycle, as this service records it. The spine owns the real one. */
export const WAIVER_PROPOSAL_STATUS = {
  pending: 'pending',
  approved: 'approved',
  rejected: 'rejected',
} as const;

/**
 * Who may **propose** a waiver (021 FR-016, task T091).
 *
 * The client's answer was "HR, with a Director countersign". Write access on Employees — the
 * placeholder this replaces — is held by more people than HR, and a write-off of company money is
 * not something a site administrator should be able to put in front of the Director on their own.
 * `PAYROLL` is the HR-office permission in this product: it is what gates the salary data a waived
 * advance comes out of.
 */
export const WAIVER_PROPOSER_PERMISSIONS: Permission[] = [Permission.PAYROLL];

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
    /**
     * Who countersigned, as a person reads it (FR-016, Phase 8).
     *
     * Null for a waiver applied before the countersignature existed. Shown as a *separate* name
     * from `waivedByName` on purpose: "HR waived this" and "HR asked and the Director agreed" are
     * different facts about who is answerable for the money.
     */
    approvedByName: string | null;
    approvedAt: Date | null;
  } | null;
  /**
   * A waiver **proposed and not yet decided**, or one that was rejected (FR-016, Phase 8).
   *
   * Separate from `waiver`, and the screen must read it as separate: until the Director decides, the
   * obligation is still outstanding and the item is still blocking a settlement. A screen that
   * rendered a proposal as a waiver would show an exit as clearable that is not.
   *
   * A **rejected** proposal is reported here rather than dropped. Silence after a rejection reads as
   * success, and the person who asked needs to see that the answer was no.
   */
  proposal: {
    status: 'pending' | 'rejected';
    reason: string;
    proposedByName: string;
    proposedAt: Date;
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
    private readonly approvals: ApprovalService,
  ) {}

  /**
   * Every asset this leaver was ever given, with how each one ended (021 FR-018a).
   *
   * **A different question from `forEmployee` below, and the difference is the client's item 10.**
   * The clearance lists what is *still* outstanding, so an asset returned during the notice period
   * correctly disappears from it. The settlement summary is the record of how each asset ended, and
   * it must still show that one — "any assets assigned to the employee should appear in the F&F
   * summary", read literally.
   *
   * This was the gap behind web task T025a. The settlement summary derived its asset list by
   * filtering the clearance's items, which can only ever contain **open** custody: an asset returned
   * a week before the last working day was absent from the summary entirely, so the summary said the
   * employee had never been given it. `FnfService.settlementSummary`'s own docblock claimed every
   * asset appeared "whether or not it blocked the settlement" — the intent, not the behaviour.
   *
   * `outcome` is the one word a reader needs:
   *
   *   * `returned` — came back, with the date.
   *   * `waived` — written off by a named person, with their reason. Still held.
   *   * `outstanding` — still held, nobody has decided.
   *
   * A waiver wins over the allocation being closed, because a closed allocation with a waiver
   * against it is an asset somebody **wrote off** rather than one that came back, and those are
   * different facts about where the asset now is.
   */
  async custodyOutcomesFor(
    ctx: RlsContext,
    companyId: string,
    employeeId: string,
  ): Promise<{
    /** Null when feature 012 is not deployed — never an empty list. */
    assets:
      | {
          allocationId: string;
          label: string;
          detail: string | null;
          outcome: 'returned' | 'waived' | 'outstanding';
          returnedOn: string | null;
          waivedByName: string | null;
          waiverReason: string | null;
        }[]
      | null;
  }> {
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
    // Null, not `[]`. "Feature 012 is not deployed" and "this employee held nothing" are different
    // facts, and a settlement summary must not render the first as the second — the decision
    // `forEmployee` makes with `unavailableSources` and the project P&L makes with
    // `unavailableCategories`.
    if (!custodySource) return { assets: null };

    const [records, waivers] = await Promise.all([
      custodySource.custodyHistoryFor(ctx, companyId, employeeId),
      withRlsContext(this.prisma, ctx, (tx) =>
        tx.exitClearanceWaiver.findMany({
          where: {
            exitRecordId: exitRecord.id,
            itemKind: CLEARANCE_KIND.asset,
          },
        }),
      ),
    ]);

    const names = await this.namesFor(waivers.map((w) => w.waivedByUserId));

    return {
      assets: records.map((record) => {
        const waiver = waivers.find((w) => w.itemRef === record.allocationId);
        return {
          allocationId: record.allocationId,
          label: `${record.assetName}${
            record.assetCode ? ` (${record.assetCode})` : ''
          }`,
          detail:
            `Site ${record.siteId}` +
            (record.quantity > 1 ? `, ${record.quantity} units` : ''),
          outcome: waiver
            ? ('waived' as const)
            : record.status === 'closed'
            ? ('returned' as const)
            : ('outstanding' as const),
          returnedOn: record.actualReturnDate
            ? record.actualReturnDate.toISOString().slice(0, 10)
            : null,
          // Falls back to the id rather than a dash, for the reason `waiverFor` gives below: a
          // waiver whose author's row has gone is still a waiver somebody made.
          waivedByName: waiver
            ? names.get(waiver.waivedByUserId) ?? waiver.waivedByUserId
            : null,
          waiverReason: waiver?.reason ?? null,
        };
      }),
    };
  }

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

    const [assets, kit, advances, waivers, proposals] = await Promise.all([
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
      // Proposals that are still open or were refused. An approved one has become a waiver and is
      // read above; carrying it here too would give the screen two places to look for one fact.
      withRlsContext(this.prisma, ctx, (tx) =>
        tx.exitClearanceWaiverProposal.findMany({
          where: {
            exitRecordId: exitRecord.id,
            status: {
              in: [
                WAIVER_PROPOSAL_STATUS.pending,
                WAIVER_PROPOSAL_STATUS.rejected,
              ],
            },
          },
          orderBy: { proposedAt: 'desc' },
        }),
      ),
    ]);

    // One query for every waiver's author rather than one per item. A clearance with six
    // waivers would otherwise be six round trips for a column.
    const waiverNames = await this.namesFor([
      ...waivers.map((w) => w.waivedByUserId),
      // The countersigners and the proposers in the same lookup. A clearance with six waivers would
      // otherwise be eighteen round trips for three columns.
      ...waivers
        .map((w) => w.approvedByUserId)
        .filter((id): id is string => id !== null),
      ...proposals.map((p) => p.proposedByUserId),
    ]);

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
            approvedByName: found.approvedByUserId
              ? waiverNames.get(found.approvedByUserId) ??
                found.approvedByUserId
              : null,
            approvedAt: found.approvedAt,
          }
        : null;
    };

    /**
     * The most recent undecided or refused proposal for an obligation.
     *
     * Most recent, because a rejected proposal can be followed by a new one — and if both exist the
     * live one is what the screen must show. `orderBy: proposedAt desc` above is what makes `find`
     * return it.
     */
    const proposalFor = (kind: ClearanceKind, ref: string) => {
      const found = proposals.find(
        (p) => p.itemKind === kind && p.itemRef === ref,
      );
      if (!found) return null;
      return {
        status: found.status as 'pending' | 'rejected',
        reason: found.reason,
        proposedByName:
          waiverNames.get(found.proposedByUserId) ?? found.proposedByUserId,
        proposedAt: found.proposedAt,
      };
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
        proposal: proposalFor(CLEARANCE_KIND.asset, asset.allocationId),
      })),
      ...kit.map((item) => ({
        kind: CLEARANCE_KIND.kit,
        ref: item.ref,
        label: item.label,
        detail: null,
        outstanding: true,
        waiver: waiverFor(CLEARANCE_KIND.kit, item.ref),
        proposal: proposalFor(CLEARANCE_KIND.kit, item.ref),
      })),
      ...advances.map((advance) => ({
        kind: CLEARANCE_KIND.advance,
        ref: advance.ref,
        label: 'Outstanding salary advance',
        detail: `Balance ${advance.balance}`,
        outstanding: true,
        waiver: waiverFor(CLEARANCE_KIND.advance, advance.ref),
        proposal: proposalFor(CLEARANCE_KIND.advance, advance.ref),
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
   * **Proposes** a waiver, and writes nothing (FR-016, Phase 8 — changed 2026-10-02).
   *
   * **This supersedes shipped behaviour.** Until now `waive()` wrote the waiver immediately on
   * write access to Employees — a placeholder, and wider than a write-off of company money
   * deserves. The client's answer is HR proposes, the Director countersigns.
   *
   * No `ExitClearanceWaiver` row is written here, and that is the whole design rather than an
   * implementation detail. The existence of such a row is what unblocks a final settlement, so a
   * row written at proposal time would be a waiver that is simultaneously applied and awaiting
   * approval — worse than either state, because the settlement would already be open while the
   * Director's queue still showed a decision to make. `exit-clearance-waiver.spec.ts` asserts the
   * absence structurally, because a behavioural test would pass while the row was still written by
   * a path nobody looked at.
   *
   * **Does not discharge the obligation either** (FR-014c). An asset waived stays open in the asset
   * register, because a waiver records that the company stopped chasing the asset — not that it
   * came back. Marking it returned would put a false fact in the register that owns the truth.
   */
  async waive(
    ctx: RlsContext,
    companyId: string,
    employeeId: string,
    input: { kind: ClearanceKind; ref: string; reason: string },
    caller: AuthenticatedUser,
  ): Promise<{ clearance: ExitClearance; pending: ApprovalInstanceView }> {
    this.assertMayPropose(caller);

    const clearance = await this.forEmployee(ctx, companyId, employeeId);
    const item = clearance.items.find(
      (i) => i.kind === input.kind && i.ref === input.ref,
    );
    if (!item) {
      throw new NotFoundException(
        'That obligation is not on this exit’s clearance.',
      );
    }
    // Already waived. Refused rather than re-proposed: re-waiving used to overwrite the reason,
    // which was reasonable when one person decided it alone and is not now — the newer reason
    // would replace one the Director had already agreed to.
    if (item.waiver !== null) {
      throw new ConflictException({
        statusCode: 409,
        code: 'EXIT_WAIVER_ALREADY_APPROVED',
        message:
          'This obligation is already waived. A waiver that has been countersigned cannot be ' +
          'replaced from here.',
      });
    }

    await this.settleStaleProposal(ctx, clearance.exitRecordId, input);

    const proposal = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.exitClearanceWaiverProposal
        .create({
          data: {
            companyId,
            exitRecordId: clearance.exitRecordId,
            itemKind: input.kind,
            itemRef: input.ref,
            reason: input.reason,
            proposedByUserId: caller.id,
            status: WAIVER_PROPOSAL_STATUS.pending,
          },
        })
        .catch((error: { code?: string }) => {
          // The unique index on (item, status) firing. One pending proposal per obligation: a
          // second would put two items in the Director's queue for one decision.
          if (error.code === 'P2002') {
            throw new ConflictException({
              statusCode: 409,
              code: 'EXIT_WAIVER_ALREADY_PENDING',
              message:
                'A waiver for this obligation is already waiting for a countersignature.',
            });
          }
          throw error;
        }),
    );

    const pending = await this.approvals.submit({
      companyId,
      actionType: ACTION_EXIT_CLEARANCE_WAIVER,
      entityType: ACTION_EXIT_CLEARANCE_WAIVER,
      entityId: proposal.id,
      originatorUserId: caller.id,
      // What the Director's queue row says. The spine cannot read the item, so the subject has to
      // carry the facts the decision turns on: what is being written off, and why.
      subject: `Waive ${item.label} on exit — ${input.reason}`,
      href: `/hr/employees/${employeeId}/exit`,
      // `PAYROLL`, matching the permission that may propose one. A waiver's history names who
      // asked for company money to be written off; that is not a thing to publish to every
      // colleague who can read an employee record.
      viewPermission: Permission.PAYROLL,
    });

    // The clearance is returned **unchanged** — still blocked. Returning a clearance that showed
    // the item waived would be the screen lying about what just happened.
    return { clearance, pending };
  }

  /**
   * Marks a pending proposal whose approval was **rejected** as rejected, so a corrected one can be
   * proposed (task T089).
   *
   * **The spine raises no event for a rejection** — only `approval.completed`, and only when the
   * state reaches `approved`. That is the right design for the spine (a module that cared about
   * every rejection would be a module watching the spine's internals), but it leaves this table's
   * `status` as a cache of something only the spine knows.
   *
   * So the cache is reconciled at the one moment it matters: when somebody tries to propose again.
   * Anywhere else and it would be a cron job keeping two copies of a fact in step, which is the
   * thing `forEmployee` deliberately does not do for obligations.
   *
   * **A rejection still leaves the obligation outstanding and the settlement blocked.** Nothing here
   * writes a waiver; it only frees the unique index so HR can come back with a better reason. The
   * failure this guards against is the opposite one — a rejection that silently clears the item
   * anyway, which looks like success to everybody except the company's balance sheet.
   */
  private async settleStaleProposal(
    ctx: RlsContext,
    exitRecordId: string,
    input: { kind: ClearanceKind; ref: string },
  ): Promise<void> {
    const pending = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.exitClearanceWaiverProposal.findFirst({
        where: {
          exitRecordId,
          itemKind: input.kind,
          itemRef: input.ref,
          status: WAIVER_PROPOSAL_STATUS.pending,
        },
      }),
    );
    if (!pending) return;

    const state = await this.approvals.stateOfSystem(
      ACTION_EXIT_CLEARANCE_WAIVER,
      pending.id,
      pending.companyId,
    );
    // Still in the chain, or there is no instance to read. Left alone — the caller gets the
    // `EXIT_WAIVER_ALREADY_PENDING` refusal, which is the right answer while a Director still has
    // the decision in front of them.
    if (!state || (state.state !== 'rejected' && state.state !== 'abandoned')) {
      return;
    }

    await withRlsContext(this.prisma, ctx, (tx) =>
      tx.exitClearanceWaiverProposal.updateMany({
        where: { id: pending.id, status: WAIVER_PROPOSAL_STATUS.pending },
        data: { status: WAIVER_PROPOSAL_STATUS.rejected },
      }),
    );
  }

  /**
   * T091. Proposing is an HR act; the chain decides the rest.
   *
   * Checked here and not only by a route decorator, because `waive()` is reachable from the
   * clearance controller and will be reachable from the F&F flow next — a guard on one route is a
   * guard on one route.
   */
  private assertMayPropose(caller: AuthenticatedUser): void {
    const may = WAIVER_PROPOSER_PERMISSIONS.some((permission) =>
      caller.permissions.includes(permission),
    );
    if (may) return;
    throw new ForbiddenException({
      statusCode: 403,
      code: 'EXIT_WAIVER_NOT_PROPOSABLE',
      message:
        'Proposing a clearance waiver is an HR action. Write access to employee records is not ' +
        'sufficient on its own, because a waiver writes off money the company is owed.',
    });
  }

  /**
   * Applies an approved waiver (FR-016, task T088).
   *
   * **Idempotent**, the shape 016's T074 established for the attendance correction and for the same
   * reason: an event handler that runs twice must not write two waivers. The `upsert` and the
   * `updateMany` guarded on `status: pending` together make a repeat run a no-op rather than a
   * duplicate.
   *
   * A **rejected** waiver never reaches here, so the obligation stays outstanding and the
   * settlement stays blocked — which is the correct behaviour by construction rather than by a
   * branch somebody has to get right. `onApprovalRejected` only marks the proposal.
   */
  @OnEvent(APPROVAL_COMPLETED_EVENT)
  async onApprovalCompleted(event: ApprovalCompletedEvent): Promise<void> {
    if (event.entityType !== ACTION_EXIT_CLEARANCE_WAIVER) return;

    const ctx: RlsContext = {
      isSuperAdmin: false,
      companyId: event.companyId,
    };

    await withRlsContext(this.prisma, ctx, async (tx) => {
      const proposal = await tx.exitClearanceWaiverProposal.findFirst({
        where: {
          id: event.entityId,
          status: WAIVER_PROPOSAL_STATUS.pending,
        },
      });
      // Already applied, or rejected, or from another tenant. Nothing to do, and nothing to log
      // as an error: a second delivery of the same event is a normal thing for an event bus to do.
      if (!proposal) return;

      const approver = await this.finalApproverOf(
        proposal.id,
        proposal.companyId,
      );

      await tx.exitClearanceWaiver.upsert({
        where: {
          exitRecordId_itemKind_itemRef: {
            exitRecordId: proposal.exitRecordId,
            itemKind: proposal.itemKind,
            itemRef: proposal.itemRef,
          },
        },
        create: {
          companyId: proposal.companyId,
          exitRecordId: proposal.exitRecordId,
          itemKind: proposal.itemKind,
          itemRef: proposal.itemRef,
          reason: proposal.reason,
          // T090. `waivedByUserId` stays **who proposed**; the countersignature is its own column.
          // "HR waived this" and "HR asked and the Director agreed" are different facts.
          waivedByUserId: proposal.proposedByUserId,
          approvedByUserId: approver,
          approvedAt: new Date(),
        },
        update: {
          reason: proposal.reason,
          waivedByUserId: proposal.proposedByUserId,
          approvedByUserId: approver,
          approvedAt: new Date(),
        },
      });

      await tx.exitClearanceWaiverProposal.updateMany({
        where: { id: proposal.id, status: WAIVER_PROPOSAL_STATUS.pending },
        data: { status: WAIVER_PROPOSAL_STATUS.approved },
      });
    });
  }

  /**
   * Who countersigned, through `ApprovalService` and never by querying the spine.
   *
   * The first version read `shared.ApprovalDecision` directly from here, and
   * `spine-boundary.spec.ts` refused it — correctly. The spine's tables are reachable only through
   * its service (016 research §1), and the one-line convenience of a join is exactly how a boundary
   * becomes imaginary.
   *
   * `latestDecision` on an instance whose state is `approved` **is** the countersignature: the
   * chain is one level, and the decision that finished it is the last one recorded. Null is
   * tolerated rather than fatal — the waiver has been approved either way, and failing to apply it
   * because a name could not be resolved would be the worse outcome.
   */
  private async finalApproverOf(
    proposalId: string,
    companyId: string,
  ): Promise<string | null> {
    const state = await this.approvals.stateOfSystem(
      ACTION_EXIT_CLEARANCE_WAIVER,
      proposalId,
      companyId,
    );
    return state?.latestDecision?.actorUserId ?? null;
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
