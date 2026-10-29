import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditAction, AuditEntityType, Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { SettingsConfig } from '../../common/configs/config.interface';
import {
  RlsContext,
  rlsContextFor,
  withRlsContext,
} from '../../common/prisma/rls-context';
import { zonedDateOnly } from '../../hr/leave/leave-days';
import { ItemsService } from '../../settings/item-masters/items.service';
import { InventoryRefsService } from '../inventory-refs.service';
import { SetDailyRatesDto } from './dto/daily-rate.dto';

/** Where an offered rate came from. */
export type DailyRateSource = 'market' | 'vendor';

/** The rate in force for an item (and vendor) on a date. */
export interface EffectiveDailyRate {
  rate: number;
  /** The day that rate was set — the latest change on or before the date asked about. */
  effectiveFrom: string;
  source: DailyRateSource;
}

/** One vendor's line on the board. */
export interface DailyRateBoardVendor {
  vendorId: string;
  vendorName: string;
  /** The vendor's own latest override on or before the date, or null if they never had one. */
  override: { rate: number; effectiveFrom: string } | null;
  /** What a purchase from this vendor on the date is offered: the override or the market, whichever is newer. */
  effective: EffectiveDailyRate | null;
}

/** One daily-rate item on the board. */
export interface DailyRateBoardItem {
  itemId: string;
  code: string;
  name: string;
  unit: string;
  machineFuel: boolean;
  /** The market rate in force on the date — yesterday's, until today's is set. */
  market: { rate: number; effectiveFrom: string } | null;
  vendors: DailyRateBoardVendor[];
}

export interface DailyRateBoard {
  date: string;
  items: DailyRateBoardItem[];
}

export interface DailyRateHistoryRow {
  id: string;
  effectiveFrom: string;
  vendorId: string | null;
  /** "Market rate" for the company-wide row. */
  vendorName: string;
  rate: number;
  setAt: Date;
}

/** Most history rows one read returns — a year of daily changes across a few vendors. */
const HISTORY_LIMIT = 500;

type RateRow = {
  vendorId: string | null;
  rate: Prisma.Decimal;
  effectiveFrom: Date;
};

const day = (date: Date) => date.toISOString().slice(0, 10);

/**
 * The newer of a vendor's override and the market rate (050). A tie goes to the vendor: an override
 * set the same day as the market rate was set *for* that vendor.
 */
export function pickEffective(
  market: RateRow | undefined,
  override: RateRow | undefined,
): EffectiveDailyRate | null {
  const chosen =
    override &&
    (!market ||
      override.effectiveFrom.getTime() >= market.effectiveFrom.getTime())
      ? { row: override, source: 'vendor' as const }
      : market
      ? { row: market, source: 'market' as const }
      : null;
  if (!chosen) return null;
  return {
    rate: chosen.row.rate.toNumber(),
    effectiveFrom: day(chosen.row.effectiveFrom),
    source: chosen.source,
  };
}

/**
 * Daily-changing item rates (050) — diesel, cement: "there are some items whose rates are changing
 * on a day basis … otherwise we'd have to change the vendor's rate every time".
 *
 * ## The shape
 *
 * A dated history per item (`inventory.ItemDailyRate`): one **market rate** the company updates once
 * a day, and an optional **override** per vendor who charges differently. On any date, a vendor is
 * offered the newer of their override and the market rate — so one edit to the market rate moves
 * every vendor at once, which is the point.
 *
 * ## What it is not
 *
 * Not the 028 agreed rate (`VendorItemRate`). That one is a contract, fixed until an approved change,
 * and a purchase must match it. A daily rate is a price, and a purchase is only *offered* it: the
 * document keeps whatever was actually paid, and nothing already recorded is rewritten. Purchases of
 * a daily-rate item therefore skip the agreed-rate lock (see `PurchasesService.assertReceivable`).
 */
@Injectable()
export class DailyRatesService {
  private readonly timeZone: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly items: ItemsService,
    private readonly refs: InventoryRefsService,
    private readonly auditLog: AuditLogService,
    configService: ConfigService,
  ) {
    this.timeZone = configService.get<SettingsConfig>('settings').timezone;
  }

  /** Today in the business timezone, `YYYY-MM-DD`. */
  today(): string {
    return zonedDateOnly(new Date(), this.timeZone);
  }

  /**
   * The rate in force for an item on a date, for one vendor or the market (050). Null when no rate
   * has ever been set on or before it. Callable from another module with its own RLS context —
   * Machinery's fuel entry asks this for its diesel.
   */
  async effective(
    ctx: RlsContext,
    companyId: string,
    itemId: string,
    vendorId: string | null,
    date: string,
  ): Promise<EffectiveDailyRate | null> {
    const on = this.refs.parseDate(date);
    return withRlsContext(this.prisma, ctx, async (tx) => {
      const latest = (vendor: string | null) =>
        tx.itemDailyRate.findFirst({
          where: {
            companyId,
            itemId,
            vendorId: vendor,
            effectiveFrom: { lte: on },
          },
          orderBy: { effectiveFrom: 'desc' },
          select: { vendorId: true, rate: true, effectiveFrom: true },
        });
      const [market, override] = await Promise.all([
        latest(null),
        vendorId ? latest(vendorId) : Promise.resolve(null),
      ]);
      return pickEffective(market ?? undefined, override ?? undefined);
    });
  }

  /** `effective`, for an inventory caller: the item must be one of the company's. */
  async effectiveFor(
    caller: AuthenticatedUser,
    query: {
      itemId: string;
      vendorId?: string;
      date: string;
      companyId?: string;
    },
  ): Promise<
    (EffectiveDailyRate & { dailyRate: true }) | { dailyRate: false }
  > {
    const companyId = this.refs.targetCompanyOf(caller, query.companyId);
    const item = await this.refs.requireItem(caller, query.itemId, companyId);
    if (!item.dailyRate) return { dailyRate: false };
    const found = await this.effective(
      rlsContextFor(caller),
      companyId,
      item.id,
      query.vendorId ?? null,
      query.date,
    );
    return found
      ? { ...found, dailyRate: true }
      : ({ dailyRate: false } as const);
  }

  /**
   * Update today's rates (050): every daily-rate item, its market rate and each vendor who has
   * supplied it or has a rate for it, as in force on `date` — so the form opens on yesterday's
   * figures and one edit per item is enough.
   */
  async board(
    caller: AuthenticatedUser,
    query: { date?: string; companyId?: string },
  ): Promise<DailyRateBoard> {
    const companyId = this.refs.targetCompanyOf(caller, query.companyId);
    const date = (query.date ?? this.today()).slice(0, 10);
    const on = this.refs.parseDate(date);
    const items = await this.items.dailyRateItems(caller, companyId);
    if (items.length === 0) return { date, items: [] };
    const itemIds = items.map((item) => item.id);

    const { rows, agreed, bought } = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const [rows, agreed, bought] = await Promise.all([
          tx.itemDailyRate.findMany({
            where: {
              companyId,
              itemId: { in: itemIds },
              effectiveFrom: { lte: on },
            },
            orderBy: { effectiveFrom: 'desc' },
            select: {
              itemId: true,
              vendorId: true,
              rate: true,
              effectiveFrom: true,
            },
          }),
          tx.vendorItemRate.findMany({
            where: { companyId, itemId: { in: itemIds } },
            distinct: ['itemId', 'vendorId'],
            select: { itemId: true, vendorId: true },
          }),
          tx.purchase.findMany({
            where: {
              companyId,
              itemId: { in: itemIds },
              deleted: false,
              vendorId: { not: null },
            },
            distinct: ['itemId', 'vendorId'],
            select: { itemId: true, vendorId: true },
          }),
        ]);
        return { rows, agreed, bought };
      },
    );

    // Newest first, so the first row seen per (item, vendor-or-market) is the one in force.
    const latest = new Map<string, RateRow>();
    for (const row of rows) {
      const key = `${row.itemId}|${row.vendorId ?? ''}`;
      if (!latest.has(key)) latest.set(key, row);
    }
    const vendorsOf = new Map<string, Set<string>>();
    const addVendor = (itemId: string, vendorId: string | null) => {
      if (!vendorId) return;
      if (!vendorsOf.has(itemId)) vendorsOf.set(itemId, new Set());
      vendorsOf.get(itemId)?.add(vendorId);
    };
    for (const row of [...agreed, ...bought])
      addVendor(row.itemId, row.vendorId);
    for (const row of rows) addVendor(row.itemId, row.vendorId);

    const names = await this.refs.vendorNames(
      caller,
      [...vendorsOf.values()].flatMap((set) => [...set]),
    );

    return {
      date,
      items: items.map((item) => {
        const market = latest.get(`${item.id}|`);
        const vendors = [...(vendorsOf.get(item.id) ?? [])]
          .map((vendorId): DailyRateBoardVendor => {
            const override = latest.get(`${item.id}|${vendorId}`);
            return {
              vendorId,
              vendorName: names.get(vendorId) ?? 'Unknown vendor',
              override: override
                ? {
                    rate: override.rate.toNumber(),
                    effectiveFrom: day(override.effectiveFrom),
                  }
                : null,
              effective: pickEffective(market, override),
            };
          })
          .sort((a, b) => a.vendorName.localeCompare(b.vendorName));
        return {
          itemId: item.id,
          code: item.code,
          name: item.name,
          unit: item.unit,
          machineFuel: item.machineFuel,
          market: market
            ? {
                rate: market.rate.toNumber(),
                effectiveFrom: day(market.effectiveFrom),
              }
            : null,
          vendors,
        };
      }),
    };
  }

  /**
   * Saves the changed rates of one day (050). A row for that day is replaced, not duplicated, so a
   * mistake typed this morning is corrected by typing again; a null rate removes that day's row. The
   * day must not be in the future — a rate is set when it is known — and every item must be a
   * daily-rate item of the company.
   */
  async set(
    caller: AuthenticatedUser,
    dto: SetDailyRatesDto,
    ipAddress: string,
    requestedCompanyId?: string,
  ): Promise<DailyRateBoard> {
    const companyId = this.refs.targetCompanyOf(caller, requestedCompanyId);
    const date = dto.date.slice(0, 10);
    if (date > this.today()) {
      throw new BadRequestException(
        `A rate cannot be set for ${date}, which is in the future.`,
      );
    }
    const on = this.refs.parseDate(date);

    const items = new Map(
      (await this.items.dailyRateItems(caller, companyId)).map((item) => [
        item.id,
        item,
      ]),
    );
    for (const row of dto.rates) {
      const item = items.get(row.itemId);
      if (!item) {
        throw new BadRequestException(
          `Item ${row.itemId} is not a daily-rate item of this company.`,
        );
      }
    }
    for (const vendorId of new Set(
      dto.rates.flatMap((r) => (r.vendorId ? [r.vendorId] : [])),
    )) {
      await this.refs.requireVendorName(caller, vendorId);
    }

    await withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
      for (const row of dto.rates) {
        const vendorId = row.vendorId || null;
        const existing = await tx.itemDailyRate.findFirst({
          where: { companyId, itemId: row.itemId, vendorId, effectiveFrom: on },
          select: { id: true },
        });
        if (row.rate === null) {
          if (existing)
            await tx.itemDailyRate.delete({ where: { id: existing.id } });
          continue;
        }
        if (existing) {
          await tx.itemDailyRate.update({
            where: { id: existing.id },
            data: { rate: row.rate, setByUserId: caller.id },
          });
        } else {
          await tx.itemDailyRate.create({
            data: {
              companyId,
              itemId: row.itemId,
              vendorId,
              rate: row.rate,
              effectiveFrom: on,
              setByUserId: caller.id,
            },
          });
        }
      }
    });

    // One entry per item, carrying every rate set for it that day: a reader of the item's history
    // sees "diesel set to 92.40, Shree Fuels 91.80" as one act.
    for (const [itemId, rows] of groupBy(dto.rates, (r) => r.itemId)) {
      await this.auditLog.record({
        entityType: AuditEntityType.ITEM,
        action: AuditAction.UPDATE,
        entityId: itemId,
        changes: {
          dailyRates: {
            date,
            rates: rows.map((r) => ({
              vendorId: r.vendorId || null,
              rate: r.rate,
            })),
          },
        } as Prisma.InputJsonValue,
        accountId: caller.id,
        companyId,
        ipAddress,
      });
    }

    return this.board(caller, { date, companyId });
  }

  /** One item's dated rates, newest first (050): the market rate and every vendor's override. */
  async history(
    caller: AuthenticatedUser,
    query: { itemId: string; from?: string; to?: string; companyId?: string },
  ): Promise<DailyRateHistoryRow[]> {
    const companyId = this.refs.targetCompanyOf(caller, query.companyId);
    await this.refs.requireItem(caller, query.itemId, companyId);
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.itemDailyRate.findMany({
          where: {
            companyId,
            itemId: query.itemId,
            ...(query.from || query.to
              ? {
                  effectiveFrom: {
                    ...(query.from
                      ? { gte: this.refs.parseDate(query.from) }
                      : {}),
                    ...(query.to ? { lte: this.refs.parseDate(query.to) } : {}),
                  },
                }
              : {}),
          },
          orderBy: [{ effectiveFrom: 'desc' }, { vendorId: 'asc' }],
          take: HISTORY_LIMIT,
        }),
    );
    const names = await this.refs.vendorNames(
      caller,
      rows.flatMap((row) => (row.vendorId ? [row.vendorId] : [])),
    );
    return rows.map((row) => ({
      id: row.id,
      effectiveFrom: day(row.effectiveFrom),
      vendorId: row.vendorId,
      vendorName: row.vendorId
        ? names.get(row.vendorId) ?? 'Unknown vendor'
        : 'Market rate',
      rate: row.rate.toNumber(),
      setAt: row.updatedAt,
    }));
  }
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    out.set(k, [...(out.get(k) ?? []), row]);
  }
  return out;
}
