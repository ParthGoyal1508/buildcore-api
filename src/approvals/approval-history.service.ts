import { BadRequestException, Injectable } from '@nestjs/common';
import { ApprovalState, Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuthenticatedUser } from '../auth/authenticated-user';
import { actorNamesFor } from '../common/actor-name';
import config from '../common/configs/config';
import { zonedDateOnly, zonedDayBounds } from '../hr/leave/leave-days';
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
  /** 036 D1 — business-timezone days, inclusive, matched against the latest action. */
  from?: string;
  to?: string;
  q?: string;
  requestedBy?: string;
  page?: number;
  pageSize?: number;
}

/** The most rows one history CSV carries (036 D1) — the same order of bound as the other exports. */
export const APPROVAL_HISTORY_EXPORT_MAX_ROWS = 5_000;

/** How many matching accounts a name search expands to (036 D1). */
const NAME_SEARCH_LIMIT = 200;

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
    const { base, where } = await this.whereFor(caller, query, companyId);
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
            // 036 D2: newest *latest action* first — for a decided item that is its decision —
            // and the screen says so. `updatedAt` moves on every step, return, reassignment and
            // withdrawal, and on nothing else (the subject and link are written once at submit).
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

  /**
   * The rows the caller may read under the filters (036 D1), and the same without the module
   * filter — the per-module counts are taken over that, so the module chips keep their numbers
   * while one of them is selected.
   */
  private async whereFor(
    caller: AuthenticatedUser,
    query: ApprovalHistoryQuery,
    companyId: string,
  ): Promise<{
    base: Prisma.ApprovalInstanceWhereInput;
    where: Prisma.ApprovalInstanceWhereInput;
  }> {
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

    const filters: Prisma.ApprovalInstanceWhereInput[] = [];
    const range = this.rangeOf(query.from, query.to);
    if (range) filters.push({ updatedAt: range });
    if (query.requestedBy) {
      filters.push({ originatorUserId: query.requestedBy });
    }
    const q = query.q?.trim();
    if (q) {
      // A name matches whoever raised the item or decided at any level. The accounts are looked
      // up first and bounded: the search only narrows rows the caller can already read, so the
      // lookup itself discloses nothing.
      const people = await withRlsContext(
        this.prisma,
        { isSuperAdmin: true },
        (tx) =>
          tx.user.findMany({
            where: {
              OR: [
                { displayName: { contains: q, mode: 'insensitive' } },
                { firstname: { contains: q, mode: 'insensitive' } },
                { lastname: { contains: q, mode: 'insensitive' } },
                { username: { contains: q, mode: 'insensitive' } },
                { email: { contains: q, mode: 'insensitive' } },
              ],
            },
            select: { id: true },
            take: NAME_SEARCH_LIMIT,
          }),
      );
      const ids = people.map((p) => p.id);
      filters.push({
        OR: [
          { subject: { contains: q, mode: 'insensitive' } },
          ...(ids.length
            ? [
                { originatorUserId: { in: ids } },
                { decisions: { some: { actorUserId: { in: ids } } } },
              ]
            : []),
        ],
      });
    }

    const base: Prisma.ApprovalInstanceWhereInput = {
      companyId,
      ...(states ? { state: { in: states } } : {}),
      // The visibility rule stays the top-level `OR`, exactly as wide as `mayViewHistory`; the
      // 036 D1 filters only ever AND onto it.
      OR: visible,
      ...(filters.length ? { AND: filters } : {}),
    };
    const where: Prisma.ApprovalInstanceWhereInput = query.module
      ? { ...base, chain: chainWhereForModule(query.module) }
      : base;
    return { base, where };
  }

  /** `from`..`to` as instants: the start of `from` to the end of `to`, in the business zone. */
  private rangeOf(
    from: string | undefined,
    to: string | undefined,
  ): Prisma.DateTimeFilter | null {
    if (!from && !to) return null;
    const zone = config().settings.timezone;
    try {
      const range: Prisma.DateTimeFilter = {};
      if (from) range.gte = zonedDayBounds(from, zone).start;
      if (to) range.lt = zonedDayBounds(to, zone).end;
      if (range.gte && range.lt && range.gte >= range.lt) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: 'The From date must not be after the To date.',
        });
      }
      return range;
    } catch (error) {
      if (error instanceof RangeError) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: 'That is not a real calendar date.',
        });
      }
      throw error;
    }
  }

  /**
   * The filtered history as CSV rows (036 D1), newest latest-action first, at most
   * {@link APPROVAL_HISTORY_EXPORT_MAX_ROWS}. One row per item; the levels are joined into one
   * "who decided what" cell so the sheet stays one line per approval.
   */
  async exportRows(
    caller: AuthenticatedUser,
    query: ApprovalHistoryQuery,
  ): Promise<string[][]> {
    const companyId = effectiveCompanyId(caller);
    const header = [
      'Subject',
      'Module',
      'Status',
      'Raised by',
      'Raised on',
      'Latest action',
      'Awaiting',
      'Decisions',
    ];
    if (!companyId) return [header];
    const ctx: RlsContext = { isSuperAdmin: false, companyId };
    const { where } = await this.whereFor(caller, query, companyId);
    const rows = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.approvalInstance.findMany({
        where,
        include: { chain: { include: { levels: true } }, decisions: true },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: APPROVAL_HISTORY_EXPORT_MAX_ROWS,
      }),
    );
    const names = await actorNamesFor(
      this.prisma,
      rows.flatMap((r) => [
        r.originatorUserId,
        r.delegatedToUserId,
        ...r.decisions.map((d) => d.actorUserId),
      ]),
    );
    const zone = config().settings.timezone;
    const day = (d: Date) => {
      const [y, m, dd] = zonedDateOnly(d, zone).split('-');
      return `${dd}-${m}-${y}`;
    };
    return [
      header,
      ...rows.map((r) => {
        const entry = this.toEntry(r, caller, names);
        const decisions = entry.steps
          .filter((step) => step.actorName)
          .map(
            (step) =>
              `${step.label}: ${step.status} by ${step.actorName}${
                step.decidedAt ? ` on ${day(step.decidedAt)}` : ''
              }${step.reason ? ` (${step.reason})` : ''}`,
          )
          .join('; ');
        return [
          entry.subject,
          entry.moduleLabel,
          entry.state,
          entry.requestedByName,
          day(entry.requestedAt),
          day(entry.lastActionAt),
          entry.awaitingLabel ?? '',
          decisions,
        ];
      }),
    ];
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
      lastActionAt: r.updatedAt,
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
