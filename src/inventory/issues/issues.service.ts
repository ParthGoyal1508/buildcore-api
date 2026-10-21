import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  CodeSeriesType,
  Prisma,
  StockLedgerType,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { ProjectsService } from '../../projects/portfolio/projects.service';
import { assertInScope, companyScope } from '../../settings/company-scope';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from '../constants/inventory.constants';
import { IndentFulfilmentService } from '../indents/indent-fulfilment.service';
import { InventoryRefsService } from '../inventory-refs.service';
import { StockService } from '../stock/stock.service';
import { inStockOf, toNumber } from '../stock/stock.types';
import { CodeSeriesService } from '../../settings/code-series/code-series.service';
import { randomUUID } from 'crypto';

import { compositeLines } from './composite-lines';
import {
  CompositeChoicesDto,
  CompositePreviewDto,
  CreateIssueDto,
  ListIssuesDto,
  ReturnIssueDto,
} from './dto/issue.dto';

export interface IssueView {
  id: string;
  companyId: string;
  siteId: string;
  siteName: string;
  itemId: string;
  itemName: string;
  itemCode: string;
  unit: string;
  date: Date;
  quantity: number;
  issuedTo: string;
  projectId: string | null;
  projectName: string | null;
  vendorId: string | null;
  vendorName: string | null;
  activityId: string | null;
  activityName: string | null;
  boqItemId: string | null;
  boqItemName: string | null;
  indentLineId: string | null;
  remarks: string | null;
  createdAt: Date;
  /** The issue slip number, `MIS-0001` (2026-10-15); null on an issue recorded before slips. */
  slipNo: string | null;
  equipmentNo: string | null;
  returnedQuantity: number | null;
  returnedOn: Date | null;
  receivedBy: string | null;
  /**
   * 039: set on each sub-item row of a composite issue — the mix, how much of it, and the group
   * every row of that issue shares (one slip, one delete).
   */
  compositeItemId: string | null;
  compositeItemName: string | null;
  compositeQuantity: number | null;
  compositeUnit: string | null;
  issueGroupId: string | null;
}

/** A composite issue as created (039): one slip, a row per sub-item. */
export interface CompositeIssueView {
  issueGroupId: string;
  slipNo: string | null;
  compositeItemId: string;
  compositeItemName: string;
  compositeQuantity: number;
  compositeUnit: string;
  issues: IssueView[];
}

/** One sub-item of a composite issue preview: what it needs from the store, and what is there. */
export interface CompositePreviewLine {
  itemId: string;
  itemName: string;
  itemCode: string;
  unit: string;
  qtyPerUnit: number;
  required: number;
  available: number;
  /** How much more the store would need; 0 when it has enough. */
  short: number;
}

export interface CompositePreview {
  compositeItemId: string;
  compositeItemName: string;
  unit: string;
  quantity: number;
  lines: CompositePreviewLine[];
  /** True when any line is short, or any line rounds to nothing at this quantity. */
  blocked: boolean;
}

/** Issue slips number from their own series, under the store's short infix. */
const ISSUE_SLIP_INFIX = 'MIS';

export interface PaginatedIssues {
  issues: IssueView[];
  /**
   * Across every page of the filter (036 M12). The quantity only when one item is filtered: a sum
   * of bags and kilograms is not a number anybody can use.
   */
  totals: { quantity: number | null };
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Issues: material leaving a store for work.
 *
 * This is the one flow where two requests can genuinely race for the same physical
 * material, so the quantity check is not a read followed by a write — it is a
 * `SELECT ... FOR UPDATE` inside the transaction that does the write
 * (`StockService.validateAndLockStock`, research.md §4). FR-003 makes this the
 * single point of stock enforcement in the whole module, which is also what lets
 * the indent amendment promise that approving an indent can never cause a negative
 * balance: approval does not come through here.
 */
@Injectable()
export class IssuesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly stock: StockService,
    private readonly refs: InventoryRefsService,
    private readonly projects: ProjectsService,
    private readonly indentFulfilment: IndentFulfilmentService,
    private readonly codeSeries: CodeSeriesService,
  ) {}

  /**
   * Validates the optional work references (FR-019).
   *
   * Both are optional by decision: requiring one would make material un-issuable at
   * any project whose BOQ has not been loaded, and 008's BOQ endpoints have not
   * shipped. What is *not* optional is that a supplied id must exist — an
   * unvalidated reference is worse than none, because it looks like traceability.
   */
  private async resolveWorkRefs(
    caller: AuthenticatedUser,
    dto: { activityId?: string; boqItemId?: string },
  ): Promise<{ activityName: string | null; boqItemName: string | null }> {
    const ctx = rlsContextFor(caller);
    const [activity, boqItem] = await Promise.all([
      dto.activityId
        ? this.projects.getActivityById(dto.activityId, ctx)
        : Promise.resolve(null),
      dto.boqItemId
        ? this.projects.getBoqItemById(dto.boqItemId, ctx)
        : Promise.resolve(null),
    ]);

    if (dto.activityId && !activity) {
      throw new BadRequestException(`Activity ${dto.activityId} not found`);
    }
    if (dto.boqItemId && !boqItem) {
      throw new BadRequestException(`BOQ item ${dto.boqItemId} not found`);
    }
    return {
      activityName: activity?.name ?? null,
      boqItemName: boqItem?.name ?? null,
    };
  }

  /**
   * Everything an issue says besides what was issued — the store, the project, the recipient, the
   * work references, the date — validated once for a plain issue and a composite one alike.
   */
  private async resolveHeader(
    caller: AuthenticatedUser,
    dto: CreateIssueDto,
    targetCompanyId: string,
  ) {
    const [siteName, workRefs, siteProjectId, vendorName] = await Promise.all([
      this.refs.requireSiteName(caller, dto.siteId, targetCompanyId),
      this.resolveWorkRefs(caller, dto),
      dto.projectId
        ? Promise.resolve(null)
        : this.refs.projectOfSite(caller, dto.siteId),
      dto.vendorId
        ? this.refs.requireActiveVendor(caller, dto.vendorId, targetCompanyId)
        : Promise.resolve(null),
    ]);

    // The project named, else the store's own (2026-10-15) — a site store belongs to the
    // project it serves, so most issues need no choice at all.
    const projectId = dto.projectId ?? siteProjectId;
    const project = projectId
      ? await this.refs.requireProject(caller, projectId, targetCompanyId)
      : null;

    // A person, or failing that the vendor or subcontractor: an issue always says who took it.
    const issuedTo = dto.issuedTo?.trim() || vendorName;
    if (!issuedTo) {
      throw new BadRequestException(
        'Say who took the material: a person, or a vendor or subcontractor.',
      );
    }

    return {
      siteName,
      workRefs,
      vendorName,
      project,
      issuedTo,
      date: this.refs.parseDate(dto.date),
    };
  }

  /** The issue slip's number, allocated inside the caller's transaction so a refusal burns none. */
  private nextSlipNo(tx: Prisma.TransactionClient, companyId: string) {
    return this.codeSeries.next(
      tx,
      companyId,
      CodeSeriesType.ISSUE_SLIP,
      ISSUE_SLIP_INFIX,
      async (candidate) =>
        !!(await tx.issue.findFirst({
          where: { companyId, slipNo: candidate },
          select: { id: true },
        })),
    );
  }

  /**
   * Issues one item, or — with `compositeItemId` (039) — each sub-item of a composite in
   * proportion under one slip. The composite path returns the group; the plain path the one row.
   */
  async create(
    caller: AuthenticatedUser,
    dto: CreateIssueDto,
    ipAddress: string,
    companyId?: string,
  ): Promise<IssueView | CompositeIssueView> {
    if (dto.itemId && dto.compositeItemId) {
      throw new BadRequestException(
        'Issue either an item or a composite item, not both.',
      );
    }
    if (dto.compositeItemId) {
      return this.createComposite(caller, dto, ipAddress, companyId);
    }
    if (!dto.itemId) {
      throw new BadRequestException('Choose the item to issue.');
    }
    const itemId = dto.itemId;
    const targetCompanyId = this.refs.targetCompanyOf(caller, companyId);

    const [item, header] = await Promise.all([
      this.refs.requireItem(caller, itemId, targetCompanyId),
      this.resolveHeader(caller, dto, targetCompanyId),
    ]);
    const { siteName, workRefs, vendorName, project, issuedTo, date } = header;

    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        // First statement in the transaction, so the lock is held for everything
        // that follows and the window in which another issue could interleave is
        // as small as it can be.
        await this.stock.validateAndLockStock(tx, {
          itemId,
          siteId: dto.siteId,
          quantity: dto.quantity,
          label: siteName,
        });

        // The issue slip's number (2026-10-15).
        const slipNo = await this.nextSlipNo(tx, targetCompanyId);

        const issue = await tx.issue.create({
          data: {
            companyId: targetCompanyId,
            slipNo,
            equipmentNo: dto.equipmentNo?.trim() || null,
            siteId: dto.siteId,
            itemId,
            date,
            quantity: dto.quantity,
            issuedTo,
            projectId: project?.id ?? null,
            vendorId: dto.vendorId ?? null,
            activityId: dto.activityId ?? null,
            boqItemId: dto.boqItemId ?? null,
            indentLineId: dto.indentLineId ?? null,
            remarks: dto.remarks?.trim() || null,
          },
        });

        await this.stock.appendLedgerEntry(tx, {
          companyId: targetCompanyId,
          itemId,
          siteId: dto.siteId,
          type: StockLedgerType.issue,
          quantity: dto.quantity,
          referenceId: issue.id,
          date,
        });

        await tx.stockBalance.updateMany({
          where: { itemId, siteId: dto.siteId },
          data: { issued: { increment: dto.quantity } },
        });

        if (dto.indentLineId) {
          await this.indentFulfilment.applyFulfilment(tx, {
            companyId: targetCompanyId,
            indentLineId: dto.indentLineId,
            quantity: dto.quantity,
            itemId,
            siteId: dto.siteId,
          });
        }

        return issue;
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.ISSUE,
      action: AuditAction.CREATE,
      entityId: created.id,
      changes: {
        after: {
          quantity: dto.quantity,
          issuedTo,
          ...(project ? { project: project.name } : {}),
        },
      },
      accountId: caller.id,
      companyId: targetCompanyId,
      ipAddress,
    });

    return {
      id: created.id,
      companyId: targetCompanyId,
      siteId: dto.siteId,
      siteName,
      itemId: item.id,
      itemName: item.name,
      itemCode: item.code,
      unit: item.unit,
      date,
      quantity: dto.quantity,
      issuedTo: created.issuedTo,
      projectId: created.projectId,
      projectName: project ? `${project.code} · ${project.name}` : null,
      vendorId: created.vendorId,
      vendorName,
      activityId: created.activityId,
      activityName: workRefs.activityName,
      boqItemId: created.boqItemId,
      boqItemName: workRefs.boqItemName,
      indentLineId: created.indentLineId,
      remarks: created.remarks,
      createdAt: created.createdAt,
      slipNo: created.slipNo,
      equipmentNo: created.equipmentNo,
      returnedQuantity: null,
      returnedOn: null,
      receivedBy: null,
      compositeItemId: null,
      compositeItemName: null,
      compositeQuantity: null,
      compositeUnit: null,
      issueGroupId: null,
    };
  }

  /**
   * A composite issue (039): `quantity` units of the mix, issued as each sub-item in proportion.
   *
   * One transaction, in three steps. Every sub-item's balance is locked — in item-id order, so
   * two composite issues sharing materials always queue rather than deadlock — and checked; any
   * shortfall refuses the whole issue with a 422 listing *every* short line, so the storekeeper
   * sees all of it at once rather than one material per attempt. Only then is anything written:
   * one slip number, and per sub-item an `Issue` row, its ledger entry and the balance, exactly as
   * a plain issue writes them. The rows share `issueGroupId`, which is what makes the group one
   * slip on paper and one delete.
   *
   * Indent lines name a single item, so a composite cannot fulfil one.
   */
  private async createComposite(
    caller: AuthenticatedUser,
    dto: CreateIssueDto,
    ipAddress: string,
    companyId?: string,
  ): Promise<CompositeIssueView> {
    if (dto.indentLineId) {
      throw new BadRequestException(
        'An indent line names a single item; issue it as that item, not as a composite.',
      );
    }
    const targetCompanyId = this.refs.targetCompanyOf(caller, companyId);
    const [composite, header] = await Promise.all([
      this.refs.requireActiveCompositeItem(
        caller,
        dto.compositeItemId as string,
        targetCompanyId,
      ),
      this.resolveHeader(caller, dto, targetCompanyId),
    ]);
    const { siteName, workRefs, vendorName, project, issuedTo, date } = header;

    const lines = compositeLines(composite, dto.quantity);
    const nothing = lines.filter((line) => line.quantity.isZero());
    if (nothing.length > 0) {
      throw new BadRequestException(
        `${dto.quantity} ${composite.unit} of ${
          composite.name
        } needs less than 0.001 of ${nothing
          .map((line) => line.itemName)
          .join(', ')}. Issue a larger quantity.`,
      );
    }

    const issueGroupId = randomUUID();
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const short: {
          itemId: string;
          itemName: string;
          unit: string;
          required: number;
          available: number;
        }[] = [];
        for (const line of lines) {
          const available = await this.stock.lockAvailable(tx, {
            itemId: line.itemId,
            siteId: dto.siteId,
          });
          // Compared at the column's three decimals, so float noise in the summed totals cannot
          // refuse an issue that takes exactly what is there.
          if (
            line.quantity.greaterThan(
              new Prisma.Decimal(available).toDecimalPlaces(3),
            )
          ) {
            short.push({
              itemId: line.itemId,
              itemName: line.itemName,
              unit: line.unit,
              required: line.quantity.toNumber(),
              available: Math.round(available * 1000) / 1000,
            });
          }
        }
        if (short.length > 0) {
          throw new UnprocessableEntityException({
            message: `Insufficient stock at ${siteName} for ${dto.quantity} ${
              composite.unit
            } of ${composite.name}: ${short
              .map(
                (s) =>
                  `${s.itemName} needs ${s.required} ${s.unit}, ${s.available} available`,
              )
              .join('; ')}.`,
            shortfalls: short,
          });
        }

        const slipNo = await this.nextSlipNo(tx, targetCompanyId);
        const created = [];
        for (const line of lines) {
          const issue = await tx.issue.create({
            data: {
              companyId: targetCompanyId,
              slipNo,
              equipmentNo: dto.equipmentNo?.trim() || null,
              siteId: dto.siteId,
              itemId: line.itemId,
              date,
              quantity: line.quantity,
              issuedTo,
              projectId: project?.id ?? null,
              vendorId: dto.vendorId ?? null,
              activityId: dto.activityId ?? null,
              boqItemId: dto.boqItemId ?? null,
              remarks: dto.remarks?.trim() || null,
              compositeItemId: composite.id,
              compositeQuantity: dto.quantity,
              issueGroupId,
            },
          });
          await this.stock.appendLedgerEntry(tx, {
            companyId: targetCompanyId,
            itemId: line.itemId,
            siteId: dto.siteId,
            type: StockLedgerType.issue,
            quantity: line.quantity.toNumber(),
            referenceId: issue.id,
            date,
          });
          await tx.stockBalance.updateMany({
            where: { itemId: line.itemId, siteId: dto.siteId },
            data: { issued: { increment: line.quantity } },
          });
          created.push({ issue, line });
        }
        return created;
      },
    );

    for (const { issue, line } of rows) {
      await this.auditLog.record({
        entityType: AuditEntityType.ISSUE,
        action: AuditAction.CREATE,
        entityId: issue.id,
        changes: {
          after: {
            quantity: line.quantity.toNumber(),
            composite: `${composite.name} · ${dto.quantity} ${composite.unit}`,
            issueGroupId,
            issuedTo,
            ...(project ? { project: project.name } : {}),
          },
        },
        accountId: caller.id,
        companyId: targetCompanyId,
        ipAddress,
      });
    }

    return {
      issueGroupId,
      slipNo: rows[0]?.issue.slipNo ?? null,
      compositeItemId: composite.id,
      compositeItemName: composite.name,
      compositeQuantity: dto.quantity,
      compositeUnit: composite.unit,
      issues: rows.map(({ issue, line }) => ({
        id: issue.id,
        companyId: targetCompanyId,
        siteId: dto.siteId,
        siteName,
        itemId: line.itemId,
        itemName: line.itemName,
        itemCode: line.itemCode,
        unit: line.unit,
        date,
        quantity: line.quantity.toNumber(),
        issuedTo: issue.issuedTo,
        projectId: issue.projectId,
        projectName: project ? `${project.code} · ${project.name}` : null,
        vendorId: issue.vendorId,
        vendorName,
        activityId: issue.activityId,
        activityName: workRefs.activityName,
        boqItemId: issue.boqItemId,
        boqItemName: workRefs.boqItemName,
        indentLineId: null,
        remarks: issue.remarks,
        createdAt: issue.createdAt,
        slipNo: issue.slipNo,
        equipmentNo: issue.equipmentNo,
        returnedQuantity: null,
        returnedOn: null,
        receivedBy: null,
        compositeItemId: composite.id,
        compositeItemName: composite.name,
        compositeQuantity: dto.quantity,
        compositeUnit: composite.unit,
        issueGroupId,
      })),
    };
  }

  /** Active composites for the issue form's picker (039), each with its recipe. */
  async compositeChoices(
    caller: AuthenticatedUser,
    query: CompositeChoicesDto,
  ) {
    return this.refs.searchCompositeItems(caller, query);
  }

  /**
   * What a composite issue would take from the store (039), line by line, before it is made: the
   * same rounding the issue uses, against the store's stock now. Advisory, like the plain stock
   * hint — the issue's own locked check is what decides.
   */
  async compositePreview(
    caller: AuthenticatedUser,
    query: CompositePreviewDto,
  ): Promise<CompositePreview> {
    const companyId = this.refs.targetCompanyOf(caller, query.companyId);
    const composite = await this.refs.requireActiveCompositeItem(
      caller,
      query.compositeItemId,
      companyId,
    );
    const lines = compositeLines(composite, query.quantity);
    const balances = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.stockBalance.findMany({
          where: {
            siteId: query.siteId,
            itemId: { in: lines.map((line) => line.itemId) },
          },
        }),
    );
    const byItem = new Map(balances.map((b) => [b.itemId, b]));
    // Shown in the recipe's own order, not the lock order.
    const position = new Map(
      composite.components.map((c) => [c.itemId, c.position]),
    );
    const ordered = [...lines].sort(
      (a, b) => (position.get(a.itemId) ?? 0) - (position.get(b.itemId) ?? 0),
    );
    const previewLines = ordered.map((line) => {
      const balance = byItem.get(line.itemId);
      const available = balance
        ? Math.round(
            inStockOf({
              received: toNumber(balance.received),
              issued: toNumber(balance.issued),
              transferIn: toNumber(balance.transferIn),
              transferOut: toNumber(balance.transferOut),
              avgRate: toNumber(balance.avgRate),
            }) * 1000,
          ) / 1000
        : 0;
      const required = line.quantity.toNumber();
      return {
        itemId: line.itemId,
        itemName: line.itemName,
        itemCode: line.itemCode,
        unit: line.unit,
        qtyPerUnit: line.qtyPerUnit,
        required,
        available,
        short:
          required > available
            ? Math.round((required - available) * 1000) / 1000
            : 0,
      };
    });
    return {
      compositeItemId: composite.id,
      compositeItemName: composite.name,
      unit: composite.unit,
      quantity: query.quantity,
      lines: previewLines,
      blocked: previewLines.some((l) => l.short > 0 || l.required === 0),
    };
  }

  async findAll(
    caller: AuthenticatedUser,
    query: ListIssuesDto,
  ): Promise<PaginatedIssues> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(
      query.pageSize ?? DEFAULT_PAGE_SIZE,
      MAX_PAGE_SIZE,
    );

    const where: Prisma.IssueWhereInput = {
      ...companyScope(caller, query.companyId),
      deleted: false,
      ...(query.siteId ? { siteId: query.siteId } : {}),
      ...(query.itemId ? { itemId: query.itemId } : {}),
      ...(query.issueGroupId ? { issueGroupId: query.issueGroupId } : {}),
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.vendorId ? { vendorId: query.vendorId } : {}),
      ...(query.slipNo
        ? { slipNo: { contains: query.slipNo.trim(), mode: 'insensitive' } }
        : {}),
      ...(query.dateFrom || query.dateTo
        ? {
            date: {
              ...(query.dateFrom
                ? { gte: this.refs.parseDate(query.dateFrom) }
                : {}),
              ...(query.dateTo
                ? { lte: this.refs.parseDate(query.dateTo) }
                : {}),
            },
          }
        : {}),
    };

    const { rows, total, sum } = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const [rows, total, sum] = await Promise.all([
          tx.issue.findMany({
            where,
            orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
            skip: (page - 1) * pageSize,
            take: pageSize,
          }),
          tx.issue.count({ where }),
          query.itemId
            ? tx.issue.aggregate({ where, _sum: { quantity: true } })
            : Promise.resolve(null),
        ]);
        return { rows, total, sum };
      },
    );

    const [items, siteNames, projectNames, vendorNames, composites] =
      await Promise.all([
        this.refs.itemsByIds(
          caller,
          rows.map((row) => row.itemId),
        ),
        this.refs.siteNames(
          caller,
          rows.map((row) => row.siteId),
        ),
        this.refs.projectNames(
          caller,
          rows.flatMap((row) => (row.projectId ? [row.projectId] : [])),
        ),
        this.refs.vendorNames(
          caller,
          rows.flatMap((row) => (row.vendorId ? [row.vendorId] : [])),
        ),
        this.refs.compositeNames(
          caller,
          rows.flatMap((row) =>
            row.compositeItemId ? [row.compositeItemId] : [],
          ),
        ),
      ]);

    return {
      issues: rows.map((row) => {
        const item = items.get(row.itemId);
        const composite = row.compositeItemId
          ? composites.get(row.compositeItemId)
          : undefined;
        return {
          id: row.id,
          companyId: row.companyId,
          siteId: row.siteId,
          siteName: siteNames.get(row.siteId) ?? 'Unknown store',
          itemId: row.itemId,
          itemName: item?.name ?? 'Unknown item',
          itemCode: item?.code ?? '',
          unit: item?.unit ?? '',
          date: row.date,
          quantity: toNumber(row.quantity),
          issuedTo: row.issuedTo,
          projectId: row.projectId,
          projectName: row.projectId
            ? projectNames.get(row.projectId) ?? 'Unknown project'
            : null,
          vendorId: row.vendorId,
          vendorName: row.vendorId
            ? vendorNames.get(row.vendorId) ?? 'Unknown vendor'
            : null,
          activityId: row.activityId,
          // Names are resolved on the detail path only. Resolving them per row
          // would be one cross-module call per issue, and the list shows the
          // material and the recipient, not the BOQ line.
          activityName: null,
          boqItemId: row.boqItemId,
          boqItemName: null,
          indentLineId: row.indentLineId,
          remarks: row.remarks,
          createdAt: row.createdAt,
          slipNo: row.slipNo,
          equipmentNo: row.equipmentNo,
          returnedQuantity:
            row.returnedQuantity === null
              ? null
              : toNumber(row.returnedQuantity),
          returnedOn: row.returnedOn,
          receivedBy: row.receivedBy,
          compositeItemId: row.compositeItemId,
          compositeItemName: row.compositeItemId
            ? composite?.name ?? 'Unknown composite'
            : null,
          compositeQuantity:
            row.compositeQuantity === null
              ? null
              : toNumber(row.compositeQuantity),
          compositeUnit: composite?.unit ?? null,
          issueGroupId: row.issueGroupId,
        };
      }),
      totals: { quantity: sum ? toNumber(sum._sum.quantity) : null },
      total,
      page,
      pageSize,
    };
  }

  /**
   * Records material coming back to the store against an issue (2026-10-15) — the daily issue
   * register's return columns. The stock goes back exactly as reversing that much of the issue
   * would: an `issue_reversal` ledger row and the store's issued total reduced. The total
   * returned only ever grows, and never past what was issued.
   *
   * A composite issue (039) is returned line by line: each sub-item row is a real issue of a real
   * material, and what comes back from a pour is rarely the mix in proportion — leftover cement
   * bags, not "2 CUM of concrete". The row's composite tag stays as it was.
   */
  async returnMaterial(
    caller: AuthenticatedUser,
    id: string,
    dto: ReturnIssueDto,
    ipAddress: string,
  ): Promise<void> {
    if (dto.returnedNow === undefined && dto.returnedQuantity === undefined) {
      throw new BadRequestException(
        'Give the quantity coming back now (returnedNow).',
      );
    }
    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        // 036 M4: the issue row is locked before its returned total is read. Two simultaneous
        // returns used to read the same total, each compute a delta from it, and both credit the
        // store — stock that never came back. The second now waits and reads the first's total.
        await tx.$queryRaw`
          SELECT "id" FROM "inventory"."Issue" WHERE "id" = ${id} FOR UPDATE
        `;
        const existing = await tx.issue.findUnique({ where: { id } });
        if (!existing || existing.deleted) {
          throw new NotFoundException(`Issue ${id} not found`);
        }
        assertInScope(caller, existing, `Issue ${id}`);
        const issued = toNumber(existing.quantity);
        const before =
          existing.returnedQuantity === null
            ? 0
            : toNumber(existing.returnedQuantity);
        const thousandths = (value: number) => Math.round(value * 1000) / 1000;
        const total =
          dto.returnedNow !== undefined
            ? thousandths(before + dto.returnedNow)
            : (dto.returnedQuantity as number);
        if (
          dto.returnedNow !== undefined &&
          dto.returnedQuantity !== undefined &&
          thousandths(dto.returnedQuantity) !== total
        ) {
          throw new BadRequestException(
            `${before} has already been returned, so returning ${dto.returnedNow} now makes ${total}, not ${dto.returnedQuantity}. Send just returnedNow.`,
          );
        }
        if (total > issued) {
          throw new BadRequestException(
            `Only ${issued} was issued and ${before} has already come back; at most ${thousandths(
              issued - before,
            )} more can be returned.`,
          );
        }
        if (total < before) {
          throw new BadRequestException(
            `${before} has already been returned. Enter the total returned so far.`,
          );
        }
        const delta = thousandths(total - before);
        const returnedOn = this.refs.parseDate(dto.returnedOn);
        if (delta > 0) {
          await this.stock.appendLedgerEntry(tx, {
            companyId: existing.companyId,
            itemId: existing.itemId,
            siteId: existing.siteId,
            type: StockLedgerType.issue_reversal,
            quantity: delta,
            referenceId: existing.id,
            date: returnedOn,
          });
          await tx.stockBalance.updateMany({
            where: { itemId: existing.itemId, siteId: existing.siteId },
            data: { issued: { decrement: delta } },
          });
          // 036 M2: material that came back was not consumed against the indent, so the line is
          // owed it again. Without this, deleting the issue later reversed only the part still
          // out and the line stayed overstated by everything that had been returned.
          if (existing.indentLineId) {
            await this.indentFulfilment.reverseFulfilment(tx, {
              indentLineId: existing.indentLineId,
              quantity: delta,
            });
          }
        }
        return tx.issue.update({
          where: { id },
          data: {
            returnedQuantity: total,
            returnedOn,
            receivedBy: dto.receivedBy.trim(),
          },
        });
      },
    );
    await this.auditLog.record({
      entityType: AuditEntityType.ISSUE,
      action: AuditAction.UPDATE,
      entityId: id,
      changes: {
        after: {
          returnedQuantity: toNumber(updated.returnedQuantity),
          receivedBy: dto.receivedBy,
        },
      },
      accountId: caller.id,
      companyId: updated.companyId,
      ipAddress,
    });
  }

  /**
   * Soft-deletes an issue and puts the material back (FR-004).
   *
   * The negative-`issued` guard is not defensive noise: `issued` is a running total
   * that only ever increases, and a reversal that took it below zero would mean the
   * ledger and the balance had already diverged. Refusing with a 422 leaves the
   * evidence in place instead of writing a balance nobody can explain.
   *
   * A row of a composite issue (039) takes its whole group with it: the slip was one issue of the
   * mix, and deleting one sub-item would leave a slip claiming 10 CUM of concrete went out
   * without its cement. Every row is reversed in the one transaction, or none is.
   */
  async remove(
    caller: AuthenticatedUser,
    id: string,
    ipAddress: string,
  ): Promise<void> {
    const removed = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        // The same row lock a return takes (036 M4), so a delete and a return racing on one issue
        // cannot both put the same material back. A composite's rows are locked together, in id
        // order, so two deletes started from different rows of one group queue rather than
        // deadlock — which is why the group is looked up before anything is locked.
        const head = await tx.issue.findUnique({
          where: { id },
          select: { issueGroupId: true },
        });
        if (head?.issueGroupId) {
          await tx.$queryRaw`
            SELECT "id" FROM "inventory"."Issue"
            WHERE "issueGroupId" = ${head.issueGroupId}
            ORDER BY "id"
            FOR UPDATE
          `;
        } else {
          await tx.$queryRaw`
            SELECT "id" FROM "inventory"."Issue" WHERE "id" = ${id} FOR UPDATE
          `;
        }
        const existing = await tx.issue.findUnique({ where: { id } });
        if (!existing || existing.deleted) {
          throw new NotFoundException(`Issue ${id} not found`);
        }
        assertInScope(caller, existing, `Issue ${id}`);

        const rows = existing.issueGroupId
          ? await tx.issue.findMany({
              where: { issueGroupId: existing.issueGroupId, deleted: false },
              orderBy: { itemId: 'asc' },
            })
          : [existing];
        for (const row of rows) {
          await this.reverseIssue(tx, row);
        }
        return rows;
      },
    );

    for (const row of removed) {
      await this.auditLog.record({
        entityType: AuditEntityType.ISSUE,
        action: AuditAction.DELETE,
        entityId: row.id,
        ...(row.issueGroupId
          ? { changes: { before: { issueGroupId: row.issueGroupId } } }
          : {}),
        accountId: caller.id,
        companyId: row.companyId,
        ipAddress,
      });
    }
  }

  /** Soft-deletes one locked issue row and puts what is still out back in the store. */
  private async reverseIssue(
    tx: Prisma.TransactionClient,
    existing: {
      id: string;
      companyId: string;
      itemId: string;
      siteId: string;
      date: Date;
      quantity: Prisma.Decimal;
      returnedQuantity: Prisma.Decimal | null;
      indentLineId: string | null;
    },
  ): Promise<void> {
    const balance = await tx.stockBalance.findUnique({
      where: {
        itemId_siteId: {
          itemId: existing.itemId,
          siteId: existing.siteId,
        },
      },
    });
    // What came back has already been put back (2026-10-15); only the rest is still out.
    const quantity =
      toNumber(existing.quantity) -
      (existing.returnedQuantity === null
        ? 0
        : toNumber(existing.returnedQuantity));
    if (!balance || toNumber(balance.issued) - quantity < 0) {
      throw new UnprocessableEntityException(
        'Reversing this issue would take the issued total below zero. The ledger and the balance disagree; this needs investigation rather than a delete.',
      );
    }

    await tx.issue.update({
      where: { id: existing.id },
      data: { deleted: true, deletedAt: new Date() },
    });

    await this.stock.appendLedgerEntry(tx, {
      companyId: existing.companyId,
      itemId: existing.itemId,
      siteId: existing.siteId,
      type: StockLedgerType.issue_reversal,
      quantity,
      referenceId: existing.id,
      date: existing.date,
    });

    await tx.stockBalance.update({
      where: { id: balance.id },
      data: { issued: { decrement: quantity } },
    });

    if (existing.indentLineId) {
      await this.indentFulfilment.reverseFulfilment(tx, {
        indentLineId: existing.indentLineId,
        quantity,
      });
    }
  }
}
