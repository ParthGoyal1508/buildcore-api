import { ReminderSeverity } from '@prisma/client';

import { RlsContext } from '../../common/prisma/rls-context';
import { MS_PER_DAY } from '../constants/dashboard.constants';

/**
 * How a rule turns days-remaining into a severity band (spec FR-029).
 *
 * A single threshold rather than a list of bands, because the ladder has exactly
 * three rungs and two of them are fixed: anything past its due date is `overdue`, and
 * anything inside the lead window but not yet near is `info`. `warnWithinDays` is the
 * only genuinely per-rule number — a certificate that takes six weeks to renew wants
 * a wider warning band than one that takes an afternoon.
 *
 * Persisted as JSON in `ReminderRule.severityLadder` so a fourth rung would not need
 * a migration in this feature.
 */
export interface ReminderSeverityLadder {
  /** Days-remaining at or below this (but not negative) reads as `warning`. */
  warnWithinDays: number;
}

/**
 * One due-date instance a rule found, before the engine adds severity and identity.
 *
 * `companyId` is carried per candidate rather than taken from a request context
 * because the nightly sweep evaluates every tenant in one pass, under the
 * cross-company bypass — the same shape `ComplianceCheckCron` uses.
 */
export interface ReminderCandidate {
  companyId: string;
  /** The owning module's id for the record — resolved by that module, never joined to. */
  entityId: string;
  /** Human-readable, shown as the reminder's headline: "Fire safety certificate — Plant 4". */
  subject: string;
  /** Calendar date the thing falls due. */
  dueDate: Date;
  /** Optional deep link into the owning module's screen for this record. */
  actionLink?: string;
}

/**
 * A registered reminder rule.
 *
 * Implemented by the module that owns the data — Principle I: this feature never
 * queries another schema, it asks the owning module to evaluate its own records and
 * hand back candidates.
 *
 * `isAvailable()` is what FR-031 hangs off: a rule for a module that is specced but
 * not built returns false, contributes nothing, and is reported to the caller as
 * unavailable rather than failing the whole request.
 */
export interface ReminderRuleProvider {
  /** Stable identity, kebab-case, unique across the installation. */
  readonly ruleKey: string;
  /** The module that owns the rule: `machinery`, `project_assets`, `settings`. */
  readonly sourceModule: string;
  /** The reminder family, used by the list's type filter: `document_expiry`. */
  readonly type: string;
  /** What the rule evaluates over: `EQUIPMENT_DOCUMENT`. */
  readonly entityType: string;
  /** How far ahead of the due date the rule starts producing candidates. */
  readonly leadDays: number;
  readonly severityLadder: ReminderSeverityLadder;

  /** False when the owning module is not built yet (spec FR-031). */
  isAvailable(): boolean;

  /**
   * Every currently-due instance. Called only when `isAvailable()` is true, and
   * always inside the caller's RLS context — a rule must not widen its own scope.
   */
  evaluate(ctx: RlsContext): Promise<ReminderCandidate[]>;
}

/** One resolved reminder, as the API returns it. Computed; never stored. */
export interface Reminder {
  /** `<ruleKey>:<entityId>` — see `reminderIdFor`. */
  id: string;
  ruleKey: string;
  sourceModule: string;
  type: string;
  entityType: string;
  entityId: string;
  companyId: string;
  subject: string;
  /** ISO calendar date, `YYYY-MM-DD`. */
  dueDate: string;
  /** Negative when overdue (spec FR-030). */
  daysRemaining: number;
  severity: ReminderSeverity;
  actionLink?: string;
}

/** A rule that could not be evaluated because its module is not built (spec FR-031). */
export interface UnavailableRuleSource {
  ruleKey: string;
  sourceModule: string;
  reason: 'module_pending';
}

/**
 * A reminder's identity, stable across evaluations.
 *
 * Composite rather than a stored surrogate key because a reminder has no row: it
 * exists only for as long as its condition holds. (rule, entity) is what actually
 * persists, so it is what a snooze targets and what the de-duplication ledger keys
 * off. Deterministic, so the id in a bookmarked snooze request still resolves
 * tomorrow.
 *
 * The separator is a colon, which is legal in a path segment (RFC 3986 §3.3) and
 * cannot appear in a `ruleKey` — rule keys are kebab-case by convention, and
 * `parseReminderId` splits on the first colon so an entity id containing one would
 * still round-trip.
 */
export function reminderIdFor(ruleKey: string, entityId: string): string {
  return `${ruleKey}:${entityId}`;
}

/** Inverse of `reminderIdFor`. Returns null for anything malformed. */
export function parseReminderId(
  id: string,
): { ruleKey: string; entityId: string } | null {
  const separator = id.indexOf(':');
  if (separator <= 0 || separator === id.length - 1) return null;
  return {
    ruleKey: id.slice(0, separator),
    entityId: id.slice(separator + 1),
  };
}

/**
 * Whole days from `from` to `to`, both `YYYY-MM-DD`.
 *
 * Parsed as UTC midnights so the result is a count of calendar days rather than of
 * 24-hour spans — the two differ across a DST boundary, and "expires in 3 days" must
 * not become 2 because the clocks moved.
 */
export function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      MS_PER_DAY,
  );
}

/**
 * The severity band for a days-remaining figure (spec FR-030).
 *
 * Overdue is `< 0`, not `<= 0`: something due today is not yet late.
 */
export function severityFor(
  daysRemaining: number,
  ladder: ReminderSeverityLadder,
): ReminderSeverity {
  if (daysRemaining < 0) return ReminderSeverity.overdue;
  if (daysRemaining <= ladder.warnWithinDays) return ReminderSeverity.warning;
  return ReminderSeverity.info;
}

/**
 * The sort spec FR-030 requires: overdue first, then soonest due.
 *
 * Not simply "by days remaining ascending" — that would put the most overdue item
 * first within the overdue group, which reads backwards on screen. The overdue group
 * is ordered by due date too, so the oldest breach heads the list.
 */
export function compareReminders(a: Reminder, b: Reminder): number {
  const aOverdue = a.severity === ReminderSeverity.overdue ? 0 : 1;
  const bOverdue = b.severity === ReminderSeverity.overdue ? 0 : 1;
  if (aOverdue !== bOverdue) return aOverdue - bOverdue;
  if (a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
