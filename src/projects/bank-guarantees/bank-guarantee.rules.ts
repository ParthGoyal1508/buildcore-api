import { BankGuaranteeStatus, BankGuaranteeType } from '@prisma/client';

/**
 * The Bank Guarantees register's rules, as pure functions (037).
 *
 * No Nest, no Prisma client — so the status a screen shows, the date an alert fires on and the
 * checks a save must pass are each decided in one place and tested without a database.
 */

export const BG_TYPE_LABEL: Record<BankGuaranteeType, string> = {
  EMD: 'EMD',
  PBG: 'PBG',
};

/** What a register shows. `EXPIRED` is derived, never stored. */
export type BankGuaranteeDisplayStatus =
  | 'RUNNING'
  | 'EXPIRED'
  | 'RELEASED'
  | 'ENCASHED';

/** Labels in the client's own words ("Running", as their sheet prints it). */
export const BG_STATUS_LABEL: Record<BankGuaranteeDisplayStatus, string> = {
  RUNNING: 'Running',
  EXPIRED: 'Expired',
  RELEASED: 'Released',
  ENCASHED: 'Encashed',
};

interface Dated {
  status: BankGuaranteeStatus;
  expiryDate: Date | null;
  claimPeriodEndDate: Date | null;
}

/**
 * The last day the guarantee is live: the claim period end when one is set, otherwise expiry.
 * Null when neither is known yet (applied for, not issued).
 */
export function liveUntil(
  bg: Pick<Dated, 'expiryDate' | 'claimPeriodEndDate'>,
): Date | null {
  return bg.claimPeriodEndDate ?? bg.expiryDate ?? null;
}

/**
 * Running, or Expired once its live-until date is behind `today` (a `YYYY-MM-DD` business date).
 * Released and Encashed are final and shown as stored.
 */
export function displayStatus(
  bg: Dated,
  today: string,
): BankGuaranteeDisplayStatus {
  if (bg.status !== BankGuaranteeStatus.RUNNING) return bg.status;
  const until = liveUntil(bg);
  if (until && until.toISOString().slice(0, 10) < today) return 'EXPIRED';
  return 'RUNNING';
}

/** Days from `today` to the live-until date; negative once past. Null when undated. */
export function daysToExpiry(
  bg: Pick<Dated, 'expiryDate' | 'claimPeriodEndDate'>,
  today: string,
): number | null {
  const until = liveUntil(bg);
  if (!until) return null;
  const from = Date.parse(`${today}T00:00:00Z`);
  return Math.round((until.getTime() - from) / (24 * 60 * 60 * 1000));
}

export interface GuaranteeDates {
  bgNumber?: string | null;
  issueDate?: string | null;
  expiryDate?: string | null;
  claimPeriodEndDate?: string | null;
}

/**
 * The date checks a guarantee must pass, as messages naming the field (empty when it passes).
 *
 * A number may be blank while the guarantee is applied for — the client's sheet has such a row —
 * but an issued guarantee (one with a number) has an issue and an expiry date, because an alert
 * cannot fire on a date nobody entered and a register row without one reads as open-ended.
 */
export function guaranteeDateErrors(input: GuaranteeDates): string[] {
  const errors: string[] = [];
  const issued = !!input.bgNumber?.trim();
  if (issued && !input.issueDate)
    errors.push('Issue date is required once the BG number is entered.');
  if (issued && !input.expiryDate)
    errors.push('Expiry date is required once the BG number is entered.');
  if (
    input.issueDate &&
    input.expiryDate &&
    input.expiryDate < input.issueDate
  ) {
    errors.push('Expiry date cannot be before the issue date.');
  }
  if (input.claimPeriodEndDate) {
    if (!input.expiryDate) {
      errors.push('A claim period end date needs an expiry date.');
    } else if (input.claimPeriodEndDate < input.expiryDate) {
      errors.push('Claim period end date cannot be before the expiry date.');
    }
  }
  return errors;
}
