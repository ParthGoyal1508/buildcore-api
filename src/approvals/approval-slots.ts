/**
 * The canonical role slots and their labels (016 FR-001a, Constitution Principle III).
 *
 * A slot is a *named position* in a chain — "first approver", "HR", "final" — that each
 * company maps to one of its own roles. The indirection exists because neither "HR
 * Office" nor "Site Incharge" is a role in this system, and the client runs two
 * companies that may staff the same chain shape differently. A level naming a role
 * would hardcode one org chart into the chain definition (research.md §2).
 *
 * `slotKey` is a free-text column rather than an enum, so a company can define a slot
 * outside this set. These are the ones the default chains use, and the labels here are
 * the fallback when a level does not carry its own — which is why they live in one
 * place instead of being interpolated at each call site.
 */

/** Whoever raises or first reviews the work — the client's "Employer" / "Site Incharge". */
export const SLOT_FIRST_APPROVER = 'first_approver';

/** The HR office. Also the only slot permitted to edit attendance under payroll review. */
export const SLOT_HR = 'hr';

/** The last word — the client's "Director", which resolves to Super Admin. */
export const SLOT_FINAL = 'final';

/** The three slots the default chains are built from, in chain order. */
export const DEFAULT_SLOT_ORDER = [
  SLOT_FIRST_APPROVER,
  SLOT_HR,
  SLOT_FINAL,
] as const;

/**
 * Human labels for the canonical slots, used when an `ApprovalLevel` has no `label` of
 * its own. A level for a slot outside this map falls back to its raw key, which is ugly
 * but legible — preferable to rendering an empty string where a reviewer expects to be
 * told who decides.
 */
export const SLOT_LABELS: Record<string, string> = {
  [SLOT_FIRST_APPROVER]: 'First approver',
  [SLOT_HR]: 'HR',
  [SLOT_FINAL]: 'Director',
};

/** The label to show for a level: its own, else the canonical one, else the raw key. */
export function labelForSlot(
  slotKey: string,
  ownLabel?: string | null,
): string {
  return ownLabel ?? SLOT_LABELS[slotKey] ?? slotKey;
}
