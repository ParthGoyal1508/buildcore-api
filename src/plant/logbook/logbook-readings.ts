import { MeterType } from '@prisma/client';

/** A day has 24 hours; an hour meter cannot have run more in one. */
export const MAX_HOURS_PER_DAY = 24;

/**
 * Why a day's readings cannot be recorded, or null when they can (036 K4).
 *
 * A pure function so the single-entry form and the monthly sheet — which checks every row before
 * writing any — apply one rule, and so the rule is testable without a database.
 *
 * - **Not in the future.** A typo year (2062) used to become the machine's latest entry and pin
 *   its meter there for good, since the meter follows the latest-dated entry.
 * - **At most 24 hours a day on an hour meter.** More is a mistyped reading, and it lands on a
 *   hire bill as hours the machine never worked. A km meter has no such ceiling.
 * - **The opening reading follows on from the previous closing one**, unless a reason is given.
 *   Refused rather than merely flagged: an unexplained gap is nearly always a typo that adds or
 *   drops hours between two entries, and a warning on a form that saves anyway is read once and
 *   then ignored. A real gap — a machine moved on a trailer, a meter replaced — is legitimate,
 *   which is what the reason is for. Only the *previous* entry is compared: the first entry for a
 *   machine has nothing to follow on from.
 */
export function readingProblem(params: {
  /** `YYYY-MM-DD`, for the messages. */
  date: string;
  dateValue: Date;
  today: Date;
  meterType: MeterType;
  openingReading: number;
  closingReading: number;
  previousClosing: number | null;
  readingGapReason?: string | null;
}): string | null {
  if (params.dateValue > params.today) {
    return `${params.date} is in the future. A logbook entry records a day that has happened.`;
  }
  const run = params.closingReading - params.openingReading;
  if (
    params.meterType === MeterType.hours &&
    thousandths(run) > thousandths(MAX_HOURS_PER_DAY)
  ) {
    return (
      `${params.date}: ${round3(
        run,
      )} hours in one day is more than ${MAX_HOURS_PER_DAY}. ` +
      'Check the opening and closing readings.'
    );
  }
  if (
    params.previousClosing !== null &&
    thousandths(params.openingReading) !==
      thousandths(params.previousClosing) &&
    !params.readingGapReason?.trim()
  ) {
    return (
      `${params.date}: the opening reading ${params.openingReading} does not follow on from the ` +
      `previous closing reading ${params.previousClosing}. Correct it, or give a reason for the ` +
      'gap (readingGapReason) — a meter replaced, a machine moved on a trailer.'
    );
  }
  return null;
}

/** Whether a gap reason is worth storing: only when there is a gap. */
export function hasReadingGap(
  openingReading: number,
  previousClosing: number | null,
): boolean {
  return (
    previousClosing !== null &&
    thousandths(openingReading) !== thousandths(previousClosing)
  );
}

function thousandths(value: number): number {
  return Math.round(value * 1000);
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
