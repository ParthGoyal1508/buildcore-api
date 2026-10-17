import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { companyScope } from '../../settings/company-scope';
import { AssetsRefsService } from '../assets-refs.service';

export interface AssetStockRow {
  assetId: string;
  assetCode: string;
  assetName: string;
  categoryId: string;
  siteId: string;
  siteName: string;
  onHand: number;
  allocated: number;
  inTransit: number;
  /** The sum of the three — the asset's whole registered pool at this site. */
  total: number;
}

export interface AssetStockFilters {
  assetId?: string;
  siteId?: string;
  companyId?: string;
  /** 036 L4: the asset's code or name contains this. */
  q?: string;
  page?: number;
  pageSize?: number;
}

/**
 * Per-site quantities for bulk assets (spec FR-005).
 *
 * The concurrency guarantee lives here, in `lockForUpdate`: two allocations racing
 * for the last four units of scaffolding must not both succeed. `SELECT … FOR
 * UPDATE` inside the caller's transaction is the same mechanism
 * `StockService.validateAndLockStock()` uses for 009's inventory, and it is chosen
 * for the same reason — an optimistic check followed by an update is a read-then-write
 * race no matter how narrow the window looks.
 */
@Injectable()
export class AssetStockService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly refs: AssetsRefsService,
  ) {}

  /**
   * Locks one asset/site stock row and returns what is free to commit.
   *
   * Must be called inside a transaction: the lock is released at commit, and a call
   * outside one would hold it for exactly as long as the statement, which is to say
   * no protection at all.
   *
   * A missing row is zero available rather than an error — an asset that has never
   * been at a site legitimately has nothing there.
   */
  async lockForUpdate(
    tx: Prisma.TransactionClient,
    params: {
      assetId: string;
      siteId: string;
      quantity: number;
      /** Named in the 422 so the message says which site ran out. */
      label?: string;
    },
  ): Promise<number> {
    const { assetId, siteId, quantity, label = 'this site' } = params;

    const rows = await tx.$queryRaw<
      {
        quantityOnHand: Prisma.Decimal;
        quantityAllocated: Prisma.Decimal;
        quantityInTransit: Prisma.Decimal;
      }[]
    >`
      SELECT "quantityOnHand", "quantityAllocated", "quantityInTransit"
      FROM "assets"."AssetStock"
      WHERE "assetId" = ${assetId} AND "siteId" = ${siteId}
      FOR UPDATE
    `;

    // `quantityOnHand` is already net of what an open allocation holds — the three
    // columns are disjoint by design, so what is free is exactly the on-hand figure.
    const available = rows.length === 0 ? 0 : Number(rows[0].quantityOnHand);

    if (quantity > available) {
      // 422 rather than 400, for the reason `StockService` documents: the request is
      // well-formed and the quantity is a valid number — it is the current stock
      // that forbids it, and the client needs that distinction to show the
      // available figure against the quantity field.
      throw new UnprocessableEntityException({
        message: `Insufficient stock at ${label}: ${available} available, ${quantity} requested.`,
        availableStock: available,
      });
    }
    return available;
  }

  /**
   * Moves quantity between the three columns of one asset/site row, creating the
   * row when it does not exist.
   *
   * The deltas are signed and applied together so a caller can express "four units
   * left on-hand and became allocated" as one call rather than two updates that
   * could interleave.
   */
  async applyDelta(
    tx: Prisma.TransactionClient,
    params: {
      companyId: string;
      assetId: string;
      siteId: string;
      onHand?: number;
      allocated?: number;
      inTransit?: number;
    },
  ): Promise<void> {
    const { companyId, assetId, siteId } = params;
    await tx.assetStock.upsert({
      where: { assetId_siteId: { assetId, siteId } },
      create: {
        companyId,
        assetId,
        siteId,
        quantityOnHand: params.onHand ?? 0,
        quantityAllocated: params.allocated ?? 0,
        quantityInTransit: params.inTransit ?? 0,
      },
      update: {
        ...(params.onHand !== undefined
          ? { quantityOnHand: { increment: params.onHand } }
          : {}),
        ...(params.allocated !== undefined
          ? { quantityAllocated: { increment: params.allocated } }
          : {}),
        ...(params.inTransit !== undefined
          ? { quantityInTransit: { increment: params.inTransit } }
          : {}),
      },
    });
  }

  /**
   * The stock screen: asset/site balances in scope.
   *
   * 036 L4: `q` searches the asset's code and name, and `page`/`pageSize` page it — a company
   * with a few hundred bulk assets across a dozen sites had every row on one screen. Without
   * `page` the whole list comes back as an array, as before, for the callers that need it all.
   */
  async findAll(
    caller: AuthenticatedUser,
    filters: AssetStockFilters = {},
  ): Promise<AssetStockRow[]> {
    return (await this.query(caller, filters)).items;
  }

  async findPage(
    caller: AuthenticatedUser,
    filters: AssetStockFilters,
  ): Promise<{
    items: AssetStockRow[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const page = Math.max(1, filters.page ?? 1);
    const pageSize = Math.min(Math.max(1, filters.pageSize ?? 25), 200);
    const { items, total } = await this.query(caller, filters, {
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return { items, total, page, pageSize };
  }

  private async query(
    caller: AuthenticatedUser,
    filters: AssetStockFilters,
    paging?: { skip: number; take: number },
  ): Promise<{ items: AssetStockRow[]; total: number }> {
    const q = filters.q?.trim();
    const where: Prisma.AssetStockWhereInput = {
      ...companyScope(caller, filters.companyId),
      ...(filters.assetId ? { assetId: filters.assetId } : {}),
      ...(filters.siteId ? { siteId: filters.siteId } : {}),
      asset: {
        deletedAt: null,
        ...(q
          ? {
              OR: [
                { assetCode: { contains: q, mode: 'insensitive' } },
                { name: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
    };
    const { rows, total } = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const [rows, total] = await Promise.all([
          tx.assetStock.findMany({
            where,
            include: {
              asset: {
                select: {
                  assetCode: true,
                  name: true,
                  categoryId: true,
                },
              },
            },
            orderBy: paging
              ? [{ asset: { assetCode: 'asc' } }, { siteId: 'asc' }]
              : [{ assetId: 'asc' }, { siteId: 'asc' }],
            ...(paging ?? {}),
          }),
          paging ? tx.assetStock.count({ where }) : Promise.resolve(0),
        ]);
        return { rows, total: paging ? total : rows.length };
      },
    );

    const siteNames = await this.refs.siteNames(
      caller,
      rows.map((row) => row.siteId),
    );

    const items = rows.map((row) => {
      const onHand = Number(row.quantityOnHand);
      const allocated = Number(row.quantityAllocated);
      const inTransit = Number(row.quantityInTransit);
      return {
        assetId: row.assetId,
        assetCode: row.asset.assetCode,
        assetName: row.asset.name,
        categoryId: row.asset.categoryId,
        siteId: row.siteId,
        siteName: siteNames.get(row.siteId) ?? 'Unknown site',
        onHand,
        allocated,
        inTransit,
        total: onHand + allocated + inTransit,
      };
    });
    return { items, total };
  }
}
