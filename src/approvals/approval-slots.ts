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

/**
 * The role each slot maps to when a company is created, by role name (016 FR-001a).
 *
 * **Answered by the client on 2026-10-04**, and until then deliberately absent. The
 * original reasoning for leaving the first two slots unmapped is worth keeping, because
 * it was right: neither "HR Office" nor "Site Incharge" exists as a role in this system,
 * and inventing a mapping would have handed the right to approve attendance and payroll
 * to whichever role happened to sound closest. `seedDefaultsForCompany` said so in as
 * many words.
 *
 * What that reasoning did not account for is the cost of the gap. A company is created
 * with twelve chains, **five of which name these slots** — payroll run, attendance
 * correction, attendance exception, operator fuel recovery — so until an administrator
 * made two settings entries no payroll could be approved at all. Measured on 2026-10-04
 * against the live development database: neither slot was mapped in *either* company,
 * three weeks after the spine shipped. The refusal is legible (`APPROVAL_SLOT_UNMAPPED`,
 * naming settings as the cause, which is why nothing hung silently) but nobody had met it,
 * because nobody had yet run a payroll in a seeded company.
 *
 * So the gap was loud in design and silent in practice. A default the client chose, which
 * an administrator can change in settings, is better than both: the chain routes on day
 * one, and the indirection the slots exist for is untouched — these are starting values,
 * not the definition of the chain.
 *
 * Mapped by **name** rather than id because these three are default roles created by
 * migration `20260830090000_seed_default_roles` and so exist in every database. A name
 * that does not resolve maps nothing and is reported, rather than throwing: a company
 * whose administrator renamed a role should still be creatable.
 */
export const DEFAULT_SLOT_ROLE_NAMES: Record<string, string> = {
  /** The client's "Site Incharge" — the role their site administrators hold. */
  [SLOT_FIRST_APPROVER]: 'Site Admin',
  /** The client's "HR Office". No role is named HR; head office is where it sits. */
  [SLOT_HR]: 'HO User',
  /** The client's "Director", settled as Super Admin on 2026-09-13. */
  [SLOT_FINAL]: 'Super Admin',
};

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
