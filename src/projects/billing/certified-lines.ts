import { BadRequestException, NotFoundException } from '@nestjs/common';

import { lineTotals, money } from './bill-totals';
import { BILLING_ERRORS } from './billing-error-codes';

/**
 * What a client certified **line by line**, checked and priced in one place (2026-10-15).
 *
 * Extracted from `ClientBillsService.certify` (2026-10-11) when the bill package's Certify learned
 * to take lines too — read from the client's certified copy, or typed in. Two certify paths with
 * two definitions of "the certified amount" would be the bill-totals defect again: each plausible,
 * a few paise apart, on the same bill.
 */

/** One line's certified quantity, as either Certify posts it. */
export interface CertifiedLine {
  lineId: string;
  certifiedQty: number;
}

/** A bill line, as much of it as certifying needs. */
export interface CertifiableLine {
  id: string;
  quantity: number;
  rate: number;
  /**
   * A non-BOQ item is billed at its own rate, without the tender premium (2026-10-14) — so it is
   * certified at it too.
   */
  nonBoq?: boolean;
}

/**
 * Refuses a line that is not on the bill, a line given twice, and a quantity above what was billed.
 *
 * Above-billed is refused with the bill-level code and for the bill-level reason: a client cannot
 * certify work nobody claimed, and the remedy is a further bill, not a certificate above this one.
 */
export function assertCertifiedLines(
  billLines: CertifiableLine[],
  certified: CertifiedLine[],
): void {
  const seen = new Set<string>();
  for (const line of certified) {
    const billed = billLines.find((row) => row.id === line.lineId);
    if (!billed) {
      throw new NotFoundException(`Line ${line.lineId} is not on this bill.`);
    }
    if (seen.has(line.lineId)) {
      // Two answers for one line, and whichever was written last would win silently.
      throw new BadRequestException(
        `Line ${line.lineId} is certified twice. Send each line once.`,
      );
    }
    seen.add(line.lineId);
    if (line.certifiedQty > billed.quantity) {
      throw new BadRequestException({
        statusCode: 400,
        code: BILLING_ERRORS.certifiedExceedsBilled,
        message:
          `Certified ${line.certifiedQty} on a line billed at ` +
          `${billed.quantity}. Raise a further bill for the extra work rather ` +
          `than certifying above this one.`,
      });
    }
  }
}

/**
 * What the certified quantities come to, at the rates and quote the bill was priced at.
 *
 * A line the client said nothing about keeps its billed quantity — omission is "not said", not
 * "certified at nothing". A client returning a certificate that covers half the schedule has said
 * nothing about the other half, and reading silence as a rejection would quietly halve the bill.
 *
 * **Priced per line through `lineTotals`**, the one definition of a line's amount, and summed — so a
 * bill certified at every billed quantity comes to exactly its gross, the sum of its printed lines,
 * rather than a figure re-derived from the total that can land a paisa above it and be refused as
 * certifying more than was billed.
 */
export function certifiedAmountOf(
  billLines: CertifiableLine[],
  certified: CertifiedLine[],
  quotedPercentage: number,
): number {
  const byId = new Map(certified.map((row) => [row.lineId, row.certifiedQty]));
  return money(
    billLines.reduce((sum, line) => {
      const qty = byId.get(line.id) ?? line.quantity;
      return (
        sum +
        lineTotals(
          { quantity: qty, rate: line.rate },
          line.nonBoq ? 0 : quotedPercentage,
        ).amount
      );
    }, 0),
  );
}
