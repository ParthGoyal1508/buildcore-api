import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  CodeSeriesType,
  IndentStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { CodeSeriesService } from '../../settings/code-series/code-series.service';
import { assertInScope, companyScope } from '../../settings/company-scope';
import {
  DEFAULT_PAGE_SIZE,
  INDENT_CODE_INFIX,
  MAX_PAGE_SIZE,
} from '../constants/inventory.constants';
import { InventoryRefsService } from '../inventory-refs.service';
import { inStockOf, toNumber } from '../stock/stock.types';
import {
  ApproveIndentDto,
  CreateIndentDto,
  IndentDecisionDto,
  ListIndentsDto,
  MarkProcurementNeededDto,
} from './dto/indent.dto';

export interface IndentLineView {
  id: string;
  itemId: string;
  itemName: string;
  itemCode: string;
  unit: string;
  requestedQuantity: number;
  approvedQuantity: number | null;
  fulfilledQuantity: number;
  /** `approved − fulfilled`, and null while nothing has been approved. Always
   * derived, never stored — SC-A01 is the claim that it cannot drift. */
  outstandingQuantity: number | null;
  reductionReason: string | null;
  activityId: string | null;
  boqItemId: string | null;
  procurementPending: boolean;
}

export interface IndentView {
  id: string;
  companyId: string;
  indentNumber: string;
  siteId: string;
  siteName: string;
  projectId: string | null;
  requiredByDate: Date;
  justification: string;
  status: IndentStatus;
  requestedByUserId: string;
  approvedByUserId: string | null;
  approvedAt: Date | null;
  decisionReason: string | null;
  /** Past its required-by date with quantity still outstanding (FR-026's sibling,
   * spec AC9). Computed on read: a stored flag would be wrong by morning. */
  overdue: boolean;
  overdueByDays: number;
  lines: IndentLineView[];
  createdAt: Date;
}

export interface ProcurementNeededView {
  /** Approved indent demand a storekeeper has marked as needing purchase. */
  indentDemand: {
    indentId: string;
    indentNumber: string;
    lineId: string;
    itemId: string;
    itemName: string;
    itemCode: string;
    unit: string;
    siteId: string;
    siteName: string;
    outstandingQuantity: number;
    requiredByDate: Date;
  }[];
  /** Items below their own reorder level, independent of any indent. */
  reorderShortfall: {
    itemId: string;
    itemName: string;
    itemCode: string;
    unit: string;
    siteId: string;
    siteName: string;
    inStock: number;
    reorderLevel: number;
    shortfall: number;
  }[];
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Material indents: a site asking for material, and someone approving the ask.
 *
 * The invariant the whole amendment rests on (FR-025): **approval does not reserve
 * stock.** Nothing in this service touches a `StockBalance` or writes a
 * `StockLedgerEntry`. Issue-time validation stays the single point of stock
 * enforcement, which is what makes it impossible for this feature to introduce a
 * path to a negative balance — and SC-A02 is the test that says so.
 */
@Injectable()
export class IndentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly refs: InventoryRefsService,
    private readonly codeSeries: CodeSeriesService,
  ) {}

  private overdueOf(
    indent: { requiredByDate: Date; status: IndentStatus },
    lines: { approvedQuantity: number | null; fulfilledQuantity: number }[],
    now: Date,
  ): { overdue: boolean; overdueByDays: number } {
    const outstanding = lines.some(
      (line) =>
        line.approvedQuantity !== null &&
        line.approvedQuantity - line.fulfilledQuantity > 0,
    );
    const settled =
      indent.status === IndentStatus.fulfilled ||
      indent.status === IndentStatus.cancelled ||
      indent.status === IndentStatus.rejected;

    if (settled || !outstanding || indent.requiredByDate >= now) {
      return { overdue: false, overdueByDays: 0 };
    }
    return {
      overdue: true,
      overdueByDays: Math.floor(
        (now.getTime() - indent.requiredByDate.getTime()) / MS_PER_DAY,
      ),
    };
  }

  private toLineView(
    line: {
      id: string;
      itemId: string;
      requestedQuantity: Prisma.Decimal;
      approvedQuantity: Prisma.Decimal | null;
      fulfilledQuantity: Prisma.Decimal;
      reductionReason: string | null;
      activityId: string | null;
      boqItemId: string | null;
      procurementPending: boolean;
    },
    item?: { name: string; code: string; unit: string },
  ): IndentLineView {
    const approved =
      line.approvedQuantity === null ? null : toNumber(line.approvedQuantity);
    const fulfilled = toNumber(line.fulfilledQuantity);
    return {
      id: line.id,
      itemId: line.itemId,
      itemName: item?.name ?? 'Unknown item',
      itemCode: item?.code ?? '',
      unit: item?.unit ?? '',
      requestedQuantity: toNumber(line.requestedQuantity),
      approvedQuantity: approved,
      fulfilledQuantity: fulfilled,
      outstandingQuantity: approved === null ? null : approved - fulfilled,
      reductionReason: line.reductionReason,
      activityId: line.activityId,
      boqItemId: line.boqItemId,
      procurementPending: line.procurementPending,
    };
  }

  async create(
    caller: AuthenticatedUser,
    dto: CreateIndentDto,
    ipAddress: string,
    companyId?: string,
  ): Promise<IndentView> {
    const targetCompanyId = this.refs.targetCompanyOf(caller, companyId);
    const siteName = await this.refs.requireSiteName(
      caller,
      dto.siteId,
      targetCompanyId,
    );
    const projectId = await this.refs.projectOfSite(caller, dto.siteId);

    const items = await Promise.all(
      dto.lines.map((line) =>
        this.refs.requireItem(caller, line.itemId, targetCompanyId),
      ),
    );
    // A retired item is refused at the field, not silently accepted and discovered
    // at issue time when the material is already wanted.
    const retired = items.filter((item) => !item.active);
    if (retired.length > 0) {
      throw new BadRequestException(
        `These items are retired and cannot be indented: ${retired
          .map((item) => item.code)
          .join(', ')}`,
      );
    }

    const requiredByDate = this.refs.parseDate(dto.requiredByDate);

    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const indentNumber = await this.codeSeries.next(
          tx,
          targetCompanyId,
          CodeSeriesType.INDENT,
          INDENT_CODE_INFIX,
        );
        return tx.materialIndent.create({
          data: {
            companyId: targetCompanyId,
            siteId: dto.siteId,
            projectId,
            indentNumber,
            requiredByDate,
            justification: dto.justification.trim(),
            requestedByUserId: caller.id,
            lines: {
              create: dto.lines.map((line) => ({
                companyId: targetCompanyId,
                itemId: line.itemId,
                requestedQuantity: line.requestedQuantity,
                activityId: line.activityId ?? null,
                boqItemId: line.boqItemId ?? null,
              })),
            },
          },
          include: { lines: true },
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.MATERIAL_INDENT,
      action: AuditAction.CREATE,
      entityId: created.id,
      changes: {
        after: { indentNumber: created.indentNumber, lines: dto.lines.length },
      },
      accountId: caller.id,
      companyId: targetCompanyId,
      ipAddress,
    });

    const itemsById = new Map(items.map((item) => [item.id, item]));
    return {
      ...this.headerView(created, siteName),
      overdue: false,
      overdueByDays: 0,
      lines: created.lines.map((line) =>
        this.toLineView(line, itemsById.get(line.itemId)),
      ),
    };
  }

  private headerView(
    indent: {
      id: string;
      companyId: string;
      indentNumber: string;
      siteId: string;
      projectId: string | null;
      requiredByDate: Date;
      justification: string;
      status: IndentStatus;
      requestedByUserId: string;
      approvedByUserId: string | null;
      approvedAt: Date | null;
      decisionReason: string | null;
      createdAt: Date;
    },
    siteName: string,
  ): Omit<IndentView, 'overdue' | 'overdueByDays' | 'lines'> {
    return {
      id: indent.id,
      companyId: indent.companyId,
      indentNumber: indent.indentNumber,
      siteId: indent.siteId,
      siteName,
      projectId: indent.projectId,
      requiredByDate: indent.requiredByDate,
      justification: indent.justification,
      status: indent.status,
      requestedByUserId: indent.requestedByUserId,
      approvedByUserId: indent.approvedByUserId,
      approvedAt: indent.approvedAt,
      decisionReason: indent.decisionReason,
      createdAt: indent.createdAt,
    };
  }

  async findAll(
    caller: AuthenticatedUser,
    query: ListIndentsDto,
  ): Promise<{
    indents: IndentView[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(
      query.pageSize ?? DEFAULT_PAGE_SIZE,
      MAX_PAGE_SIZE,
    );

    const where: Prisma.MaterialIndentWhereInput = {
      ...companyScope(caller, query.companyId),
      deleted: false,
      ...(query.status ? { status: query.status } : {}),
      ...(query.siteId ? { siteId: query.siteId } : {}),
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.itemId ? { lines: { some: { itemId: query.itemId } } } : {}),
    };

    const { rows, total } = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const [rows, total] = await Promise.all([
          tx.materialIndent.findMany({
            where,
            include: { lines: true },
            orderBy: [{ requiredByDate: 'asc' }, { createdAt: 'desc' }],
            skip: (page - 1) * pageSize,
            take: pageSize,
          }),
          tx.materialIndent.count({ where }),
        ]);
        return { rows, total };
      },
    );

    const [items, siteNames] = await Promise.all([
      this.refs.itemsByIds(
        caller,
        rows.flatMap((row) => row.lines.map((line) => line.itemId)),
      ),
      this.refs.siteNames(
        caller,
        rows.map((row) => row.siteId),
      ),
    ]);

    const now = new Date();
    return {
      indents: rows.map((row) => {
        const lines = row.lines.map((line) =>
          this.toLineView(line, items.get(line.itemId)),
        );
        return {
          ...this.headerView(row, siteNames.get(row.siteId) ?? 'Unknown store'),
          ...this.overdueOf(
            row,
            lines.map((line) => ({
              approvedQuantity: line.approvedQuantity,
              fulfilledQuantity: line.fulfilledQuantity,
            })),
            now,
          ),
          lines,
        };
      }),
      total,
      page,
      pageSize,
    };
  }

  async findOne(caller: AuthenticatedUser, id: string): Promise<IndentView> {
    const indent = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.materialIndent.findUnique({
          where: { id },
          include: { lines: true },
        }),
    );
    if (!indent || indent.deleted) {
      throw new NotFoundException(`Indent ${id} not found`);
    }
    assertInScope(caller, indent, `Indent ${id}`);

    const [items, siteName] = await Promise.all([
      this.refs.itemsByIds(
        caller,
        indent.lines.map((line) => line.itemId),
      ),
      this.refs
        .requireSiteName(caller, indent.siteId, indent.companyId)
        .catch(() => 'Unknown store'),
    ]);

    const lines = indent.lines.map((line) =>
      this.toLineView(line, items.get(line.itemId)),
    );
    return {
      ...this.headerView(indent, siteName),
      ...this.overdueOf(
        indent,
        lines.map((line) => ({
          approvedQuantity: line.approvedQuantity,
          fulfilledQuantity: line.fulfilledQuantity,
        })),
        new Date(),
      ),
      lines,
    };
  }

  /**
   * Approves an indent, line by line (FR-022).
   *
   * Both quantities survive: reducing a line writes `approvedQuantity` and keeps
   * `requestedQuantity` untouched, so the reduction stays visible and auditable.
   * A reduction without a reason is refused — an approver who silently halves a
   * request leaves the site unable to tell a decision from an error.
   *
   * Writes nothing to any stock table. See the class comment: FR-025.
   */
  async approve(
    caller: AuthenticatedUser,
    id: string,
    dto: ApproveIndentDto,
    ipAddress: string,
  ): Promise<IndentView> {
    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const indent = await tx.materialIndent.findUnique({
          where: { id },
          include: { lines: true },
        });
        if (!indent || indent.deleted) {
          throw new NotFoundException(`Indent ${id} not found`);
        }
        assertInScope(caller, indent, `Indent ${id}`);
        if (indent.status !== IndentStatus.submitted) {
          throw new ConflictException(
            `Only a submitted indent can be approved; this one is ${indent.status}.`,
          );
        }

        const byId = new Map(indent.lines.map((line) => [line.id, line]));
        for (const decision of dto.lines) {
          const line = byId.get(decision.lineId);
          if (!line) {
            throw new BadRequestException(
              `Indent line ${decision.lineId} does not belong to indent ${id}`,
            );
          }
          const requested = toNumber(line.requestedQuantity);
          if (decision.approvedQuantity > requested) {
            throw new BadRequestException(
              `Line ${decision.lineId}: approving ${decision.approvedQuantity} exceeds the ${requested} requested.`,
            );
          }
          if (
            decision.approvedQuantity < requested &&
            !decision.reductionReason?.trim()
          ) {
            throw new BadRequestException(
              `Line ${decision.lineId}: a reduced quantity needs a reason.`,
            );
          }
          await tx.materialIndentLine.update({
            where: { id: line.id },
            data: {
              approvedQuantity: decision.approvedQuantity,
              reductionReason:
                decision.approvedQuantity < requested
                  ? decision.reductionReason?.trim() ?? null
                  : null,
            },
          });
        }

        // Lines the approver did not mention are approved at zero rather than left
        // null: null means "not yet decided", and an indent that is approved as a
        // whole must not contain undecided lines.
        const decided = new Set(dto.lines.map((line) => line.lineId));
        await tx.materialIndentLine.updateMany({
          where: { indentId: id, id: { notIn: [...decided] } },
          data: { approvedQuantity: 0 },
        });

        return tx.materialIndent.update({
          where: { id },
          data: {
            status: IndentStatus.approved,
            approvedByUserId: caller.id,
            approvedAt: new Date(),
          },
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.MATERIAL_INDENT,
      action: AuditAction.UPDATE,
      entityId: id,
      changes: {
        after: {
          status: IndentStatus.approved,
          // Mapped to plain objects rather than passed as DTO instances: the audit
          // `changes` column is typed as JSON, and a class instance is not.
          lines: dto.lines.map((line) => ({
            lineId: line.lineId,
            approvedQuantity: line.approvedQuantity,
            reductionReason: line.reductionReason ?? null,
          })),
        },
      },
      accountId: caller.id,
      companyId: updated.companyId,
      ipAddress,
    });
    return this.findOne(caller, id);
  }

  async reject(
    caller: AuthenticatedUser,
    id: string,
    dto: IndentDecisionDto,
    ipAddress: string,
  ): Promise<IndentView> {
    const updated = await this.decide(
      caller,
      id,
      IndentStatus.rejected,
      dto.reason,
      (indent) => {
        if (indent.status !== IndentStatus.submitted) {
          throw new ConflictException(
            `Only a submitted indent can be rejected; this one is ${indent.status}.`,
          );
        }
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.MATERIAL_INDENT,
      action: AuditAction.UPDATE,
      entityId: id,
      changes: { after: { status: IndentStatus.rejected, reason: dto.reason } },
      accountId: caller.id,
      companyId: updated.companyId,
      ipAddress,
    });
    return this.findOne(caller, id);
  }

  /**
   * Cancels an indent (FR-026).
   *
   * Refused outright once any line has been fulfilled: material has already moved
   * against this demand, and cancelling would leave those issues pointing at a
   * request that claims never to have happened.
   */
  async cancel(
    caller: AuthenticatedUser,
    id: string,
    dto: IndentDecisionDto,
    ipAddress: string,
  ): Promise<IndentView> {
    const updated = await this.decide(
      caller,
      id,
      IndentStatus.cancelled,
      dto.reason,
      (indent) => {
        const fulfilled = indent.lines.some(
          (line) => toNumber(line.fulfilledQuantity) > 0,
        );
        if (fulfilled) {
          throw new ConflictException(
            'This indent has already been partly fulfilled and can no longer be cancelled.',
          );
        }
        if (
          indent.status === IndentStatus.cancelled ||
          indent.status === IndentStatus.rejected
        ) {
          throw new ConflictException(
            `This indent is already ${indent.status}.`,
          );
        }
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.MATERIAL_INDENT,
      action: AuditAction.UPDATE,
      entityId: id,
      changes: {
        after: { status: IndentStatus.cancelled, reason: dto.reason },
      },
      accountId: caller.id,
      companyId: updated.companyId,
      ipAddress,
    });
    return this.findOne(caller, id);
  }

  private async decide(
    caller: AuthenticatedUser,
    id: string,
    status: IndentStatus,
    reason: string,
    guard: (indent: {
      status: IndentStatus;
      lines: { fulfilledQuantity: Prisma.Decimal }[];
    }) => void,
  ) {
    return withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
      const indent = await tx.materialIndent.findUnique({
        where: { id },
        include: { lines: true },
      });
      if (!indent || indent.deleted) {
        throw new NotFoundException(`Indent ${id} not found`);
      }
      assertInScope(caller, indent, `Indent ${id}`);
      guard(indent);

      return tx.materialIndent.update({
        where: { id },
        data: {
          status,
          decisionReason: reason.trim(),
          approvedByUserId: caller.id,
          approvedAt: new Date(),
        },
      });
    });
  }

  /** Flags approved lines that cannot be met from stock and need buying (FR-027). */
  async markProcurementNeeded(
    caller: AuthenticatedUser,
    id: string,
    dto: MarkProcurementNeededDto,
    ipAddress: string,
  ): Promise<IndentView> {
    const indent = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.materialIndent.findUnique({
          where: { id },
          include: { lines: true },
        });
        if (!existing || existing.deleted) {
          throw new NotFoundException(`Indent ${id} not found`);
        }
        assertInScope(caller, existing, `Indent ${id}`);

        const own = new Set(existing.lines.map((line) => line.id));
        const foreign = dto.lineIds.filter((lineId) => !own.has(lineId));
        if (foreign.length > 0) {
          throw new BadRequestException(
            `These lines do not belong to indent ${id}: ${foreign.join(', ')}`,
          );
        }

        await tx.materialIndentLine.updateMany({
          where: { id: { in: dto.lineIds } },
          data: { procurementPending: true },
        });
        return existing;
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.MATERIAL_INDENT,
      action: AuditAction.UPDATE,
      entityId: id,
      changes: { after: { procurementPending: dto.lineIds } },
      accountId: caller.id,
      companyId: indent.companyId,
      ipAddress,
    });
    return this.findOne(caller, id);
  }

  /**
   * What needs buying, from two independent sources (FR-027).
   *
   * Returned as two labelled lists and never summed. The same item can appear in
   * both — a site indents 100 bags of cement *and* the store is below its reorder
   * level — and adding them would produce a purchase order for material nobody
   * asked for twice over. Keeping them separate makes the double-count impossible
   * to reach by accident rather than merely discouraged.
   */
  async procurementNeeded(
    caller: AuthenticatedUser,
    companyId?: string,
  ): Promise<ProcurementNeededView> {
    const scope = companyScope(caller, companyId);

    const { lines, balances } = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const [lines, balances] = await Promise.all([
          tx.materialIndentLine.findMany({
            where: {
              ...scope,
              procurementPending: true,
              indent: {
                deleted: false,
                status: {
                  in: [IndentStatus.approved, IndentStatus.partially_fulfilled],
                },
              },
            },
            include: { indent: true },
          }),
          tx.stockBalance.findMany({ where: scope }),
        ]);
        return { lines, balances };
      },
    );

    const itemIds = [
      ...lines.map((line) => line.itemId),
      ...balances.map((balance) => balance.itemId),
    ];
    const [items, siteNames] = await Promise.all([
      this.refs.itemsByIds(caller, itemIds),
      this.refs.siteNames(caller, [
        ...lines.map((line) => line.indent.siteId),
        ...balances.map((balance) => balance.siteId),
      ]),
    ]);

    const indentDemand = lines
      .map((line) => {
        const approved =
          line.approvedQuantity === null ? 0 : toNumber(line.approvedQuantity);
        const outstanding = approved - toNumber(line.fulfilledQuantity);
        const item = items.get(line.itemId);
        return {
          indentId: line.indentId,
          indentNumber: line.indent.indentNumber,
          lineId: line.id,
          itemId: line.itemId,
          itemName: item?.name ?? 'Unknown item',
          itemCode: item?.code ?? '',
          unit: item?.unit ?? '',
          siteId: line.indent.siteId,
          siteName: siteNames.get(line.indent.siteId) ?? 'Unknown store',
          outstandingQuantity: outstanding,
          requiredByDate: line.indent.requiredByDate,
        };
      })
      .filter((row) => row.outstandingQuantity > 0);

    const reorderShortfall = balances
      .map((balance) => {
        const item = items.get(balance.itemId);
        if (!item || item.reorderLevel === null) return null;
        const inStock = inStockOf({
          received: toNumber(balance.received),
          issued: toNumber(balance.issued),
          transferIn: toNumber(balance.transferIn),
          transferOut: toNumber(balance.transferOut),
          avgRate: toNumber(balance.avgRate),
        });
        if (inStock >= item.reorderLevel) return null;
        return {
          itemId: balance.itemId,
          itemName: item.name,
          itemCode: item.code,
          unit: item.unit,
          siteId: balance.siteId,
          siteName: siteNames.get(balance.siteId) ?? 'Unknown store',
          inStock,
          reorderLevel: item.reorderLevel,
          shortfall: item.reorderLevel - inStock,
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);

    return { indentDemand, reorderShortfall };
  }

  /** Soft-delete, matching FR-004's treatment of every other movement (FR-028). */
  async remove(
    caller: AuthenticatedUser,
    id: string,
    ipAddress: string,
  ): Promise<void> {
    const removed = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.materialIndent.findUnique({
          where: { id },
          include: { lines: true },
        });
        if (!existing || existing.deleted) {
          throw new NotFoundException(`Indent ${id} not found`);
        }
        assertInScope(caller, existing, `Indent ${id}`);
        if (
          existing.lines.some((line) => toNumber(line.fulfilledQuantity) > 0)
        ) {
          throw new ConflictException(
            'This indent has been partly fulfilled and cannot be deleted.',
          );
        }
        return tx.materialIndent.update({
          where: { id },
          data: { deleted: true, deletedAt: new Date() },
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.MATERIAL_INDENT,
      action: AuditAction.DELETE,
      entityId: id,
      accountId: caller.id,
      companyId: removed.companyId,
      ipAddress,
    });
  }
}
