import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  ApprovalDecisionAction,
  AuditAction,
  AuditEntityType,
  Prisma,
} from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../auth/audit-log.service';
import { AuthenticatedUser } from '../auth/authenticated-user';
import type { ApprovalsConfig } from '../common/configs/config.interface';
import { RlsContext, withRlsContext } from '../common/prisma/rls-context';
import { UsersService } from '../users/users.service';
import {
  APPROVAL_ALREADY_DECIDED,
  APPROVAL_ALREADY_SUBMITTED,
  APPROVAL_CHAIN_NOT_CONFIGURED,
  APPROVAL_DIRECTOR_REQUIRED,
  APPROVAL_NOT_COMPLETE,
  APPROVAL_NOT_AUTHORISED,
  APPROVAL_NOT_PENDING,
  APPROVAL_NOT_SUBMITTED,
  APPROVAL_REASON_REQUIRED,
  APPROVAL_REASSIGN_FORBIDDEN,
  APPROVAL_SLOT_UNMAPPED,
  APPROVAL_VIEW_FORBIDDEN,
  ApprovalErrorCode,
} from './approval-error-codes';
import { labelForSlot } from './approval-slots';
import {
  ApprovalDecisionView,
  ApprovalInstanceView,
  ApprovalQueueEntry,
  ApprovalQueuePage,
  DecideApprovalInput,
  InertReason,
  isLive,
  SubmitApprovalInput,
  TakeEffectGate,
} from './approval.types';
import { ChainsService } from './chains.service';

/** The event a module listens for to learn its item finished the chain (T013). */
export const APPROVAL_COMPLETED_EVENT = 'approval.completed';

/**
 * The payload of `approval.completed`.
 *
 * Four identifiers and nothing else. The spine cannot include the item, because it has
 * never read the item and has no relation through which to read it — that opacity is
 * research.md §1, and it is why completion is an event rather than a callback. A spine
 * that called modules would have to know them.
 */
export interface ApprovalCompletedEvent {
  entityType: string;
  entityId: string;
  companyId: string;
  instanceId: string;
}

/** Raised on the same index that enforces it, so the two cannot disagree. */
const UNIQUE_VIOLATION = 'P2002';

type InstanceWithContext = Prisma.ApprovalInstanceGetPayload<{
  include: {
    chain: { include: { levels: true } };
    decisions: true;
  };
}>;

/**
 * The approval spine (016 FR-001 to FR-021b).
 *
 * Every module that needs a multi-level approval calls this service. Nothing calls back:
 * completion is announced on the event bus, and the spine never queries another module's
 * schema or dereferences the `(entityType, entityId)` pair it stores. That is Principle I
 * applied rather than worked around — see research.md §1.
 */
@Injectable()
export class ApprovalService {
  private readonly logger = new Logger(ApprovalService.name);

  /**
   * Action types that must be approved before they take effect even when nothing is
   * configured (FR-018a). Read once at construction — it is policy, not per-request state.
   */
  private readonly directorFinalActionTypes: string[];

  constructor(
    private readonly prisma: PrismaService,
    private readonly chains: ChainsService,
    private readonly users: UsersService,
    private readonly audit: AuditLogService,
    private readonly events: EventEmitter2,
    configService: ConfigService,
  ) {
    this.directorFinalActionTypes =
      configService.get<ApprovalsConfig>('approvals').directorFinalActionTypes;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Submitting (T010)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Puts an item into its chain (FR-001, FR-001b, FR-007).
   *
   * A missing chain is a **configuration fault**, not a 403. Telling the submitting user
   * they are "forbidden" would send them asking for permissions they already hold, when
   * the actual remedy is for an administrator to define a chain.
   */
  async submit(input: SubmitApprovalInput): Promise<ApprovalInstanceView> {
    const ctx: RlsContext = {
      isSuperAdmin: false,
      companyId: input.companyId,
    };

    const chain = await this.chains.findActiveChain(
      ctx,
      input.companyId,
      input.actionType,
    );
    if (!chain) {
      throw new ConflictException({
        statusCode: 409,
        message:
          `No active approval chain is configured for "${input.actionType}". ` +
          `This is a configuration gap, not a permissions problem — an administrator ` +
          `must define the chain before items of this kind can be submitted.`,
        code: APPROVAL_CHAIN_NOT_CONFIGURED,
      });
    }

    try {
      const created = await withRlsContext(this.prisma, ctx, (tx) =>
        tx.approvalInstance.create({
          data: {
            companyId: input.companyId,
            chainId: chain.id,
            entityType: input.entityType,
            entityId: input.entityId,
            subject: input.subject,
            href: input.href ?? null,
            viewPermission: input.viewPermission,
            originatorUserId: input.originatorUserId,
            currentPosition: 1,
          },
          include: {
            chain: { include: { levels: true } },
            decisions: true,
          },
        }),
      );
      return this.toView(created, null);
    } catch (error) {
      // The partial unique index is what catches a concurrent double-submit; a
      // read-then-write check here would lose the race it exists to prevent.
      if (this.isUniqueViolation(error)) {
        throw new ConflictException({
          statusCode: 409,
          message:
            `This item is already in an approval chain. It cannot be submitted twice ` +
            `while the first is still open.`,
          code: APPROVAL_ALREADY_SUBMITTED,
        });
      }
      throw error;
    }
  }

  /**
   * Resubmits a returned item (FR-005, FR-020).
   *
   * A new *round*, not a new instance: the item keeps its identity and its history, and
   * `returnCount` increments so repetition leaves a trace (FR-020). Prior decisions are
   * retained deliberately — the record must show that the item went round, and the round
   * number is what lets the same people decide again without breaking FR-021a.
   */
  async resubmit(
    entityType: string,
    entityId: string,
    companyId: string,
    byUserId: string,
  ): Promise<ApprovalInstanceView> {
    const ctx: RlsContext = { isSuperAdmin: false, companyId };

    const instance = await this.loadByEntity(ctx, entityType, entityId);
    if (!instance)
      throw new NotFoundException('No approval found for this item.');
    if (instance.state !== 'returned') {
      throw new ConflictException({
        statusCode: 409,
        message: `Only a returned item can be resubmitted; this one is ${instance.state}.`,
        code: APPROVAL_NOT_PENDING,
      });
    }
    if (instance.originatorUserId !== byUserId) {
      throw new ForbiddenException({
        statusCode: 403,
        message: 'Only the person who raised this item may resubmit it.',
        code: APPROVAL_NOT_AUTHORISED,
      });
    }

    const updated = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.approvalInstance.update({
        where: { id: instance.id },
        data: {
          state: 'pending',
          currentPosition: 1,
          round: { increment: 1 },
          returnCount: { increment: 1 },
          delegatedToUserId: null,
          delegationReason: null,
        },
        include: { chain: { include: { levels: true } }, decisions: true },
      }),
    );
    return this.toView(updated, null);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Deciding (T011, T012, T017)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Records one decision (FR-002 to FR-006, FR-020, FR-021, FR-021a).
   *
   * Every refusal is distinguishable and every refusal is audited (FR-003). The ordering
   * of the checks below is not arbitrary: *authority* is checked before *already decided*,
   * because telling somebody with no authority that they have "already decided" would be
   * confusing, while the reverse — telling a Super Admin who already decided that they
   * lack authority — is the specific untruth FR-011 exists to prevent.
   */
  async decide(
    input: DecideApprovalInput,
    caller: AuthenticatedUser,
    ipAddress: string,
  ): Promise<ApprovalInstanceView> {
    const ctx: RlsContext = {
      isSuperAdmin: false,
      companyId: caller.companyId,
    };

    const instance = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.approvalInstance.findUnique({
        where: { id: input.instanceId },
        include: {
          chain: { include: { levels: true } },
          decisions: true,
        },
      }),
    );
    if (!instance) throw new NotFoundException('Approval not found.');

    const refuse = async (
      code: ApprovalErrorCode,
      message: string,
      status: 403 | 409 | 400 = 403,
    ): Promise<never> => {
      await this.auditRefusal(instance, caller, ipAddress, code, input.action);
      const body = { statusCode: status, message, code };
      if (status === 409) throw new ConflictException(body);
      if (status === 400) throw new BadRequestException(body);
      throw new ForbiddenException(body);
    };

    if (instance.state !== 'pending') {
      await refuse(
        APPROVAL_NOT_PENDING,
        `This item is ${instance.state} and is not awaiting a decision.`,
        409,
      );
    }

    const level = instance.chain.levels.find(
      (l) => l.position === instance.currentPosition,
    );
    if (!level) {
      // A chain whose levels no longer cover currentPosition. Not reachable through
      // ChainsService, which refuses gaps — but an item is stuck rather than wrong, and
      // saying so plainly beats a crash.
      await refuse(
        APPROVAL_NOT_PENDING,
        `This item is parked at level ${instance.currentPosition}, which its chain no ` +
          `longer defines. An administrator must repair the chain.`,
        409,
      );
      throw new Error('unreachable');
    }

    const roleId = await this.chains.resolveSlot(
      ctx,
      instance.companyId,
      level.slotKey,
    );
    if (!roleId) {
      await refuse(
        APPROVAL_SLOT_UNMAPPED,
        `Nobody can approve this yet: the "${labelForSlot(
          level.slotKey,
          level.label,
        )}" level has no role mapped for this company. This is a settings problem, not ` +
          `a permissions one.`,
        409,
      );
    }

    const isDelegate = instance.delegatedToUserId === caller.id;
    if (!isDelegate && !caller.roleIds.includes(roleId as string)) {
      await refuse(
        APPROVAL_NOT_AUTHORISED,
        `This item is awaiting the "${labelForSlot(
          level.slotKey,
          level.label,
        )}" level, which your roles do not hold.`,
      );
    }

    // FR-021a. Checked here so the refusal is legible, and enforced by the unique index
    // below so a race cannot slip past it.
    if (
      instance.decisions.some(
        (d) => d.actorUserId === caller.id && d.round === instance.round,
      )
    ) {
      await refuse(
        APPROVAL_ALREADY_DECIDED,
        `You have already recorded a decision on this item. One person cannot decide ` +
          `twice on the same item, whatever roles they hold — if this level needs to be ` +
          `decided by somebody else, the item must be reassigned.`,
      );
    }

    const reason = input.reason?.trim() || null;
    if (input.action !== ApprovalDecisionAction.approve && !reason) {
      await refuse(
        APPROVAL_REASON_REQUIRED,
        `A reason is required when you ${input.action} an item.`,
        400,
      );
    }

    const isFinalLevel =
      instance.chain.levels.length === instance.currentPosition;

    let updated: InstanceWithContext;
    try {
      updated = await withRlsContext(this.prisma, ctx, async (tx) => {
        await tx.approvalDecision.create({
          data: {
            approvalInstanceId: instance.id,
            companyId: instance.companyId,
            round: instance.round,
            position: instance.currentPosition,
            actorUserId: caller.id,
            action: input.action,
            reason,
          },
        });

        // Unchecked, not the checked input: the scalar `delegatedToUserId` is what wants
        // clearing, and the checked variant only exposes it as a relation `disconnect`.
        const data: Prisma.ApprovalInstanceUncheckedUpdateInput =
          input.action === ApprovalDecisionAction.approve
            ? isFinalLevel
              ? {
                  state: 'approved',
                  delegatedToUserId: null,
                  delegationReason: null,
                }
              : {
                  currentPosition: { increment: 1 },
                  // A delegation is granted for one level, so advancing clears it.
                  delegatedToUserId: null,
                  delegationReason: null,
                }
            : input.action === ApprovalDecisionAction.reject
            ? {
                state: 'rejected',
                delegatedToUserId: null,
                delegationReason: null,
              }
            : {
                state: 'returned',
                delegatedToUserId: null,
                delegationReason: null,
              };

        return tx.approvalInstance.update({
          where: { id: instance.id },
          data,
          include: {
            chain: { include: { levels: true } },
            decisions: true,
          },
        });
      });
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw this.explainDecisionRace(error);
      }
      throw error;
    }

    await this.audit.record({
      entityType: AuditEntityType.APPROVAL_DECISION,
      action: AuditAction.UPDATE,
      entityId: instance.id,
      changes: {
        entityType: instance.entityType,
        entityId: instance.entityId,
        position: instance.currentPosition,
        decision: input.action,
        resultingState: updated.state,
      },
      accountId: caller.id,
      companyId: instance.companyId,
      ipAddress,
    });

    // T013. After the transaction commits, never inside it: a handler that reacted to a
    // decision the transaction then rolled back would apply an approval that never
    // happened.
    if (updated.state === 'approved') {
      const event: ApprovalCompletedEvent = {
        entityType: updated.entityType,
        entityId: updated.entityId,
        companyId: updated.companyId,
        instanceId: updated.id,
      };
      this.events.emit(APPROVAL_COMPLETED_EVENT, event);
    }

    return this.toView(updated, caller);
  }

  /**
   * Turns a unique-index violation on `ApprovalDecision` into the right refusal.
   *
   * Two indexes can fire here and they mean different things. `actorUserId` means this
   * person decided twice — FR-021a, won by the database rather than by the check above.
   * `position` means two different approvers at the same level raced, and one lost —
   * FR-021, where the item has simply moved on.
   */
  private explainDecisionRace(error: unknown): Error {
    const target = String(
      (error as Prisma.PrismaClientKnownRequestError).meta?.target ?? '',
    );

    if (target.includes('actorUserId')) {
      return new ForbiddenException({
        statusCode: 403,
        message:
          'You have already recorded a decision on this item. Two decisions from the ' +
          'same person arrived at once and only the first was kept.',
        code: APPROVAL_ALREADY_DECIDED,
      });
    }

    return new ConflictException({
      statusCode: 409,
      message:
        'Another approver at this level recorded a decision first. Reload to see where ' +
        'the item has got to.',
      code: APPROVAL_NOT_PENDING,
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Reading state (T013a, T014)
  // ───────────────────────────────────────────────────────────────────────────

  /** What a module renders beside one item (FR-008, FR-010, FR-011). */
  async stateOf(
    entityType: string,
    entityId: string,
    viewer: AuthenticatedUser,
  ): Promise<ApprovalInstanceView | null> {
    const ctx: RlsContext = {
      isSuperAdmin: false,
      companyId: viewer.companyId,
    };
    const instance = await this.loadByEntity(ctx, entityType, entityId);
    return instance ? this.toView(instance, viewer) : null;
  }

  /**
   * The same view, for a caller that is not a person (016 T036).
   *
   * A scheduled job asking "has this run been approved yet?" has no viewer, so
   * `canActNow` is false and `inertReason` null — "may this caller act" has no answer
   * when there is no caller. Separate from `stateOf` rather than a nullable parameter on
   * it, so a controller cannot reach this by passing an undefined user and silently lose
   * the per-caller fields the interface depends on.
   */
  async stateOfSystem(
    entityType: string,
    entityId: string,
    companyId: string,
  ): Promise<ApprovalInstanceView | null> {
    const instance = await this.loadByEntity(
      { isSuperAdmin: false, companyId },
      entityType,
      entityId,
    );
    return instance ? this.toView(instance, null) : null;
  }

  /**
   * The batch form. **Modules MUST use this when rendering a list** (contract Part 1).
   *
   * Calling `stateOf` per row is the obvious mistake and produces an N+1 against the
   * spine from every list in the product — which, once six modules have migrated, is
   * every list. One query for the instances, one for the slot mappings, and one holder
   * lookup per *distinct* current level, cached.
   */
  async statesOf(
    entityType: string,
    entityIds: string[],
    viewer: AuthenticatedUser,
  ): Promise<Map<string, ApprovalInstanceView>> {
    const result = new Map<string, ApprovalInstanceView>();
    if (entityIds.length === 0) return result;

    const ctx: RlsContext = {
      isSuperAdmin: false,
      companyId: viewer.companyId,
    };

    const instances = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.approvalInstance.findMany({
        where: { entityType, entityId: { in: entityIds } },
        include: {
          chain: { include: { levels: true } },
          decisions: true,
        },
      }),
    );

    const holderCache = new Map<string, { id: string; name: string }[]>();
    const nameCache = new Map<string, string>();
    for (const instance of instances) {
      result.set(
        instance.entityId,
        await this.toView(instance, viewer, holderCache, nameCache),
      );
    }
    return result;
  }

  /**
   * The full ordered history for one item (FR-009, US3 scenarios 2 and 4, T043).
   *
   * **Who may read this is decided by the owning module, not by the spine** — which is
   * why the answer is stored on the instance at submit time rather than computed here.
   * The spine has never read the item and has no relation through which to read it, so
   * there is nothing for it to reason about; `viewPermission` is the module's declaration
   * carried forward, and this method enforces it.
   *
   * Participants pass regardless of that permission. A site engineer who raised a
   * correction must be able to see why it was rejected even though the reason lives
   * behind a permission they do not hold, and an approver must be able to re-read a chain
   * they themselves acted in. Refusing either would mean the two people most entitled to
   * an explanation are the two who cannot get one.
   */
  async historyOf(
    entityType: string,
    entityId: string,
    viewer: AuthenticatedUser,
  ): Promise<ApprovalDecisionView[]> {
    const ctx: RlsContext = {
      isSuperAdmin: false,
      companyId: viewer.companyId,
    };
    const instance = await this.loadByEntity(ctx, entityType, entityId);
    // An empty list rather than a 404, and deliberately *before* the permission check:
    // "this item has never been in a chain" is not a secret, and 404-vs-403 on an id the
    // caller already holds tells them nothing they did not already know.
    if (!instance) return [];

    if (!this.mayViewHistory(instance, viewer)) {
      throw new ForbiddenException({
        statusCode: 403,
        message:
          'You do not have permission to view this item, so its approval history ' +
          'is not available to you.',
        code: APPROVAL_VIEW_FORBIDDEN,
      });
    }

    const names = await this.namesFor(
      instance.decisions.map((d) => d.actorUserId),
    );
    return [...instance.decisions]
      .sort((a, b) => a.decidedAt.getTime() - b.decidedAt.getTime())
      .map((d) => this.toDecisionView(d, instance, names));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // The take-effect gate (FR-007, FR-018, T049, T050)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Whether an item may take effect yet — **the one gate every module asks** (T050).
   *
   * Feature 017 must call this for work orders, LOIs and purchase orders rather than
   * building its own check, and the same goes for payment release and final settlement.
   * The requirement is not stylistic: an approval rule with two implementations is an
   * approval rule that will be enforced in one place and not the other, and the place it
   * is missed is discovered by the money having already moved.
   *
   * Three questions, in this order, and the order is the content:
   *
   * 1. **Was it submitted at all?** For the action types FR-018 names, "no" is a refusal.
   *    A module that skipped `submit` must not release a payment because there was
   *    nothing to check it against. For every other action type "no" is a pass — FR-022
   *    forbids this feature changing behaviour for modules it never migrated, and
   *    refusing there would break every unmigrated approval in the product at once.
   * 2. **Did the chain finish?** Pending, returned and rejected all mean no (FR-007).
   * 3. **If the chain is director-final, did the director actually approve?** Checked
   *    against the recorded decisions, not against the chain's shape. A chain defined
   *    before the well-formedness rule existed would satisfy a shape check with nobody
   *    having approved, and "whatever preceded" in FR-018 is exactly the case where
   *    everything looks complete.
   */
  async mayTakeEffect(input: {
    actionType: string;
    entityType: string;
    entityId: string;
    companyId: string;
  }): Promise<TakeEffectGate> {
    const ctx: RlsContext = {
      isSuperAdmin: false,
      companyId: input.companyId,
    };
    const instance = await this.loadByEntity(
      ctx,
      input.entityType,
      input.entityId,
    );

    const clear: TakeEffectGate = {
      allowed: true,
      code: null,
      message: null,
      state: instance?.state ?? null,
      levelLabel: null,
      awaitingHolderCount: 0,
    };

    if (!instance) {
      if (!this.directorFinalActionTypes.includes(input.actionType)) {
        return clear;
      }
      return {
        allowed: false,
        code: APPROVAL_NOT_SUBMITTED,
        message:
          `This must be approved before it takes effect, and it has never been ` +
          `submitted for approval. An administrator must define the approval chain ` +
          `for "${input.actionType}".`,
        state: null,
        levelLabel: null,
        awaitingHolderCount: 0,
      };
    }

    const levels = [...instance.chain.levels].sort(
      (a, b) => a.position - b.position,
    );
    const current = levels.find((l) => l.position === instance.currentPosition);
    const levelLabel = current
      ? labelForSlot(current.slotKey, current.label)
      : null;

    if (instance.state !== 'approved') {
      return {
        allowed: false,
        code: APPROVAL_NOT_COMPLETE,
        message:
          instance.state === 'rejected'
            ? 'This was rejected and cannot take effect.'
            : `This is awaiting approval${
                levelLabel ? ` at ${levelLabel}` : ''
              } and cannot take effect yet.`,
        state: instance.state,
        levelLabel,
        awaitingHolderCount: await this.holderCountAt(instance, current),
      };
    }

    if (instance.chain.isFinalAuthorityRequired) {
      const finalLevel = levels.find((l) => l.isFinalAuthority);
      const approvedFinally =
        finalLevel &&
        instance.decisions.some(
          (d) =>
            d.position === finalLevel.position &&
            d.round === instance.round &&
            d.action === 'approve',
        );
      if (!approvedFinally) {
        return {
          allowed: false,
          code: APPROVAL_DIRECTOR_REQUIRED,
          message:
            'This requires final approval by the director before it takes effect, ' +
            'and no such approval is recorded.',
          state: instance.state,
          levelLabel: finalLevel
            ? labelForSlot(finalLevel.slotKey, finalLevel.label)
            : null,
          awaitingHolderCount: await this.holderCountAt(instance, finalLevel),
        };
      }
    }

    return clear;
  }

  /**
   * The same gate, as a refusal (T049).
   *
   * `409`, not `403`: the caller is not forbidden from releasing payments, the payment is
   * not yet releasable. A 403 would send somebody to ask for permissions they already
   * hold.
   */
  async assertMayTakeEffect(input: {
    actionType: string;
    entityType: string;
    entityId: string;
    companyId: string;
  }): Promise<void> {
    const gate = await this.mayTakeEffect(input);
    if (gate.allowed) return;

    // A level nobody can act on is US5 scenario 4 — held correctly, but held on nobody.
    // Logged rather than merely returned, because the person who hits the refusal is not
    // the person who can fix it.
    if (gate.awaitingHolderCount === 0 && gate.levelLabel) {
      this.logger.error(
        `${input.actionType}/${input.entityId} is held at "${gate.levelLabel}", which ` +
          `no active account can act on. Map the slot to a role with holders, or the ` +
          `item will wait indefinitely.`,
      );
    }

    throw new ConflictException({
      statusCode: 409,
      message: gate.message,
      code: gate.code,
    });
  }

  /** How many active accounts could act at a level. Zero is a configuration problem. */
  private async holderCountAt(
    instance: InstanceWithContext,
    level: InstanceWithContext['chain']['levels'][number] | undefined,
  ): Promise<number> {
    if (!level) return 0;
    if (instance.delegatedToUserId) return 1;
    const roleId = await this.chains.resolveSlot(
      { isSuperAdmin: false, companyId: instance.companyId },
      instance.companyId,
      level.slotKey,
    );
    if (!roleId) return 0;
    const holders = await this.users.findActiveHoldersOfRole(
      roleId,
      instance.companyId,
    );
    return holders.length;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Closing and reassigning (T015, T015a)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Closes an item's chain because the item itself was cancelled or deleted (T015).
   *
   * The mitigation for having no foreign key (research.md §1): without this, a cancelled
   * indent leaves a chain pending forever, cluttering somebody's queue with work that no
   * longer exists. Idempotent — closing an already-closed chain is not an error, because
   * the module calling it may be retrying.
   */
  async abandon(
    entityType: string,
    entityId: string,
    companyId: string,
    reason: string,
  ): Promise<void> {
    const ctx: RlsContext = { isSuperAdmin: false, companyId };
    const instance = await this.loadByEntity(ctx, entityType, entityId);
    if (!instance || !isLive(instance.state)) return;

    await withRlsContext(this.prisma, ctx, (tx) =>
      tx.approvalInstance.update({
        where: { id: instance.id },
        data: {
          state: 'abandoned',
          delegatedToUserId: null,
          delegationReason: reason,
        },
      }),
    );
    this.logger.log(
      `Abandoned approval ${instance.id} (${entityType}/${entityId}): ${reason}`,
    );
  }

  /**
   * Reassigns a pending item to a named person at its current level (FR-019, T015a).
   *
   * **Not a convenience.** Because FR-021a forbids a second decision by the same person,
   * this is the only way an item stalled by thin staffing can move — the sole holder of a
   * level's role having already decided earlier in the chain leaves the item stuck with no
   * error raised anywhere.
   *
   * An administrative act, and specifically not available to the person the item is
   * currently waiting on: letting the current approver reassign would turn "I am
   * unavailable" into a way of ducking a decision while appearing to act (T015b).
   */
  async reassign(
    instanceId: string,
    toUserId: string,
    reason: string,
    caller: AuthenticatedUser,
    ipAddress: string,
  ): Promise<ApprovalInstanceView> {
    const ctx: RlsContext = {
      isSuperAdmin: false,
      companyId: caller.companyId,
    };

    const instance = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.approvalInstance.findUnique({
        where: { id: instanceId },
        include: { chain: { include: { levels: true } }, decisions: true },
      }),
    );
    if (!instance) throw new NotFoundException('Approval not found.');

    if (instance.state !== 'pending') {
      throw new ConflictException({
        statusCode: 409,
        message: `This item is ${instance.state} and has nothing awaiting reassignment.`,
        code: APPROVAL_NOT_PENDING,
      });
    }

    if (!reason?.trim()) {
      throw new BadRequestException({
        statusCode: 400,
        message: 'A reason is required when reassigning an approval.',
        code: APPROVAL_REASON_REQUIRED,
      });
    }

    const level = instance.chain.levels.find(
      (l) => l.position === instance.currentPosition,
    );
    const roleId = level
      ? await this.chains.resolveSlot(ctx, instance.companyId, level.slotKey)
      : null;

    // The guard T015b asks for: whoever the item is presently awaiting cannot be the one
    // to hand it on.
    const callerAwaitsThis =
      instance.delegatedToUserId === caller.id ||
      (roleId !== null && caller.roleIds.includes(roleId));
    if (callerAwaitsThis) {
      await this.auditRefusal(
        instance,
        caller,
        ipAddress,
        APPROVAL_REASSIGN_FORBIDDEN,
      );
      throw new ForbiddenException({
        statusCode: 403,
        message:
          'This item is awaiting you. Reassignment is for when an approver is ' +
          'unavailable, and cannot be used to pass on a decision that is yours to make.',
        code: APPROVAL_REASSIGN_FORBIDDEN,
      });
    }

    const updated = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.approvalInstance.update({
        where: { id: instance.id },
        data: { delegatedToUserId: toUserId, delegationReason: reason.trim() },
        include: { chain: { include: { levels: true } }, decisions: true },
      }),
    );

    await this.audit.record({
      entityType: AuditEntityType.APPROVAL_DECISION,
      action: AuditAction.UPDATE,
      entityId: instance.id,
      changes: {
        reassignedTo: toUserId,
        atPosition: instance.currentPosition,
        reason: reason.trim(),
      },
      accountId: caller.id,
      companyId: instance.companyId,
      ipAddress,
    });

    return this.toView(updated, caller);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // The queue (T016)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Everything awaiting this user, across every action type (FR-010, contract Part 2).
   *
   * **Excludes items the caller has already decided on this round.** A queue that lists
   * work you are forbidden to action teaches people to ignore the queue, which costs more
   * than the missing row ever would.
   */
  async queueFor(
    caller: AuthenticatedUser,
    paging: { limit?: number; cursor?: string | null } = {},
  ): Promise<ApprovalQueuePage> {
    const companyId = caller.companyId;
    if (!companyId) return { items: [], nextCursor: null };

    const limit = Math.min(Math.max(paging.limit ?? 25, 1), 100);
    const ctx: RlsContext = { isSuperAdmin: false, companyId };

    const rows = await withRlsContext(this.prisma, ctx, async (tx) => {
      // Which slots this caller's roles fill. No read of `settings.UserRole` — the role
      // ids arrived with the authenticated caller (Principle I).
      const mappings = await tx.roleSlotMapping.findMany({
        where: { companyId, roleId: { in: caller.roleIds } },
        select: { slotKey: true },
      });
      const slotKeys = mappings.map((m) => m.slotKey);

      // The (chain, position) pairs those slots sit at, on active chains only.
      const levels =
        slotKeys.length === 0
          ? []
          : await tx.approvalLevel.findMany({
              where: {
                companyId,
                slotKey: { in: slotKeys },
                chain: { isActive: true },
              },
              select: { chainId: true, position: true },
            });

      const byRole = levels.map((l) => ({
        chainId: l.chainId,
        currentPosition: l.position,
      }));

      // A delegated item reaches the delegate regardless of their roles — that is the
      // whole point of FR-019.
      const reachable: Prisma.ApprovalInstanceWhereInput[] = [
        ...byRole,
        { delegatedToUserId: caller.id },
      ];
      if (reachable.length === 0) return [];

      return tx.approvalInstance.findMany({
        where: {
          companyId,
          state: 'pending',
          OR: reachable,
          // FR-021a, applied to the listing rather than only to the action.
          decisions: { none: { actorUserId: caller.id } },
        },
        include: { chain: { include: { levels: true } }, decisions: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: limit + 1,
        ...(paging.cursor ? { cursor: { id: paging.cursor }, skip: 1 } : {}),
      });
    });

    const page = rows.slice(0, limit);
    const names = await this.namesFor(
      page.map((r) => r.originatorUserId).filter((id): id is string => !!id),
    );
    const now = Date.now();

    return {
      items: page.map((instance): ApprovalQueueEntry => {
        const level = instance.chain.levels.find(
          (l) => l.position === instance.currentPosition,
        );
        return {
          instanceId: instance.id,
          actionType: instance.chain.actionType,
          entityType: instance.entityType,
          entityId: instance.entityId,
          subject: instance.subject,
          href: instance.href,
          requestedById: instance.originatorUserId,
          // Matches `toView`: a scheduled run has no person behind it, and "Unknown user"
          // would read as data we lost rather than a fact we know.
          requestedByName: instance.originatorUserId
            ? names.get(instance.originatorUserId) ?? 'Unknown user'
            : 'The system',
          requestedAt: instance.createdAt,
          ageHours: Math.floor(
            (now - instance.createdAt.getTime()) / 3_600_000,
          ),
          currentPosition: instance.currentPosition,
          levelLabel: level
            ? labelForSlot(level.slotKey, level.label)
            : `Level ${instance.currentPosition}`,
        };
      }),
      nextCursor: rows.length > limit ? page[page.length - 1].id : null,
    };
  }

  /** The badge count. Separate from the queue because it is polled on every screen. */
  async queueCountFor(caller: AuthenticatedUser): Promise<number> {
    const companyId = caller.companyId;
    if (!companyId) return 0;
    const ctx: RlsContext = { isSuperAdmin: false, companyId };

    return withRlsContext(this.prisma, ctx, async (tx) => {
      const mappings = await tx.roleSlotMapping.findMany({
        where: { companyId, roleId: { in: caller.roleIds } },
        select: { slotKey: true },
      });
      const slotKeys = mappings.map((m) => m.slotKey);
      const levels =
        slotKeys.length === 0
          ? []
          : await tx.approvalLevel.findMany({
              where: {
                companyId,
                slotKey: { in: slotKeys },
                chain: { isActive: true },
              },
              select: { chainId: true, position: true },
            });

      const reachable: Prisma.ApprovalInstanceWhereInput[] = [
        ...levels.map((l) => ({
          chainId: l.chainId,
          currentPosition: l.position,
        })),
        { delegatedToUserId: caller.id },
      ];
      if (reachable.length === 0) return 0;

      return tx.approvalInstance.count({
        where: {
          companyId,
          state: 'pending',
          OR: reachable,
          decisions: { none: { actorUserId: caller.id } },
        },
      });
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Internals
  // ───────────────────────────────────────────────────────────────────────────

  private loadByEntity(
    ctx: RlsContext,
    entityType: string,
    entityId: string,
  ): Promise<InstanceWithContext | null> {
    return withRlsContext(this.prisma, ctx, (tx) =>
      tx.approvalInstance.findFirst({
        where: { entityType, entityId },
        include: { chain: { include: { levels: true } }, decisions: true },
        // Newest first, so a re-raised item shows its current chain rather than the
        // terminal one it had before.
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  /** Display names for a set of user ids, resolved once. */
  private async namesFor(userIds: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(userIds)];
    if (unique.length === 0) return new Map();

    const rows = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      (tx) =>
        tx.user.findMany({
          where: { id: { in: unique } },
          select: {
            id: true,
            displayName: true,
            firstname: true,
            lastname: true,
            username: true,
            email: true,
          },
        }),
    );

    // Deactivated users are included deliberately (FR-008): history that cannot name who
    // acted is not history. `User` is a `shared` table, the same schema as the spine.
    return new Map(
      rows.map((u) => [
        u.id,
        u.displayName?.trim() ||
          [u.firstname, u.lastname].filter(Boolean).join(' ').trim() ||
          u.username ||
          u.email,
      ]),
    );
  }

  /**
   * Assembles the view the interface consumes (T013a, FR-010, FR-011).
   *
   * `viewer` may be null when no particular caller is asking — a module submitting an
   * item, say. In that case `canActNow` is false and `inertReason` is null, because "can
   * this caller act" has no answer when there is no caller, and inventing `false` with a
   * reason would have the interface explain a refusal nobody received.
   */
  private async toView(
    instance: InstanceWithContext,
    viewer: AuthenticatedUser | null,
    holderCache?: Map<string, { id: string; name: string }[]>,
    nameCache?: Map<string, string>,
  ): Promise<ApprovalInstanceView> {
    const levels = [...instance.chain.levels].sort(
      (a, b) => a.position - b.position,
    );
    const level = levels.find((l) => l.position === instance.currentPosition);
    const finished = !isLive(instance.state);

    const ctx: RlsContext = {
      isSuperAdmin: false,
      companyId: instance.companyId,
    };

    const roleId =
      level && instance.state === 'pending'
        ? await this.chains.resolveSlot(ctx, instance.companyId, level.slotKey)
        : null;

    let holders: { id: string; name: string }[] = [];
    let awaitingRoleName: string | null = null;
    // `level` is narrowed alongside `roleId` rather than asserted: a non-null roleId
    // already implies a level, but saying so with `!` would keep compiling if the two
    // ever stopped being derived together.
    if (roleId && level) {
      const cacheKey = `${instance.companyId}|${roleId}`;
      holders =
        holderCache?.get(cacheKey) ??
        (await this.users.findActiveHoldersOfRole(roleId, instance.companyId));
      holderCache?.set(cacheKey, holders);
      awaitingRoleName = labelForSlot(level.slotKey, level.label);
    }

    // Names: the originator always, plus the latest decision's actor.
    const latest = [...instance.decisions].sort(
      (a, b) => b.decidedAt.getTime() - a.decidedAt.getTime(),
    )[0];
    const wanted = instance.originatorUserId ? [instance.originatorUserId] : [];
    if (latest) wanted.push(latest.actorUserId);
    const names = nameCache ?? new Map<string, string>();
    const missing = wanted.filter((id) => !names.has(id));
    if (missing.length) {
      for (const [id, name] of await this.namesFor(missing))
        names.set(id, name);
    }

    const { canActNow, inertReason } = this.actability(
      instance,
      viewer,
      roleId,
      finished,
    );

    const delegateName = instance.delegatedToUserId
      ? (await this.namesFor([instance.delegatedToUserId])).get(
          instance.delegatedToUserId,
        ) ?? null
      : null;

    return {
      instanceId: instance.id,
      companyId: instance.companyId,
      actionType: instance.chain.actionType,
      entityType: instance.entityType,
      entityId: instance.entityId,
      subject: instance.subject,
      href: instance.href,
      state: instance.state,
      currentPosition: instance.currentPosition,
      totalLevels: levels.length,
      round: instance.round,
      returnCount: instance.returnCount,
      originatorUserId: instance.originatorUserId,
      // "The system" rather than "Unknown user": a scheduled run has no originator by
      // design, and reporting that as unknown would read like missing data.
      originatorName: instance.originatorUserId
        ? names.get(instance.originatorUserId) ?? 'Unknown user'
        : 'The system',
      levelLabel:
        finished || !level ? null : labelForSlot(level.slotKey, level.label),
      awaitingRoleName,
      // A reassignment names one person, so it answers this precisely. Otherwise only a
      // sole holder can be named without guessing.
      awaitingUserName:
        delegateName ?? (holders.length === 1 ? holders[0].name : null),
      awaitingHolderCount: instance.delegatedToUserId ? 1 : holders.length,
      canActNow,
      // Only the originator, and only while it is returned. The service enforces both
      // again on the write — this is what the interface renders, never what it relies on.
      canResubmitNow:
        instance.state === 'returned' &&
        !!viewer &&
        instance.originatorUserId === viewer.id,
      inertReason,
      latestDecision: latest
        ? this.toDecisionView(latest, instance, names)
        : null,
      createdAt: instance.createdAt,
      updatedAt: instance.updatedAt,
    };
  }

  /**
   * Whether this viewer may act, and if not, which of the four reasons applies (FR-011).
   *
   * The order matters. `already_decided` is tested before `insufficient_authority`
   * because a Super Admin who decided at an earlier level holds every permission in the
   * system — telling them they lack authority is false, and sends the one person who can
   * change permissions to go and change permissions that were never the problem.
   */
  private actability(
    instance: InstanceWithContext,
    viewer: AuthenticatedUser | null,
    roleId: string | null,
    finished: boolean,
  ): { canActNow: boolean; inertReason: InertReason | null } {
    if (!viewer || finished || instance.state !== 'pending') {
      return { canActNow: false, inertReason: null };
    }

    if (
      instance.decisions.some(
        (d) => d.actorUserId === viewer.id && d.round === instance.round,
      )
    ) {
      return { canActNow: false, inertReason: 'already_decided' };
    }

    if (!roleId) {
      return { canActNow: false, inertReason: 'slot_unmapped' };
    }

    const isDelegate = instance.delegatedToUserId === viewer.id;
    if (isDelegate || viewer.roleIds.includes(roleId)) {
      return { canActNow: true, inertReason: null };
    }

    // Held by somebody else at this level rather than beyond this viewer's authority
    // altogether — the distinction the interface needs to say "waiting on HR" instead of
    // "you cannot do this".
    return {
      canActNow: false,
      inertReason: instance.delegatedToUserId
        ? 'awaiting_other'
        : 'insufficient_authority',
    };
  }

  /**
   * Whether this viewer may read the item's history (FR-009, T043).
   *
   * Two ways in, and they are additive rather than alternative because they answer
   * different questions. The permission answers "is this person one of the people this
   * kind of record is for"; participation answers "was this person in this particular
   * chain". Neither implies the other.
   */
  private mayViewHistory(
    instance: InstanceWithContext,
    viewer: AuthenticatedUser,
  ): boolean {
    if (viewer.permissions.includes(instance.viewPermission)) return true;
    if (instance.originatorUserId === viewer.id) return true;
    if (instance.delegatedToUserId === viewer.id) return true;
    return instance.decisions.some((d) => d.actorUserId === viewer.id);
  }

  private toDecisionView(
    decision: InstanceWithContext['decisions'][number],
    instance: InstanceWithContext,
    names: Map<string, string>,
  ): ApprovalDecisionView {
    const level = instance.chain.levels.find(
      (l) => l.position === decision.position,
    );
    return {
      position: decision.position,
      levelLabel: level
        ? labelForSlot(level.slotKey, level.label)
        : `Level ${decision.position}`,
      actorUserId: decision.actorUserId,
      actorName: names.get(decision.actorUserId) ?? 'Unknown user',
      action: decision.action,
      reason: decision.reason,
      decidedAt: decision.decidedAt,
      round: decision.round,
    };
  }

  /** Every refused decision is recorded (FR-003, T017). */
  private async auditRefusal(
    instance: InstanceWithContext,
    caller: AuthenticatedUser,
    ipAddress: string,
    code: ApprovalErrorCode,
    attempted?: ApprovalDecisionAction,
  ): Promise<void> {
    await this.audit.record({
      entityType: AuditEntityType.APPROVAL_REFUSED,
      action: AuditAction.UPDATE,
      entityId: instance.id,
      changes: {
        entityType: instance.entityType,
        entityId: instance.entityId,
        attemptedAction: attempted ?? 'reassign',
        atPosition: instance.currentPosition,
        refusedBecause: code,
      },
      accountId: caller.id,
      companyId: instance.companyId,
      ipAddress,
    });
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === UNIQUE_VIOLATION
    );
  }
}
