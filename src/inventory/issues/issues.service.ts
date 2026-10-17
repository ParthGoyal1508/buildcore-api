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
import { toNumber } from '../stock/stock.types';
import { CodeSeriesService } from '../../settings/code-series/code-series.service';
import { CreateIssueDto, ListIssuesDto, ReturnIssueDto } from './dto/issue.dto';

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
}

/** Issue slips number from their own series, under the store's short infix. */
const ISSUE_SLIP_INFIX = 'MIS';

export interface PaginatedIssues {
  issues: IssueView[];
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

  async create(
    caller: AuthenticatedUser,
    dto: CreateIssueDto,
    ipAddress: string,
    companyId?: string,
  ): Promise<IssueView> {
    const targetCompanyId = this.refs.targetCompanyOf(caller, companyId);

    const [item, siteName, workRefs, siteProjectId, vendorName] =
      await Promise.all([
        this.refs.requireItem(caller, dto.itemId, targetCompanyId),
        this.refs.requireSiteName(caller, dto.siteId, targetCompanyId),
        this.resolveWorkRefs(caller, dto),
        dto.projectId
          ? Promise.resolve(null)
          : this.refs.projectOfSite(caller, dto.siteId),
        dto.vendorId
          ? this.refs.requireVendorName(caller, dto.vendorId)
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

    const date = this.refs.parseDate(dto.date);

    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        // First statement in the transaction, so the lock is held for everything
        // that follows and the window in which another issue could interleave is
        // as small as it can be.
        await this.stock.validateAndLockStock(tx, {
          itemId: dto.itemId,
          siteId: dto.siteId,
          quantity: dto.quantity,
          label: siteName,
        });

        // The issue slip's number (2026-10-15), allocated inside the transaction so a refused
        // issue does not burn one.
        const slipNo = await this.codeSeries.next(
          tx,
          targetCompanyId,
          CodeSeriesType.ISSUE_SLIP,
          ISSUE_SLIP_INFIX,
          async (candidate) =>
            !!(await tx.issue.findFirst({
              where: { companyId: targetCompanyId, slipNo: candidate },
              select: { id: true },
            })),
        );

        const issue = await tx.issue.create({
          data: {
            companyId: targetCompanyId,
            slipNo,
            equipmentNo: dto.equipmentNo?.trim() || null,
            siteId: dto.siteId,
            itemId: dto.itemId,
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
          itemId: dto.itemId,
          siteId: dto.siteId,
          type: StockLedgerType.issue,
          quantity: dto.quantity,
          referenceId: issue.id,
          date,
        });

        await tx.stockBalance.updateMany({
          where: { itemId: dto.itemId, siteId: dto.siteId },
          data: { issued: { increment: dto.quantity } },
        });

        if (dto.indentLineId) {
          await this.indentFulfilment.applyFulfilment(tx, {
            companyId: targetCompanyId,
            indentLineId: dto.indentLineId,
            quantity: dto.quantity,
            itemId: dto.itemId,
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

    const { rows, total } = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const [rows, total] = await Promise.all([
          tx.issue.findMany({
            where,
            orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
            skip: (page - 1) * pageSize,
            take: pageSize,
          }),
          tx.issue.count({ where }),
        ]);
        return { rows, total };
      },
    );

    const [items, siteNames, projectNames, vendorNames] = await Promise.all([
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
    ]);

    return {
      issues: rows.map((row) => {
        const item = items.get(row.itemId);
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
        };
      }),
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
        // cannot both put the same material back.
        await tx.$queryRaw`
          SELECT "id" FROM "inventory"."Issue" WHERE "id" = ${id} FOR UPDATE
        `;
        const existing = await tx.issue.findUnique({ where: { id } });
        if (!existing || existing.deleted) {
          throw new NotFoundException(`Issue ${id} not found`);
        }
        assertInScope(caller, existing, `Issue ${id}`);

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
          where: { id },
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

        return existing;
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.ISSUE,
      action: AuditAction.DELETE,
      entityId: id,
      accountId: caller.id,
      companyId: removed.companyId,
      ipAddress,
    });
  }
}
