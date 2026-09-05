import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AssetAllocationStatus,
  AssetStatus,
  AssetTrackingMode,
  AuditAction,
  AuditEntityType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { assertInScope, companyScope } from '../../settings/company-scope';
import { assertTransition, AVAILABLE_STATUSES } from '../asset-status';
import { AssetsRefsService } from '../assets-refs.service';
import { todayUtc } from '../dates';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from '../constants/assets.constants';
import { AssetStockService } from '../stock/asset-stock.service';
import {
  CreateAllocationDto,
  ListAllocationsDto,
  ReturnAllocationDto,
} from './dto/allocation.dto';

export interface AllocationRow {
  id: string;
  companyId: string;
  assetId: string;
  assetCode: string;
  assetName: string;
  projectId: string;
  siteId: string;
  siteName: string;
  custodianEmployeeId: string | null;
  custodianName: string | null;
  quantity: number;
  allocatedFrom: Date;
  expectedReturnDate: Date;
  actualReturnDate: Date | null;
  conditionOnReturnId: string | null;
  conditionOnReturnName: string | null;
  remarks: string | null;
  status: AssetAllocationStatus;
  /** Open, and past its expected return date (spec FR-016). Computed, never
   * stored — a stored flag is wrong the day after it is written. */
  overdue: boolean;
  daysOverdue: number;
  createdAt: Date;
}

/** One person's outstanding custody, for the custody register (spec FR-011). */
export interface OutstandingCustody {
  custodianEmployeeId: string;
  custodianName: string;
  allocations: AllocationRow[];
  overdueCount: number;
}

type AllocationWithAsset = Prisma.AssetAllocationGetPayload<{
  include: { asset: { select: { assetCode: true; name: true } } };
}>;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Allocation and return (spec US3).
 *
 * The two rules that shape everything here:
 *
 * 1. A serialised asset can hold at most one open allocation. Enforced inside the
 *    same transaction that creates the allocation, not by a check before it — the
 *    guard is worth nothing if two requests can both pass it before either writes.
 *
 * 2. A return's condition grade decides the asset's next status (FR-015): a scrap
 *    grade condemns it, a damaged grade sends it for repair, anything else returns
 *    it to `idle`. That mapping lives in one place, `statusOnReturn` below, because
 *    a second copy of it in the transfer receipt is exactly how the two would drift.
 */
@Injectable()
export class AllocationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly refs: AssetsRefsService,
    private readonly stock: AssetStockService,
    private readonly auditLog: AuditLogService,
  ) {}

  // ── Reads ─────────────────────────────────────────────────────────────────

  private async decorate(
    caller: AuthenticatedUser,
    rows: AllocationWithAsset[],
  ): Promise<AllocationRow[]> {
    if (rows.length === 0) return [];
    const today = todayUtc();

    const [siteNames, custodianNames, grades] = await Promise.all([
      this.refs.siteNames(
        caller,
        rows.map((row) => row.siteId),
      ),
      this.refs.employeeNames(
        caller,
        rows.flatMap((row) =>
          row.custodianEmployeeId ? [row.custodianEmployeeId] : [],
        ),
      ),
      this.refs.gradesByIds(
        caller,
        rows.flatMap((row) =>
          row.conditionOnReturnId ? [row.conditionOnReturnId] : [],
        ),
      ),
    ]);

    return rows.map((row) => {
      const overdue =
        row.status === AssetAllocationStatus.open &&
        row.expectedReturnDate < today;
      return {
        id: row.id,
        companyId: row.companyId,
        assetId: row.assetId,
        assetCode: row.asset.assetCode,
        assetName: row.asset.name,
        projectId: row.projectId,
        siteId: row.siteId,
        siteName: siteNames.get(row.siteId) ?? 'Unknown site',
        custodianEmployeeId: row.custodianEmployeeId,
        custodianName: row.custodianEmployeeId
          ? custodianNames.get(row.custodianEmployeeId) ?? 'Unknown employee'
          : null,
        quantity: Number(row.quantity),
        allocatedFrom: row.allocatedFrom,
        expectedReturnDate: row.expectedReturnDate,
        actualReturnDate: row.actualReturnDate,
        conditionOnReturnId: row.conditionOnReturnId,
        conditionOnReturnName: row.conditionOnReturnId
          ? grades.get(row.conditionOnReturnId)?.name ?? 'Unknown grade'
          : null,
        remarks: row.remarks,
        status: row.status,
        overdue,
        daysOverdue: overdue
          ? Math.floor(
              (today.getTime() - row.expectedReturnDate.getTime()) / MS_PER_DAY,
            )
          : 0,
        createdAt: row.createdAt,
      };
    });
  }

  async findAll(
    caller: AuthenticatedUser,
    query: ListAllocationsDto,
  ): Promise<{
    items: AllocationRow[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(
      query.pageSize ?? DEFAULT_PAGE_SIZE,
      MAX_PAGE_SIZE,
    );

    const where: Prisma.AssetAllocationWhereInput = {
      ...companyScope(caller, query.companyId),
      deletedAt: null,
      ...(query.assetId ? { assetId: query.assetId } : {}),
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.siteId ? { siteId: query.siteId } : {}),
      ...(query.custodianEmployeeId
        ? { custodianEmployeeId: query.custodianEmployeeId }
        : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.overdue
        ? {
            status: AssetAllocationStatus.open,
            expectedReturnDate: { lt: todayUtc() },
          }
        : {}),
    };

    const { rows, total } = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const [rows, total] = await Promise.all([
          tx.assetAllocation.findMany({
            where,
            orderBy: [{ status: 'asc' }, { expectedReturnDate: 'asc' }],
            skip: (page - 1) * pageSize,
            take: pageSize,
            include: { asset: { select: { assetCode: true, name: true } } },
          }),
          tx.assetAllocation.count({ where }),
        ]);
        return { rows, total };
      },
    );

    return {
      items: await this.decorate(caller, rows),
      total,
      page,
      pageSize,
    };
  }

  /**
   * Everything still out, grouped by custodian (spec FR-011).
   *
   * Grouped here rather than left to the client because the question the custody
   * register answers is "what is this person holding?", and a flat list sorted by
   * custodian makes every consumer re-derive the same grouping.
   */
  async getOutstandingCustody(
    caller: AuthenticatedUser,
    companyId?: string,
  ): Promise<OutstandingCustody[]> {
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.assetAllocation.findMany({
          where: {
            ...companyScope(caller, companyId),
            deletedAt: null,
            status: AssetAllocationStatus.open,
            custodianEmployeeId: { not: null },
          },
          orderBy: { expectedReturnDate: 'asc' },
          include: { asset: { select: { assetCode: true, name: true } } },
        }),
    );

    const decorated = await this.decorate(caller, rows);
    const grouped = new Map<string, OutstandingCustody>();
    for (const allocation of decorated) {
      const custodianId = allocation.custodianEmployeeId;
      if (!custodianId) continue;
      const entry = grouped.get(custodianId) ?? {
        custodianEmployeeId: custodianId,
        custodianName: allocation.custodianName ?? 'Unknown employee',
        allocations: [],
        overdueCount: 0,
      };
      entry.allocations.push(allocation);
      if (allocation.overdue) entry.overdueCount += 1;
      grouped.set(custodianId, entry);
    }
    return [...grouped.values()].sort((a, b) =>
      a.custodianName.localeCompare(b.custodianName),
    );
  }

  // ── Writes ────────────────────────────────────────────────────────────────

  async create(
    caller: AuthenticatedUser,
    dto: CreateAllocationDto,
    ipAddress: string,
    requestedCompanyId?: string,
  ): Promise<AllocationRow> {
    const companyId = this.refs.targetCompanyOf(caller, requestedCompanyId);

    const asset = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) => tx.asset.findUnique({ where: { id: dto.assetId } }),
    );
    if (!asset || asset.deletedAt)
      throw new NotFoundException('Asset not found');
    assertInScope(caller, asset, 'Asset');

    // The site must belong to the project, or the allocation would report a cost
    // against a project the asset never went to.
    await this.refs.requireSite(caller, dto.siteId, companyId, dto.projectId);

    const category = await this.refs.requireCategory(
      caller,
      asset.categoryId,
      companyId,
    );

    if (category.custodyRequired && !dto.custodianEmployeeId) {
      throw new BadRequestException(
        `${category.name} requires a custodian: somebody has to be accountable ` +
          'for this asset while it is out.',
      );
    }
    if (dto.custodianEmployeeId) {
      const custodian = await this.refs.requireCustodian(
        caller,
        dto.custodianEmployeeId,
        companyId,
      );
      // FR-010: a custodian posted somewhere else cannot hold an asset here — the
      // register would say one thing and the site another.
      if (custodian.siteId !== dto.siteId) {
        throw new BadRequestException(
          `${custodian.name} is posted at a different site and cannot take ` +
            'custody of an asset allocated here.',
        );
      }
    }

    const serialised = asset.trackingMode === AssetTrackingMode.serialised;
    if (serialised && dto.siteId !== asset.currentSiteId) {
      // A serialised asset is one physical unit and it is somewhere. Allocating it
      // to a site it is not at would make the register claim it moved without any
      // record of the move — that is what a transfer is for (US5).
      throw new BadRequestException(
        `${asset.assetCode} is at a different site. Transfer it there first, so ` +
          'the move is recorded.',
      );
    }
    const quantity = dto.quantity ?? 1;
    if (serialised && quantity !== 1) {
      throw new BadRequestException(
        `${asset.assetCode} is serialised: an allocation is the whole unit, so ` +
          'quantity must be 1.',
      );
    }

    const allocatedFrom = this.refs.parseDate(dto.allocatedFrom);
    const expectedReturnDate = this.refs.parseDate(dto.expectedReturnDate);
    if (expectedReturnDate < allocatedFrom) {
      throw new BadRequestException(
        'expectedReturnDate cannot precede allocatedFrom.',
      );
    }

    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        if (serialised) {
          // Checked inside the transaction, not before it: two requests that both
          // pass a pre-flight check and then both write is exactly the race this
          // guard exists to stop. The row lock below is what serialises them.
          await tx.$queryRaw`
            SELECT "id" FROM "assets"."Asset" WHERE "id" = ${asset.id} FOR UPDATE
          `;
          const open = await tx.assetAllocation.count({
            where: {
              assetId: asset.id,
              status: AssetAllocationStatus.open,
              deletedAt: null,
            },
          });
          if (open > 0) {
            throw new ConflictException(
              `${asset.assetCode} is already allocated. Return it before ` +
                'allocating it again.',
            );
          }
          if (!AVAILABLE_STATUSES.includes(asset.status)) {
            throw new ConflictException(
              `${asset.assetCode} is ${asset.status} and cannot be allocated.`,
            );
          }
          assertTransition(
            asset.status,
            AssetStatus.allocated,
            asset.assetCode,
          );
        } else {
          // Bulk: the units come out of the source site's on-hand balance, under the
          // same `FOR UPDATE` lock 009's inventory uses.
          await this.stock.lockForUpdate(tx, {
            assetId: asset.id,
            siteId: dto.siteId,
            quantity,
            label: 'the allocation site',
          });
        }

        const allocation = await tx.assetAllocation.create({
          data: {
            companyId,
            assetId: asset.id,
            projectId: dto.projectId,
            siteId: dto.siteId,
            custodianEmployeeId: dto.custodianEmployeeId ?? null,
            quantity,
            allocatedFrom,
            expectedReturnDate,
            remarks: dto.remarks ?? null,
            createdBy: caller.id,
          },
          include: { asset: { select: { assetCode: true, name: true } } },
        });

        await this.stock.applyDelta(tx, {
          companyId,
          assetId: asset.id,
          siteId: dto.siteId,
          onHand: -quantity,
          allocated: quantity,
        });

        if (serialised) {
          await tx.asset.update({
            where: { id: asset.id },
            data: {
              status: AssetStatus.allocated,
              currentSiteId: dto.siteId,
              currentCustodianId: dto.custodianEmployeeId ?? null,
            },
          });
        }

        return allocation;
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.ASSET_ALLOCATION,
      action: AuditAction.CREATE,
      entityId: created.id,
      accountId: caller.id,
      companyId,
      ipAddress,
      changes: {
        assetCode: created.asset.assetCode,
        projectId: dto.projectId,
        siteId: dto.siteId,
        quantity,
        custodianEmployeeId: dto.custodianEmployeeId ?? null,
      },
    });

    const [row] = await this.decorate(caller, [created]);
    return row;
  }

  /**
   * The status an asset lands in when it comes back at a given grade (spec FR-015).
   *
   * One function, used by the return here and — when US5 lands — by the transfer
   * receipt, because two copies of this mapping is how the two flows would come to
   * disagree about what "damaged" means.
   */
  static statusOnReturn(grade: {
    isDamaged: boolean;
    isScrap: boolean;
  }): AssetStatus {
    if (grade.isScrap) return AssetStatus.scrapped;
    if (grade.isDamaged) return AssetStatus.under_repair;
    return AssetStatus.idle;
  }

  async returnAllocation(
    caller: AuthenticatedUser,
    allocationId: string,
    dto: ReturnAllocationDto,
    ipAddress: string,
  ): Promise<AllocationRow> {
    const existing = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.assetAllocation.findUnique({
          where: { id: allocationId },
          include: { asset: true },
        }),
    );
    if (!existing || existing.deletedAt) {
      throw new NotFoundException('Allocation not found');
    }
    assertInScope(caller, existing, 'Allocation');
    if (existing.status !== AssetAllocationStatus.open) {
      throw new ConflictException('This allocation has already been returned.');
    }

    const grade = await this.refs.requireGrade(
      caller,
      dto.conditionOnReturnId,
      existing.companyId,
    );
    const actualReturnDate = this.refs.parseDate(dto.actualReturnDate);
    if (actualReturnDate < existing.allocatedFrom) {
      throw new BadRequestException(
        'actualReturnDate cannot precede the allocation start.',
      );
    }

    const nextStatus = AllocationService.statusOnReturn(grade);
    const serialised =
      existing.asset.trackingMode === AssetTrackingMode.serialised;
    if (serialised) {
      assertTransition(
        existing.asset.status,
        nextStatus,
        existing.asset.assetCode,
      );
    }

    const quantity = Number(existing.quantity);

    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const allocation = await tx.assetAllocation.update({
          where: { id: allocationId },
          data: {
            actualReturnDate,
            conditionOnReturnId: dto.conditionOnReturnId,
            remarks: dto.remarks ?? existing.remarks,
            status: AssetAllocationStatus.closed,
          },
          include: { asset: { select: { assetCode: true, name: true } } },
        });

        // The units come back off the allocated column. A scrapped return does not
        // return them to on-hand: the asset left the pool, and crediting it back
        // would show stock that no longer exists.
        await this.stock.applyDelta(tx, {
          companyId: existing.companyId,
          assetId: existing.assetId,
          siteId: existing.siteId,
          allocated: -quantity,
          ...(nextStatus === AssetStatus.scrapped ? {} : { onHand: quantity }),
        });

        await tx.asset.update({
          where: { id: existing.assetId },
          data: {
            currentConditionGradeId: dto.conditionOnReturnId,
            ...(serialised
              ? {
                  status: nextStatus,
                  currentCustodianId: null,
                  ...(nextStatus === AssetStatus.scrapped
                    ? { disposalDate: actualReturnDate }
                    : {}),
                }
              : {}),
          },
        });

        return allocation;
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.ASSET_ALLOCATION,
      action: AuditAction.UPDATE,
      entityId: allocationId,
      accountId: caller.id,
      companyId: existing.companyId,
      ipAddress,
      changes: {
        returned: dto.actualReturnDate,
        conditionGrade: grade.name,
        assetStatus: nextStatus,
      },
    });

    const [row] = await this.decorate(caller, [updated]);
    return row;
  }
}
