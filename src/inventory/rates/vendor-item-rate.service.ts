import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import type { RlsContext } from '../../common/prisma/rls-context';
import { withRlsContext } from '../../common/prisma/rls-context';

/** What a vendor has agreed for an item, as a screen reads it. */
export interface AgreedRateView {
  id: string;
  vendorId: string;
  itemId: string;
  rate: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

export const RATE_ERRORS = {
  /** A purchase sent a rate that differs from the one agreed with that vendor (028 FR-013). */
  rateFixed: 'PURCHASE_RATE_FIXED',
} as const;

/**
 * The rate agreed with a vendor for an item (028 FR-011 to FR-016).
 *
 * ## The rule, in one sentence
 *
 * The **first** purchase of a vendor–item pair types a rate and establishes it; every purchase after
 * it is supplied that rate and may not alter it without an approved change.
 *
 * ## Why this is enforced here and not in a DTO
 *
 * A DTO can require a number; only a service can require **this** number. The rule is "equal to the
 * rate agreed with this vendor for this item", which is a database read — no validator expresses it,
 * so a DTO that merely accepts a rate leaves the rule enforced nowhere, and a form that renders the
 * field read-only enforces it only for callers who use the form.
 *
 * 028's research §5 originally justified this by claiming `PATCH /inventory/purchases/:id` accepted
 * a rate from any caller. **It does not** — `UpdatePurchaseDto` carries only `date` and `remarks`,
 * because the stock ledger and the bill were computed from the rest and correcting a purchase is
 * delete plus re-create. A guard was written there and removed once the DTO was read; dead code that
 * looks like a control is worse than none, because the next reader trusts it. Corrected in research
 * §5 and in FR-013 rather than quietly dropped.
 *
 * There is a second, quieter reason to refuse rather than silently overwrite: `stock.service.ts`
 * recomputes a **weighted average on every receipt**, so a rate accepted and then replaced would
 * move the valuation of every unit of that material already held, with nobody told.
 *
 * ## A known item from a new vendor is a first purchase
 *
 * The contract is per vendor, so a vendor who has not supplied this item has nothing to supply. That
 * means the control can be stepped around by adding a vendor — **a chosen limit, not a hole**.
 * Blocking new suppliers would be worse than the loophole, so FR-016 answers it with visibility
 * instead: what other vendors have agreed is shown beside a first entry, and first purchases are
 * reportable for a period.
 */
@Injectable()
export class VendorItemRateService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The rate in force for a pair, or null where none has been agreed.
   *
   * "In force" is `effectiveTo IS NULL` — the open end of the history, the convention
   * `settings.HireRate` established. Ordered by `effectiveFrom` descending so a row left open by an
   * earlier mistake cannot outrank the current one.
   */
  async currentFor(
    tx: Prisma.TransactionClient,
    companyId: string,
    vendorId: string,
    itemId: string,
  ): Promise<{ id: string; rate: Prisma.Decimal; effectiveFrom: Date } | null> {
    return tx.vendorItemRate.findFirst({
      where: { companyId, vendorId, itemId, effectiveTo: null },
      orderBy: { effectiveFrom: 'desc' },
      select: { id: true, rate: true, effectiveFrom: true },
    });
  }

  /**
   * Refuses a purchase whose rate differs from the agreed one, naming the figure and its date.
   *
   * Naming both is what makes the refusal actionable. "That rate is wrong" leaves somebody guessing
   * which of the two figures the system believes; "agreed at ₹412.00 with effect from 12 Aug 2026"
   * tells them what to type, or what to get changed.
   *
   * A difference is compared on the stored `Decimal`, never on a JavaScript number — two rates that
   * differ in the second paisa are two different rates, and a float comparison would call them
   * equal often enough to matter.
   */
  assertMatchesAgreed(
    agreed: { rate: Prisma.Decimal; effectiveFrom: Date } | null,
    submitted: number,
  ): void {
    if (!agreed) return;
    if (agreed.rate.equals(new Prisma.Decimal(submitted))) return;

    throw new ConflictException({
      statusCode: 409,
      code: RATE_ERRORS.rateFixed,
      message:
        `This item is agreed with this vendor at ${agreed.rate.toFixed(
          2,
        )}, with effect from ` +
        `${agreed.effectiveFrom
          .toISOString()
          .slice(0, 10)}. A purchase cannot change an agreed ` +
        'rate — raise a rate change and have it approved.',
    });
  }

  /**
   * Records the rate a first purchase established.
   *
   * Idempotent against the unique key: two purchases of the same new pair committed at the same
   * instant would otherwise both try to open a rate from today. The second is ignored rather than
   * refused — both agreed the same figure, which is the only case that can reach here, because any
   * later purchase of the pair goes through `assertMatchesAgreed` first.
   */
  async establish(
    tx: Prisma.TransactionClient,
    input: {
      companyId: string;
      vendorId: string;
      itemId: string;
      rate: number;
      effectiveFrom: Date;
      purchaseId: string;
    },
  ): Promise<void> {
    await tx.vendorItemRate
      .create({
        data: {
          companyId: input.companyId,
          vendorId: input.vendorId,
          itemId: input.itemId,
          rate: input.rate,
          effectiveFrom: input.effectiveFrom,
          establishedByPurchaseId: input.purchaseId,
        },
      })
      .catch((error: { code?: string }) => {
        if (error.code === 'P2002') return;
        throw error;
      });
  }

  /**
   * What every vendor has agreed for one item (028 FR-016).
   *
   * Read beside a first entry, so a figure typed well away from what others charge is typed
   * deliberately and visibly. This is the whole of what stands between the add-a-vendor loophole and
   * a rate nobody notices.
   */
  async agreedAcrossVendors(
    ctx: RlsContext,
    companyId: string,
    itemId: string,
  ): Promise<AgreedRateView[]> {
    return withRlsContext(this.prisma, ctx, async (tx) => {
      const rows = await tx.vendorItemRate.findMany({
        where: { companyId, itemId, effectiveTo: null },
        orderBy: { effectiveFrom: 'desc' },
      });
      return rows.map((row) => ({
        id: row.id,
        vendorId: row.vendorId,
        itemId: row.itemId,
        rate: row.rate.toNumber(),
        effectiveFrom: row.effectiveFrom,
        effectiveTo: row.effectiveTo,
      }));
    });
  }

  /**
   * Rates established by a first purchase in a period (028 FR-016).
   *
   * The short list worth a second pair of eyes: every one of these is a figure somebody typed with
   * nothing to check it against. The report is the other half of not blocking new suppliers.
   */
  async establishedBetween(
    ctx: RlsContext,
    companyId: string,
    from: Date,
    to: Date,
  ): Promise<AgreedRateView[]> {
    return withRlsContext(this.prisma, ctx, async (tx) => {
      const rows = await tx.vendorItemRate.findMany({
        where: {
          companyId,
          establishedByPurchaseId: { not: null },
          effectiveFrom: { gte: from, lte: to },
        },
        orderBy: { effectiveFrom: 'desc' },
      });
      return rows.map((row) => ({
        id: row.id,
        vendorId: row.vendorId,
        itemId: row.itemId,
        rate: row.rate.toNumber(),
        effectiveFrom: row.effectiveFrom,
        effectiveTo: row.effectiveTo,
      }));
    });
  }
}
