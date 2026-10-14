import { Injectable } from '@nestjs/common';
import { ApprovalState, Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuthenticatedUser } from '../auth/authenticated-user';
import { actorNamesFor } from '../common/actor-name';
import { repairStoredApprovalHref } from '../common/web-routes';
import { RlsContext, withRlsContext } from '../common/prisma/rls-context';
import { effectiveCompanyId } from '../settings/company-scope';
import {
  APPROVAL_MODULES,
  OTHER_MODULE,
  chainWhereForModule,
  moduleOf,
} from './approval-modules';
import { labelForSlot } from './approval-slots';
import {
  ApprovalDecisionView,
  ApprovalHistoryEntry,
  ApprovalHistoryPage,
  ApprovalHistoryStep,
  ApprovalModuleCount,
  isLive,
} from './approval.types';
import type {
  ApprovalHistoryScope,
  ApprovalHistoryStatus,
} from './dto/approval-history-query.dto';

type InstanceRow = Prisma.ApprovalInstanceGetPayload<{
  include: { chain: { include: { levels: true } }; decisions: true };
}>;

const STATES_FOR: Record<ApprovalHistoryStatus, ApprovalState[] | null> = {
  open: ['pending', 'returned'],
  decided: ['approved', 'rejected'],
  withdrawn: ['abandoned'],
  all: null,
};

const STEP_STATUS = {
  approve: 'approved',
  reject: 'rejected',
  return: 'returned',
} as const;

export interface ApprovalHistoryQuery {
  status?: ApprovalHistoryStatus;
  scope?: ApprovalHistoryScope;
  module?: string;
  page?: number;
  pageSize?: number;
}

/**
 * The approval history: past and in-flight items, not only the caller's queue
 * (2026-10-15).
 *
 * ## Why a second listing beside the queue
 *
 * `/approvals/queue` answers "what must I decide now" and, by design, drops an item the
 * moment the caller has decided it. That made the Approvals screen empty for anybody
 * with nothing pending — and the client asked for the opposite: past approvals along
 * with pending ones, the hierarchy, and who approved what. The queue's rule is right for
 * a queue, so this is a separate read rather than a looser queue.
 *
 * ## Who sees what — the same rule as an item's own history
 *
 * A row is listed when the caller could open that item's history through
 * `GET /approvals/:entityType/:entityId/history` — `ApprovalService.mayViewHistory`,
 * expressed as a `where` instead of checked row by row:
 *
 * - they hold the item's `viewPermission`, the permission its module declared at submit
 *   time (a PAYROLL holder sees payroll runs, a PROJECT_FINANCIALS holder sees bills); or
 * - they took part: raised it, were delegated it, or decided at any level of any round.
 *
 * Two listings that disagreed about who may see a rejection reason would be a leak in
 * whichever was looser, so this one is written to be exactly as wide as the per-item
 * check and no wider. `scope=mine` drops the first clause.
 *
 * ## Query budget
 *
 * One `groupBy` (per-module counts, which also gives `total`), one chain lookup to map
 * those counts to modules, one page of instances with their levels and decisions
 * included, and one name lookup for every person on the page. Four reads, whatever the
 * page size — never one per row.
 */
@Injectable()
export class ApprovalHistoryService {
  constructor(private readonly prisma: PrismaService) {}

  async historyFor(
    caller: AuthenticatedUser,
    query: ApprovalHistoryQuery = {},
  ): Promise<ApprovalHistoryPage> {
    const page = Math.max(query.page ?? 1, 1);
    const pageSize = Math.min(Math.max(query.pageSize ?? 20, 1), 100);
    const companyId = effectiveCompanyId(caller);
    if (!companyId) {
      return { items: [], total: 0, page, pageSize, modules: [] };
    }

    const ctx: RlsContext = { isSuperAdmin: false, companyId };
    const states = STATES_FOR[query.status ?? 'decided'];

    const tookPart: Prisma.ApprovalInstanceWhereInput[] = [
      { originatorUserId: caller.id },
      { delegatedToUserId: caller.id },
      { decisions: { some: { actorUserId: caller.id } } },
    ];
    const visible: Prisma.ApprovalInstanceWhereInput[] =
      query.scope === 'mine'
        ? tookPart
        : [
            ...(caller.permissions.length
              ? [{ viewPermission: { in: caller.permissions } }]
              : []),
            ...tookPart,
          ];

    const base: Prisma.ApprovalInstanceWhereInput = {
      companyId,
      ...(states ? { state: { in: states } } : {}),
      OR: visible,
    };
    const where: Prisma.ApprovalInstanceWhereInput = query.module
      ? { ...base, chain: chainWhereForModule(query.module) }
      : base;

    const { rows, modules } = await withRlsContext(
      this.prisma,
      ctx,
      async (tx) => {
        const [byChain, rows] = await Promise.all([
          tx.approvalInstance.groupBy({
            by: ['chainId'],
            where: base,
            _count: { _all: true },
          }),
          tx.approvalInstance.findMany({
            where,
            include: { chain: { include: { levels: true } }, decisions: true },
            orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
            skip: (page - 1) * pageSize,
            take: pageSize,
          }),
        ]);
        const chains = byChain.length
          ? await tx.approvalChain.findMany({
              where: { id: { in: byChain.map((c) => c.chainId) } },
              select: { id: true, actionType: true },
            })
          : [];
        return { rows, modules: this.countByModule(byChain, chains) };
      },
    );

    const total = query.module
      ? modules.find((m) => m.key === query.module)?.count ?? 0
      : modules.reduce((sum, m) => sum + m.count, 0);

    const names = await actorNamesFor(
      this.prisma,
      rows.flatMap((r) => [
        r.originatorUserId,
        r.delegatedToUserId,
        ...r.decisions.map((d) => d.actorUserId),
      ]),
    );

    return {
      items: rows.map((r) => this.toEntry(r, caller, names)),
      total,
      page,
      pageSize,
      modules,
    };
  }

  /** Per-module counts, in `APPROVAL_MODULES` order with `other` last. */
  private countByModule(
    byChain: { chainId: string; _count: { _all: number } }[],
    chains: { id: string; actionType: string }[],
  ): ApprovalModuleCount[] {
    const actionTypeOf = new Map(chains.map((c) => [c.id, c.actionType]));
    const counts = new Map<string, number>();
    for (const row of byChain) {
      const key = moduleOf(actionTypeOf.get(row.chainId) ?? '').key;
      counts.set(key, (counts.get(key) ?? 0) + row._count._all);
    }
    return [...APPROVAL_MODULES, OTHER_MODULE]
      .filter((m) => counts.has(m.key))
      .map((m) => ({
        key: m.key,
        label: m.label,
        count: counts.get(m.key) ?? 0,
      }));
  }

  private toEntry(
    r: InstanceRow,
    caller: AuthenticatedUser,
    names: Map<string, string>,
  ): ApprovalHistoryEntry {
    const levels = [...r.chain.levels].sort((a, b) => a.position - b.position);
    const live = isLive(r.state);
    const thisRound = r.decisions.filter((d) => d.round === r.round);
    const nameOf = (id: string) => names.get(id) ?? 'Unknown user';

    const steps: ApprovalHistoryStep[] = levels.map((level) => {
      const decision = thisRound.find((d) => d.position === level.position);
      const label = labelForSlot(level.slotKey, level.label);
      const common = {
        position: level.position,
        label,
        slotKey: level.slotKey,
        isFinalAuthority: level.isFinalAuthority,
      };
      if (decision) {
        return {
          ...common,
          status: STEP_STATUS[decision.action],
          actorName: nameOf(decision.actorUserId),
          decidedAt: decision.decidedAt,
          reason: decision.reason,
        };
      }
      // `pending` is the only state in which a level is being waited on. A returned item
      // waits on its originator, not on a level, so its later levels are not reached
      // *this round* — they will be when it is resubmitted, as a new round.
      const status =
        r.state === 'pending'
          ? level.position === r.currentPosition
            ? 'current'
            : level.position > r.currentPosition
            ? 'upcoming'
            : 'not_reached'
          : 'not_reached';
      return {
        ...common,
        status,
        actorName: null,
        decidedAt: null,
        reason: null,
      };
    });

    const current = levels.find((l) => l.position === r.currentPosition);
    const earlierDecisions: ApprovalDecisionView[] = r.decisions
      .filter((d) => d.round < r.round)
      .sort((a, b) => a.decidedAt.getTime() - b.decidedAt.getTime())
      .map((d) => {
        const level = levels.find((l) => l.position === d.position);
        return {
          position: d.position,
          levelLabel: level
            ? labelForSlot(level.slotKey, level.label)
            : `Level ${d.position}`,
          actorUserId: d.actorUserId,
          actorName: nameOf(d.actorUserId),
          action: d.action,
          reason: d.reason,
          decidedAt: d.decidedAt,
          round: d.round,
        };
      });

    const { key, label } = moduleOf(r.chain.actionType);
    return {
      instanceId: r.id,
      actionType: r.chain.actionType,
      module: key,
      moduleLabel: label,
      entityType: r.entityType,
      entityId: r.entityId,
      subject: r.subject,
      href: repairStoredApprovalHref(r.href),
      state: r.state,
      round: r.round,
      returnCount: r.returnCount,
      currentPosition: r.currentPosition,
      totalLevels: levels.length,
      requestedById: r.originatorUserId,
      requestedByName: r.originatorUserId
        ? nameOf(r.originatorUserId)
        : 'The system',
      requestedAt: r.createdAt,
      closedAt: live ? null : r.updatedAt,
      awaitingLabel:
        r.state === 'pending' && current
          ? labelForSlot(current.slotKey, current.label)
          : null,
      delegatedToName: r.delegatedToUserId ? nameOf(r.delegatedToUserId) : null,
      steps,
      earlierDecisions,
      viewerTookPart:
        r.originatorUserId === caller.id ||
        r.delegatedToUserId === caller.id ||
        r.decisions.some((d) => d.actorUserId === caller.id),
    };
  }
}
