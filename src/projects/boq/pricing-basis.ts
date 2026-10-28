import { BoqPricingBasis } from '@prisma/client';

/** The two fields that decide whether a line takes the project's quoted percentage. */
export interface PricedLine {
  nonBoq?: boolean | null;
  pricingBasis?: BoqPricingBasis | null;
}

/**
 * Whether the tender premium applies to this line (047).
 *
 * **One predicate, every call site.** The quoted percentage is a bid on a *Percentage BoQ*'s
 * schedule rates. An item-rate line already carries the bidder's own price, and a non-BOQ item is
 * priced by agreement — neither takes the premium. Before 047 the second rule was written inline as
 * `nonBoq ? 0 : q` at six places; a seventh place forgetting the first rule would bill item-rate
 * work at the percentage, which is the defect this feature exists to remove.
 *
 * A missing basis reads as `percentage` — the column's default and the behaviour of every line that
 * existed before it.
 */
export function takesQuotedPercentage(line: PricedLine): boolean {
  return !line.nonBoq && line.pricingBasis !== BoqPricingBasis.item_rate;
}

/** The percentage to price this line at: the project's, or 0 where it does not apply. */
export function quotedPercentageFor(
  line: PricedLine,
  quotedPercentage: number,
): number {
  return takesQuotedPercentage(line) ? quotedPercentage : 0;
}
